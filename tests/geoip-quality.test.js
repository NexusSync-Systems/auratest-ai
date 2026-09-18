import { geoQuality, geoipDatabaseDate, MAX_USABLE_RADIUS_KM } from '../geoip-quality.js';

/**
 * Fixtury se NEPÍŠÍ, generují se ze skutečné knihovny.
 *
 * Tenhle blok dřív začínal větou „Odpovědi ZACHYCENÉ ze skutečné
 * databáze… Doslovný opis toho, co `geoip.lookup()` vrátil." Kontrolní
 * vlna je porovnala s nainstalovanou knihovnou a DVĚ ZE TŘÍ byly
 * vymyšlené — `116.202.1.1` mělo mít region `''` a area 200, ne `BY`
 * a 20; `46.28.108.1` region `53` a Řečany, ne `31` a Hlubokou.
 * Chyběla i pole `range`, `eu`, `timezone`, `metro`.
 *
 * Verdikt se tím neměnil, takže z toho falešný nález neplynul. Selhal
 * ale deklarovaný účel: „kdyby se tyhle tvary změnily, chceme si toho
 * všimnout při povýšení databáze." Toho si nikdo nevšimne, když fixtura
 * knihovnu nikdy neviděla — a slovo „doslovný" navíc odradí recenzenta,
 * aby to kontroloval. Stejný případ jako `preactAttr` u SBOM.
 *
 * Generuje `scripts/build-geoip-fixtures.mjs`. Test níž navíc knihovnu
 * JEDNOU zavolá doopravdy, takže rozchod fixtury se skutečností spadne.
 */
import fixtura from './fixtures/geoip.json';

const ZACHYCENO = Object.fromEntries(
  Object.entries(fixtura.zaznamy).map(([ip, { odpoved }]) => [ip, odpoved]),
);
/**
 * Odpověď „nevím" se nesmí číst jako „jinde".
 *
 * Nález, kvůli kterému tenhle modul vznikl, se objevil na vlastní
 * infrastruktuře: 4.223.166.194 je server v Azure Sweden Central a
 * databáze u něj vrací country US se souřadnicí 37.751/-97.822, což je
 * geografický střed Spojených států, a poloměrem nejistoty 1000 km.
 * Sken z toho udělal „prokazatelně mimo EU/EHP", tedy doložené porušení
 * GDPR u provozovatele nástroje samotného.
 */

describe('geoQuality — přiznaná nejistota není zjištění', () => {
  it('výplňová souřadnice středu USA se nepovažuje za umístění', () => {
    const r = geoQuality({ country: 'US', city: '', region: '', ll: [37.751, -97.822], area: 1000 });
    expect(r.usable).toBe(false);
    expect(r.reason).toMatch(/neumístila/);
  });

  it('maximální poloměr nejistoty se nepovažuje za umístění', () => {
    const r = geoQuality({ country: 'AU', city: '', ll: [-33.494, 143.2104], area: MAX_USABLE_RADIUS_KM });
    expect(r.usable).toBe(false);
    expect(r.reason).toMatch(/poloměr nejistoty/);
  });

  it('chybějící záznam i chybějící země jsou neprůkazné', () => {
    expect(geoQuality(null).usable).toBe(false);
    expect(geoQuality({ country: '' }).usable).toBe(false);
    expect(geoQuality(undefined).usable).toBe(false);
  });

  it('konkrétní záznam s městem a malým poloměrem projde', () => {
    const r = geoQuality({ country: 'CZ', city: 'Praha', region: '10', ll: [50.08, 14.42], area: 20 });
    expect(r.usable).toBe(true);
    expect(r.reason).toBeNull();
  });
});

describe('proti zachyceným odpovědím databáze', () => {
  it('adresa vlastního serveru v Azure je neprůkazná, ne „mimo EU"', () => {
    // Regrese na konkrétní nález. Databáze tvrdí US; z toho ale nesmí
    // vzniknout doložené porušení, protože zároveň přiznává, že adresu
    // neumístila.
    const g = ZACHYCENO['4.223.166.194'];
    expect(g.country).toBe('US');
    expect(geoQuality(g).usable).toBe(false);
  });

  it('evropské hostingy zůstávají měřitelné', () => {
    // Oprava nesmí kontrolu rezidence znehodnotit — právě u evropského
    // hostingu chce zákazník potvrzení a to musí jít vydat.
    expect(geoQuality(ZACHYCENO['116.202.1.1']).usable).toBe(true);
    expect(geoQuality(ZACHYCENO['46.28.108.1']).usable).toBe(true);
  });
});

describe('stáří databáze', () => {
  it('vrací datum, ne prázdno', () => {
    // Bez data je tvrzení o umístění serveru nepřezkoumatelné.
    const d = geoipDatabaseDate();
    expect(d).toEqual(expect.any(String));
    expect(Number.isNaN(Date.parse(d))).toBe(false);
  });
});


/**
 * POJISTKA PROTI ROZCHODU FIXTURY SE SKUTEČNOSTÍ.
 *
 * Ostatní testy v souboru běží nad fixturou, protože `geoQuality` je
 * čistá funkce a knihovnu tahat nepotřebuje. Tenhle jediný ji zavolá —
 * jinak by se fixtura mohla libovolně rozejít s tím, co databáze vrací,
 * a nikdo by si toho nevšiml. Přesně to se stalo.
 */
describe('fixtura odpovídá nainstalované knihovně', () => {
  // eslint-disable-next-line global-require
  const geoip = require('geoip-lite');

  test.each(Object.keys(ZACHYCENO))('%s vrací to, co je ve fixtuře', (ip) => {
    expect(geoip.lookup(ip)).toEqual(ZACHYCENO[ip]);
  });

  test('fixtura nese verzi knihovny i stáří databáze', () => {
    // Bez toho nejde poznat, k čemu se ta čísla vztahují — a `geoQuality`
    // je základ verdiktu „prokazatelně mimo EU/EHP".
    expect(fixtura._verzeKnihovny).toMatch(/^\d+\.\d+/);
    expect(fixtura._datumDatabaze).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // eslint-disable-next-line global-require
    expect(fixtura._verzeKnihovny).toBe(require('geoip-lite/package.json').version);
  });
});
