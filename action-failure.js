/**
 * Rozhodnutí, čí je to vlastně chyba, když agentovi selže akce.
 *
 * Nástroj tvrdí závěry o cizích aplikacích. Když si vlastní neschopnost
 * provést kliknutí zapíše jako „bug testovaného webu", tvrdí něco, co
 * neizměřil — a přesně tomu se má vyhýbat.
 *
 * Tři případy:
 *
 *   policy   Navigaci zablokovala vlastní bezpečnostní politika (SSRF guard).
 *            Aplikace v pořádku, agent se tam vědomě nepustil.
 *
 *   overlay  Prvek překryla jiná vrstva. Playwright to v call logu hlásí jako
 *            „intercepts pointer events" a na evropských webech je to skoro
 *            vždycky cookie lišta. Aplikace v pořádku, agent se nedostal.
 *
 *   viewport Prvek se nepodařilo dostat do viditelné části okna. Playwright
 *            v call logu píše „element is outside of the viewport" i poté, co
 *            sám odscrolloval. Skutečný běh na drinkboostup.cz to poslal do
 *            reportu jako NÁLEZ o zákazníkově webu — přitom to neznamená ani
 *            vadu, ani její nepřítomnost. Prvek může být v posuvném
 *            kontejneru, mimo plátno, nebo mít pevnou pozici, kterou
 *            scrollování nedožene. Bez dalšího zkoumání se z toho nic vyvodit
 *            nedá, takže se to nesmí tvrdit.
 *
 *   prostredi Nezdařilo se to, protože se pod agentem rozpadlo prostředí:
 *            zavřel se prohlížeč, stránka mezitím navigovala, prvek se
 *            přerenderoval. O aplikaci to neříká NIC — a část toho jsme
 *            způsobili sami. Ověřeno spuštěním: pět takových hlášek
 *            (`Target page, context or browser has been closed`,
 *            `Execution context was destroyed`, `Element is not attached
 *            to the DOM`, `Target crashed`) padalo do `app` a zapisovalo se
 *            do `bugs` jako vada zákazníkova webu. Znění jsou ověřená proti
 *            `playwright-core/lib/coreBundle.js`, ne odhadnutá.
 *
 *   neurcitelne  Timeout bez dalšího vodítka. Playwright čekal, prvek se
 *            nedal ovládnout, ale PROČ se z hlášky nepozná — call log
 *            neuvádí ani překryv, ani viewport. Může to být rozbité
 *            tlačítko (vada), nekonečná animace, nebo pomalý server.
 *            Řídící zásada nástroje říká, že neprůkazné se nehlásí jako
 *            nález; zůstane tedy vidět mezi varováními i s původní hláškou,
 *            aby si člověk mohl udělat úsudek sám.
 *
 *   app      Všechno ostatní — teprve tohle smí zvednout ruku jako nález.
 *
 * Modul je záměrně bez závislostí, aby šel testovat bez importu agent.js
 * (ten tahá Playwright a test se pak vleče).
 */

const POLICY_PATTERNS = /zablokována|neveřejn|interní rozsah/i;
const OVERLAY_PATTERN = /intercepts pointer events/i;
const VIEWPORT_PATTERN = /element is outside of the viewport/i;

/**
 * Rozpadlo se prostředí, ne aplikace.
 *
 * Každé znění je opsané z `playwright-core/lib/coreBundle.js`, ne odhadnuté:
 *   „Target page, context or browser has been closed"  (2×)
 *   „Execution context was destroyed, most likely because of a navigation" (6×)
 *   „Element is not attached to the DOM"               (3×)
 *   „detached from document" / „detached from the DOM"  (5×)
 *   „Target crashed"                                    (2×)
 *
 * První z nich způsobíme obvykle sami (konec běhu, uvolnění slotu). Druhá
 * a třetí nastanou na každé živé aplikaci, která během kliknutí naviguje
 * nebo překreslí komponentu — u Reactu a Vue je to běžný stav, ne vada.
 */
const PROSTREDI_PATTERN =
  /has been closed|Target crashed|Execution context was destroyed|not attached to the DOM|detached from/i;

/**
 * Timeout bez vysvětlení.
 *
 * Musí se testovat AŽ PO překryvu a viewportu — ty mají vlastní znění
 * uvnitř call logu a jsou konkrétnější. Zbude případ, kdy Playwright
 * jen čekal a nic bližšího neuvedl.
 */
