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
  console.log(`${DIM}  ${out}`);
  console.log('  Otevři ho a zkontroluj diakritiku a stránkování — to skript');
  console.log(`  posoudit nedokáže.${RESET}\n`);
  process.exit(0);
} catch (err) {
  console.log();
  console.log(`${RED}✘ Vykreslení selhalo: ${err.message}${RESET}`);
  console.log(`${DIM}  Obvyklá příčina: chybí systémové knihovny Chromia.${RESET}\n`);
  process.exit(1);
}
