/**
 * Sběr přeneseného objemu pro uhlíkovou stopu.
 *
 * PROČ VLASTNÍ MODUL
 * Tahle logika byla vevnitř `auditGreenAndResidency` a testy si její
 * kopii opsaly k sobě. Kopie se testovala sama — z čehož plyne, že
 * všech pět testů kolem `sizes()` mohlo zůstat zelených i po tom, co by
 * se skutečná měřicí smyčka rozbila. Zrovna u tohohle kódu je to vážné:
 * jednou už se stalo, že měření vrátilo „změřeno 0, nezměřeno 140",
 * a report z toho vydal známku.
 *
 * Teď je to jedna funkce, kterou volá agent i test.
 *
 * @param {import('playwright').BrowserContext} context
 * @returns {{mereni: Promise[], vysledek: () => object}}
 *   `mereni` se MUSÍ dočkat (`Promise.allSettled`) před čtením výsledku.
 */
export function sberObjemu(context) {
  // Co se změřit nepodařilo, se NEPŘIČTE JAKO NULA. Původní kód
  // u nedostupného těla tiše nechal `size = 0` a výsledek se pak tiskl
  // jako změřený objem. Místo toho se takové požadavky počítají zvlášť
  // a výsledek se označí za dolní mez.
  let totalBytes = 0;
  let zmerenychPozadavku = 0;
  let nezmerenychPozadavku = 0;
  // Objem po doménách. Rozdělit ho na vlastní a cizí jde až po navigaci,
  // kdy je známá doména auditovaného webu — proto se to tady jen sbírá.
  const bajtuPodleDomen = new Map();

  // NA POSLUCHAČE SE MUSÍ POČKAT.
  //
  // Playwright vrácený Promise z posluchače zahazuje — neawaituje ho.
  // `request.sizes()` je přitom kolo do prohlížeče a zpět. Bez tohohle
  // pole by se `totalBytes` četlo dřív, než se rozdělaná měření
  // doresolvují, a co nestihlo, by se ani nezapočítalo, ani nezvýšilo
  // `nezmerenychPozadavku`. Výsledek by byl podtečený a přitom
  // označený jako ÚPLNÝ — tedy známka lepší, než jaká patří.
  // `browser.close()` ve `finally` ty Promisy navíc odstřelí.
  const mereni = [];

  // POSLUCHAČ PATŘÍ NA KONTEXT, NE NA STRÁNKU.
  //
  // Požadavky vzniklé v Service Workeru Playwright dispatchuje na
  // `ServiceWorker`, ne na `Page` (`coreBundle.js`, `reportRequestFinished`
  // volané přes `this._page?.frameManager || this._serviceWorker`).
  // `page.on` je proto na každém PWA nevidí — a protože událost vůbec
  // nedorazí, nezvýší se ani počet nezměřených a výsledek se tváří
  // jako úplný. Podrámce (iframe) `page.on` chytá, ty problém nebyly.
  context.on('requestfinished', (request) => {
    mereni.push((async () => {
      try {
        const sizes = await request.sizes();
        // MĚŘÍ SE `responseBodySize`. Nic jiného.
        //
        // První verze téhle opravy sahala po `sizes().transferSize`.
        // To pole ve veřejném API NEEXISTUJE: `types.d.ts:20627-20649`
        // slibuje čtyři pole a `transferSize` mezi nimi není. Je jen
        // v interním `_sizes()`, které jich vrací pět, a obal jedno
        // zahazuje. `!Number.isFinite(undefined)` je pravda, takže
        // KAŽDÝ požadavek padal mezi nezměřené — ostrý běh proti
        // cloudflare.com vrátil „změřeno 0, nezměřeno 140".
        //
        // Sonda `scripts/probe-sizes.mjs` to změřila na 280 požadavcích
        // ve dvou průchodech: `transferSize` bylo undefined u všech,
        // `responseBodySize` kladné u 140/140 s route ochranou.
        const prenos = sizes?.responseBodySize;

        // `responseHeadersSize` se NEPŘIČÍTÁ.
        //
        // Sonda ukázala, že při zapnutém odchytávání požadavků (a to
        // je náš případ, `guardNavigation` instaluje route na kontextu)
        // hlásí Playwright `responseHeadersSize: 0` u všech 140
        // požadavků, zatímco `responseBodySize` u dvou odpovědí
        // s `content-length` a bez komprese vyšlo nad tu hodnotu
        // (17 836 → 18 291 a 19 524 → 21 777). Režie je tedy už
        // v tom čísle započtená a přičítat hlavičky by ji zdvojilo.

        // Pozor na to, CO znamená nula a záporné číslo.
        //
        // `_sizes()` při neznámé velikosti těla nevrací −1 ani NaN —
        // sáhne po `content-length`, a když ani ten není, dosadí 0.
        // Když Chromium ohlásí `encodedDataLength === 0` (trefa do
        // cache), vyjde `encodedBodySize` záporné; sonda to zachytila
        // u 4 ze 137 požadavků v průchodu bez ochrany. Obojí znamená
        // „nevíme", ne „přeneslo se nic", a fail-closed to patří mezi
        // nezměřené.
        if (!Number.isFinite(prenos) || prenos <= 0) {
          nezmerenychPozadavku += 1;
          return;
        }
        totalBytes += prenos;
        zmerenychPozadavku += 1;
        try {
          const domena = new URL(request.url()).hostname;
          const zaznam = bajtuPodleDomen.get(domena) || { bajtu: 0, pozadavku: 0 };
          zaznam.bajtu += prenos;
          zaznam.pozadavku += 1;
          bajtuPodleDomen.set(domena, zaznam);
        } catch {
          // Adresa bez použitelného hostname (blob:, data:) — do součtu
          // patří, do rozdělení podle domén se zařadit nedá.
        }
      } catch {
        // `sizes()` vyhodí, když je kontext už zavřený.
        nezmerenychPozadavku += 1;
      }
    })());
  });

  // Selhaný požadavek se taky částečně přenesl, ale kolik, nevíme.
  // Patří sem i zrušené prefetche a požadavky odmítnuté SSRF ochranou.
  context.on('requestfailed', () => { nezmerenychPozadavku += 1; });

  return {
    mereni,
    vysledek: () => ({
      totalBytes,
      zmerenychPozadavku,
      nezmerenychPozadavku,
      bajtuPodleDomen,
    }),
  };
}
