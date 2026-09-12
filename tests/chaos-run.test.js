import {
  INJEKTAZ,
  rozhodniInjektaz,
  vytvorChaosHandler,
  vyhodnotChaos,
} from '../chaos-run.js';

/**
 * Chaos test — dvě ověřené vady, oba P0.
 *
 *   1. Obslužná rutina volala `route.continue()`, což požadavek odešle HNED.
 *      Hlídač proti SSRF je registrovaný na úrovni KONTEXTU a rutiny na
 *      úrovni STRÁNKY mají v Playwrightu přednost, takže se na požadavek
 *      nedostal. Chaos test běžel bez ochrany proti SSRF.
 *   2. Verdikt nekoukal na stavový kód. Server vracející 503 dal stejnou
 *      chybu v baseline i v hlavním běhu, rozdíl byl nulový a chybová
 *      stránka dostala „Aplikace přežila N injektovaných poruch bez pádu".
 */

const PARAMETRY = {
  abortProbability: 0.1,
  delayProbability: 0.2,
  delayMs: 3000,
  resourceTypes: ['script', 'fetch', 'xhr', 'image'],
  maxInjections: 500,
};

const novyStav = () => ({
  abortedRequests: 0,
  delayedRequests: 0,
  injections: [],
  abortedUrls: new Set(),
});

const fakeRoute = (url, resourceType = 'script') => {
  const volani = [];
  return {
    volani,
    request: () => ({ url: () => url, resourceType: () => resourceType }),
    abort: async (d) => { volani.push(['abort', d]); },
    continue: async () => { volani.push(['continue']); },
    fallback: async () => { volani.push(['fallback']); },
  };
};

describe('rozhodniInjektaz', () => {
  it('pod prahem zahodí, nad ním zdrží, dál pustí', () => {
    expect(rozhodniInjektaz(0.05, 'script', PARAMETRY)).toBe(INJEKTAZ.ZAHODIT);
    expect(rozhodniInjektaz(0.15, 'script', PARAMETRY)).toBe(INJEKTAZ.ZDRZET);
    expect(rozhodniInjektaz(0.5, 'script', PARAMETRY)).toBe(INJEKTAZ.PUSTIT);
  });

  it('hranice zahození patří té přísnější větvi', () => {
    // Přesně na `abortProbability` se ještě nezahazuje — hranice je
    // zapsaná jako `roll < abortProbability`. Tuhle hodnotu lze porovnat
    // přesně, protože se nic nesčítá.
    expect(rozhodniInjektaz(0.1, 'script', PARAMETRY)).toBe(INJEKTAZ.ZDRZET);
    expect(rozhodniInjektaz(0.0999, 'script', PARAMETRY)).toBe(INJEKTAZ.ZAHODIT);

    // Horní hranici zdržení NETESTUJEME na přesnou hodnotu: je to součet
    // dvou desetinných čísel (0.1 + 0.2 === 0.30000000000000004), takže
    // tvrdit, kam patří právě 0.3, by znamenalo tvrdit přesnost, kterou
    // dvojková plovoucí čárka nemá. Na výsledku experimentu to nic nemění
    // — `rollFor` vrací hash, pravděpodobnost zásahu hranice je nulová.
    expect(rozhodniInjektaz(0.2999, 'script', PARAMETRY)).toBe(INJEKTAZ.ZDRZET);
    expect(rozhodniInjektaz(0.3001, 'script', PARAMETRY)).toBe(INJEKTAZ.PUSTIT);
  });

  it('typ mimo seznam se neinjektuje', () => {
    expect(rozhodniInjektaz(0.01, 'document', PARAMETRY)).toBe(INJEKTAZ.PUSTIT);
    expect(rozhodniInjektaz(0.01, 'stylesheet', PARAMETRY)).toBe(INJEKTAZ.PUSTIT);
  });

  it('nečíselný roll neinjektuje — nevím není porucha', () => {
    expect(rozhodniInjektaz(NaN, 'script', PARAMETRY)).toBe(INJEKTAZ.PUSTIT);
    expect(rozhodniInjektaz(undefined, 'script', PARAMETRY)).toBe(INJEKTAZ.PUSTIT);
  });
});

