#!/usr/bin/env node
/**
 * Vygeneruje fixtury pro `tests/geoip-quality.test.js` ze SKUTEČNÉ knihovny.
 *
 * PROČ TENHLE SKRIPT VZNIKL
 * Fixtury v testu byly uvozené větou „Odpovědi ZACHYCENÉ ze skutečné
 * databáze… Doslovný opis toho, co `geoip.lookup()` vrátil." Kontrolní
 * vlna je porovnala s nainstalovanou knihovnou a dvě ze tří byly
 * vymyšlené:
 *
 *   116.202.1.1  fixtura: region 'BY', city 'Munich', ll [48.1543, 11.5545], area 20
 *                skutečnost: region '', city '', ll [51.2993, 9.491], area 200
 *   46.28.108.1  fixtura: region '31', city 'Hluboka nad Vltavou', ll [49.05, 14.4333]
 *                skutečnost: region '53', city 'Recany nad Labem', ll [50.05, 15.4833]
 *
 * Verdikt se tím dnes nemění (`geoQuality` je nad skutečnými záznamy
 * stejný), takže z toho falešný nález neplynul. Selhal ale deklarovaný
 * účel: „Kdyby se tyhle tvary někdy změnily, chceme si toho všimnout při
 * povýšení databáze." Toho si nikdo nevšimne, když fixtura knihovnu
 * nikdy neviděla — a věta „doslovný opis" navíc odradí recenzenta,
 * aby to kontroloval.
 *
 * Stejný postup jako u SBOM fixtur (`scripts/build-sbom-fixtures.mjs`):
 * fixtura se NEPÍŠE, generuje se ze zdroje.
 *
 * Použití:
 *   node scripts/build-geoip-fixtures.mjs
 *
 * Spusť po každém `npm update geoip-lite` nebo po obnově databáze.
 */
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const geoip = require('geoip-lite');

/**
 * Adresy, ne odpovědi. Každá pokrývá jeden případ, který `geoQuality`
 * rozlišuje — proč tam je, stojí u ní.
 */
const ADRESY = {
  '4.223.166.194':
    'veřejná adresa vlastního serveru v Azure Sweden Central; databáze '
    + 'u ní vrací country US se souřadnicí geografického středu USA '
    + 'a poloměrem 1000 km. Kvůli ní tenhle modul vznikl.',
  '116.202.1.1': 'Hetzner, Německo',
  '46.28.108.1': 'Wedos, Česko',
  '8.8.8.8': 'Google DNS — běžná veřejná adresa pro srovnání',
};

const dat = path.join(path.dirname(require.resolve('geoip-lite')), '..', 'data', 'geoip-country.dat');
const stariDatabaze = fs.existsSync(dat)
  ? fs.statSync(dat).mtime.toISOString().slice(0, 10)
  : 'neznámé';

const zaznamy = {};
for (const [ip, popis] of Object.entries(ADRESY)) {
  const odpoved = geoip.lookup(ip);
  zaznamy[ip] = { popis, odpoved };
  console.log(`${ip.padEnd(16)} ${JSON.stringify(odpoved)}`);
}

const out = path.join(process.cwd(), 'tests', 'fixtures', 'geoip.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `${JSON.stringify({
  _generovano: 'scripts/build-geoip-fixtures.mjs — NEUPRAVOVAT RUČNĚ',
  _verzeKnihovny: require('geoip-lite/package.json').version,
  _datumDatabaze: stariDatabaze,
  _vygenerovano: new Date().toISOString().slice(0, 10),
  zaznamy,
}, null, 2)}\n`);

console.log(`\n✔ Zapsáno do ${out}`);
console.log(`  geoip-lite ${require('geoip-lite/package.json').version}, databáze z ${stariDatabaze}`);
