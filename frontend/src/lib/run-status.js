/**
 * Stav ukazatele v hlavičce.
 *
 * PROČ TO NENÍ JEN `isRunning`
 * Ukazatel četl jediný lokální příznak, který se nastavuje při spuštění
 * agentního testu. Vznikly tím dvě nepravdy:
 *
 *   1. Během compliance skenů svítilo „Připraven". Osm prohlížečů drtilo
 *      server a hlavička tvrdila, že se nic neděje.
 *   2. Po obnovení stránky se příznak vynuloval. Běh přitom pokračoval na
 *      serveru — uživatel viděl „Připraven", spustil další a narazil na
 *      vyčerpané sloty.
 *
 * Stav se proto skládá ze tří zdrojů: z toho, co spustil tenhle panel
 * (přežije jen do reloadu), a z běhů, které má uživatel rozdělané na
 * serveru (přežijí cokoli).
 *
 * TŘETÍ STAV: NEVÍME
 * Běh zůstane ve stavu `running` i tehdy, když proces mezitím spadl —
 * nikdo mu už status nepřepíše. Tvrdit po dvou hodinách „běží" by bylo
 * stejné vydávání domněnky za měření, jakému se vyhýbají skenery. Po
 * uplynutí horní hranice se proto hlásí, že stav není známý.
 */

/**
 * Jak dlouho smí běh zůstat ve stavu „running", než ho přestaneme
 * považovat za živý.
 *
 * Odvozeno od `BROWSER_SLOT_MAX_HOLD_MS` na serveru (10 minut), s rezervou
 * na dokončení zápisu. Kratší hodnota by hlásila „neznámý stav" u běhů,
 * které normálně pokračují.
 */
export const STALE_AFTER_MS = 15 * 60 * 1000;

/** Běhy, které server považuje za rozdělané. */
export function runningSessions(sessions) {
  return (Array.isArray(sessions) ? sessions : []).filter((s) => s?.status === 'running');
}

/**
 * Složí stav ukazatele.
 *
 * @param {object} input
 * @param {boolean} input.localRunning  agentní test spuštěný z tohohle panelu
 * @param {boolean} input.auditsLoading probíhá compliance sken z tohohle panelu
 * @param {Array}   input.sessions      běhy uživatele ze serveru
 * @param {number}  [input.now]
 * @returns {{state: 'idle'|'running'|'unknown', label: string, title: string, count: number}}
 */
export function runStatus({ localRunning, auditsLoading, sessions, now = Date.now() }) {
  const running = runningSessions(sessions);

  // Rozdělené na živé a zaseknuté podle stáří.
  const fresh = [];
  const stale = [];
  for (const s of running) {
    const started = Date.parse(s.timestamp);
    // Nečitelný čas → nedá se posoudit stáří. Bereme jako živý běh, ať
    // ukazatel spíš varuje, než aby mlčel.
    if (Number.isNaN(started) || now - started < STALE_AFTER_MS) fresh.push(s);
    else stale.push(s);
  }

  if (localRunning || auditsLoading || fresh.length > 0) {
    const count = fresh.length || (localRunning || auditsLoading ? 1 : 0);
    return {
      state: 'running',
      label: count > 1 ? `Běží ${count} testy` : 'Test běží…',
      title:
        fresh.length > 0
          ? 'Na serveru máte rozdělaný běh. Pokračuje i po zavření stránky.'
          : 'Právě probíhá měření.',
      count,
    };
  }

  if (stale.length > 0) {
    // Ani „běží", ani „připraven". Běh se nedokončil a nikdo mu status
    // nepřepsal — nejspíš spadl proces. Tvrdit cokoli z toho by bylo
    // domněnka.
    return {
      state: 'unknown',
      label: stale.length > 1 ? `${stale.length} běhy bez odezvy` : 'Běh bez odezvy',
      title:
        'Běh zůstal rozdělaný déle, než trvá nejdelší povolené měření. ' +
        'Nejspíš se nedokončil; jeho výsledek se nedozvíme.',
      count: stale.length,
    };
  }

  return {
    state: 'idle',
    label: 'Připraven',
    title: 'Neběží žádné měření.',
    count: 0,
  };
}
