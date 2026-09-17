#!/usr/bin/env node
/**
 * Souhlasí uložené otisky výsledků se skutečnými daty?
 *
 * PROČ SAMOSTATNÝ SKRIPT
 * `verify-ledger.mjs` ověřuje ŘETĚZ — že se zpětně nezasahovalo do
 * posloupnosti záznamů. Neověřuje ale `resultDigest`, tedy otisk
 * VÝSLEDKU. Ten se počítá z dat session v databázi a spis ho při
 * sestavení přepočítává (`verifyResultDigest` v `case-file.js`).
 *
 * `verify-case-file.mjs` na tohle taky neodpoví: staví spis z ukázkových
 * běhů a s prázdným seznamem záznamů, takže ověřuje jen sazbu.
 *
 * Mezi těmi dvěma tedy byla díra přesně tam, kde záleží nejvíc: spis
 * u nesouhlasícího otisku tiskne „Otisk souhlasí: NE", což čtenář čte
 * jako manipulaci se záznamem. Když takový rozchod způsobí změna
 * v našem kódu (nové pole v `auditResultOf`), obviňujeme zákazníka
 * z něčeho, co jsme udělali sami.
 *
 * Proto se `auditResultOf` verzuje (`schema` v záznamu) a proto tenhle
 * skript existuje: po KAŽDÉ změně předpisu otisku se má spustit.
 *
 * Čte data zákazníků, takže patří na server, ne do CI:
 *   docker compose exec auratest-ai node scripts/verify-digests.mjs
 *
 * Návratový kód: 0 = všechny ověřitelné otisky souhlasí, 1 = nesouhlasí.
 */
import { readLedger, auditResultOf, digestOf } from '../audit-ledger.js';
import * as db from '../db.js';

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

const zaznamy = readLedger().filter((r) => !r.__malformed && r.resultDigest);

console.log(`\n▶ Otisky výsledků`);
console.log(`  záznamů s otiskem: ${zaznamy.length}`);

const souhlasi = [];
const nesouhlasi = [];
const neoveritelne = [];

for (const zaznam of zaznamy) {
  // Chybějící `schema` = záznam z doby před verzováním, tedy verze 1.
  const schema = zaznam.schema ?? 1;

  let session;
  try {
    session = await db.getSession(zaznam.sessionId);
  } catch (err) {
    neoveritelne.push({ zaznam, duvod: `session se nepodařilo načíst: ${err.message}` });
    continue;
  }

  if (!session) {
    // Není to nález o manipulaci: session mohla být smazána, zatímco
    // záznam je ze své podstaty trvalý. Tvrdit z toho porušení by byl
    // závěr bez opory.
    neoveritelne.push({ zaznam, duvod: 'session už v databázi není' });
    continue;
  }

  try {
    const prepocteny = digestOf(auditResultOf(session, schema));
    if (prepocteny === zaznam.resultDigest) souhlasi.push(zaznam);
    else nesouhlasi.push({ zaznam, schema, prepocteny });
  } catch (err) {
    neoveritelne.push({ zaznam, duvod: `přepočet selhal: ${err.message}` });
  }
}

const podleSchemat = {};
for (const z of souhlasi) {
  const s = z.schema ?? 1;
  podleSchemat[s] = (podleSchemat[s] || 0) + 1;
}

console.log(`  ${GREEN}souhlasí: ${souhlasi.length}${RESET}` +
  (Object.keys(podleSchemat).length
    ? ` ${DIM}(podle verze předpisu: ${Object.entries(podleSchemat).map(([s, n]) => `v${s}=${n}`).join(', ')})${RESET}`
    : ''));
console.log(`  nesouhlasí: ${nesouhlasi.length ? RED : ''}${nesouhlasi.length}${RESET}`);
console.log(`  ${DIM}neověřitelné: ${neoveritelne.length}${RESET}`);

if (neoveritelne.length > 0) {
  console.log(`\n${DIM}Neověřitelné (není to nález — jen se to nedalo posoudit):${RESET}`);
  for (const { zaznam, duvod } of neoveritelne.slice(0, 10)) {
    console.log(`${DIM}  ${zaznam.sessionId}: ${duvod}${RESET}`);
  }
  if (neoveritelne.length > 10) console.log(`${DIM}  … a dalších ${neoveritelne.length - 10}${RESET}`);
}

if (nesouhlasi.length === 0) {
  console.log(`\n${GREEN}✔ Všechny ověřitelné otisky souhlasí.${RESET}`);
  console.log(`${DIM}  Znamená to, že uložený výsledek odpovídá tomu, co se tehdy`);
  console.log('  změřilo a zapsalo — a že spis u těchhle běhů nebude tvrdit');
  console.log(`  „Otisk souhlasí: NE".${RESET}\n`);
  process.exit(0);
}

console.log(`\n${RED}✘ ${nesouhlasi.length} otisků nesouhlasí:${RESET}\n`);
for (const { zaznam, schema, prepocteny } of nesouhlasi.slice(0, 20)) {
  console.log(`  ${zaznam.sessionId}  ${DIM}(${zaznam.recordedAt}, předpis v${schema})${RESET}`);
  console.log(`    zapsáno:    ${zaznam.resultDigest}`);
  console.log(`    přepočteno: ${prepocteny}`);
}
if (nesouhlasi.length > 20) console.log(`  … a dalších ${nesouhlasi.length - 20}`);

console.log(`\n${RED}Dvě možné příčiny a je potřeba je rozlišit:${RESET}`);
console.log('  1. Data session se opravdu změnila po zápisu do záznamu.');
console.log('  2. Změnil se předpis otisku (`auditResultOf`) bez zvýšení');
console.log('     `AKTUALNI_SCHEMA_OTISKU`. Pak je to NAŠE chyba a spis by');
console.log('     zákazníka obvinil z manipulace, kterou neudělal.\n');
process.exit(1);
