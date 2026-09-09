#!/usr/bin/env node
/**
 * Obnoví snímek IP rozsahů poskytovatelů cloudu.
 *
 * PROČ RUČNĚ A NE PŘI SKENU
 * Výsledek se commituje do repozitáře. Sken pak běží offline a je
 * reprodukovatelný — týž audit dá stejný výsledek i za rok, což záznam
 * auditů vyžaduje. Kdyby se rozsahy stahovaly během skenu, závisel by
 * výsledek na tom, co zrovna bylo na internetu, a nikdo by to nedoložil.
 *
 * KDY TO SPUSTIT
 * Poskytovatelé rozsahy mění řádově týdně. Jednou za měsíc bohatě stačí;
 * report u každého auditu uvádí datum snímku, takže je vidět, jak starý
 * podklad se použil.
 *
 * POUŽITÍ
 *   node scripts/update-cloud-ranges.mjs
 *   node scripts/update-cloud-ranges.mjs --azure-file ./ServiceTags_Public.json
 *
 * Azure zveřejňuje soubor pod adresou s datem, která se každé pondělí
 * mění. Skript zkusí několik posledních pondělků; když neuspěje, dá se
 * soubor stáhnout ručně ze stránky Microsoftu a předat přes `--azure-file`.
 */

import fs from 'fs';
import path from 'path';
import { PROJECT_ROOT } from '../paths.js';
import { regionCountry } from '../cloud-regions.js';

const OUT = path.join(PROJECT_ROOT, 'data', 'cloud-ranges.json');

const args = process.argv.slice(2);
const azureFileIdx = args.indexOf('--azure-file');
const azureFile = azureFileIdx !== -1 ? args[azureFileIdx + 1] : null;

/** Stáhne JSON a nepadá na chybě — zdroj, který nejde načíst, se přeskočí. */
async function stahni(url, popis) {
  process.stdout.write(`  ${popis} … `);
  try {
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) {
      console.log(`nepodařilo se (HTTP ${res.status})`);
      return null;
    }
    const data = await res.json();
    console.log('hotovo');
    return data;
  } catch (err) {
    console.log(`nepodařilo se (${err.message})`);
    return null;
  }
}

/** Poslední pondělky — Azure datuje soubor podle nich. */
function poslednPondelky(pocet = 6) {
  const out = [];
  const d = new Date();
  // Posun na nejbližší předchozí pondělí.
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  for (let i = 0; i < pocet; i++) {
    out.push(
      `${d.getUTCFullYear()}`
      + String(d.getUTCMonth() + 1).padStart(2, '0')
      + String(d.getUTCDate()).padStart(2, '0')
    );
    d.setUTCDate(d.getUTCDate() - 7);
  }
  return out;
}

const ranges = [];
const sources = [];
/** Regiony, které jsme v datech potkali, ale neumíme převést na zemi. */
const neznameRegiony = new Set();

function pridej({ provider, cidr, region, service }) {
  if (!cidr || !cidr.includes('.')) return; // jen IPv4
  const [ip, bitsRaw] = cidr.split('/');
  const bits = Number(bitsRaw);
  if (!Number.isInteger(bits)) return;

  const okt = ip.split('.').map(Number);
  if (okt.length !== 4 || okt.some((o) => !Number.isInteger(o) || o > 255)) return;
  const size = 2 ** (32 - bits);
  const start = Math.floor(((okt[0] * 256 + okt[1]) * 256 + okt[2]) * 256 + okt[3]) ;
  const s = Math.floor(start / size) * size;

  if (region && !regionCountry(provider, region)) neznameRegiony.add(`${provider}:${region}`);

  ranges.push({
    p: provider,
    cidr,
    s,
    e: s + size - 1,
    b: bits,
    r: region || '',
    svc: service || '',
  });
}

console.log('Stahuji rozsahy poskytovatelů:');

