/**
 * Běhy, které zůstaly viset ve stavu „running".
 *
 * CO SE DĚJE
 * Běh se do databáze zapíše jako `running` hned na začátku a status se mu
 * přepíše až na konci. Když proces mezitím skončí — nasazení pošle
 * SIGTERM, kontejneru dojde paměť, stroj se restartuje — nikdo ten zápis
 * neprovede. Záznam pak tvrdí „běží" navždycky.
 *
 * U nás to vyrobilo tři takové běhy za jediné odpoledne, protože každé
 * `docker compose up -d --build` posílá běžícímu serveru SIGTERM.
 *
 * ČÍM TO NENÍ
 * Není to nález o testovaném webu a nesmí tak vypadat. Přerušený běh se
 * proto zapisuje jako `failed` s důvodem v `runErrors` — tedy tam, kde
 * jsou chyby měření, ne mezi `bugs`. A nikdy jako `completed`: ten stav
 * ve spisu znamená „výsledek platí".
 *
 * DVĚ POJISTKY, PROTOŽE KRYJÍ RŮZNÉ SMRTI
 *   1. Korektní vypnutí (SIGTERM) — server stihne běhy dopsat sám.
 *      Kryje nasazení, což je náš případ.
 *   2. Hlídač podle tepu — běh si periodicky zapisuje `heartbeatAt`
 *      a co netepe, je po prahu prohlášeno za mrtvé. Kryje SIGKILL,
 *      OOM i výpadek stroje, kde první pojistka neproběhne.
 *
 * Proč tep a ne „starší než X": dlouhý živý běh a mrtvý běh vypadají
 * podle času startu stejně. Tep je jediné, co je rozliší.
 */

/**
 * Jak dlouho smí běh mlčet, než ho prohlásíme za mrtvý.
 *
 * Odvozeno od `BROWSER_SLOT_MAX_HOLD_MS` na serveru (10 minut) plus
 * rezerva na dokončení zápisu. Kratší práh by zabíjel běhy, které
 * normálně pokračují — a to je horší než zombie: zabitý živý běh znamená
 * zahozený výsledek, o kterém se uživatel nikdy nedozví.
 */
export const HEARTBEAT_STALE_MS = 15 * 60 * 1000;

/**
 * Práh pro záznamy, které tep NEMAJÍ vůbec.
 *
 * Běhy z doby před zavedením tepu a běhy procesu, kterému se všechny
 * zápisy tepu nepodařily. U nich rozhoduje čas startu — a ten o životě
 * nevypovídá nic, takže musí být práh výrazně shovívavější. Měřit je
 * patnácti minutami by znamenalo zabíjet živé běhy kvůli tomu, že se
 * nepodařil zápis, který s měřením nesouvisí.
 */
export const LEGACY_STALE_MS = 6 * 60 * 60 * 1000;

/** Jak často běh tepe. Výrazně kratší než práh, ať se nestřílí o fous. */
export const HEARTBEAT_INTERVAL_MS = 60 * 1000;

/**
 * Je tenhle běh zaseknutý?
 *
 * @param {{status?: string, heartbeatAt?: string, timestamp?: string}} session
 * @param {number} [now]
 * @param {number} [prahMs]
 * @returns {boolean}
 */
export function jeZaseknuty(session, now = Date.now(), prahy = {}) {
  if (session?.status !== 'running') return false;

  const sTepem = prahy.heartbeatMs ?? HEARTBEAT_STALE_MS;
  const bezTepu = prahy.legacyMs ?? LEGACY_STALE_MS;

  // Tep má přednost a má vlastní, přísnější práh — je to jediná známka
  // života, na kterou se dá spolehnout.
  const tep = Date.parse(session.heartbeatAt);
  if (!Number.isNaN(tep)) return now - tep >= sTepem;

  // Bez tepu zbývá čas startu. Ten o životě nevypovídá nic, takže se
  // posuzuje shovívavějším prahem — dlouhý živý běh a mrtvý běh podle
  // něj vypadají stejně.
  const start = Date.parse(session.timestamp);

  // Nečitelný čas NENÍ důvod prohlásit běh za mrtvý. Zabít živý běh
  // znamená zahodit výsledek, o kterém se uživatel nikdy nedozví;
  // nechat zombie znamená zmatený seznam. První je horší.
  if (Number.isNaN(start)) return false;

  return now - start >= bezTepu;
}

/**
 * Jak má vypadat záznam přerušeného běhu.
 *
 * Vrací JEN pole, která se mají přepsat — volající je slučuje do
 * existujícího záznamu. Nedotýká se `bugs`: ty patří webu, tohle je
 * okolnost běhu.
 *
 * @param {{status?: string, runErrors?: string[], bugs?: unknown}} session
 * @param {'vypnuti'|'bez-tepu'} duvod
 * @param {string} [kdy] ISO čas, kdy se to zjistilo
 */
export const DUVODY = {
  vypnuti: 'Běh přerušen restartem serveru. Nedoběhl, takže nemá výsledek.',
  'bez-tepu': 'Běh přestal odpovídat a nedoběhl. Proces, který ho držel, '
    + 'už neexistuje.',
  odlozeno: 'Běh se nespustil: v okamžiku spuštění nebyl volný prohlížeč. '
    + 'Nezměřilo se nic.',
};

export function zaznamPrerusenehoBehu(session, duvod, kdy = new Date().toISOString()) {
  // Neznámý důvod se NEPŘEKLÁDÁ tiše na některý ze známých. Překlep na
  // volajícím by jinak zapsal do dokumentu nesprávnou příčinu.
  const veta = DUVODY[duvod]
    ?? `Běh nedoběhl a nemá výsledek (nezařazená příčina: ${String(duvod)}).`;

  return {
    // NIKDY `completed`. Ten stav ve spisu znamená „výsledek platí".
    status: 'failed',
    // Chyby MĚŘENÍ, ne nálezy o webu. Oddělení je celý smysl `runErrors`.
    runErrors: [...(Array.isArray(session?.runErrors) ? session.runErrors : []), veta],
    summary: veta,
    interruptedAt: kdy,
    // `heartbeatAt` se schválně NENULUJE.
    //
    // Před opravou se nastavovalo na `null` a `jeZaseknuty` četlo
    // `heartbeatAt ?? timestamp` — `null` tedy propadlo na čas startu,
    // tedy na hodnotu starou hodiny. Záznam byl okamžitě zase
    // „zaseknutý" a při každém dalším zápisu běhu se překlápěl
    // `running` ↔ `failed`, přičemž `runErrors` narůstaly opakovanými
    // větami o přerušení.
    //
    // Proti opakovanému zpracování chrání `status`: `jeZaseknuty`
    // pracuje jen s `running`.
  };
}

/**
 * Vybere ze seznamu ty běhy, které je třeba dopsat.
 *
 * Oddělené od zápisu, aby šlo otestovat rozhodování bez databáze.
 */
export function zaseknuteBehy(sessions, now = Date.now(), prahy = {}) {
  return (Array.isArray(sessions) ? sessions : [])
    .filter((s) => jeZaseknuty(s, now, prahy));
}
