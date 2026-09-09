import { geoQuality, geoipDatabaseDate, MAX_USABLE_RADIUS_KM } from '../geoip-quality.js';

/**
 * Odpovědi ZACHYCENÉ ze skutečné databáze (geoip-lite, snímek 8. 7. 2026).
 *
 * Doslovný opis toho, co `geoip.lookup()` vrátil. Modul samotný knihovnu
 * neimportuje — je to čistá funkce nad výsledkem — takže ji netahá ani
 * test. Kdyby se tyhle tvary někdy změnily, chceme si toho všimnout při
 * povýšení databáze, ne až u zákazníka.
 */
const ZACHYCENO = {
  // veřejná adresa vlastního serveru v Azure Sweden Central
  '4.223.166.194': { range: [80740352, 81788927], country: 'US', region: '', eu: '0',
    timezone: 'America/Chicago', city: '', ll: [37.751, -97.822], metro: 0, area: 1000 },
  // Hetzner, Německo
  '116.202.1.1': { country: 'DE', region: 'BY', city: 'Munich', ll: [48.1543, 11.5545], area: 20 },
  // Wedos, Česko
  '46.28.108.1': { country: 'CZ', region: '31', city: 'Hluboka nad Vltavou', ll: [49.05, 14.4333], area: 50 },
};

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
