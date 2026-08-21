/**
 * Normalizace čísla verze pro dotaz do databáze zranitelností OSV.
 *
 * Vlastní modul, ne funkce v agent.js: na tomhle čísle stojí verdikt
 * „FAIL: okamžitě aktualizujte závislosti", takže potřebuje testy — a testovat
 * ho přes agent.js znamenalo natáhnout do test workeru celý Playwright.
 */

/**
 * Vrátí semver použitelný pro OSV, jinak null (např. z 'detekováno', '3.x').
 *
 * Chybějící patch verzi NEDOPLŇUJE. Dřív se z „2.6" udělalo „2.6.0" a na tohle
 * domyšlené číslo se pak zeptalo OSV — nasazená 2.6.14 s opravenými CVE tak
 * mohla dostat „FAIL: okamžitě aktualizujte závislosti". Verdikt vyvozený
 * z čísla, které si nástroj vymyslel, je horší než žádný verdikt.
 */
export function normalizeSemver(raw) {
  if (typeof raw !== 'string') return null;
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(raw);
  if (!match) return null;
  return `${match[1]}.${match[2]}.${match[3]}`;
}
