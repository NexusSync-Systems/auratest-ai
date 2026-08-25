#!/usr/bin/env node
/**
 * Vyrobí ukázkový report pro veřejnou stránku — skutečným skenem.
 *
 * PROČ NE RUČNĚ NAPSANÝ JSON
 * Ukázka má klientovi předvést, jak nástroj vypadá, včetně toho, že spoustu
 * věcí prohlásí za neprůkazné. Kdyby se čísla vymyslela, byla by to marketingová
 * atrapa nástroje, který stojí na tom, že netvrdí nic, co nezměřil. Tenhle
 * skript proto spustí tytéž funkce jako aplikace a uloží, co vyšlo.
 *
 * Vynechává jen autonomního agenta — ten dělá screenshoty a video, které by
 * se musely veřejně servírovat, a jeho výstup závisí na tom, kam zrovna klikl.
 * Compliance skenery jsou deterministické v tom smyslu, že měří vlastnosti
 * cíle, ne náhodnou procházku.
 *
 * POUŽITÍ
 *   node scripts/export-sample-report.mjs https://www.cloudflare.com
 *
 * Zapíše `frontend/public/sample-report.json`. Ten se commituje — je to
 * naměřený artefakt s datem, ne generovaný build.
 *
 * V kontejneru:
 *   docker compose exec auratest-ai node scripts/export-sample-report.mjs <url>
 *   docker compose cp auratest-ai:/app/frontend/public/sample-report.json .
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  auditNIS2AndPQC,
  auditAIAct,
  auditCRAVulnerabilities,
  auditGreenAndResidency,
  auditAccessibility,
  auditStrictCookies,
  checkPage,
} from '../agent.js';

const TARGET = process.argv[2];
if (!TARGET) {
  console.error('Použití: node scripts/export-sample-report.mjs <url>');
  process.exit(1);
}

const OUT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'frontend',
  'public',
  'sample-report.json'
);

/**
 * Spustí jeden skener a nikdy nespadne.
 *
 * Když sken selže, uloží se `null` s důvodem. Ukázka pak tu sekci vůbec
 * nezobrazí — což je pořád lepší než ji zobrazit s vymyšleným obsahem.
 */
async function run(name, fn) {
  const startedAt = Date.now();
  process.stdout.write(`  ${name} … `);
  try {
    const data = await fn();
    console.log(`hotovo (${Math.round((Date.now() - startedAt) / 1000)} s)`);
    return { data, error: null };
  } catch (err) {
    console.log(`SELHALO: ${err.message}`);
    return { data: null, error: err.message };
  }
}

console.log(`\n▶ Ukázkový report proti ${TARGET}\n`);

const nis2 = await run('NIS2 / PQC', () => auditNIS2AndPQC(TARGET));
const aiAct = await run('AI Act čl. 50', () => auditAIAct(TARGET));
const cra = await run('CRA / SBOM', () => auditCRAVulnerabilities(TARGET));
const green = await run('Green Deal / rezidence', () => auditGreenAndResidency(TARGET));
const a11y = await run('Přístupnost (EAA)', () => auditAccessibility(TARGET));
const cookies = await run('Cookies (GDPR)', () => auditStrictCookies(TARGET));
// `checkPage` bere objekt monitoru, ne holou URL. S řetězcem se `target.url`
// vyhodnotí jako undefined a funkce vrátí „Chybí nebo neplatná URL" — což
// vypadá jako nedostupný web, ačkoli šlo o špatné volání.
const monitor = await run('Dostupnost', () =>
  checkPage({ url: TARGET, name: 'Ukázkový cíl' })
);

const report = {
  // Datum je součást výsledku, ne dekorace: stav cizího webu se mění
  // a report starý půl roku tvrdí něco o minulosti.
  measuredAt: new Date().toISOString(),
  target: TARGET,
  note:
    'Naměřeno skutečným během nástroje, ne ručně sestaveno. ' +
    'Nálezy popisují stav cílového webu v uvedený čas.',
  sections: { nis2, aiAct, cra, green, a11y, cookies, monitor },
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);

const failed = Object.entries(report.sections).filter(([, v]) => v.error);
console.log(`\n✔ Zapsáno: ${OUT}`);
if (failed.length) {
  console.log(`  ${failed.length} sekcí selhalo a bude v ukázce vynecháno:`);
  failed.forEach(([k, v]) => console.log(`    • ${k}: ${v.error}`));
}
console.log();
