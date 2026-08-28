#!/usr/bin/env node
/**
 * Kontrola běhového prostředí — umí tenhle stroj vůbec to, co nástroj tvrdí?
 *
 * PROČ TO EXISTUJE
 * TLS sondy nezávisí na verzi Node, ale na verzi OpenSSL, se kterou je Node
 * sestavený. Ta se mezi buildy liší a slabé sady šifer z novějších buildů
 * mizí úplně — `@SECLEVEL=0` je nevrátí, protože nejsou zkompilované.
 *
 * Když sonda nemůže vzniknout, `tls.connect` vyhodí výjimku ještě před
 * navázáním spojení a výsledek skončí jako `null`. Sken tím tiše ztratí
 * jednu kontrolu. Nikde se to neprojeví: testy jsou zelené, protože
 * klasifikační funkce se testují dosazenými hodnotami, a report jen napíše
 * „neprůkazné". Rozdíl mezi „server je v pořádku" a „nezměřili jsme to"
 * je přitom celý smysl tohohle nástroje.
 *
 * Skript proto vypíše, co prostředí skutečně umí, aby to bylo vidět
 * v logu CI vedle výsledku testů — ne až v produkci na zákaznickém webu.
 *
 * ROZDÍL MEZI SELHÁNÍM A UPOZORNĚNÍM
 * Skript končí nenulově jen tehdy, když prostředí nesplňuje POŽADAVEK,
 * který má kód napsaný v hlavičce (OpenSSL 3.5+). Nedostupná jednotlivá
 * sonda je zatím upozornění, protože kód s ní ještě neumí naložit poctivě
 * — vrací `null` bez rozlišení, jestli za to může prostředí, nebo cíl.
 * Až se to opraví, patří sem tvrdý test: nedostupná sonda musí být
 * v reportu označená jako neměřitelná, ne jako neprůkazný výsledek měření.
 */
import tls from 'tls';
import { CIPHER_PROBES, PQC_GROUP } from '../tls-audit.js';

/** Hlavička `tls-audit.js` požaduje OpenSSL 3.5+ kvůli hybridní PQC skupině. */
const MIN_OPENSSL = [3, 5];

/** `3.5.7` → [3, 5, 7]; `3.0.13+quic` → [3, 0, 13]. */
function parseOpenSsl(raw) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(raw || ''));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function novejsiNeboStejne(a, b) {
  for (let i = 0; i < b.length; i++) {
    if ((a[i] ?? 0) > b[i]) return true;
    if ((a[i] ?? 0) < b[i]) return false;
  }
  return true;
}

/**
 * Jde sonda na tomhle buildu vůbec vytvořit?
 *
 * Kontext se sestavuje bez sítě, takže se tím netestuje cizí server —
 * jen to, jestli náš klient umí sadu vůbec nabídnout.
 */
function sondaDostupna(ciphers) {
  try {
    tls.createSecureContext({ ciphers, minVersion: 'TLSv1.2', maxVersion: 'TLSv1.2' });
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err.code || err.message };
  }
}

const openssl = process.versions.openssl;
const verze = parseOpenSsl(openssl);

console.log(`Node:    ${process.version}`);
console.log(`OpenSSL: ${openssl}`);
console.log('');

let selhani = 0;

if (!verze) {
  console.error(`CHYBA: verzi OpenSSL „${openssl}" se nepodařilo přečíst.`);
  selhani++;
} else if (!novejsiNeboStejne(verze, MIN_OPENSSL)) {
  console.error(
    `CHYBA: tls-audit.js vyžaduje OpenSSL ${MIN_OPENSSL.join('.')}+, ` +
      `tohle prostředí má ${openssl}.`
  );
  console.error(
    'Sondy na sady šifer a hybridní post-kvantovou výměnu klíčů by na něm ' +
      'vracely neprůkazné výsledky, aniž by bylo poznat, že za to může ' +
      'prostředí a ne měřený web.'
  );
  selhani++;
}

console.log('Sondy na sady šifer:');
const mrtve = [];
for (const probe of CIPHER_PROBES) {
  const stav = sondaDostupna(probe.ciphers);
  if (stav.ok) {
    console.log(`  dostupná   ${probe.key}`);
  } else {
    console.log(`  NEDOSTUPNÁ ${probe.key} — ${stav.reason}`);
    mrtve.push(probe.key);
  }
}

console.log('');
const pqc = (() => {
  try {
    tls.createSecureContext({ groups: PQC_GROUP });
    return true;
  } catch {
    return false;
  }
})();
console.log(`Skupina ${PQC_GROUP}: ${pqc ? 'dostupná' : 'NEDOSTUPNÁ'}`);

if (mrtve.length > 0) {
  console.log('');
  console.log('─'.repeat(64));
  console.log(`UPOZORNĚNÍ: ${mrtve.length} z ${CIPHER_PROBES.length} sond na tomhle`);
  console.log(`buildu nelze sestavit: ${mrtve.join(', ')}.`);
  console.log('');
  console.log('Sken je nenabídne, takže u nich nikdy nevznikne měření —');
  console.log('ani kladné, ani záporné. Report to dnes hlásí jako neprůkazné,');
  console.log('což je pravda o výsledku, ale zamlčuje příčinu: nezměřilo se to');
  console.log('kvůli našemu prostředí, ne kvůli cizímu webu.');
  console.log('─'.repeat(64));
}

process.exit(selhani > 0 ? 1 : 0);