describe('vytvorChaosHandler', () => {
  const handler = (stav, roll) => vytvorChaosHandler({
    rollFor: () => roll,
    parametry: PARAMETRY,
    stav,
    pauza: async () => {},
  });

  it('propuštěný požadavek jde přes fallback, NIKDY přes continue', async () => {
    // Tohle je ten P0. `continue()` požadavek odešle hned a hlídač proti
    // SSRF na úrovni kontextu se na něj nedostane.
    const stav = novyStav();
    const route = fakeRoute('https://klient.cz/app.js');
    await handler(stav, 0.9)(route);

    expect(route.volani).toEqual([['fallback']]);
    expect(route.volani.some(([co]) => co === 'continue')).toBe(false);
  });

  it('zdržený požadavek jde po pauze taky přes fallback', async () => {
    const stav = novyStav();
    const route = fakeRoute('https://klient.cz/api/data');
    await handler(stav, 0.15)(route);

    expect(route.volani).toEqual([['fallback']]);
    expect(stav.delayedRequests).toBe(1);
  });

  it('typ mimo seznam taky přes fallback, ne continue', async () => {
    const stav = novyStav();
    const route = fakeRoute('https://klient.cz/', 'document');
    await handler(stav, 0.01)(route);

    expect(route.volani).toEqual([['fallback']]);
  });

  it('zahozený požadavek se zaznamená i s URL', async () => {
    const stav = novyStav();
    const route = fakeRoute('https://klient.cz/track.js');
    await handler(stav, 0.01)(route);

    expect(route.volani).toEqual([['abort', 'failed']]);
    expect(stav.abortedRequests).toBe(1);
    expect(stav.abortedUrls.has('https://klient.cz/track.js')).toBe(true);
    expect(stav.injections).toEqual([
      { type: 'abort', resourceType: 'script', url: 'https://klient.cz/track.js' },
    ]);
  });

  it('strop na záznam injektáží platí, počty rostou dál', async () => {
    // Stránka může vystřelit statisíce požadavků. Záznam má strop, ale
    // POČET ne — jinak by report tvrdil menší injektáž, než proběhla.
    const stav = novyStav();
    const h = vytvorChaosHandler({
      rollFor: () => 0.01,
      parametry: { ...PARAMETRY, maxInjections: 2 },
      stav,
      pauza: async () => {},
    });
    for (let i = 0; i < 5; i++) await h(fakeRoute(`https://klient.cz/${i}.js`));

    expect(stav.injections).toHaveLength(2);
    expect(stav.abortedRequests).toBe(5);
  });

  it('zavřená stránka handler nepoloží', async () => {
    // `fallback()` na zavřené stránce vyhodí. Výjimka odtud by skončila
    // jako unhandled rejection v obslužné rutině Playwrightu.
    const stav = novyStav();
    const route = {
      request: () => ({ url: () => 'https://klient.cz/x.js', resourceType: () => 'script' }),
      abort: async () => { throw new Error('Target closed'); },
      fallback: async () => { throw new Error('Target closed'); },
      continue: async () => { throw new Error('Target closed'); },
    };

    await expect(handler(stav, 0.9)(route)).resolves.toBeUndefined();
    await expect(handler(stav, 0.01)(route)).resolves.toBeUndefined();
  });
});

describe('vyhodnotChaos', () => {
  const zaklad = {
    baselineCompleted: true,
    baselineNavigationFailed: false,
    httpProblem: null,
    injected: 5,
    newCrash: false,
    newNavigationFailure: false,
    newConsoleErrors: 0,
    browserNetworkErrors: 2,
  };

  it('chybová stránka NENÍ odolná aplikace', () => {
    // Ověřená vada: 503 v baseline i v hlavním běhu dal nulový rozdíl
    // a verdikt „Aplikace přežila 5 injektovaných poruch bez pádu".
    const v = vyhodnotChaos({
      ...zaklad,
      httpProblem: 'Server odpověděl 503. (v baseline i v hlavním běhu)',
    });

    expect(v.isResilient).toBe(null);
    expect(v.rating).toMatch(/NEPRŮKAZNÉ/);
    expect(v.rating).toMatch(/503/);
    expect(v.rating).not.toMatch(/přežila/);
  });

  it('chybová stránka bez podzdrojů se neschová za „neinjektovalo se nic"', () => {
    // Chybová stránka často nemá žádné podzdroje, takže `injected === 0`.
    // Kdyby se stav serveru vyhodnocoval později, report by uváděl
    // nepravdivý důvod neprůkaznosti.
    const v = vyhodnotChaos({
      ...zaklad,
      injected: 0,
      httpProblem: 'Server odpověděl 404.',
    });

    expect(v.rating).toMatch(/404/);
    expect(v.rating).not.toMatch(/žádná porucha se neinjektovala/);
  });

  it('neproběhlá baseline je neprůkazná', () => {
    expect(vyhodnotChaos({ ...zaklad, baselineCompleted: false }).isResilient).toBe(null);
  });

  it('stránka nedostupná i bez injektáže je neprůkazná', () => {
    const v = vyhodnotChaos({ ...zaklad, baselineNavigationFailed: true });
    expect(v.isResilient).toBe(null);
    expect(v.rating).toMatch(/problém není v odolnosti/);
  });

  it('bez injektáže se odolnost netestovala', () => {
    const v = vyhodnotChaos({ ...zaklad, injected: 0 });
    expect(v.isResilient).toBe(null);
    expect(v.rating).toMatch(/netestovala/);
  });

  it('nový pád je nález', () => {
    expect(vyhodnotChaos({ ...zaklad, newCrash: true }).isResilient).toBe(false);
    expect(vyhodnotChaos({ ...zaklad, newNavigationFailure: true }).isResilient).toBe(false);
  });

  it('nové chyby v konzoli jsou nález a počet se uvede', () => {
    const v = vyhodnotChaos({ ...zaklad, newConsoleErrors: 3 });
    expect(v.isResilient).toBe(false);
    expect(v.rating).toMatch(/3 nových chyb/);
    // Odečtené síťové hlášky prohlížeče musí být v reportu vidět.
    expect(v.rating).toMatch(/nepočítaje 2 síťových hlášek/);
  });

  it('přežití bez nových chyb je kladný výsledek experimentu', () => {
    const v = vyhodnotChaos(zaklad);
    expect(v.isResilient).toBe(true);
    expect(v.rating).toMatch(/přežila 5 injektovaných poruch/);
    // Ani tady se nesmí objevit slovo o splnění předpisu.
    expect(v.rating).not.toMatch(/splněn/i);
  });

  it('každý důvod neprůkaznosti má vlastní věty', () => {
    const duvody = [
      vyhodnotChaos({ ...zaklad, baselineCompleted: false }).rating,
      vyhodnotChaos({ ...zaklad, baselineNavigationFailed: true }).rating,
      vyhodnotChaos({ ...zaklad, httpProblem: 'Server odpověděl 503.' }).rating,
      vyhodnotChaos({ ...zaklad, injected: 0 }).rating,
    ];
    expect(new Set(duvody).size).toBe(4);
  });
});
