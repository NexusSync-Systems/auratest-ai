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
      // Okraje řídí @page v CSS předlohy; tady by se jen zdvojily.
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
