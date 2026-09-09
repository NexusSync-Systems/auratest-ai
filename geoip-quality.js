/**
 * Ví geolokační databáze, kde ta adresa je — nebo jen hádá?
 *
 * PROBLÉM, KTERÝ TO ŘEŠÍ
 * `geoip-lite` vrací u neznámé adresy záznam, který vypadá jako plnohodnotný
 * výsledek: má `country`, má souřadnice. Jenže:
 *
 *   4.223.166.194 → { country: 'US', city: '', region: '',
 *                     ll: [37.751, -97.822], area: 1000 }
 *
 * Souřadnice 37.751 / −97.822 je geografický střed Spojených států, který
 * MaxMind vrací jako výplň, když adresu neumí umístit. `area: 1000` je
 * maximální poloměr nejistoty — tisíc kilometrů. Město ani region nejsou.
 *
 * Ta konkrétní adresa je přitom veřejná adresa serveru v Azure Sweden
 * Central. Databáze v balíčku je z července a rozsah `4.0.0.0/8`, který
 * Microsoft koupil od AT&T, v ní pořád patří Spojeným státům. Sken
 * z toho vyrobil „prokazatelně mimo EU/EHP", tedy `false` = doložené
 * porušení, u vlastní infrastruktury provozovatele. Totéž by potkalo
 * každého zákazníka na Azure — a to je v Evropě velká část trhu.
 *
 * ZÁSADA
 * Odpověď „nevím" se nesmí číst jako odpověď „jinde". Když databáze
 * signalizuje maximální nejistotu, je výsledek NEPRŮKAZNÝ a do verdiktu
 * nepatří — stejně jako sonda, kterou náš build neumí sestavit.
 *
 * CO TO NEŘEŠÍ
 * Databáze zůstává nepřesná i tam, kde si je jistá. Tohle odchytí jen
 * přiznanou nejistotu, ne tichý omyl. Proto k tomu patří i uvedení stáří
 * databáze v reportu — bez data je tvrzení o umístění serveru
 * nepřezkoumatelné.
 */

import fs from 'fs';
import path from 'path';
// PROJECT_ROOT, ne `import.meta.url`: testy běží přes babel-jest, který ESM
// převádí na CommonJS a `import.meta` v něm neexistuje. Projekt to takhle
// řeší i v `paths.js` a `audit-ledger.js`.
import { PROJECT_ROOT } from './paths.js';

/** Souřadnice, kterou MaxMind vrací místo skutečné polohy. */
const US_CENTROID = { lat: 37.751, lon: -97.822 };

/** Poloměr nejistoty, nad kterým už údaj nic neurčuje (km). */
export const MAX_USABLE_RADIUS_KM = 1000;

/**
 * Dá se z výsledku určit země?
 *
 * @param {object|null} geo výsledek `geoip.lookup()`
 * @returns {{usable: boolean, reason: string|null}}
 */
export function geoQuality(geo) {
  if (!geo || typeof geo !== 'object') {
    return { usable: false, reason: 'adresa v databázi není' };
  }
  if (!geo.country) {
    return { usable: false, reason: 'záznam neuvádí zemi' };
  }

  const ll = Array.isArray(geo.ll) ? geo.ll : null;
  const naStreduUSA = ll
    && Math.abs(ll[0] - US_CENTROID.lat) < 0.01
    && Math.abs(ll[1] - US_CENTROID.lon) < 0.01;

  // Výplňová souřadnice je nejsilnější signál: znamená, že databáze
  // adresu neumístila a doplnila střed země.
  if (naStreduUSA) {
    return { usable: false, reason: 'databáze adresu neumístila (výplňová souřadnice)' };
  }

  if (typeof geo.area === 'number' && geo.area >= MAX_USABLE_RADIUS_KM) {
    return {
      usable: false,
      reason: `poloměr nejistoty ${geo.area} km — údaj neurčuje ani zemi`,
    };
  }

  return { usable: true, reason: null };
}

/**
 * Datum databáze v balíčku.
 *
 * Bez něj je tvrzení o umístění serveru nepřezkoumatelné: proti námitce
 * „ten rozsah byl mezitím přeregistrován" není čím argumentovat. Čte se
 * čas souboru, protože `geoip-lite` datum snímku nikde neuvádí.
 */
export function geoipDatabaseDate() {
  try {
    const soubor = path.join(
      PROJECT_ROOT, 'node_modules', 'geoip-lite', 'data', 'geoip-country.dat'
    );
    return fs.statSync(soubor).mtime.toISOString();
  } catch {
    // Bez data se to musí říct, ne mlčky vynechat.
    return null;
  }
}
