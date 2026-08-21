import {
  fingerprintScript,
  packagesFromSourceMap,
  mergeFindings,
  collectBundleEvidence,
  LIBRARY_SIGNATURES,
  MAX_SCAN_BYTES,
  MAX_SOURCE_MAP_BYTES,
  MAX_SOURCE_MAP_PACKAGES,
} from '../sbom-fingerprint.js';

/**
 * SBOM z obsahu bundlů.
 *
 * Původní detekce četla jen `window.jQuery` a spol. U bundlované aplikace
 * (Vite, webpack, ESM) nevrátila nic — takže „SBOM" moderního webu byl prázdný
 * seznam.
 */

describe('fingerprintScript — verzní bannery', () => {
  it('najde jQuery podle banneru', () => {
    const bundle = '/*! jQuery v3.6.0 | (c) OpenJS Foundation | jquery.org/license */\n!function(e,t){}();';
    const [hit] = fingerprintScript(bundle).filter((f) => f.name === 'jQuery');
    expect(hit.version).toBe('3.6.0');
    expect(hit.npm).toBe('jquery');
    expect(hit.confidence).toBe('version-detected');
  });

  it('najde Bootstrap podle banneru', () => {
    const bundle = '/*! Bootstrap v5.3.2 (https://getbootstrap.com/) */';
    const [hit] = fingerprintScript(bundle).filter((f) => f.name === 'Bootstrap');
    expect(hit.version).toBe('5.3.2');
  });

  it('najde Vue podle banneru', () => {
    const bundle = '/*!\n * Vue.js v2.7.14\n * (c) 2014-2022 Evan You\n */';
    const [hit] = fingerprintScript(bundle).filter((f) => f.name === 'Vue.js');
    expect(hit.version).toBe('2.7.14');
  });

  it('uloží úryvek jako důkaz', () => {
    const [hit] = fingerprintScript('/*! jQuery v3.6.0 */').filter((f) => f.name === 'jQuery');
    expect(hit.evidence).toContain('3.6.0');
    expect(hit.evidence.length).toBeLessThanOrEqual(120);
  });
});

describe('fingerprintScript — detekce bez verze', () => {
  it('React v produkčním bundlu se pozná podle chybové hlášky', () => {
    // Přesně ten případ, na kterém původní skener selhával: minifikovaný
    // Vite bundle bez jediného globálu.
    const bundle = 'function xk(e){throw Error("Minified React error #418; visit https://react.dev/errors/418")}';
    const [hit] = fingerprintScript(bundle).filter((f) => f.name === 'React');
    expect(hit).toBeDefined();
    expect(hit.version).toBeNull();
    expect(hit.confidence).toBe('presence-only');
  });

  it('detekce bez verze se NEtváří jako detekce s verzí', () => {
    // Kdyby se to sloučilo, knihovna bez verze by prošla do OSV s prázdným
    // řetězcem a vrátila „žádné CVE" — falešný PASS.
    const findings = fingerprintScript('Minified React error #1');
    for (const f of findings) {
      if (f.version === null) expect(f.confidence).toBe('presence-only');
      else expect(f.confidence).toBe('version-detected');
    }
  });
});

