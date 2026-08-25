#!/usr/bin/env node
/**
 * Ověření neporušenosti záznamu auditů.
 *
 * Spouští se na nasazené instalaci — a hlavně kdykoli je potřeba někomu
 * doložit, že s historií nikdo nehýbal:
 *
 *   docker compose exec auratest-ai node scripts/verify-ledger.mjs
 *
 * Vypíše i otisk poslední položky. Ten je smysluplné pravidelně ukotvit
 * mimo tenhle stroj (e-mail, jiný systém, tisk k podpisu). Od okamžiku
 * ukotvení je přepis historie do té doby prokazatelný — bez ukotvení
 * řetěz dokazuje jen to, že s ním nikdo nehýbal ČÁSTEČNĚ.
 *
 * Návratový kód: 0 = řetěz sedí, 1 = nesedí. Aby to šlo dát do monitoringu.
 */
import { verifyChain, headHash, readLedger, LEDGER_FILE } from '../audit-ledger.js';

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

const result = verifyChain();
const records = readLedger();

console.log(`\nZáznam auditů: ${LEDGER_FILE}`);
console.log(`Položek: ${result.count}`);

if (result.count > 0) {
  const first = records.find((r) => !r.__malformed);
  const last = [...records].reverse().find((r) => !r.__malformed);
  if (first && last) {
    console.log(`Období:  ${first.recordedAt} … ${last.recordedAt}`);
  }
  console.log(`Otisk hlavy: ${headHash()}`);
  console.log(`${DIM}  (tenhle otisk je to, co má smysl ukotvit mimo stroj)${RESET}`);
}

console.log();

if (result.ok) {
  console.log(`${GREEN}✔ Řetěz je neporušený.${RESET}`);
  console.log(
    `${DIM}  Dokazuje to, že žádný záznam nebyl dodatečně změněn ani odstraněn.`
  );
  console.log(
    `  Nedokazuje to nemožnost podvrhu: kdo smí do souboru zapisovat, může`
  );
  console.log(
    `  přepsat celou historii a otisky přepočítat. Proti tomu pomáhá jedině`
  );
  console.log(`  ukotvení otisku hlavy mimo tenhle stroj.${RESET}\n`);
  process.exit(0);
}

console.log(`${RED}✘ Řetěz je porušený — ${result.problems.length} nálezů:${RESET}\n`);
for (const p of result.problems) {
  const where = p.sessionId ? ` (session ${p.sessionId})` : '';
  console.log(`  položka ${p.index}${where}`);
  console.log(`    ${p.problem}`);
}
console.log();
process.exit(1);
