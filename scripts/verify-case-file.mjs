#!/usr/bin/env node
/**
 * Ověření, že se spis vytiskne do PDF.
 *
 * PROČ SAMOSTATNÝ SKRIPT
 * Vykreslení PDF spouští Chromium, takže se nedá ověřit tam, kde prohlížeč
 * chybí — v jednotkových testech ani ve vývojovém sandboxu. Tenhle skript
 * to změří na nasazené instalaci:
 *
 *   docker compose exec auratest-ai node scripts/verify-case-file.mjs
 *
 * Nepracuje s daty zákazníků: sestaví spis z ukázkových běhů a ze
 * skutečného registru pravidel. Ověřuje se tím sazba, diakritika
 * a stránkování, ne obsah konkrétního auditu.
 *
 * Návratový kód: 0 = PDF vzniklo, 1 = nevzniklo.
 */
import fs from 'fs';
import { chromium } from 'playwright';
import { launchOptions } from '../browser-options.js';
import os from 'os';
import path from 'path';
import { buildCaseFile, renderCaseFileHtml } from '../case-file.js';
import { renderCaseFilePdf } from '../case-file-pdf.js';

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

// Ukázkové běhy pokrývají všechny tři verdikty — kdyby se sazba rozbila
// jen u jednoho z nich, projde jinak test nezaslouženě.
const now = new Date().toISOString();
const sessions = [
  {
    id: 'ukazka-nalez',
    url: 'https://příklad.cz/přihlášení',
    goal: 'Compliance sken (ukázka)',
    status: 'completed',
    bugs: ['Chybí hlavička Content-Security-Policy', 'Tracker před souhlasem'],
    warnings: ['Zaseknutí UI (Long Task): 145 ms'],
    summary: 'Dva nálezy.',
    timestamp: now,
  },
  {
    id: 'ukazka-bez-nalezu',
    url: 'https://příklad.cz/',
    goal: 'Compliance sken (ukázka)',
    status: 'completed',
    bugs: [],
    warnings: [],
    summary: '',
    timestamp: now,
  },
  {
    id: 'ukazka-neprukazne',
    url: 'https://příklad.cz/nedostupné',
    goal: 'Compliance sken (ukázka)',
    status: 'failed',
    bugs: [],
    warnings: [],
    summary: 'Spojení vypršelo',
    timestamp: now,
  },
];

const caseFile = buildCaseFile({ sessions, records: [], subject: 'ukázka' });
const html = renderCaseFileHtml(caseFile);

console.log('\n▶ Spis');
console.log(`  běhů: ${caseFile.summary.runs}` +
  ` (s nálezem ${caseFile.summary.withFindings},` +
  ` bez nálezu ${caseFile.summary.withoutFindings},` +
  ` neprůkazných ${caseFile.summary.inconclusive})`);
console.log(`  pravidel ve spisu: ${caseFile.ruleset.rules.length}`);
console.log(`  HTML: ${html.length} znaků`);

/**
 * Počet stran z PDF bez parseru.
 *
 * `/Type /Page` (ne `/Pages`) se v Chromiem vygenerovaném PDF objevuje
 * jednou na stránku a je v nekomprimované části objektů. Vrací `null`,
 * když se nic nenajde — „nevím" je pravdivější než dohad.
 */
function pocetStran(buffer) {
  const text = buffer.toString('latin1');
  // Stránkové objekty se počítají PŘÍMO. `/Count` je až záloha: vyskytuje
  // se i v osnově dokumentu, kde znamená počet položek, ne stran.
  // `[^s]` odliší `/Page` od `/Pages`.
  const vyskyty = text.match(/\/Type\s*\/Page[^s]/g);
  if (vyskyty) return vyskyty.length;
  const podleCount = text.match(/\/Type\s*\/Pages[^]{0,200}?\/Count\s+(\d+)/);
  return podleCount ? Number(podleCount[1]) : null;
}

/** Vykreslení bez zásahu `renderCaseFilePdf` — pro srovnání okrajů. */
async function renderRawPdf(htmlDoc, options) {
  const browser = await chromium.launch(launchOptions());
  try {
    const page = await browser.newPage();
    await page.setContent(htmlDoc, { waitUntil: 'load' });
    return await page.pdf({ format: 'A4', printBackground: true, ...options });
  } finally {
    await browser.close();
  }
}

try {
  const started = Date.now();
  const pdf = await renderCaseFilePdf(html);
  const out = path.join(os.tmpdir(), 'auraguard-spis-ukazka.pdf');
  fs.writeFileSync(out, pdf);

  // Kontrola hlavičky, ne jen nenulové délky: prázdný nebo useknutý soubor
  // by jinak prošel jako úspěch.
  const isPdf = pdf.subarray(0, 5).toString() === '%PDF-';

  console.log();
  if (!isPdf) {
    console.log(`${RED}✘ Výstup není PDF (chybí hlavička %PDF-).${RESET}\n`);
    process.exit(1);
  }

  console.log(`${GREEN}✔ PDF vzniklo${RESET} — ${pdf.length} bajtů za ${Date.now() - started} ms`);
  console.log(`${DIM}  ${out}${RESET}`);

  // UPLATNILY SE OKRAJE? MĚŘITELNĚ, NE OD OKA.
  //
  // Skript tu dřív napsal „otevři ho a zkontroluj stránkování — to skript
  // posoudit nedokáže" a šel pryč. Jenže ověření, které se dělá očima,
  // se po pár týdnech přestane dělat — a přesně takhle prošla vada, kdy
  // Playwright posílal Chromiu nulové okraje (`margin = {}` → `|| 0`)
  // a patička „strana X / Y" se nevykreslila vůbec, protože Chromium ji
  // kreslí DO PLOCHY OKRAJE.
  //
  // Text z PDF se bez parseru vytáhnout nedá spolehlivě (fonty bývají
  // podmnožinové, takže v proudu nejsou ASCII znaky). Zato jde ověřit
  // NÁSLEDEK: s okraji je plocha pro obsah menší, takže se totéž HTML
  // rozloží na jiný počet stran než bez nich. Kdyby se `margin` ignoroval,
  // obě vykreslení by byla shodná.
  const bezOkraju = await renderRawPdf(html, {});
  const stranS = pocetStran(pdf);
  const stranBez = pocetStran(bezOkraju);

  console.log();
  console.log(`  stran s okraji: ${stranS ?? '?'}, bez okrajů: ${stranBez ?? '?'}`);

  if (stranS === null || stranBez === null) {
    console.log(`${DIM}  Počet stran se z PDF vyčíst nepodařilo — kontrola okrajů`);
    console.log(`  neproběhla. NENÍ to důkaz, že jsou okraje špatně.${RESET}`);
  } else if (pdf.length === bezOkraju.length && stranS === stranBez) {
    console.log(`${RED}✘ Okraje se zřejmě neuplatnily: vykreslení s okraji`);
    console.log('  i bez nich dává stejný počet stran i stejnou velikost.');
    console.log(`  Patička se stránkováním se pak nevykreslí.${RESET}\n`);
    process.exit(1);
  } else {
    console.log(`${GREEN}  ✔ Okraje se uplatnily — rozložení se bez nich liší.${RESET}`);
  }

  console.log(`${DIM}  Diakritiku je pořád potřeba zkontrolovat okem.${RESET}\n`);
  process.exit(0);
} catch (err) {
  console.log();
  console.log(`${RED}✘ Vykreslení selhalo: ${err.message}${RESET}`);
  console.log(`${DIM}  Obvyklá příčina: chybí systémové knihovny Chromia.${RESET}\n`);
  process.exit(1);
}