const TIMEOUT_PATTERN = /Timeout \d+ms exceeded/i;

/**
 * Call log Playwrightu do reportu nepatří celý.
 *
 * U timeoutu má i pár tisíc znaků opakovaných pokusů („retrying click action
 * - waiting 20ms 2 × waiting for element to be visible…"). V dokumentu pro
 * úřad z toho byla stránka vnitřního výpisu nástroje, ve které se skutečná
 * příčina ztratila. Zůstane první věta a důvod, zbytek se ustřihne.
 */
export function zkratCallLog(text) {
  // Vstup se koercuje. Volá se s `actionErr.message`, a výjimka bez
  // `.message` by jinak shodila i zatřídění, které je k ničemu horší:
  // ztratil by se celý záznam o kroku, ne jen jeho hláška.
  const t = String(text ?? '');
  const bezLogu = t.split(/\s*Call log:/i)[0].trim();
  // Hláška složená JEN z call logu. Ustřižení se značí, aby čtenář
  // poznal, že text pokračuje — dřív se vrátil bez „…".
  if (bezLogu.length === 0) {
    return t.length > 200 ? `${t.slice(0, 197)}…` : t;
  }
  return bezLogu.length > 300 ? `${bezLogu.slice(0, 297)}…` : bezLogu;
}

// Z call logu vytáhne značku a id překrývajícího prvku:
//   `- <div class="…"> from <div data-nosnippet="true" id="onetrust-consent-sdk">…`
// Zajímá nás ten za `from`, protože to je element, který kliknutí sebral.
const OVERLAY_SOURCE = /from <([a-zA-Z][\w-]*)[^>]*\bid="([^"]+)"/;

/**
 * @param {string} action    název akce (`click`, `type`, …)
 * @param {number} step      pořadí kroku, do hlášky
 * @param {string} errorMessage  `err.message` z Playwrightu
 * @returns {{ kind: 'policy'|'overlay'|'app', isAppFault: boolean, message: string }}
 */
export function classifyActionFailure(action, step, errorMessage) {
  const text = String(errorMessage ?? '');

  if (POLICY_PATTERNS.test(text)) {
    return {
      kind: 'policy',
      isAppFault: false,
      message: `Akce '${action}' v kroku ${step} selhala: ${text}`,
    };
  }

  if (OVERLAY_PATTERN.test(text)) {
    const source = text.match(OVERLAY_SOURCE);
    const where = source ? ` (<${source[1]} id="${source[2]}">)` : '';
    return {
      kind: 'overlay',
      isAppFault: false,
      message:
        `Akce '${action}' v kroku ${step} nešla provést: prvek překrývá jiná vrstva${where}, ` +
        `typicky cookie lišta. Není to vada aplikace — agent se na prvek nedostal.`,
    };
  }

  if (VIEWPORT_PATTERN.test(text)) {
    return {
      kind: 'viewport',
      isAppFault: false,
      message:
        `Akce '${action}' v kroku ${step} nešla provést: prvek se nepodařilo ` +
        'dostat do viditelné části okna ani po odscrollování. Z toho neplyne ' +
        'vada aplikace ani její nepřítomnost — agent se na prvek nedostal.',
    };
  }

  if (PROSTREDI_PATTERN.test(text)) {
    return {
      kind: 'prostredi',
      isAppFault: false,
      message:
        `Akce '${action}' v kroku ${step} neproběhla: rozpadlo se prostředí `
        + `měření (${zkratCallLog(text)}). Stránka mezitím navigovala, prvek `
        + 'se překreslil, nebo se zavřel prohlížeč. O aplikaci to neříká nic.',
    };
  }

  if (TIMEOUT_PATTERN.test(text)) {
    return {
      kind: 'neurcitelne',
      isAppFault: false,
      message:
        `Akce '${action}' v kroku ${step} se nepodařila a důvod se určit `
        + `nedá: ${zkratCallLog(text)} Call log neuvádí ani překryv, ani `
        + 'prvek mimo viewport. Může jít o nefunkční prvek, o animaci, která '
        + 'ho nikdy neustálí, nebo o pomalou odpověď serveru — z jediného '
        + 'pokusu se to nepozná, takže se to nehlásí jako nález.',
    };
  }

  return {
    kind: 'app',
    isAppFault: true,
    message: `Akce '${action}' v kroku ${step} selhala: ${zkratCallLog(text)}`,
  };
}
