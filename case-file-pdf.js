/**
 * Vytištění spisu do PDF.
 *
 * PROČ PŘES PLAYWRIGHT
 * Prohlížeč už je závislostí — celý nástroj na něm stojí. Přidávat kvůli
 * PDF další knihovnu by znamenalo druhý renderer s vlastními chybami
 * v sazbě a vlastním chováním u diakritiky.
 *
 * Vlastní modul, ne součást `case-file.js`: sestavení a vykreslení spisu
 * musí jít testovat bez spouštění prohlížeče.
 */

import { chromium } from 'playwright';
import { launchOptions } from './browser-options.js';

/**
 * Okraje stránky spisu — JEDINÝ zdroj pravdy.
 *
 * PROČ TO NEŘÍDÍ `@page` V CSS
 * Předchozí verze okraje `page.pdf()` nepředávala a komentář u toho
 * tvrdil: „Okraje řídí @page v CSS předlohy; tady by se jen zdvojily."
 * To není pravda. Playwright má `margin = {}` jako výchozí hodnotu
 * a pak počítá `convertPrintParameterToInches(margin.top) || 0`
 * (`coreBundle.js:35423-35426`), takže Chromiu posílá VÝSLOVNOU NULU
 * pro všechny čtyři strany — plus `preferCSSPageSize: false`
 * (`:35407`). Explicitní nula v `Page.printToPDF` přebíjí `@page
 * { margin: 18mm 16mm }`.
 *
 * Dva důsledky, oba v dokumentu pro úřad:
 *  • spis se sázel od kraje ke kraji,
 *  • patička s „strana X / Y" se nevykreslila vůbec — Chromium hlavičku
 *    a patičku kreslí DO PLOCHY OKRAJE, a při nulovém okraji není kam.
 *
 * U důkazního dokumentu je chybějící stránkování věcná vada: nejde
 * doložit, že je spis úplný.
 *
 * Hodnoty jsou proto tady a `@page` v `case-file.js` je nemá duplikovat.
 */
export const OKRAJE_SPISU = {
  top: '18mm',
  bottom: '18mm',
  left: '16mm',
  right: '16mm',
};

/**
 * @param {string} html předloha z `renderCaseFileHtml()`
 * @returns {Promise<Buffer>}
 */
export async function renderCaseFilePdf(html) {
  const browser = await chromium.launch(launchOptions());
  try {
    const page = await browser.newPage();

    // `setContent` místo dočasného souboru: spis obsahuje otisky a cíle
    // auditů, které nemá smysl odkládat na disk.
    //
    // `waitUntil: 'load'` stačí — předloha je záměrně bez externích zdrojů,
    // takže není na co čekat. `networkidle` by tu jen přidalo prodlevu.
    await page.setContent(html, { waitUntil: 'load' });

    return await page.pdf({
      format: 'A4',
      // Okraje se MUSÍ předat — viz `OKRAJE_SPISU`. Bez nich Chromium
      // dostane nulu a patička se nevykreslí.
      margin: OKRAJE_SPISU,
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: '<span></span>',
      footerTemplate:
        '<div style="width:100%;font-size:8pt;color:#777;padding:0 16mm;' +
        'display:flex;justify-content:space-between;">' +
        '<span>AuraGuard — spis auditů</span>' +
        '<span>strana <span class="pageNumber"></span> / <span class="totalPages"></span></span>' +
        '</div>',
    });
  } finally {
    // I když vykreslení spadne: nezavřený prohlížeč drží stovky MB a při
    // opakovaném exportu položí stroj.
    await browser.close();
  }
}
