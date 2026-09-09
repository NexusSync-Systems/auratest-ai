/**
 * Určení umístění serveru z rozsahů zveřejněných poskytovatelem cloudu.
 *
 * PROČ TO EXISTUJE
 * Geolokační databáze třetí strany u cloudových adres selhává — a to
 * způsobem, který se pozná až u zákazníka. Adresa serveru v Azure Sweden
 * Central vycházela jako Spojené státy, protože rozsah `4.0.0.0/8` koupil
 * Microsoft od AT&T a snímek databáze ho pořád vedl jako americký. Sken
 * z toho vyrobil „prokazatelně mimo EU/EHP", tedy doložené porušení GDPR.
 *
 * Po opravě se takové adresy hlásí jako neprůkazné, což je poctivé, ale
 * pro zákazníka na Azure nebo AWS to znamená, že rezidenci nepotvrdíme
 * nikdy. A to je v Evropě velká část trhu.
 *
 * PROČ JE TO LEPŠÍ DŮKAZ, NE JEN VĚTŠÍ POKRYTÍ
 * Rozsahy zveřejňuje sám provozovatel datového centra a uvádí u nich
 * region. Je to tedy údaj od toho, kdo o umístění rozhoduje — ne odhad
 * třetí strany podle registrace adresního bloku. Pro spis předkládaný
 * úřadu je to nesrovnatelně silnější podklad.
 *
 * PROČ SE DATA NESTAHUJÍ PŘI SKENU
 * Snímek je součástí repozitáře a nese datum. Sken tak běží offline a je
 * reprodukovatelný — což záznam auditů vyžaduje. Stahovat rozsahy během
 * skenu by znamenalo, že týž audit může vyjít jinak podle toho, co zrovna
 * bylo na internetu, a nikdo by to nedoložil.
 *
 * CO TO NEUMÍ
 *   • Jen IPv4. IPv6 rozsahy poskytovatelé zveřejňují taky, ale zatím se
 *     nezpracovávají; adresa IPv6 vyjde jako nenalezená, tedy neprůkazná.
 *   • Rozsah říká, kde stojí SERVER. Kam ten server data ukládá dál —
 *     do zálohy, do jiné služby — z toho neplyne nic.
 *   • Anycast služby (CloudFront, Front Door, globální load balancery)
 *     se vyřazují: jejich adresa odpovídá z nejbližšího uzlu.
 */

import fs from 'fs';
import path from 'path';
import { PROJECT_ROOT } from './paths.js';
import { regionCountry } from './cloud-regions.js';

/** Kde leží snímek rozsahů. Obnovuje `scripts/update-cloud-ranges.mjs`. */
export const RANGES_FILE = path.join(PROJECT_ROOT, 'data', 'cloud-ranges.json');

/**
 * Služby, jejichž adresy jsou anycast.
 *
 * Odpověď přijde z nejbližšího uzlu, takže region v datech neříká, kde
 * data leží. Je to tentýž důvod, proč se vyřazují domény za CDN.
 */
export const ANYCAST_SERVICES = new Set([
  'CLOUDFRONT', 'GLOBALACCELERATOR', 'ROUTE53', 'ROUTE53_HEALTHCHECKS',
  'AzureFrontDoor', 'AzureFrontDoor.Frontend', 'AzureFrontDoor.Backend',
  'AzureTrafficManager', 'AzureCDN',
  'Google Global',
]);

let cache = null;

/** Převede IPv4 na číslo. Vrací `null` u čehokoli, co IPv4 není. */
export function ipv4ToInt(ip) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(ip || '').trim());
  if (!m) return null;
  let n = 0;
  for (let i = 1; i <= 4; i++) {
    const okt = Number(m[i]);
    if (okt > 255) return null;
    n = n * 256 + okt;
  }
  return n;
}

/** Rozloží zápis `1.2.3.0/24` na číselný interval. */
export function cidrToRange(cidr) {
  const [ip, bitsRaw] = String(cidr || '').split('/');
  const start = ipv4ToInt(ip);
  const bits = Number(bitsRaw);
  if (start === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return null;
  const size = 2 ** (32 - bits);
  // Maska se aplikuje, aby `1.2.3.5/24` znamenalo `1.2.3.0/24` — zápis
  // s nenulovými bity za maskou je v datech poskytovatelů běžný.
  const maskedStart = Math.floor(start / size) * size;
  return { start: maskedStart, end: maskedStart + size - 1, bits };
}

/**
 * Načte snímek rozsahů.
 *
 * Soubor nemusí existovat — repozitář jde naklonovat a spustit i bez něj.
 * Chybějící snímek znamená, že se rozsahy nepoužijí; sken pak spadne zpět
 * na geolokaci a řekne to.
 */
export function loadRanges(file = RANGES_FILE) {
  if (cache && cache.file === file) return cache.data;
  let data = { generatedAt: null, sources: [], ranges: [] };
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    // Rozsahy se řadí podle začátku, aby šlo binárně vyhledávat.
    const ranges = (raw.ranges || []).slice().sort((a, b) => a.s - b.s);
    data = { generatedAt: raw.generatedAt || null, sources: raw.sources || [], ranges };
  } catch {
    // Chybějící nebo poškozený snímek není chyba běhu — jen o zdroj míň.
  }
  cache = { file, data };
  return data;
}

/** Zapomene načtený snímek. Jen pro testy. */
export function clearCache() {
  cache = null;
}

/**
 * Ve kterém cloudu a regionu adresa leží?
 *
 * Vrací nejužší rozsah, který adresu obsahuje. Poskytovatelé publikují
 * rozsahy překryvně — širší blok pro celý region a užší pro konkrétní
 * službu — a ten užší nese přesnější údaj.
 *
 * @returns {{provider: string, region: string, country: string|null,
 *            service: string|null, prefix: string, anycast: boolean}|null}
 */
export function lookupCloudIp(ip, file = RANGES_FILE) {
  const n = ipv4ToInt(ip);
  if (n === null) return null;

  const { ranges } = loadRanges(file);
  if (ranges.length === 0) return null;

  // Binární vyhledání první položky, jejíž začátek je za adresou.
  let lo = 0;
  let hi = ranges.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ranges[mid].s <= n) lo = mid + 1;
    else hi = mid;
  }

  // Odtud zpět: hledá se nejužší rozsah, který adresu obsahuje.
  //
  // Zpět se jde jen omezeně. Rozsahy se překrývají, ale ne donekonečna;
  // bez stropu by se u husté oblasti procházel celý seznam a lookup by
  // přestal být levný.
  let best = null;
  for (let i = lo - 1; i >= 0 && i >= lo - 4000; i--) {
    const r = ranges[i];
    if (r.e < n) continue;
    if (best === null || r.b > best.b) best = r;
  }
  if (!best) return null;

  const anycast = ANYCAST_SERVICES.has(best.svc) || !best.r;
  return {
    provider: best.p,
    region: best.r || null,
    country: anycast ? null : regionCountry(best.p, best.r),
    service: best.svc || null,
    prefix: best.cidr,
    anycast,
  };
}

/** Datum snímku a zdroje — pro doložitelnost v reportu. */
export function rangesSnapshot(file = RANGES_FILE) {
  const { generatedAt, sources, ranges } = loadRanges(file);
  return { generatedAt, sources, count: ranges.length };
}
