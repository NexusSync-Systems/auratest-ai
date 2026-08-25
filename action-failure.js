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
 *   app      Všechno ostatní — teprve tohle smí zvednout ruku jako nález.
 *
 * Modul je záměrně bez závislostí, aby šel testovat bez importu agent.js
 * (ten tahá Playwright a test se pak vleče).
 */

const POLICY_PATTERNS = /zablokována|neveřejn|interní rozsah/i;
const OVERLAY_PATTERN = /intercepts pointer events/i;

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

  return {
    kind: 'app',
    isAppFault: true,
    message: `Akce '${action}' v kroku ${step} selhala: ${text}`,
  };
}
