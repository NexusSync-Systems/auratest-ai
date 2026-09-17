/**
 * Odhad uhlíkové stopy.
 *
 * PROČ TYHLE TESTY VYPADAJÍ TAKHLE
 * Opakovaná zkušenost z tohohle projektu: test napsaný proti mým vlastním
 * číslům potvrdí moji představu, ne skutečnost. U SBOM to stálo celý commit.
 *
 * Proto se tady netvrdí „funkce vrátí to, co jsem spočítal". Tvrdí se, že
 * naše odvození reprodukuje ČÍSLA, KTERÁ PUBLIKOVAL NĚKDO JINÝ: tabulku
 * hodnocení ze Sustainable Web Design. Ta tabulka vznikla nezávisle na nás
 * (percentily HTTP Archive převedené modelem v4 na gramy). Když z našeho
 * emisního faktoru vyjdou jejich gramy, odvození sedí. Kdyby ne, sedí
 * tabulka a chybu máme my.
 *
 * https://sustainablewebdesign.org/digital-carbon-ratings/
 */
import {
  INTENZITA_CELKEM_KWH_NA_GB,
  EMISNI_FAKTOR_G_NA_GB,
  UHLIKOVA_INTENZITA_G_NA_KWH,
  STUPNICE_SWD,
  hodnoceniSWD,
  odhadniEmise,
  POPIS_MODELU,
} from '../green-model.js';

describe('odvození emisního faktoru', () => {
  test('součet šesti intenzit SWDM v4 je 0.300 kWh/GB', () => {
    expect(INTENZITA_CELKEM_KWH_NA_GB).toBeCloseTo(0.300, 10);
  });

  test('emisní faktor je 148.2 gCO2e/GB', () => {
    expect(EMISNI_FAKTOR_G_NA_GB).toBeCloseTo(148.2, 6);
  });

  /**
   * Klíčový test. Tabulka SWD dává ke každé známce jak velikost stránky
   * v kB, tak gramy CO2e. My známe jen velikost — gramy si dopočítáme
   * a musí vyjít jejich.
   *
   * Tolerance 0.001 g je jejich zaokrouhlení na tři desetinná místa.
   */
  test.each(STUPNICE_SWD.filter((s) => s.gramyVTabulce !== null))(
    '$znamka: $doBajtu B → $gramyVTabulce g podle publikované tabulky',
    ({ doBajtu, gramyVTabulce }) => {
      const nase = (doBajtu / 1e9) * EMISNI_FAKTOR_G_NA_GB;
      expect(nase).toBeCloseTo(gramyVTabulce, 3);
    },
  );

  test('uhlíková intenzita je globální průměr, ne regionální hodnota', () => {
    // Kdyby se sem někdy dosadila hodnota pro konkrétní zemi, přestane
    // být srovnání mezi weby „like for like" a stupnice pozbude smysl.
    expect(UHLIKOVA_INTENZITA_G_NA_KWH).toBe(494);
  });
});

describe('stará konstanta 0.81', () => {
  /**
   * Regrese na jednotkovou chybu, kvůli které tenhle soubor vznikl.
   * `0.81` je kWh/GB z verze 3 modelu, ne gramy na megabajt.
   */
  test('nikde se nepoužívá jako gramy na megabajt', () => {
    const jedenMb = 1e6;
    const stareCislo = (jedenMb / 1e6) * 0.81; // 0.81 g — co počítal starý kód
    const { co2Grams } = odhadniEmise(jedenMb, { nezmerenychPozadavku: 0 });
    expect(co2Grams).not.toBeCloseTo(stareCislo, 2);
    expect(co2Grams).toBeCloseTo(0.148, 3);
  });

  test('1 MB je pod hranicí propadnutí — starý kód z něj dělal „F"', () => {
    // Stránka o 1 MB je lehčí než 70 % webu. Stará stupnice jí dávala
    // „C (Průměr)" a při 3 MB „F (Znečišťující)"; obojí bez zdroje.
    const { rating } = odhadniEmise(1e6, { nezmerenychPozadavku: 0 });
    expect(rating).toBe('C');
  });
});