describe('fingerprintScript — falešné poplachy', () => {
  it('prázdný nebo neřetězcový vstup nic nenajde', () => {
    expect(fingerprintScript('')).toEqual([]);
    expect(fingerprintScript(null)).toEqual([]);
    expect(fingerprintScript(undefined)).toEqual([]);
    expect(fingerprintScript(12345)).toEqual([]);
  });

  it('webpack runtime se nehlásí jako Bootstrap', () => {
    // „bootstrap" je běžné slovo ve webpack runtime i v komentářích.
    // Fantomová položka v SBOM není neškodná: nedohledá se k ní verze,
    // spadne mezi neověřené a shodí celý výsledek na neprůkazný.
    const runtime = `
      // webpack/runtime/jsonp chunk loading
      __webpack_require__.O = 0; // startup / bootstrap phase
      function bootstrap(modules) { return __webpack_require__(0); }
    `;
    expect(fingerprintScript(runtime).map((f) => f.name)).not.toContain('Bootstrap');
  });

  it('zmínka o knihovně v komentáři není důkaz její přítomnosti', () => {
    const comments = `
      // TODO: nahradit axios za fetch
      /* dřív jsme používali moment, teď date-fns */
      const note = "react-dom bylo odstraněno";
    `;
    const names = fingerprintScript(comments).map((f) => f.name);
    expect(names).not.toContain('Axios');
    expect(names).not.toContain('React DOM');
  });

  it('deklarovaný semver rozsah se nevydává za nasazenou verzi', () => {
    // `"react": "^18.2.0"` v package.json je ROZSAH — reálně nasazená bývá
    // 18.3.1. Dotaz do OSV na 18.2.0 by mohl vyrobit FAIL na CVE, které je
    // v nasazené verzi opravené.
    const pkg = '{"dependencies":{"react":"^18.2.0","react-dom":"~18.2.0","next":"^14.1.0"}}';
    for (const f of fingerprintScript(pkg)) {
      expect(f.version).toBeNull();
    }
  });

  it('verze Underscore z lodash banneru se nevydává za verzi lodashe', () => {
    // Oficiální lodash.min.js má v hlavičce:
    //   "Lodash lodash.com/license | Underscore.js 1.8.3 underscorejs.org/LICENSE"
    // To 1.8.3 je verze UNDERSCORE. Volný vzor z toho udělal dotaz do OSV na
    // lodash@1.8.3 a vrátil „FAIL: okamžitě aktualizujte" u aktuální 4.17.x.
    const banner = [
      '/**', ' * @license', ' * Lodash lodash.com/license |',
      ' * Underscore.js 1.8.3 underscorejs.org/LICENSE', ' */',
    ].join('\n');
    const hit = fingerprintScript(banner).find((f) => f.name === 'Lodash');
    expect(hit?.version ?? null).toBeNull();
  });

  it('skutečnou verzi lodashe ale najde dál', () => {
    const real = 'var VERSION="4.17.21";function lodash(value){}';
    expect(fingerprintScript(real).find((f) => f.name === 'Lodash')?.version).toBe('4.17.21');
  });

  it('D3 se pozná i v minifikovaném bundlu', () => {
    // Původní vzory (`d3.select`, `d3-selection`) nesedly ani na
    // neminifikovaný d3.js — signatura byla mrtvá.
    const bundle = 'var version="7.9.0";function scaleLinear(){}function scaleOrdinal(){}';
    const hit = fingerprintScript(bundle).find((f) => f.name === 'D3');
    expect(hit).toBeDefined();
    expect(hit.version).toBe('7.9.0');
  });

  it('běžný aplikační kód nevypadá jako knihovna', () => {
    const app = `
      export function calculateTotal(items) {
        return items.reduce((sum, item) => sum + item.price, 0);
      }
      const config = { apiUrl: '/api/v1', retries: 3 };
    `;
    expect(fingerprintScript(app)).toEqual([]);
  });

  it('respektuje limit prohledávaného obsahu', () => {
    // Banner až za limitem se nesmí najít — jinak by limit nic neomezoval.
    const padding = 'x'.repeat(MAX_SCAN_BYTES + 100);
    expect(fingerprintScript(padding + '/*! jQuery v3.6.0 */')).toEqual([]);
    expect(fingerprintScript('/*! jQuery v3.6.0 */' + padding).length).toBeGreaterThan(0);
  });

  it('každá signatura má název balíčku pro dotaz do OSV', () => {
    for (const sig of LIBRARY_SIGNATURES) {
      expect(typeof sig.npm).toBe('string');
      expect(sig.npm.length).toBeGreaterThan(0);
    }
  });

  it('každý verzní vzor má zachytávající skupinu', () => {
    // Bez ní je `match[1]` undefined a verze tiše zmizí — knihovna pak
    // spadne mezi neověřené, přestože její verze v bundlu byla.
    // Tenhle test odhalil právě takový vzor u Next.js.
    const capturing = (source) => /(?<!\\)\((?!\?[:=!<])/.test(source);
    for (const sig of LIBRARY_SIGNATURES) {
      for (const pattern of sig.version || []) {
        expect(`${sig.name}: ${capturing(pattern.source)}`).toBe(`${sig.name}: true`);
      }
    }
  });
});

describe('packagesFromSourceMap', () => {
  it('vytáhne balíčky z cest do node_modules', () => {
    const map = {
      sources: [
        '../node_modules/react-dom/client.js',
        '../node_modules/lodash/isEqual.js',
        'src/App.jsx',
      ],
    };
    expect(packagesFromSourceMap(map).map((p) => p.npm).sort())
      .toEqual(['lodash', 'react-dom']);
  });

  it('rozumí scoped balíčkům', () => {
    const map = { sources: ['./node_modules/@angular/core/fesm2022/core.mjs'] };
    expect(packagesFromSourceMap(map)[0].npm).toBe('@angular/core');
  });

  it('zvládne webpack:// prefix a vnořené node_modules', () => {
    const map = {
      sources: ['webpack://app/./node_modules/foo/node_modules/bar/index.js'],
    };
    // Bere se poslední node_modules — skutečně načtený balíček.
    expect(packagesFromSourceMap(map)[0].npm).toBe('bar');
  });

  it('ignoruje vlastní kód aplikace', () => {
    const map = { sources: ['src/main.js', 'webpack://app/./src/utils.js'] };
    expect(packagesFromSourceMap(map)).toEqual([]);
  });

  it('odfiltruje technické adresáře', () => {
    const map = { sources: ['./node_modules/.vite/deps/react.js', './node_modules/.pnpm/x/index.js'] };
    expect(packagesFromSourceMap(map)).toEqual([]);
  });

  it('nespadne na rozbitém vstupu', () => {
    expect(packagesFromSourceMap('{nevalidní json')).toEqual([]);
    expect(packagesFromSourceMap(null)).toEqual([]);
    expect(packagesFromSourceMap({})).toEqual([]);
    expect(packagesFromSourceMap({ sources: [null, 42, {}] })).toEqual([]);
  });

  it('přijme mapu i jako JSON řetězec', () => {
    const json = JSON.stringify({ sources: ['../node_modules/axios/index.js'] });
    expect(packagesFromSourceMap(json)[0].npm).toBe('axios');
  });

  it('stejný balíček uvede jen jednou', () => {
    const map = {
      sources: ['./node_modules/lodash/a.js', './node_modules/lodash/b.js', './node_modules/lodash/c.js'],
    };
    expect(packagesFromSourceMap(map)).toHaveLength(1);
  });
});

describe('mergeFindings', () => {
  it('spojí nález z více zdrojů do jedné položky', () => {
    const { libraries } = mergeFindings([
      { source: 'runtime-global', findings: [{ name: 'React', npm: 'react', version: null, confidence: 'presence-only' }] },
      { source: 'source-map', findings: [{ name: 'react', npm: 'react', version: null, confidence: 'presence-only' }] },
    ]);
    expect(libraries).toHaveLength(1);
    expect(libraries[0].sources).toEqual(['runtime-global', 'source-map']);
  });

  it('konkrétní verze přebije pouhou přítomnost', () => {
    const { libraries } = mergeFindings([
      { source: 'source-map', findings: [{ name: 'jQuery', npm: 'jquery', version: null, confidence: 'presence-only' }] },
      { source: 'bundle-fingerprint', findings: [{ name: 'jQuery', npm: 'jquery', version: '3.6.0', confidence: 'version-detected' }] },
    ]);
    expect(libraries[0].version).toBe('3.6.0');
    expect(libraries[0].confidence).toBe('version-detected');
  });

  it('při rozporu nabídne k ověření OBĚ verze', () => {
    // Stránka může načítat dvě kopie téže knihovny. Zeptat se OSV jen na
    // první znamenalo, že zranitelná druhá projde bez kontroly.
    const { libraries } = mergeFindings([
      { source: 'runtime-global', findings: [{ name: 'jQuery', npm: 'jquery', version: '3.7.1', confidence: 'version-detected' }] },
      { source: 'bundle-fingerprint', findings: [{ name: 'jQuery', npm: 'jquery', version: '3.4.0', confidence: 'version-detected' }] },
    ]);
    expect(libraries[0].alternateVersions).toEqual(['3.4.0']);

    // Přesně to, co dělá auditCRAVulnerabilities.
    const queue = libraries.flatMap((lib) => [
      lib, ...(lib.alternateVersions || []).map((version) => ({ ...lib, version })),
    ]);
    expect(queue.map((q) => q.version)).toEqual(['3.7.1', '3.4.0']);
  });

  it('rozpor mezi verzemi zaznamená, místo aby si tiše vybral', () => {
    const { libraries, conflicts } = mergeFindings([
      { source: 'runtime-global', findings: [{ name: 'jQuery', npm: 'jquery', version: '3.6.0', confidence: 'version-detected' }] },
      { source: 'bundle-fingerprint', findings: [{ name: 'jQuery', npm: 'jquery', version: '1.12.4', confidence: 'version-detected' }] },
    ]);
    expect(libraries).toHaveLength(1);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].versions).toEqual(['3.6.0', '1.12.4']);
  });

  it('prázdný vstup dá prázdný SBOM, ne výjimku', () => {
    expect(mergeFindings([])).toEqual({ libraries: [], conflicts: [] });
    expect(mergeFindings([{ source: 'x', findings: null }]).libraries).toEqual([]);
  });

  it('rozlišuje knihovny podle npm názvu, ne podle zobrazovaného jména', () => {
    const { libraries } = mergeFindings([
      { source: 'a', findings: [{ name: 'React', npm: 'react', version: '18.2.0' }] },
      { source: 'b', findings: [{ name: 'React DOM', npm: 'react-dom', version: '18.2.0' }] },
    ]);
    expect(libraries).toHaveLength(2);
  });
});