// ── AWS ──────────────────────────────────────────────────────────────────
const AWS_URL = 'https://ip-ranges.amazonaws.com/ip-ranges.json';
const aws = await stahni(AWS_URL, 'AWS');
if (aws?.prefixes) {
  for (const p of aws.prefixes) {
    pridej({ provider: 'aws', cidr: p.ip_prefix, region: p.region, service: p.service });
  }
  sources.push({ provider: 'aws', url: AWS_URL, snapshot: aws.createDate || null });
}

// ── Google Cloud ─────────────────────────────────────────────────────────
const GCP_URL = 'https://www.gstatic.com/ipranges/cloud.json';
const gcp = await stahni(GCP_URL, 'Google Cloud');
if (gcp?.prefixes) {
  for (const p of gcp.prefixes) {
    pridej({ provider: 'gcp', cidr: p.ipv4Prefix, region: p.scope, service: p.service });
  }
  sources.push({ provider: 'gcp', url: GCP_URL, snapshot: gcp.creationTime || null });
}

// ── Azure ────────────────────────────────────────────────────────────────
let azure = null;
let azureUrl = null;
if (azureFile) {
  process.stdout.write(`  Azure ze souboru ${azureFile} … `);
  try {
    azure = JSON.parse(fs.readFileSync(azureFile, 'utf8'));
    azureUrl = `soubor: ${path.basename(azureFile)}`;
    console.log('hotovo');
  } catch (err) {
    console.log(`nepodařilo se (${err.message})`);
  }
} else {
  const ZAKLAD = 'https://download.microsoft.com/download/7/1/D/'
    + '71D86715-5596-4529-9B13-DA13A5DE5B63/ServiceTags_Public_';
  for (const datum of poslednPondelky()) {
    const url = `${ZAKLAD}${datum}.json`;
    azure = await stahni(url, `Azure (${datum})`);
    if (azure) { azureUrl = url; break; }
  }
}
if (azure?.values) {
  for (const tag of azure.values) {
    const region = tag.properties?.region || '';
    const service = tag.properties?.systemService || tag.name || '';
    for (const cidr of tag.properties?.addressPrefixes || []) {
      pridej({ provider: 'azure', cidr, region, service });
    }
  }
  sources.push({
    provider: 'azure',
    url: azureUrl,
    snapshot: azure.changeNumber ? `changeNumber ${azure.changeNumber}` : null,
  });
}

// ── Zápis ────────────────────────────────────────────────────────────────
if (ranges.length === 0) {
  console.error('');
  console.error('Nepodařilo se stáhnout ani jeden zdroj — snímek se nepřepisuje.');
  console.error('Přepsat ho prázdným souborem by bylo horší než nechat starý:');
  console.error('sken by přišel o rozsahy a nikdo by nevěděl proč.');
  process.exit(1);
}

ranges.sort((a, b) => a.s - b.s);

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({
  generatedAt: new Date().toISOString(),
  sources,
  ranges,
}), 'utf8');

console.log('');
console.log(`Zapsáno ${ranges.length} rozsahů do ${path.relative(PROJECT_ROOT, OUT)}`);
console.log(`Velikost: ${(fs.statSync(OUT).size / 1024 / 1024).toFixed(1)} MB`);
for (const s of sources) {
  console.log(`  ${s.provider.padEnd(6)} snímek: ${s.snapshot ?? 'neuveden'}`);
}

if (neznameRegiony.size > 0) {
  console.log('');
  console.log('─'.repeat(64));
  console.log(`REGIONY BEZ PŘEVODU NA ZEMI: ${neznameRegiony.size}`);
  console.log('');
  console.log('Adresa v takovém regionu vyjde jako neprůkazná — poskytovatel');
  console.log('ji zná, ale my nevíme, ve které zemi ten region leží. Doplň je');
  console.log('do `cloud-regions.js` podle dokumentace poskytovatele.');
  console.log('');
  for (const r of [...neznameRegiony].sort().slice(0, 40)) console.log(`  ${r}`);
  if (neznameRegiony.size > 40) console.log(`  … a dalších ${neznameRegiony.size - 40}`);
  console.log('─'.repeat(64));
}
