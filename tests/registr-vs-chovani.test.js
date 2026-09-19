import { getRule } from '../rule-registry.js';
import { SNIMEK_MAX_STARI_DNU } from '../cloud-ranges.js';
import { SOURCE_TYPE } from '../c2pa.js';
import slovnikIptc from './fixtures/iptc-digitalsourcetype.json';

/**
 * REGISTR PRAVIDEL MUSÍ ODPOVÍDAT CHOVÁNÍ.
 *
 * Registr je dokument, kterým se úřadu popisuje METODA — co se měří, jak
 * a s jakými mezemi. Když se změní chování a registr zůstane, nástroj
 * o sobě tvrdí něco, co neplatí. To se už jednou stalo (úloha „registr
 * neodráží změny z poslední opravy") a stalo se to znovu: rozsahy IPv6
 * a lhůta stárnutí snímku se nasadily, zatímco v mezích pravidla dál
 * stálo „Zpracovávají se jen adresy IPv4".
 *
 * Test NEUMÍ poznat, že se změnilo chování — to by musel vědět, co je
 * správně. Umí ale svázat text registru s KONSTANTAMI a TABULKAMI
 * v kódu, takže se ty dvě věci nemohou rozejít mlčky. Kdo změní práh
 * nebo přidá hodnotu do slovníku, dozví se to tady.
 */
describe('rezidence dat: text pravidla vs. kód', () => {
  const pravidlo = getRule('gdpr.residency.geoip');

  test('lhůta stárnutí snímku je v mezích uvedená číslem z kódu', () => {
    // Kdo změní `SNIMEK_MAX_STARI_DNU` a nechá v registru staré číslo,
    // popíše úřadu jinou metodu, než jaká běží.
    expect(pravidlo.limits).toContain(String(SNIMEK_MAX_STARI_DNU));
  });

  test('meze netvrdí, že se zpracovává jen IPv4', () => {
    // Doslovná věta z verze 3. IPv6 se zpracovává od 18. 9. 2026.
    expect(pravidlo.limits).not.toMatch(/jen adresy IPv4/i);
    expect(pravidlo.limits).toMatch(/IPv4 i IPv6/);
  });

  test('změna chování zvedla verzi a má záznam v changelogu', () => {
    expect(pravidlo.version).toBeGreaterThanOrEqual(4);
    expect(pravidlo.changelog[pravidlo.version]).toBeTruthy();
    expect(pravidlo.changelog[pravidlo.version]).toMatch(/IPv6/);
  });
});

describe('označení syntetického obsahu: text pravidla vs. slovník', () => {
  const pravidlo = getRule('aiact.cl50.2.synthetic-marking');

  test('hodnoty, které o AI nerozhodují, jsou v mezích vyjmenované', () => {
    // Tady je ta vazba nejcennější: kdo přidá do `c2pa.js` další
    // nerozhodnou hodnotu a nezmíní ji tady, změní tím, co se počítá
    // mezi „nehlásí se jako AI" — a v registru to nebude.
    const nerozhodne = slovnikIptc.hodnoty
      .filter((h) => h['očekáváme'] === SOURCE_TYPE.AMBIGUOUS)
      .map((h) => h.id);

    expect(nerozhodne.length).toBeGreaterThan(0);
    for (const id of nerozhodne) {
      expect(pravidlo.limits).toContain(id);
    }
  });

  test('meze netvrdí, že je pokrytá jen část slovníku', () => {
    // Doslovná věta z verze 2. Slovník je pokrytý celý.
    expect(pravidlo.limits).not.toMatch(/Pokryta je jen\s+část slovníku/i);
  });

  test('změna chování zvedla verzi a má záznam v changelogu', () => {
    expect(pravidlo.version).toBeGreaterThanOrEqual(3);
    expect(pravidlo.changelog[pravidlo.version]).toMatch(/compositeSynthetic/);
  });
});
