#!/usr/bin/env node
/**
 * Ruční ukotvení otisku řetězu.
 *
 * Server ukotvuje sám v pravidelném intervalu, ale tenhle skript je tu
 * ze dvou důvodů:
 *
 *   1. Provozovatel, který nemá Slack, potřebuje otisk dostat ven po svém —
 *      do e-mailu, do jiného stroje, na papír. Výstup skriptu je právě to,
 *      co se má poslat.
 *   2. Před předáním spisu úřadu se hodí ukotvit ručně, aby byl kryt
 *      i nejnovější záznam. Automatické ukotvení nechává na konci nekrytou
 *      mezeru danou periodou.
 *
 * Použití:
 *   node scripts/anchor-ledger.mjs                    zapíše a vypíše kotvu
 *   node scripts/anchor-ledger.mjs --check            jen ověří stávající kotvy
 *   node scripts/anchor-ledger.mjs --note "před kontrolou ČTÚ"
 *
 * Exit 0 = v pořádku, 1 = ukotvený otisk se v řetězu nenachází.
 */
import { readLedger, verifyChain } from '../audit-ledger.js';
import { createAnchor, readAnchors, anchorSummary, anchorMessage } from '../ledger-anchor.js';

const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const noteIndex = args.indexOf('--note');
const note = noteIndex !== -1 ? args[noteIndex + 1] : undefined;

const chain = verifyChain();
if (!chain.ok) {
  console.error('Řetěz záznamů je porušený — ukotvovat ho nemá smysl:');
  for (const p of chain.problems) console.error(`  položka ${p.index}: ${p.problem}`);
  process.exit(1);
}

if (!checkOnly) {
  const { message } = createAnchor({ note });
  console.log(message);
  console.log('');
  console.log('─'.repeat(60));
  console.log('Zprávu výše odešlete nebo uložte MIMO tento server.');
  console.log('Kopie, která zůstane vedle záznamu, důkazní hodnotu nemá:');
  console.log('kdo smí zapisovat do řetězu, smí zapisovat i do ní.');
  console.log('─'.repeat(60));
  console.log('');
}

const stav = anchorSummary(readLedger(), readAnchors());
console.log(`Stav ukotvení: ${stav.state}`);
console.log(stav.rationale);

if (stav.state === 'broken') {
  process.exit(1);
}

// Kotva, kterou nikdo neověřil proti odeslané kopii, je jen zápis v souboru.
if (stav.state === 'anchored') {
  console.log('');
  console.log('Porovnejte otisk výše s kopií, kterou máte uloženou mimo systém.');
  console.log(`Otisk: ${stav.headHash}`);
}

// Poznámka pro čtenáře výstupu: `anchorMessage` je vyexportovaná, aby šlo
// text kotvy sestavit i jinde (server ji posílá do Slacku) a znění zůstalo
// jedno jediné.
void anchorMessage;
