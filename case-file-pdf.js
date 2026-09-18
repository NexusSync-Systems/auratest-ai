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
 * Prohlížeč, ve kterém se tiskne spis, NESMÍ SÁHNOUT DO SÍTĚ.
 *
 * Tohle byl jediný kontext v celém nástroji bez hlídače navigace. Dnes
 * ho drží nad vodou důsledné escapování v `case-file.js` — jenže to je
 * jedna funkce a jedna chyba v ní stačí: do spisu se dostávají adresy
 * auditovaných webů, a ty zadává zákazník. Vložený `<img src="http://
 * 169.254.169.254/latest/meta-data/">` by z tisku spisu udělal nástroj
 * na čtení metadat cloudu.
 *
 * Hlídač je tu proto přísnější než `guardNavigation` u skenerů: ten
 * adresy prověřuje, protože skener SE MÁ na web podívat. Tady se dívat
 * nemá na nic. Předloha je záměrně bez externích zdrojů, takže každý
 * požadavek ven je buď chyba v šabloně, nebo pokus o zneužití — a obojí
 * patří do logu, ne do PDF.
 *
 * `data:` a `about:` se propouštějí: nejdou ven a předloha je může
 * legitimně použít pro vložený obrázek nebo prázdný rámec.
 */
export async function zakazSit(page, onBlocked) {
  if (typeof page?.route !== 'function') {
    console.warn('[spis] Stránka neumí route() — hlídač sítě se nezapnul.');
    return;
  }
  await page.route('**/*', async (route, request) => {
    // Výjimka z async handleru by skončila jako neodchycené odmítnutí
    // Promise a shodila proces — přesně to se u skenerů už jednou stalo.
    try {
      const url = String(request.url() || '');
      if (/^(data:|about:|blob:)/i.test(url)) return await route.continue();

      console.warn(`[spis] Zablokován požadavek ven při tisku spisu: ${url}`);
      if (onBlocked) onBlocked(url);
      return await route.abort();
    } catch {
      // Ani selhání hlídače nesmí položit export.
      try { await route.abort(); } catch { /* route už mohla být vyřízena */ }
    }
  });
}

/**
 * @param {string} html předloha z `renderCaseFileHtml()`
 * @param {object} [options]
 * @param {(url: string) => void} [options.onBlocked] volá se pro každý
 *   zablokovaný požadavek — testy si tak ověří, že hlídač opravdu drží.
 * @returns {Promise<Buffer>}
 */
export async function renderCaseFilePdf(html, { onBlocked } = {}) {
  const browser = await chromium.launch(launchOptions());
  try {
    const page = await browser.newPage();
    await zakazSit(page, onBlocked);

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
