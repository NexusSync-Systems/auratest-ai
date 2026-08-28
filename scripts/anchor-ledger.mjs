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
 *   node scripts/anchor-ledger.mjs --saved "e-mail"   potvrdí uložení ven
 *
 * `--saved` je PROHLÁŠENÍ PROVOZOVATELE, ne měření. Nástroj nemá jak
 * ověřit, že jste text opravdu uložili jinam — jen si tu informaci
 * poznamená, aby spis nehlásil „ukotveno" u kotvy, která systém nikdy
 * neopustila.
 *
 * Exit 0 = v pořádku, 1 = ukotvený otisk se v řetězu nenachází.
 */
import { readLedger, verifyChain } from '../audit-ledger.js';
import {
  createAnchor,
  readAnchors,
  anchorSummary,
  anchorMessage,
  recordAnchorDelivery,
} from '../ledger-anchor.js';

const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const noteIndex = args.indexOf('--note');
const note = noteIndex !== -1 ? args[noteIndex + 1] : undefined;
const savedIndex = args.indexOf('--saved');
const savedTo = savedIndex !== -1 ? args[savedIndex + 1] : null;

const chain = verifyChain();
if (!chain.ok) {
  console.error('Řetěz záznamů je porušený — ukotvovat ho nemá smysl:');
  for (const p of chain.problems) console.error(`  položka ${p.index}: ${p.problem}`);
  process.exit(1);
}

if (!checkOnly) {
  const { anchor, message } = createAnchor({
    note,
    // Odeslání se zaznamenává jen tehdy, když ho provozovatel potvrdí.
    // Vyrobit si potvrzení sám by znamenalo, že o důkazní hodnotě kotvy
    // rozhoduje tentýž systém, který má hlídat.
    delivered: savedTo
      ? { channel: savedTo, ok: true, at: new Date().toISOString(), by: 'operator' }
      : null,
  });
  console.log(message);
  void anchor;
  console.log('');
  console.log('─'.repeat(60));
  console.log('Zprávu výše odešlete nebo uložte MIMO tento server.');
  console.log('Kopie, která zůstane vedle záznamu, důkazní hodnotu nemá:');
  console.log('kdo smí zapisovat do řetězu, smí zapisovat i do ní.');
  console.log('─'.repeat(60));
  console.log('');
}

// Plná kontrola se předává výslovně. Skript sice výš končí, když řetěz
// neprojde, ale spoléhat na pořadí řádků znamená, že by se záruka při
// přeuspořádání skriptu tiše ztratila.
// `--check --saved` doplní potvrzení k poslední kotvě, aniž by zakládal
// novou. Ukotvovat znovu jen kvůli poznámce by zbytečně množilo kotvy.
if (checkOnly && savedTo) {
  const posledni = readAnchors().filter((a) => !a.__malformed).pop();
  if (posledni) {
    recordAnchorDelivery(posledni.anchoredAt, {
      channel: savedTo,
      ok: true,
      at: new Date().toISOString(),
      by: 'operator',
    });
    console.log(`Zaznamenáno: kotva z ${posledni.anchoredAt} uložena — ${savedTo}.`);
    console.log('');
  }
}

const stav = anchorSummary(readLedger(), readAnchors(), chain.ok);
console.log(`Stav ukotvení: ${stav.state}`);
console.log(stav.rationale);

if (stav.state === 'broken') {
  process.exit(1);
}

// Kotva nad prázdným záznamem není chyba, ale ani úspěch — a hlavně nemá
// smysl ji uchovávat v domnění, že něco dokládá.
if (stav.state === 'empty') {
  console.log('');
  console.log('Spusťte nejdřív nějaký audit a ukotvěte znovu.');
}

// Kotva, kterou nikdo neověřil proti odeslané kopii, je jen zápis v souboru.
if (stav.state === 'anchored') {
  console.log('');
  console.log('Porovnejte otisk výše s kopií, kterou máte uloženou mimo systém.');
  console.log(`Otisk: ${stav.headHash}`);
}

if (stav.state === 'internal-only') {
  console.log('');
  console.log('─'.repeat(60));
  console.log('Kotva zatím systém neopustila, takže spis ji nebude počítat');
  console.log('za doklad. Ulož text výše jinam a potvrď to příkazem:');
  console.log('');
  console.log('  node scripts/anchor-ledger.mjs --check --saved "kam jsi to uložil"');
  console.log('');
  console.log('Nástroj nemá jak ověřit, že se to opravdu stalo — je to');
  console.log('tvoje prohlášení, ne měření. Spis to tak i uvede.');
  console.log('─'.repeat(60));
}

// Poznámka pro čtenáře výstupu: `anchorMessage` je vyexportovaná, aby šlo
// text kotvy sestavit i jinde (server ji posílá do Slacku) a znění zůstalo
// jedno jediné.
void anchorMessage;
