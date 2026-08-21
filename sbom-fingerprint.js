/**
 * Sestavení SBOM ze skutečně stažených JS souborů.
 *
 * Původní skener četl jen globální proměnné (`window.jQuery`, `window._`…).
 * Bundlovaná aplikace (Vite, webpack, Rollup, ESM) do `window` nevystaví nic,
 * takže SBOM zůstal prázdný — a nástroj, který se prodává jako generátor
 * softwarového kusovníku podle CRA, u moderního webu nevrátil ani jednu
 * položku.
 *
 * Tady se místo toho prohledává obsah stažených skriptů. Tři zdroje důkazu,
 * seřazené od nejsilnějšího:
 *
 *   1. **Source mapy** — pole `sources` obsahuje cesty typu
 *      `node_modules/react-dom/client.js`. To je přímý seznam závislostí tak,
 *      jak je viděl bundler. Nejspolehlivější, ale bývá jen na testovacích
 *      buildech.
 *   2. **Verzní bannery** — `/*! jQuery v3.6.0 …` a podobné. Minifikace je
 *      většinou zachovává (`/*!` je „zachovej i při minifikaci").
 *   3. **Charakteristické vzory** — řetězce, které knihovna do bundlu vždy
 *      vloží (např. varovná hláška Reactu). Doloží přítomnost, ne verzi.
 *
 * Co se **nezjistí**: knihovna bez banneru, bez source mapy a bez unikátního
 * řetězce zůstane neviditelná. Prázdný výsledek proto znamená „nenašli jsme",
 * ne „nic tam není" — a tak se taky reportuje.
 *
 * Funkce jsou čisté (řetězec → nálezy), aby šly testovat bez prohlížeče.
 */

/** Kolik znaků skriptu se prohledává. Bundly bývají megabajtové. */
export const MAX_SCAN_BYTES = 3 * 1024 * 1024;

/**
 * Strop na velikost stahované source mapy.
 *
 * Mapu poskytuje skenovaná (tedy cizí) strana. Bez stropu stačí, aby server
 * začal posílat nekonečný proud dat — naměřeno 1,1 GB RSS za 10 s, než sepnul
 * timeout. Čte se proto po částech a při překročení se spojení zahodí.
 */
export const MAX_SOURCE_MAP_BYTES = 8 * 1024 * 1024;

/** Strop na počet balíčků vytažených ze source map jednoho auditu. */
export const MAX_SOURCE_MAP_PACKAGES = 500;

/**
 * Přečte tělo odpovědi, ale nejvýš `limit` bajtů.
 *
 * `response.text()` načte do paměti cokoli, co protistrana pošle. Tady se
 * čte po chuncích a při překročení stropu se stream zruší.
 */
async function readCapped(response, limit = MAX_SOURCE_MAP_BYTES) {
  // Rychlá cesta: server řekl velikost dopředu.
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel?.();
    throw new Error(`Source mapa je větší než ${limit} B.`);
  }

  if (!response.body?.getReader) {
    // Fallback pro stahovače bez streamu (testovací dvojník, node-fetch v2).
    // Strop se musí uplatnit i tady, jinak by ho výměna stahovače tiše zrušila.
    const text = await response.text();
    if (text.length > limit) throw new Error(`Source mapa přesáhla ${limit} B.`);
    return text;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > limit) throw new Error(`Source mapa přesáhla ${limit} B.`);
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return text + decoder.decode();
}

/**
 * Vzory pro rozpoznání knihoven.
 *
 * `version` musí mít právě jednu zachytávající skupinu — číslo verze.
 * `presence` doloží jen přítomnost; verze pak zůstane `null`.
 *
 * `npm` je název balíčku v registru npm, aby šel použít v dotazu do OSV.
 */
