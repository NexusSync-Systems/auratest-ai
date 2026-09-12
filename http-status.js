/**
 * Odpověděl server tak, že se z toho dá něco měřit?
 *
 * PROČ TO TU JE
 * Skenery si tuhle podmínku psaly samostatně, nebo vůbec. Chaos test ji
 * neměl: `page.goto()` na server, který na všechno vrací 503, se nepovažuje
 * za selhání navigace — odpověď PŘIŠLA, jen je chybová. Baseline dostal
 * týž 503, takže rozdíl proti němu byl nulový a verdikt vyšel
 * „Aplikace přežila N injektovaných poruch bez pádu". Chybová stránka
 * „odolala" místo aby byla neprůkazná.
 *
 * Chybová stránka není měřená aplikace. Cokoli se na ní naměří, vypovídá
 * o chybové stránce.
 */

/**
 * @param {{ok: () => boolean, status: () => number}|null|undefined} response
 *   Odpověď z `page.goto()`. `null` = navigace selhala nebo vyhodila.
 * @returns {string|null} popis chyby, nebo `null` když je odpověď použitelná
 */
export function popisHttpChyby(response) {
  if (!response) return 'Server neodpověděl.';
  try {
    if (response.ok()) return null;
    return `Server odpověděl ${response.status()}.`;
  } catch (err) {
    // Odpověď z uzavřeného kontextu na `ok()` vyhodí. „Nevím" je pak
    // pravdivější než „v pořádku".
    return `Odpověď serveru se nepodařilo přečíst: ${err.message}`;
  }
}

/**
 * Sloučení popisu z baseline a hlavního běhu.
 *
 * Stačí, aby jeden z nich narazil na chybovou stránku — porovnání mezi
 * dvěma různými stavy serveru nic neměří.
 */
export function popisHttpChybyBehu({ baseline, hlavni } = {}) {
  if (baseline && hlavni && baseline === hlavni) {
    return `${baseline} (v baseline i v hlavním běhu)`;
  }
  if (baseline && hlavni) {
    return `Baseline: ${baseline} Hlavní běh: ${hlavni}`;
  }
  if (baseline) return `Baseline běh: ${baseline}`;
  if (hlavni) return `Hlavní běh: ${hlavni}`;
  return null;
}
