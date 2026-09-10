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

/**
 * Názvy regionů, které znamenají „globální", ne konkrétní místo.
 *
 * PRÁZDNÝ ŘETĚZEC SEM NEPATŘÍ.
 * Původně tu byl a byla to chyba: 35 131 z 69 044 rozsahů Azure, tedy
 * skoro polovina, má region prázdný. Nejde o globální služby — jsou to
 * značky jako `AzureSQL`, `AzureMonitor` nebo `LogicApps`, u nichž Azure
 * vlastnost `region` prostě neuvádí. Prohlásit je za anycast znamenalo
 * napsat zákazníkovi do spisu, že jeho doména „běží za CDN, kde
 * geolokace ukazuje na nejbližší PoP" — tvrzení o topologii sítě, které
 * nikdo neměřil a které u databázové služby není pravdivé.
 *
 * Chybějící region znamená NEZNÁMÉ MÍSTO, ne globální službu. Rozdíl je
 * v tom, co se o adrese smí říct.
 */
const GLOBAL_REGIONS = new Set(['global', 'GLOBAL']);

let cache = null;

/**
 * Největší rozsah ve snímku — určuje, jak daleko zpět se musí hledat.
 *
 * Počítá se jednou při načtení. Bez toho by se buď procházel celý seznam,
 * nebo by se musel volit pevný strop, což se už jednou ukázalo jako
 * krátké.
 */
function maxRangeSize(ranges) {
  if (ranges.__maxSize === undefined) {
    let max = 0;
    for (const r of ranges) {
      const size = r.e - r.s + 1;
      if (size > max) max = size;
    }
    Object.defineProperty(ranges, '__maxSize', { value: max, enumerable: false });
  }
  return ranges.__maxSize;
}

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

  // Odtud zpět: seberou se VŠECHNY rozsahy, které adresu obsahují.
  //
  // Dřív se hledal jen jeden „nejužší" a při shodě šířky vyhrál ten, na
  // který se narazilo dřív — tedy náhoda daná pořadím v poli. Mělo to dva
  // následky, oba ověřené nad skutečným snímkem: ve 120 bodech dostala
  // adresa krytá službou CloudFront zemi, přestože se anycast má vyřadit,
  // a ve 3 510 bodech přebil rozsah bez regionu ten s regionem.
  //
  // Kam až zpět: rozsahy jsou seřazené podle začátku, takže stačí jít,
  // dokud je vzdálenost menší než největší rozsah ve snímku. Dřív tu byl
  // pevný strop 4000 položek a už dnes nestačil — u bloku 20.192.0.0/10
  // je potřeba 5479 kroků, takže adresy v něm vycházely jako nenalezené.
  const maxSize = maxRangeSize(ranges);
  const kryjici = [];
  for (let i = lo - 1; i >= 0; i--) {
    const r = ranges[i];
    // Za tímhle bodem už žádný rozsah adresu obsáhnout nemůže.
    if (n - r.s >= maxSize) break;
    if (r.e >= n) kryjici.push(r);
  }
  if (kryjici.length === 0) return null;

  // Anycast rozhoduje kterýkoli kryjící rozsah, ne jen ten nejužší.
  // Když je adresa vedená pod CloudFrontem, je anycast bez ohledu na to,
  // že ji zároveň pokrývá regionální blok.
  const anycast = kryjici.some(
    (r) => ANYCAST_SERVICES.has(r.svc) || GLOBAL_REGIONS.has(r.r)
  );

  // Zemi určuje nejužší rozsah, který nějakou zemi vůbec zná. Rozsah bez
  // regionu nebo s regionem mimo naši tabulku se přeskočí — neurčuje nic,
  // takže nemá co přebíjet ten, který určuje.
  let sZemi = null;
  let nejuzsi = kryjici[0];
  for (const r of kryjici) {
    if (r.b > nejuzsi.b) nejuzsi = r;
    if (!r.r || GLOBAL_REGIONS.has(r.r)) continue;
    if (!regionCountry(r.p, r.r)) continue;
    if (sZemi === null || r.b > sZemi.b) sZemi = r;
  }

  const zdroj = sZemi || nejuzsi;
  return {
    provider: zdroj.p,
    region: zdroj.r || null,
    country: anycast ? null : (sZemi ? regionCountry(sZemi.p, sZemi.r) : null),
    service: zdroj.svc || null,
    prefix: zdroj.cidr,
    anycast,
  };
}

/** Datum snímku a zdroje — pro doložitelnost v reportu. */
export function rangesSnapshot(file = RANGES_FILE) {
  const { generatedAt, sources, ranges } = loadRanges(file);
  return { generatedAt, sources, count: ranges.length };
}