export const LIBRARY_SIGNATURES = [
  {
    name: 'jQuery',
    npm: 'jquery',
    type: 'Library',
    version: [
      /\/\*![\s\S]{0,80}?jQuery(?: JavaScript Library)? v(\d+\.\d+\.\d+)/i,
      /jquery["']?\s*[:=]\s*["'](\d+\.\d+\.\d+)["']/i,
      /jQuery\.fn\.jquery\s*=\s*["'](\d+\.\d+\.\d+)/,
    ],
    presence: [/jQuery\.fn\.init/, /\bjQuery\b[\s\S]{0,40}\bprototype\b/],
  },
  {
    name: 'React',
    npm: 'react',
    type: 'Framework',
    // POZOR na vzory typu `"react": "^18.2.0"` — to je DEKLAROVANÝ ROZSAH
    // z package.json, ne nasazená verze. `^18.2.0` se běžně resolvuje na
    // 18.3.1, takže dotaz do OSV na 18.2.0 mohl vyrobit FAIL na CVE, které
    // je v reálně nasazené verzi opravené. Takové vzory sem nepatří.
    version: [
      /reactVersion\s*[:=]\s*["'](\d+\.\d+\.\d+)["']/,
      // Musí být blízko u sebe, jinak chytí `exports.version` cizího balíčku.
      /exports\.version\s*=\s*["'](\d+\.\d+\.\d+)["'][\s\S]{0,80}?\breact\b/i,
    ],
    // Hlášky, které React vkládá do bundlu i v produkci.
    presence: [
      /Minified React error #\d+/,
      /__REACT_DEVTOOLS_GLOBAL_HOOK__/,
      /react\.(?:element|fragment|portal)/i,
    ],
  },
  {
    name: 'React DOM',
    npm: 'react-dom',
    type: 'Library',
    version: [],
    // `react-dom` jako pouhý řetězec se objevuje i v komentářích a licencích.
    // Vyžaduje se skutečná stopa běhového kódu.
    presence: [/createRoot[\s\S]{0,60}hydrateRoot/, /__reactContainer\$/, /react-dom\.production/],
  },
  {
    name: 'Vue.js',
    npm: 'vue',
    type: 'Framework',
    version: [
      /\/\*![\s\S]{0,80}?Vue\.js v(\d+\.\d+\.\d+)/i,
      /(?:^|[^\w])version\s*[:=]\s*["'](\d+\.\d+\.\d+)["'][\s\S]{0,200}?__VUE__/,
    ],
    presence: [/__VUE__/, /\bcreateElementVNode\b/, /\bVue\.js\b/],
  },
  {
    name: 'Angular',
    npm: '@angular/core',
    type: 'Framework',
    version: [/ng-version=["'](\d+\.\d+\.\d+)["']/],
    presence: [/ng-version/, /\bplatformBrowserDynamic\b/, /\bɵɵdefineComponent\b/],
  },
  {
    name: 'Lodash',
    npm: 'lodash',
    type: 'Library',
    // POZOR: banner oficiálního lodash.min.js zní
    //   "Lodash lodash.com/license | Underscore.js 1.8.3 underscorejs.org/LICENSE"
    // — to `1.8.3` je verze UNDERSCORE, ne lodashe (skutečná verze v tom
    // souboru vůbec není). Volný vzor „lodash … první trojčíslí" z toho udělal
    // dotaz do OSV na lodash@1.8.3 a vrátil „FAIL: okamžitě aktualizujte
    // závislosti" u aktuální 4.17.x. Vyžaduje se proto přiřazení do proměnné
    // VERSION těsně u zmínky o lodashi, ne libovolné číslo v okolí.
    version: [
      /VERSION\s*=\s*["'](\d+\.\d+\.\d+)["'][\s\S]{0,80}?\blodash\b/i,
      /\blodash\b[\s\S]{0,80}?VERSION\s*=\s*["'](\d+\.\d+\.\d+)["']/i,
    ],
    // `__lodash_hash_undefined__` a `lodash.templateSources` jsou stopy
    // skutečného kódu, ne jen zmínky.
    presence: [/__lodash_hash_undefined__/, /\blodash\b[\s\S]{0,60}?\bLICENSE\b/i],
  },
  {
    name: 'Next.js',
    npm: 'next',
    type: 'Framework',
    // Pozor: vzor bez zachytávající skupiny sem nepatří — `match[1]` by bylo
    // undefined a verze by tiše zmizela. Takové vzory patří do `presence`.
    version: [],
    presence: [/__NEXT_DATA__/, /__NEXT_LOADED_PAGES__/],
  },
  {
    name: 'Moment.js',
    npm: 'moment',
    type: 'Library',
    // Moment je vyřazený z údržby — v SBOM je to důležitá informace.
    version: [/moment[\s\S]{0,60}?version\s*[:=]\s*["'](\d+\.\d+\.\d+)["']/i],
    presence: [/\bisMoment\b/, /moment\.js/i],
  },
  {
    name: 'Axios',
    npm: 'axios',
    type: 'Library',
    version: [/VERSION\s*[:=]\s*["'](\d+\.\d+\.\d+)["'][\s\S]{0,120}?axios/i, /axios\/(\d+\.\d+\.\d+)/],
    // Ne holé slovo — „axios" bývá v komentářích a v názvech proměnných.
    presence: [/\bAxiosError\b/, /\bisAxiosError\b/, /\baxios\b[\s\S]{0,40}\binterceptors\b/],
  },
  {
    name: 'Bootstrap',
    npm: 'bootstrap',
    type: 'Library',
    version: [/\/\*![\s\S]{0,80}?Bootstrap v(\d+\.\d+\.\d+)/i],
    // NE `/\bbootstrap\b/i` — „bootstrap" je běžné slovo ve webpack runtime
    // („__webpack_require__ bootstrap"), v komentářích i v názvech vlastních
    // funkcí. Položka v SBOM je tvrzení „tahle knihovna tu je"; vyrobit ho
    // z výskytu obecného slova je falešný poplach, který navíc shodí celý
    // výsledek na neprůkazný, protože k němu nedohledáme verzi.
    presence: [/getbootstrap\.com/i, /\bbs-toggle\b/, /\bdata-bs-[a-z]+\b/],
  },
  {
    name: 'D3',
    npm: 'd3',
    type: 'Library',
    // Vzory musí sedět na MINIFIKOVANÝ bundle. `d3.select` minifikace
    // přejmenuje a řetězec „d3-selection" v distribuci není — původní
    // signatura proto nesedla ani na neminifikovaný d3.js.
    // `var version = "7.9.0"` v souboru naopak je, stejně jako charakteristické
    // názvy exportů, které se jako řetězce zachovají.
    version: [/\bversion\s*=\s*["'](\d+\.\d+\.\d+)["'][\s\S]{0,200}?\bscaleLinear\b/],
    presence: [/\bscaleLinear\b[\s\S]{0,400}?\bscaleOrdinal\b/, /\bd3\.(?:select|scaleLinear)\b/],
  },
];

/** Balíčky, které v `sources` source mapy nejsou skutečné závislosti webu. */
const SOURCE_MAP_NOISE = new Set(['.bin', '.cache', '.pnpm', '.vite']);

/**
 * Vytáhne názvy balíčků z pole `sources` source mapy.
 *
 * Cesty vypadají jako `../node_modules/react-dom/client.js` nebo
 * `webpack://app/./node_modules/@scope/pkg/index.js`. Zajímá nás jen segment
 * hned za posledním `node_modules/` (u scoped balíčků dva segmenty).
 *
 * @param {object|string} sourceMap  Rozparsovaná mapa nebo její JSON.
 * @returns {Array<{ npm: string, evidence: string }>}
 */
export function packagesFromSourceMap(sourceMap) {
  let map = sourceMap;
  if (typeof map === 'string') {
    try {
      map = JSON.parse(map);
    } catch {
      return [];
    }
  }
  const sources = Array.isArray(map?.sources) ? map.sources : [];
  const found = new Map();

  for (const source of sources) {
    if (typeof source !== 'string') continue;
    const idx = source.lastIndexOf('node_modules/');
    if (idx === -1) continue;

    const rest = source.slice(idx + 'node_modules/'.length);
    const segments = rest.split('/').filter(Boolean);
    if (segments.length === 0) continue;

    // Scoped balíček (@scope/name) zabírá dva segmenty.
    const npm = segments[0].startsWith('@') && segments.length > 1
      ? `${segments[0]}/${segments[1]}`
      : segments[0];

    if (SOURCE_MAP_NOISE.has(npm) || npm.startsWith('.')) continue;
    if (!found.has(npm)) found.set(npm, source);
  }

  return [...found].map(([npm, evidence]) => ({ npm, evidence }));
}

/**
 * Najde knihovny v obsahu jednoho skriptu.
 *
 * @param {string} content  Zdrojový kód (klidně minifikovaný).
 * @returns {Array<{ name, npm, type, version, confidence, evidence }>}
 */
export function fingerprintScript(content) {
  if (typeof content !== 'string' || content.length === 0) return [];
  // U mnohamegabajtových bundlů by regexy běžely zbytečně dlouho.
  const text = content.length > MAX_SCAN_BYTES ? content.slice(0, MAX_SCAN_BYTES) : content;

  const results = [];
  for (const signature of LIBRARY_SIGNATURES) {
    let version = null;
    let evidence = null;

    for (const pattern of signature.version || []) {
      const match = pattern.exec(text);
      if (match?.[1]) {
        version = match[1];
        evidence = match[0].slice(0, 120);
        break;
      }
    }

    if (!version) {
      const hit = (signature.presence || []).find((pattern) => pattern.test(text));
      if (!hit) continue;
      evidence = hit.exec(text)?.[0]?.slice(0, 120) || null;
    }

    results.push({
      name: signature.name,
      npm: signature.npm,
      type: signature.type,
      version,
      // Bez verze se nedá dotázat OSV — a nedá se ani tvrdit, že je knihovna
      // v pořádku. Proto se to rozlišuje.
      confidence: version ? 'version-detected' : 'presence-only',
      evidence,
    });
  }
  return results;
}

/**
 * Projde stažené skripty, prohledá jejich obsah a dotáhne source mapy.
 *
 * Oddělené od Playwrightu schválně: stačí cokoli s `url()` a `text()`, takže
 * to jde testovat bez prohlížeče. V tomhle projektu vznikala většina chyb
 * právě v místech, která se dala ověřit jen spuštěním celého skeneru.
 *
 * @param {Array<{url(): string, text(): Promise<string>}>} responses
 * @param {object} deps
 * @param {(url: string) => Promise<{ok: boolean, text(): Promise<string>}>} deps.fetchMap
 *        Stahovač source map. Volá se jen pro mapy ze stejného původu.
 * @param {(url: string) => void|Promise<void>} [deps.assertUrlAllowed]
 *        SSRF pojistka; smí vyhodit synchronně i asynchronně (proto `await`).
 */
export async function collectBundleEvidence(responses, deps = {}) {
  const { fetchMap, assertUrlAllowed } = deps;
  const findings = [];
  const sourceMapPackages = [];
  const unreadable = [];
  // Strop na počet balíčků z map: nepřátelská mapa může mít milion položek
  // v poli `sources` a nafouknout odpověď na stovky MB.
  let packageBudget = MAX_SOURCE_MAP_PACKAGES;

  for (const response of responses) {
    let body;
    try {
      body = await response.text();
    } catch (err) {
      // Tělo už nemusí být k dispozici (redirect, cache, zavřené spojení).
      // Že jsme skript nepřečetli, musí být v reportu vidět — jinak by
      // prázdný SBOM vypadal jako „nic tam není".
      unreadable.push({ url: response.url(), reason: err.message });
      continue;
    }

    findings.push(...fingerprintScript(body));

    if (typeof fetchMap !== 'function' || packageBudget <= 0) continue;
    // sourceMappingURL bývá na konci souboru.
    const mapMatch = /[#@]\s*sourceMappingURL=([^\s*'"]+)/.exec(body.slice(-2048));
    if (!mapMatch || mapMatch[1].startsWith('data:')) continue;

    try {
      const mapUrl = new URL(mapMatch[1], response.url());
      // Mapa se stahuje jen ze stejného původu jako skript — jinak by přes ni
      // šlo skener donutit sáhnout kamkoli.
      if (mapUrl.origin !== new URL(response.url()).origin) continue;
      // `await` je tu zásadní: guard je async, takže bez něj by se odmítnutí
      // Promise nikdy nedostalo do `catch`, fetch by proběhl i na zakázanou
      // adresu a odmítnutí by skončilo jako unhandledRejection — což tenhle
      // server ukončuje. Kontrolní vlna to našla jako vzdáleně spustitelný DoS.
      await assertUrlAllowed?.(mapUrl.href);
      const mapResponse = await fetchMap(mapUrl.href);
      if (!mapResponse?.ok) {
        // Nepřečtené tělo drží spojení až do GC.
        await mapResponse?.body?.cancel?.();
        continue;
      }
      const packages = packagesFromSourceMap(await readCapped(mapResponse));
      sourceMapPackages.push(...packages.slice(0, packageBudget));
      packageBudget -= packages.length;
    } catch {
      // Chybějící, nedostupná nebo příliš velká mapa není chyba —
      // jen o zdroj důkazu míň.
    }
  }

  return { findings, sourceMapPackages, unreadable };
}

/**
 * Sloučí nálezy z více skriptů a z runtime globálů do jednoho seznamu.
 *
 * Přednost má nález s konkrétní verzí. Když dva zdroje hlásí jinou verzi téže
 * knihovny, ponechá se první a rozpor se zaznamená — mlčky si vybrat jednu by
 * znamenalo skrýt, že si zdroje odporují.
 */
export function mergeFindings(groups) {
  const byKey = new Map();
  const conflicts = [];

  for (const { source, findings } of groups) {
    for (const finding of findings || []) {
      const key = (finding.npm || finding.name).toLowerCase();
      const existing = byKey.get(key);

      if (!existing) {
        byKey.set(key, { ...finding, sources: [source] });
        continue;
      }

      if (!existing.sources.includes(source)) existing.sources.push(source);

      if (finding.version && !existing.version) {
        existing.version = finding.version;
        existing.confidence = finding.confidence;
        existing.evidence = finding.evidence;
      } else if (finding.version && existing.version && finding.version !== existing.version) {
        conflicts.push({
          library: existing.name,
          versions: [existing.version, finding.version],
          note: 'Zdroje se neshodly na verzi — stránka může načítat dvě různé kopie.',
        });
        // Obě verze se musí ověřit. Zeptat se jen na tu první znamenalo,
        // že zranitelná druhá kopie prošla bez kontroly.
        existing.alternateVersions = existing.alternateVersions || [];
        if (!existing.alternateVersions.includes(finding.version)) {
          existing.alternateVersions.push(finding.version);
        }
      }
    }
  }

  return { libraries: [...byKey.values()], conflicts };
}
