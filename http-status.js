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

/**
 * Navigace a posouzení odpovědi v jednom — aby to nikdo nepsal znovu.
 *
 * PROČ TAHLE FUNKCE PŘIBYLA
 * `popisHttpChyby` existovalo, ale volalo ho jen pár skenerů. Ostatní si
 * psaly vlastní variantu, a kdo ji napsal jen napůl, měřil chybovou
 * stránku jako by to byl auditovaný web:
 *
 *   • cookie skener chytal jen VÝJIMKU z navigace. `page.goto()` na server
 *     vracející 503 ale nevyhazuje — odpověď přišla, jen je chybová.
 *     `navigationError` zůstalo `null`, na chybové stránce nebyly trackery,
 *     a do neměnného záznamu se zapsalo „BEZ NÁLEZU: před udělením souhlasu
 *     nebyly nalezeny trackery". O webu, který se nepodařilo otevřít.
 *   • NIS2 skener neposuzoval stav vůbec a jako jediný nevracel
 *     `navigationError`. Hlavičky blokovací stránky Cloudflare se tak
 *     vyhodnotily jako hlavičky zákazníka — a dvanáct pravidel z toho
 *     udělalo PROKÁZANÁ porušení, ne neprůkazné výsledky.
 *
 * Komentář v `agent.js` přitom tvrdil, že „skener přístupnosti i cookie
 * skener tohle mají od úkolu #91". U cookie skeneru to nebyla pravda.
 * Kopírovaná podmínka se takhle chová vždycky; proto je z ní funkce.
 *
 * Vrací VÝSLEDEK, ne výjimku: neprůkazné měření je legitimní zjištění
 * a spis ho musí umět vykázat.
 *
 * @returns {{response: object|null, navigationError: string|null}}
 */
export async function navigujAOver(page, url, options = {}) {
  const { waitUntil = 'networkidle', timeout = 30000 } = options;
  let navigationError = null;
  const response = await page
    .goto(url, { waitUntil, timeout })
    .catch((err) => { navigationError = err.message; return null; });

  // Výjimka z navigace má přednost: je konkrétnější než „Server neodpověděl."
  if (!navigationError) navigationError = popisHttpChyby(response);

  return { response, navigationError };
}