describe('collectBundleEvidence', () => {
  const script = (url, body) => ({ url: () => url, text: async () => body });

  it('prohledá všechny skripty a sloučí nálezy', async () => {
    const { findings } = await collectBundleEvidence([
      script('https://a.cz/1.js', '/*! jQuery v3.6.0 */'),
      script('https://a.cz/2.js', '/*! Bootstrap v5.3.2 */'),
    ], {});
    expect(findings.map((f) => f.name).sort()).toEqual(['Bootstrap', 'jQuery']);
  });

  it('nečitelný skript zaznamená, místo aby ho přeskočil potichu', async () => {
    // Prázdný SBOM z nečitelných skriptů nesmí vypadat jako "nic tam není".
    const broken = { url: () => 'https://a.cz/x.js', text: async () => { throw new Error('body unavailable'); } };
    const { findings, unreadable } = await collectBundleEvidence([broken], {});
    expect(findings).toEqual([]);
    expect(unreadable).toEqual([{ url: 'https://a.cz/x.js', reason: 'body unavailable' }]);
  });

  it('dotáhne source mapu a vytáhne z ní balíčky', async () => {
    const fetched = [];
    const { sourceMapPackages } = await collectBundleEvidence([
      script('https://a.cz/app.js', 'const x=1;\n//# sourceMappingURL=app.js.map'),
    ], {
      fetchMap: async (url) => {
        fetched.push(url);
        return { ok: true, text: async () => JSON.stringify({ sources: ['../node_modules/lodash/isEqual.js'] }) };
      },
    });
    expect(fetched).toEqual(['https://a.cz/app.js.map']);
    expect(sourceMapPackages.map((p) => p.npm)).toEqual(['lodash']);
  });

  it('nestahuje mapu z cizího původu', async () => {
    // Jinak by šlo přes sourceMappingURL donutit skener sáhnout kamkoli.
    const fetchMap = jest.fn();
    await collectBundleEvidence([
      script('https://a.cz/app.js', '//# sourceMappingURL=https://zlo.example/mapa.json'),
    ], { fetchMap });
    expect(fetchMap).not.toHaveBeenCalled();
  });

  it('respektuje SSRF pojistku', async () => {
    const fetchMap = jest.fn();
    const assertUrlAllowed = jest.fn(() => { throw new Error('privátní adresa'); });
    await collectBundleEvidence([
      script('http://127.0.0.1/app.js', '//# sourceMappingURL=app.js.map'),
    ], { fetchMap, assertUrlAllowed });
    expect(assertUrlAllowed).toHaveBeenCalled();
    expect(fetchMap).not.toHaveBeenCalled();
  });

  it('respektuje i ASYNCHRONNÍ SSRF pojistku', async () => {
    // Regrese: guard `assertPublicHttpUrl` je async, ale volal se bez `await`.
    // Odmítnutá Promise pak neprošla přes catch, fetch se provedl i na
    // zakázanou adresu a odmítnutí skončilo jako unhandledRejection — což
    // tenhle server ukončuje. Původní test to nechytil, protože mockoval
    // guard synchronně.
    const fetchMap = jest.fn();
    const assertUrlAllowed = jest.fn(async () => { throw new Error('privátní adresa'); });

    const rejections = [];
    const onRejection = (err) => rejections.push(err);
    process.on('unhandledRejection', onRejection);
    try {
      await collectBundleEvidence([
        script('http://a.cz/app.js', '//# sourceMappingURL=app.js.map'),
      ], { fetchMap, assertUrlAllowed });
      // Nechat proběhnout mikroúlohy, aby se případné odmítnutí projevilo.
      await new Promise((r) => setImmediate(r));
    } finally {
      process.off('unhandledRejection', onRejection);
    }

    expect(assertUrlAllowed).toHaveBeenCalled();
    expect(fetchMap).not.toHaveBeenCalled();
    expect(rejections).toEqual([]);
  });

  it('nestahuje mapu větší než limit', async () => {
    // Mapu poskytuje cizí strana. Bez stropu stačí posílat data donekonečna.
    const huge = 'x'.repeat(1024);
    const fetchMap = async () => ({
      ok: true,
      headers: { get: (h) => (h === 'content-length' ? String(MAX_SOURCE_MAP_BYTES + 1) : null) },
      body: { cancel: async () => {} },
      text: async () => huge,
    });
    const { sourceMapPackages } = await collectBundleEvidence([
      script('https://a.cz/app.js', '//# sourceMappingURL=app.js.map'),
    ], { fetchMap });
    expect(sourceMapPackages).toEqual([]);
  });

  it('omezí počet balíčků z jedné mapy', async () => {
    // Naměřeno: mapa s milionem `sources` nafoukla odpověď na desítky MB.
    const sources = Array.from({ length: 5000 }, (_, i) => `./node_modules/pkg${i}/index.js`);
    const fetchMap = async () => ({ ok: true, text: async () => JSON.stringify({ sources }) });
    const { sourceMapPackages } = await collectBundleEvidence([
      script('https://a.cz/app.js', '//# sourceMappingURL=app.js.map'),
    ], { fetchMap });
    expect(sourceMapPackages.length).toBeLessThanOrEqual(MAX_SOURCE_MAP_PACKAGES);
  });

  it('strop platí i pro stahovač bez streamu', async () => {
    // Fallback `response.text()` byl neomezený. V produkci se nepoužije
    // (nativní fetch má vždy stream), ale při výměně stahovače by se strop
    // tiše ztratil.
    const fetchMap = async () => ({
      ok: true,
      text: async () => 'x'.repeat(MAX_SOURCE_MAP_BYTES + 10),
    });
    const { sourceMapPackages } = await collectBundleEvidence([
      script('https://a.cz/app.js', '//# sourceMappingURL=app.js.map'),
    ], { fetchMap });
    expect(sourceMapPackages).toEqual([]);
  });

  it('inline data: mapu nestahuje', async () => {
    const fetchMap = jest.fn();
    await collectBundleEvidence([
      script('https://a.cz/app.js', '//# sourceMappingURL=data:application/json;base64,e30='),
    ], { fetchMap });
    expect(fetchMap).not.toHaveBeenCalled();
  });

  it('nedostupná mapa neshodí celý audit', async () => {
    const { findings, sourceMapPackages } = await collectBundleEvidence([
      script('https://a.cz/app.js', '/*! jQuery v3.6.0 */\n//# sourceMappingURL=app.js.map'),
    ], { fetchMap: async () => { throw new Error('404'); } });
    expect(sourceMapPackages).toEqual([]);
    // Fingerprinting proběhl i tak.
    expect(findings.map((f) => f.name)).toContain('jQuery');
  });

  it('bez skriptů vrátí prázdný, ale platný výsledek', async () => {
    expect(await collectBundleEvidence([], {}))
      .toEqual({ findings: [], sourceMapPackages: [], unreadable: [] });
  });
});

describe('Realistický bundle', () => {
  it('najde v jednom souboru víc knihoven', () => {
    const bundle = [
      '/*! jQuery v3.5.1 | (c) JS Foundation */',
      'var t=function(){throw Error("Minified React error #31")};',
      '/*! Bootstrap v4.6.0 (https://getbootstrap.com/) */',
    ].join('\n');

    const names = fingerprintScript(bundle).map((f) => f.name);
    expect(names).toContain('jQuery');
    expect(names).toContain('React');
    expect(names).toContain('Bootstrap');
  });

  it('jQuery 3.5.1 se dá poslat do OSV, React bez verze ne', () => {
    // Tohle je hranice, kterou nástroj musí umět přiznat: co má verzi, jde
    // ověřit; co ji nemá, musí skončit jako neověřené.
    const bundle = '/*! jQuery v3.5.1 */\nthrow Error("Minified React error #31");';
    const findings = fingerprintScript(bundle);
    const jq = findings.find((f) => f.name === 'jQuery');
    const react = findings.find((f) => f.name === 'React');

    expect(jq.version).toBe('3.5.1');
    expect(react.version).toBeNull();
  });
});
