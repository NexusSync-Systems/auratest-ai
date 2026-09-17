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
import { readLedger, overOtisk, PREDPISY_OTISKU } from '../audit-ledger.js';
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
  let session;
  try {
    session = await db.getSession(zaznam.sessionId);
  } catch (err) {
    neoveritelne.push({ zaznam, duvod: `session se nepodařilo načíst: ${err.message}` });
    continue;
  }

  // `overOtisk` zkouší VŠECHNY známé předpisy. `schema` u záznamů z doby
  // před verzováním hlásilo `1` bez ohledu na to, kterým ze tří tehdejších
  // předpisů otisk vznikl.
  const vysledek = overOtisk(session, zaznam);
  if (vysledek.stav === 'ok') souhlasi.push({ zaznam, predpis: vysledek.predpis });
  else if (vysledek.stav === 'nesouhlasi') nesouhlasi.push({ zaznam, duvod: vysledek.duvod });
  else neoveritelne.push({ zaznam, duvod: vysledek.duvod });
}

const podlePredpisu = {};
for (const { predpis } of souhlasi) {
  podlePredpisu[predpis] = (podlePredpisu[predpis] || 0) + 1;
}

console.log(`  ${GREEN}souhlasí: ${souhlasi.length}${RESET}` +
  (Object.keys(podlePredpisu).length
    ? `\n${DIM}    podle předpisu: ${Object.entries(podlePredpisu).map(([p, n]) => `${p} → ${n}`).join(', ')}${RESET}`
    : ''));
console.log(`  neověřitelné: ${neoveritelne.length}`);
console.log(`  nesouhlasí: ${nesouhlasi.length ? RED : ''}${nesouhlasi.length}${RESET}`);

if (neoveritelne.length > 0) {
  console.log(`\n${DIM}Neověřitelné — NENÍ to nález o zásahu:${RESET}`);
  const duvody = {};
  for (const { duvod } of neoveritelne) duvody[duvod] = (duvody[duvod] || 0) + 1;
  for (const [duvod, pocet] of Object.entries(duvody)) {
    console.log(`${DIM}  ${pocet}× ${duvod}${RESET}`);
  }
}

if (nesouhlasi.length === 0) {
  console.log(`\n${GREEN}✔ Žádný záznam neukazuje na zásah.${RESET}`);
  if (neoveritelne.length > 0) {
    console.log(`${DIM}  U ${neoveritelne.length} záznamů otisk výsledku nedokládá nic —`);
    console.log('  pocházejí z doby, kdy nástroj verzi předpisu nezaznamenával.');
    console.log('  Jejich neporušenost dokládá řetězení a ukotvení, ne otisk.');
    console.log(`  Spis to u nich uvádí.${RESET}`);
  }
  console.log('');
  process.exit(0);
}

console.log(`\n${RED}✘ ${nesouhlasi.length} záznamů ukazuje na rozpor:${RESET}\n`);
for (const { zaznam, duvod } of nesouhlasi.slice(0, 20)) {
  console.log(`  ${zaznam.sessionId}  ${DIM}(${zaznam.recordedAt}, schema ${zaznam.schema ?? 1})${RESET}`);
  console.log(`    zapsáno: ${zaznam.resultDigest}`);
  console.log(`    ${DIM}${duvod}${RESET}`);
}
if (nesouhlasi.length > 20) console.log(`  … a dalších ${nesouhlasi.length - 20}`);

console.log(`\n${RED}Tyhle záznamy nesou jednoznačnou verzi předpisu, takže rozpor`);
console.log('má oporu: data session se od zápisu do záznamu změnila.');
console.log(`Známé předpisy: ${PREDPISY_OTISKU.map((p) => p.id).join(', ')}${RESET}\n`);
process.exit(1);
