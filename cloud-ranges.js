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
 * V TOMHLE NASAZENÍ SE IPv6 VĚTEV NESPOUŠTÍ
 * Ověřeno na produkčním serveru 18. 9. 2026: kontejner IPv6 trasu nemá.
 *
 *   dns.lookup('www.cloudflare.com', {all:true})
 *     → 104.16.123.96 (v4), 2606:4700::6810:7b60 (v6)   — DNS AAAA vrací
 *   net.connect('2606:4700::6810:7b60', 443)
 *     → ENETUNREACH                                      — spojení neprojde
 *
 * Chromium proto vždy spadne na IPv4 a `response.serverAddr()` vrátí
 * adresu v4. Podpora IPv6 níž je tedy správná, otestovaná a ZATÍM SPÍCÍ;
 * začne platit v okamžiku, kdy IPv6 v Dockeru někdo zapne, nebo na jiném
 * nasazení. Je to poznámka o NAŠEM prostředí, ne o měřených webech —
 * report ani tak netvrdí víc, než co naměřil: rezidenci určenou z adresy
 * IPv4, což je poctivý údaj.
 *
 * CO TO NEUMÍ
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
    // Nula správného typu: u IPv6 jsou hranice `BigInt` a míchat typy
    // v porovnání by tiše selhalo.
    let max = typeof ranges[0]?.s === 'bigint' ? 0n : 0;
    for (const r of ranges) {
      const size = r.e - r.s + (typeof r.s === 'bigint' ? 1n : 1);
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
 * Převede IPv6 na `BigInt`. Vrací `null` u čehokoli, co IPv6 není.
 *
 * PROČ TO TU VŮBEC JE
 * Modul uměl jen IPv4 a komentář to přiznával jako omezení. Jenže to
 * omezení není neutrální: Chromium na dvoustohovém stroji volí IPv6
 * (Happy Eyeballs), takže `response.serverAddr()` vrátí adresu IPv6 —
 * a rozsahy poskytovatele se vůbec nepoužijí. Verdikt pak stojí na
 * geolokační databázi, tedy PŘESNĚ na tom zdroji, jehož selhávání
 * u cloudových adres je důvodem existence celého modulu. Server v Azure
 * Sweden Central dostal přes IPv4 „US" a ten nález se opravil jen díky
 * rozsahům; přes IPv6 by se neopravil.
 *
 * Rozbor je vlastní, ne přes `net.isIPv6`: potřebujeme číslo, ne jen
 * ano/ne, a chceme odmítnout i zápisy, které Node bere shovívavě.
 */
export function ipv6ToBigInt(ip) {
  let text = String(ip || '').trim().toLowerCase();
  // `[2001:db8::1]` z URL a `fe80::1%eth0` z linkové adresy.
  if (text.startsWith('[') && text.endsWith(']')) text = text.slice(1, -1);
  const zona = text.indexOf('%');
  if (zona !== -1) text = text.slice(0, zona);
  if (!text.includes(':')) return null;

  // Koncovka v IPv4 zápisu (`::ffff:1.2.3.4`) se převede na dvě skupiny.
  const posledni = text.lastIndexOf(':');
  const konec = text.slice(posledni + 1);
  if (konec.includes('.')) {
    const v4 = ipv4ToInt(konec);
    if (v4 === null) return null;
    const horni = Math.floor(v4 / 65536);
    const dolni = v4 % 65536;
    text = `${text.slice(0, posledni + 1)}${horni.toString(16)}:${dolni.toString(16)}`;
  }

  const casti = text.split('::');
  if (casti.length > 2) return null;
  const vlevo = casti[0] ? casti[0].split(':') : [];
  const vpravo = casti.length === 2 ? (casti[1] ? casti[1].split(':') : []) : null;

  let skupiny;
  if (vpravo === null) {
    // Bez `::` musí být přesně osm skupin — dopočítávat je by znamenalo
    // domýšlet adresu, která v zápisu není.
    if (vlevo.length !== 8) return null;
    skupiny = vlevo;
  } else {
    const doplnit = 8 - vlevo.length - vpravo.length;
    // `::` musí zkracovat aspoň jednu skupinu, jinak je zápis neplatný.
    if (doplnit < 1) return null;
    skupiny = [...vlevo, ...Array(doplnit).fill('0'), ...vpravo];
  }

  let n = 0n;
  for (const g of skupiny) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    n = (n << 16n) | BigInt(Number.parseInt(g, 16));
  }
  return n;
}