describe('hodnoceniSWD', () => {
  test('prahy jsou horní meze včetně', () => {
    expect(hodnoceniSWD(272_510)).toBe('A+');
    expect(hodnoceniSWD(272_511)).toBe('A');
    expect(hodnoceniSWD(2_419_560)).toBe('E');
  });

  /**
   * Tohle NENÍ test proti zdroji, je to náš vlastní předpoklad.
   *
   * Tabulka udává E ≤ 2419.56 kB a F ≥ 2419.57 kB — devět bajtů mezi tím
   * nepatří ani k jedné známce. Kód je přiřazuje k F, tedy k horší
   * z obou. Je to volba, ne údaj ze zdroje, a test ji jako volbu
   * pojmenovává.
   */
  test('devítibajtová mezera mezi E a F připadá F (naše volba, ne zdroj)', () => {
    expect(hodnoceniSWD(2_419_565)).toBe('F');
  });

  /**
   * Proč se klasifikuje podle bajtů a ne podle gramů.
   *
   * Tabulka SWD u řádku F píše „≥ 2419.57 kB" a zároveň „≥ 0.360 g".
   * Jenže 2419.57 kB dává 0.3586 g. Sloupec s gramy je zaokrouhlený
   * a mezi 0.359 a 0.360 tak vzniká pásmo bez známky. Klasifikace podle
   * bajtů, což je zdrojový sloupec, tu díru nemá.
   */
  test('stránka v zaokrouhlovací díře tabulky známku dostane', () => {
    // Díra leží mezi 0.359 g (horní mez E) a 0.360 g (dolní mez F),
    // tedy 2 422 403 – 2 429 149 B. První verze tohohle testu použila
    // 2 430 000 B → 0.3601 g, což je NAD dírou a podle sloupce s gramy
    // prostě F; test procházel, aniž by ten jev předvedl. Našla to
    // kontrolní vlna.
    const vDire = 2_425_000;
    const gramy = (vDire / 1e9) * EMISNI_FAKTOR_G_NA_GB;
    expect(gramy).toBeGreaterThan(0.359);
    expect(gramy).toBeLessThan(0.360);
    expect(hodnoceniSWD(vDire)).toBe('F');
  });

  test('stupnice pokrývá celý obor — poslední mez je nekonečno', () => {
    expect(STUPNICE_SWD[STUPNICE_SWD.length - 1].doBajtu).toBe(Infinity);
    expect(hodnoceniSWD(1e12)).toBe('F');
  });

  test('nečíslo nedostane známku', () => {
    expect(hodnoceniSWD(NaN)).toBeNull();
    expect(hodnoceniSWD(-1)).toBeNull();
    expect(hodnoceniSWD(undefined)).toBeNull();
  });
});

describe('neúplné měření', () => {
  test('nezměřené požadavky → žádná známka a výsledek je dolní mez', () => {
    const v = odhadniEmise(1e6, { zmerenychPozadavku: 10, nezmerenychPozadavku: 3 });
    expect(v.measured).toBe(true);
    expect(v.uplne).toBe(false);
    expect(v.rating).toBeNull();
    expect(v.duvod).toMatch(/dolní mez/);
    expect(v.co2Grams).toBeGreaterThan(0);
  });

  test('úplné měření známku dostane a nemá výhradu', () => {
    const v = odhadniEmise(1e6, { zmerenychPozadavku: 10, nezmerenychPozadavku: 0 });
    expect(v.uplne).toBe(true);
    expect(v.rating).toBe('C');
    expect(v.duvod).toBeNull();
  });

  test('nezměřitelný objem se nevydává za nulu', () => {
    const v = odhadniEmise(null);
    expect(v.measured).toBe(false);
    expect(v.co2Grams).toBeNull();
    expect(v.totalMb).toBeNull();
    expect(v.rating).toBeNull();
  });
});

