/**
 * Rozhodování chaos testu — injektáž a verdikt.
 *
 * PROČ JE TO VE VLASTNÍM MODULU
 * Obojí bylo zapletené do `runChaosTest`, tedy do funkce, která potřebuje
 * Chromium. Nešlo to testovat a byly v tom dva P0:
 *
 *   1. Obslužná rutina volala `route.continue()`. Ta požadavek odešle HNED
 *      a obslužná rutina na úrovni kontextu — `guardNavigation` s ochranou
 *      proti SSRF — se na něj vůbec nedostane, protože rutiny na úrovni
 *      STRÁNKY mají v Playwrightu přednost. Chaos test tedy běžel bez
 *      hlídače: auditovaný web stačilo přesměrovat na vnitřní adresu
 *      a obsah se vrátil do reportu.
 *   2. Verdikt nekoukal na stavový kód. `page.goto()` na server, který
 *      vrací 503, navigaci za selhanou nepovažuje, baseline dostal tentýž
 *      503, rozdíl byl nulový — a chybová stránka dostala „Aplikace
 *      přežila N injektovaných poruch bez pádu".
 */

/** Co se má s požadavkem stát. */
export const INJEKTAZ = {
  ZAHODIT: 'abort',
  ZDRZET: 'delay',
  PUSTIT: 'pass',
};

/**
 * Rozhodnutí o jednom požadavku.
 *
 * `roll` je číslo z <0,1) odvozené z hashe SEED + URL, ne ze sekvence —
 * pořadí požadavků prohlížeč mezi běhy nedodrží.
 */
export function rozhodniInjektaz(roll, resourceType, parametry) {
  const { abortProbability, delayProbability, resourceTypes } = parametry;
  if (!resourceTypes.includes(resourceType)) return INJEKTAZ.PUSTIT;
  if (!Number.isFinite(roll)) return INJEKTAZ.PUSTIT;
  if (roll < abortProbability) return INJEKTAZ.ZAHODIT;
  if (roll < abortProbability + delayProbability) return INJEKTAZ.ZDRZET;
  return INJEKTAZ.PUSTIT;
}

/**
 * Obslužná rutina pro `page.route`.
 *
 * NIKDY nevolá `route.continue()`. Požadavek, který nezahazujeme, se
 * vypouští přes `route.fallback()`, aby se na něj dostal hlídač proti
 * SSRF registrovaný na úrovni kontextu.
 */
export function vytvorChaosHandler({ rollFor, parametry, stav, pauza }) {
  const cekej = pauza || ((ms) => new Promise((r) => setTimeout(r, ms)));

  return async (route) => {
    const request = route.request();
    const resourceType = request.resourceType();
    const requestUrl = request.url();

    const co = rozhodniInjektaz(rollFor(requestUrl), resourceType, parametry);

    if (co === INJEKTAZ.ZAHODIT) {
      stav.abortedRequests++;
      stav.abortedUrls.add(requestUrl);
      if (stav.injections.length < parametry.maxInjections) {
        stav.injections.push({ type: 'abort', resourceType, url: requestUrl });
      }
      return route.abort('failed').catch(() => {});
    }

    if (co === INJEKTAZ.ZDRZET) {
      stav.delayedRequests++;
      if (stav.injections.length < parametry.maxInjections) {
        stav.injections.push({ type: 'delay', resourceType, url: requestUrl, ms: parametry.delayMs });
      }
      await cekej(parametry.delayMs);
      // `fallback()`, ne `continue()` — stránka se mezitím mohla zavřít.
      return route.fallback().catch(() => {});
    }

    return route.fallback().catch(() => {});
  };
}

/**
 * Verdikt odolnostního experimentu.
 *
 * Pořadí podmínek je součást věci: každý důvod neprůkaznosti musí být
 * vyloučen PŘED tím, než se z rozdílu proti baseline odvodí závěr.
 *
 * @returns {{isResilient: boolean|null, rating: string}}
 */
export function vyhodnotChaos({
  baselineCompleted,
  baselineNavigationFailed,
  httpProblem,
  injected,
  newCrash,
  newNavigationFailure,
  newConsoleErrors,
  browserNetworkErrors,
}) {
  if (!baselineCompleted) {
    return {
      isResilient: null,
      rating: 'NEPRŮKAZNÉ: baseline běh bez injektáže se nepodařilo provést, takže není proti čemu porovnávat.',
    };
  }

  if (baselineNavigationFailed) {
    return {
      isResilient: null,
      rating: 'NEPRŮKAZNÉ: stránka se nenačetla ani bez injektáže — problém není v odolnosti.',
    };
  }

  // Chybová stránka není měřená aplikace. Musí se vyloučit DŘÍV než
  // `injected === 0`: chybová stránka často nemá žádné podzdroje, takže by
  // se schovala za „neinjektovala se žádná porucha" a důvod v reportu by
  // byl nepravdivý.
  if (httpProblem) {
    return {
      isResilient: null,
      rating: `NEPRŮKAZNÉ: server nevrátil použitelnou stránku. ${httpProblem}`,
    };
  }

  if (injected === 0) {
    return {
      isResilient: null,
      rating: 'NEPRŮKAZNÉ: žádná porucha se neinjektovala, odolnost se netestovala.',
    };
  }

  if (newCrash || newNavigationFailure) {
    return {
      isResilient: false,
      rating: `Aplikace se pod ${injected} injektovanými poruchami rozpadla (oproti baseline běhu bez injektáže).`,
    };
  }

  if (newConsoleErrors > 0) {
    return {
      isResilient: false,
      rating: `Injektáž ${injected} poruch vyvolala ${newConsoleErrors} nových chyb v konzoli oproti baseline (nepočítaje ${browserNetworkErrors} síťových hlášek prohlížeče). Aplikace výpadky neošetřuje.`,
    };
  }

  return {
    isResilient: true,
    rating: `Aplikace přežila ${injected} injektovaných poruch bez pádu a bez nových chyb oproti baseline. Síťové hlášky prohlížeče (${browserNetworkErrors}) se nezapočítávají — aplikace je zjevně ošetřila.`,
  };
}