/** Pevně široký šestnáctkový zápis — v JSON se `BigInt` uložit nedá. */
export function bigIntNaHex(n) {
  return n.toString(16).padStart(32, '0');
}

/** Rozloží `2600:1f00::/40` na interval. `null`, když to CIDR IPv6 není. */
export function cidr6ToRange(cidr) {
  const [ip, bitsRaw] = String(cidr || '').split('/');
  const start = ipv6ToBigInt(ip);
  const bits = Number(bitsRaw);
  if (start === null || !Number.isInteger(bits) || bits < 0 || bits > 128) return null;
  const size = 1n << BigInt(128 - bits);
  const maskovany = (start / size) * size;
  return { start: maskovany, end: maskovany + size - 1n, bits };
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
  let data = { generatedAt: null, sources: [], ranges: [], ranges6: [] };
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    // Rozsahy se řadí podle začátku, aby šlo binárně vyhledávat.
    const ranges = (raw.ranges || []).slice().sort((a, b) => a.s - b.s);

    // IPv6 se drží zvlášť a hranice se převádějí na `BigInt` až tady.
    // V JSON jsou jako pevně široký šestnáctkový zápis — `BigInt` se
    // serializovat nedá a `Number` by u 128 bitů ztratil přesnost, takže
    // by se rozsahy překrývaly a adresa by dostala cizí region.
    const ranges6 = (raw.ranges6 || [])
      .map((r) => ({ ...r, s: BigInt(`0x${r.s6}`), e: BigInt(`0x${r.e6}`) }))
      .sort((a, b) => (a.s < b.s ? -1 : (a.s > b.s ? 1 : 0)));

    data = {
      generatedAt: raw.generatedAt || null,
      sources: raw.sources || [],
      ranges,
      ranges6,
    };
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
 * Z `::ffff:1.2.3.4` udělá `1.2.3.4`; ostatní adresy nechá být.
 *
 * Prefix `::ffff:/96` je podle RFC 4291 §2.5.5.2 vyhrazený pro adresy
 * IPv4 mapované do IPv6 — jde o TÉHOŽ hostitele, ne o adresu v prostoru
 * IPv6. Rozpoznává se i šestnáctkový zápis téhož (`::ffff:401:dfa2`),
 * protože oba tvary znamenají totéž.
 */
export function odmapujIpv4(ip) {
  const text = String(ip || '').trim();
  const n = ipv6ToBigInt(text);
  if (n === null) return text;

  // Horních 80 bitů nulových a následuje 0xffff → mapovaná adresa IPv4.
  const MASKA_96 = (1n << 32n) - 1n;
  if (n >> 32n !== 0xffffn) return text;

  const v4 = Number(n & MASKA_96);
  return [v4 >>> 24, (v4 >>> 16) & 255, (v4 >>> 8) & 255, v4 & 255].join('.');
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
  const snimek = loadRanges(file);

  // IPv4 i IPv6 se hledají stejným postupem, jen v jiném poli a jiným
  // číselným typem. Sloučit je do jednoho pole nejde: `Number` a `BigInt`
  // se v JavaScriptu nedají porovnávat relačními operátory bez převodu
  // a převod na `Number` by u 128 bitů zahodil přesnost.
  //
  // ADRESA IPv4 ZAPSANÁ JAKO IPv6 PATŘÍ NA CESTU IPv4.
  //
  // `::ffff:4.223.166.194` je tentýž server jako `4.223.166.194`, jen
  // v zápisu podle RFC 4291 §2.5.5.2. Podle dvojtečky by šel hledat mezi
  // rozsahy IPv6, kde ale prefixy `::ffff:/96` nikdo nepublikuje —
  // výsledek by byl `null` a adresa by spadla na geolokační databázi,
  // tedy na zdroj, kvůli kterému tenhle modul vznikl. Ověřeno: vlastní
  // server v Azure Sweden Central vyjde přes `4.223.166.194` správně,
  // přes `::ffff:4.223.166.194` jako nenalezený.
  //
  // Jestli Chromium takový zápis ve `serverAddr().ipAddress` skutečně
  // vrací, jsem neověřil — adresy IPv4 normalizuje na tečkový zápis.
  // Je to tedy obrana do hloubky, ne dnešní chyba. Stojí jednu podmínku.
  const cistaIp = odmapujIpv4(ip);
  const jeV6 = String(cistaIp || '').includes(':');
  const n = jeV6 ? ipv6ToBigInt(cistaIp) : ipv4ToInt(cistaIp);
  if (n === null) return null;

  const ranges = jeV6 ? snimek.ranges6 : snimek.ranges;
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
  const { generatedAt, sources, ranges, ranges6 } = loadRanges(file);
  return {
    generatedAt,
    sources,
    count: ranges.length,
    count6: ranges6.length,
  };
}

/**
 * Jak starý smí snímek být, než přestane nést verdikt.
 *
 * ODKUD TO ČÍSLO JE
 * Ze snímku samotného. Poskytovatelé rozsahy vydávají průběžně:
 * Azure publikuje `ServiceTags_Public_RRRRMMDD.json` v týdenních
 * souborech, AWS mění `createDate` u `ip-ranges.json` řádově denně.
 * Devadesát dnů tedy znamená, že nám uteklo kolem TŘINÁCTI revizí.
 *
 * PROČ TO VŮBEC HLÍDAT
 * Kontrolovala se jen existence snímku. Když snímek BYL, ale byl starý,
 * vyslovil se verdikt „server v EU/EHP" nebo „mimo EU/EHP" se stejnou
 * jistotou jako nad čerstvými daty. Přitom zastaralý snímek selhává
 * dvěma způsoby a jeden z nich je tichý:
 *   • nový rozsah v něm chybí → adresa se nenajde a spadne na geolokaci,
 *     tedy na zdroj, kvůli kterému tenhle modul vznikl,
 *   • rozsah mezitím přešel do jiného regionu → vyjde CIZÍ ZEMĚ, a to
 *     s plnou jistotou.
 *
 * Práh je záměrně velkorysý: jde o to zachytit snímek, na který se
 * zapomnělo, ne trestat týden zpoždění.
 */
export const SNIMEK_MAX_STARI_DNU = 90;

/**
 * Stáří snímku ve dnech, nebo `null` když snímek nemá datum.
 */
export function stariSnimkuDnu(file = RANGES_FILE, ted = Date.now()) {
  const { generatedAt } = loadRanges(file);
  if (!generatedAt) return null;
  const kdy = Date.parse(generatedAt);
  if (Number.isNaN(kdy)) return null;
  return Math.max(0, Math.floor((ted - kdy) / 86400000));
}

/**
 * Je snímek tak starý, že z něj nelze vyslovit verdikt o zemi?
 *
 * Chybějící datum se počítá jako ZASTARALÝ. Snímek bez data neumíme
 * posoudit, a neposouditelný podklad nesmí nést tvrzení o rezidenci.
 */
export function jeSnimekZastaraly(file = RANGES_FILE, ted = Date.now()) {
  const { ranges, ranges6, generatedAt } = loadRanges(file);
  // Prázdný snímek řeší volající zvlášť („snímek není k dispozici").
  if (ranges.length === 0 && ranges6.length === 0) return false;
  if (!generatedAt) return true;
  const dnu = stariSnimkuDnu(file, ted);
  return dnu === null || dnu > SNIMEK_MAX_STARI_DNU;
}

/**
 * Obsahuje snímek vůbec nějaké rozsahy IPv6?
 *
 * Rozhoduje o tom, co se smí říct o adrese IPv6, kterou jsme nenašli.
 * Když snímek IPv6 nezná, „nenalezeno" neznamená „není to cloud" — znamená
 * to, že jsme se nedívali. Spolehnout se v takovém případě na geolokační
 * databázi by vrátilo přesně tu chybu, kvůli které tenhle modul vznikl:
 * server v Azure Sweden Central hlášený jako Spojené státy.
 *
 * Kód volající se tak nemusí ptát na verzi souboru ani na datum snímku.
 */
export function maIpv6Rozsahy(file = RANGES_FILE) {
  return loadRanges(file).ranges6.length > 0;
}