describe('scope', () => {
  test('cestuje s každým výsledkem, i s neúspěšným', () => {
    expect(odhadniEmise(1e6).scope).toBe(POPIS_MODELU);
    expect(odhadniEmise(null).scope).toBe(POPIS_MODELU);
  });

  test('výsledek je označený jako odhad a odkazuje na zdroj', () => {
    expect(POPIS_MODELU.jeOdhad).toBe(true);
    expect(POPIS_MODELU.zdroj).toMatch(/^https:\/\/sustainablewebdesign\.org\//);
    expect(POPIS_MODELU.stupniceZdroj).toMatch(/^https:\/\/sustainablewebdesign\.org\//);
  });

  test('výslovně říká, že známka není posouzení shody s předpisem', () => {
    expect(POPIS_MODELU.nepokryva.join(' ')).toMatch(/shodu s jakýmkoli předpisem/);
  });

  test('zelený hosting se nezapočítává a je to řečeno', () => {
    expect(POPIS_MODELU.predpoklady.join(' ')).toMatch(/[Zz]elený hosting/);
  });
});

describe('desítkové jednotky', () => {
  test('MB je 10⁶ bajtů, ne 2²⁰', () => {
    // Starý kód dělil 1024², takže „1 MB" v reportu bylo 1 048 576 bajtů.
    // Tabulka SWD stojí na HTTP Archive, který počítá desítkově.
    const { totalMb } = odhadniEmise(2_419_560, { nezmerenychPozadavku: 0 });
    expect(totalMb).toBeCloseTo(2.42, 2);
  });

  test('hranice propadnutí odpovídá průměrné stránce 2,42 MB', () => {
    expect(odhadniEmise(2_419_560, { nezmerenychPozadavku: 0 }).rating).toBe('E');
    expect(odhadniEmise(2_419_561, { nezmerenychPozadavku: 0 }).rating).toBe('F');
  });
});

/**
 * MĚŘICÍ CESTA.
 *
 * Kontrolní vlna našla, že 24 testů výš pokrývá jen aritmetiku — tedy to
 * nejmíň riskantní. Sčítání bajtů, čekání na `sizes()` a počítání
 * nezměřených požadavků nemělo test žádný, a přitom tam byly všechny tři
 * P0 nálezy.
 *
 * Playwright v tomhle prostředí spustit nejde (`libXdamage.so.1`), takže
 * se testuje proti napodobenině `context`, která se chová jako Playwright:
 * posluchače volá synchronně, vrácený Promise ZAHAZUJE a `sizes()`
 * resolvuje až na dalším tiku.
 */
describe('měřicí cesta', () => {
  /** Napodobenina `BrowserContext`, která zahazuje návratové hodnoty posluchačů. */
  function fakeContext() {
    const posluchaci = {};
    return {
      on(udalost, fn) { (posluchaci[udalost] ||= []).push(fn); },
      emit(udalost, arg) { for (const fn of posluchaci[udalost] || []) fn(arg); },
    };
  }

  /** Kopie měřicí logiky z `auditGreenAndResidency`. */
  function sber(context) {
    let totalBytes = 0;
    let zmerenych = 0;
    let nezmerenych = 0;
    const mereni = [];
    context.on('requestfinished', (request) => {
      mereni.push((async () => {
        try {
          const sizes = await request.sizes();
          const prenos = sizes?.responseBodySize;
          if (!Number.isFinite(prenos) || prenos <= 0) { nezmerenych += 1; return; }
          totalBytes += prenos;
          zmerenych += 1;
        } catch { nezmerenych += 1; }
      })());
    });
    context.on('requestfailed', () => { nezmerenych += 1; });
    return {
      mereni,
      vysledek: () => ({ totalBytes, zmerenych, nezmerenych }),
    };
  }

  /**
   * Napodobenina vrací PŘESNĚ ta pole, která má veřejné API
   * (`types.d.ts:20627-20649`). Kdyby tu bylo `transferSize`, test by
   * cementoval pole, které Playwright nevrací — a přesně na tom
   * ostrý běh ztroskotal: „změřeno 0 požadavků, nezměřeno 140".
   */
  const req = (responseBodySize) => ({
    sizes: async () => ({
      requestBodySize: 0,
      requestHeadersSize: 400,
      responseBodySize,
      responseHeadersSize: 0,
    }),
  });

  test('bez čekání na sizes() se součet čte podtečený', async () => {
    // Přesně ta chyba: `sizes()` je kolo do prohlížeče, posluchač je async
    // a Playwright na něj nečeká. Kdo přečte součet hned, dostane nulu —
    // a dřív ji dostal označenou jako ÚPLNÉ měření.
    const ctx = fakeContext();
    const s = sber(ctx);
    ctx.emit('requestfinished', req(1000));
    ctx.emit('requestfinished', req(2000));
    expect(s.vysledek().totalBytes).toBe(0);

    await Promise.allSettled(s.mereni);
    expect(s.vysledek()).toEqual({ totalBytes: 3000, zmerenych: 2, nezmerenych: 0 });
  });

  test('pole, které API nevrací, nesmí shodit celé měření', async () => {
    // Regrese na chybu, kvůli které ostrý běh nezměřil vůbec nic.
    // `sizes()` vrací čtyři pole; `transferSize` mezi nimi NENÍ.
    const ctx = fakeContext();
    const s = sber(ctx);
    ctx.emit('requestfinished', req(50_000));
    await Promise.allSettled(s.mereni);
    expect(s.vysledek()).toEqual({ totalBytes: 50_000, zmerenych: 1, nezmerenych: 0 });

    const klice = Object.keys(await req(1).sizes());
    expect(klice).not.toContain('transferSize');
    expect(klice).toContain('responseBodySize');
  });

  test('nulový nebo záporný responseBodySize je NEZMĚŘENO, ne nula', async () => {
    // `_sizes()` při neznámé velikosti nevrací −1 ani NaN: sáhne po
    // `content-length` a jinak dosadí 0. U trefy do cache hlásí Chromium
    // `encodedDataLength === 0`, takže `responseBodySize` vyjde záporný —
    // sonda to na ostrém webu zachytila u 4 ze 137 požadavků.
    // Obojí znamená „nevíme" a fail-closed to nesmí skončit v součtu.
    const ctx = fakeContext();
    const s = sber(ctx);
    ctx.emit('requestfinished', req(0));
    ctx.emit('requestfinished', req(-312));
    ctx.emit('requestfinished', req(5000));
    await Promise.allSettled(s.mereni);
    expect(s.vysledek()).toEqual({ totalBytes: 5000, zmerenych: 1, nezmerenych: 2 });
  });

  test('výjimka ze sizes() zvýší nezměřené, nespadne', async () => {
    const ctx = fakeContext();
    const s = sber(ctx);
    ctx.emit('requestfinished', { sizes: async () => { throw new Error('Target closed'); } });
    await Promise.allSettled(s.mereni);
    expect(s.vysledek()).toEqual({ totalBytes: 0, zmerenych: 0, nezmerenych: 1 });
  });

  test('selhaný požadavek se počítá mezi nezměřené', () => {
    const ctx = fakeContext();
    const s = sber(ctx);
    ctx.emit('requestfailed', {});
    expect(s.vysledek().nezmerenych).toBe(1);
  });

  test('neúplné měření nedostane známku ani po doměření', async () => {
    const ctx = fakeContext();
    const s = sber(ctx);
    ctx.emit('requestfinished', req(500_000));
    ctx.emit('requestfinished', req(0));
    await Promise.allSettled(s.mereni);
    const { totalBytes, zmerenych, nezmerenych } = s.vysledek();
    const v = odhadniEmise(totalBytes, {
      zmerenychPozadavku: zmerenych, nezmerenychPozadavku: nezmerenych,
    });
    expect(v.rating).toBeNull();
    expect(v.uplne).toBe(false);
  });

  test('žádný ohlášený požadavek → neprůkazné, ne „A+"', () => {
    // Reprodukce nálezu kontrolní vlny: `uplne` se počítalo jen z počtu
    // nezměřených, takže nula změřených prošla jako úplné měření
    // nejlehčí možné stránky a dostala nejlepší známku stupnice.
    const v = odhadniEmise(0, { zmerenychPozadavku: 0, nezmerenychPozadavku: 0 });
    expect(v.measured).toBe(false);
    expect(v.rating).toBeNull();
    expect(v.co2Grams).toBeNull();
    expect(v.duvod).toMatch(/ani jeden dokončený požadavek/);
  });
});
