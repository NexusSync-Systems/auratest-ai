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
 *   app      Všechno ostatní — teprve tohle smí zvednout ruku jako nález.
 *
 * Modul je záměrně bez závislostí, aby šel testovat bez importu agent.js
 * (ten tahá Playwright a test se pak vleče).
 */

const POLICY_PATTERNS = /zablokována|neveřejn|interní rozsah/i;
const OVERLAY_PATTERN = /intercepts pointer events/i;
const VIEWPORT_PATTERN = /element is outside of the viewport/i;

/**
 * Call log Playwrightu do reportu nepatří celý.
 *
 * U timeoutu má i pár tisíc znaků opakovaných pokusů („retrying click action
 * - waiting 20ms 2 × waiting for element to be visible…"). V dokumentu pro
 * úřad z toho byla stránka vnitřního výpisu nástroje, ve které se skutečná
 * příčina ztratila. Zůstane první věta a důvod, zbytek se ustřihne.
 */
function zkratCallLog(text) {
  const bezLogu = text.split(/\s*Call log:/i)[0].trim();
  if (bezLogu.length === 0) return text.slice(0, 200);
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

  return {
    kind: 'app',
    isAppFault: true,
    message: `Akce '${action}' v kroku ${step} selhala: ${zkratCallLog(text)}`,
  };
}
