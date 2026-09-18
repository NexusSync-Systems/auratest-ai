import { regionCountry } from '../cloud-regions.js';
import { REGIONY_BEZ_DOKUMENTACE } from '../cloud-regions.js';

/**
 * Převod regionu na zemi.
 *
 * Tohle je místo, kde vzniká důkazní tvrzení: když report napíše „server
 * je v Irsku", opírá se o tenhle převod. Zdrojem musí být dokumentace
 * poskytovatele, ne odhad z názvu.
 */
describe('země se NEODVOZUJE z prefixu', () => {
  test('eu-west-2 je Londýn, tedy MIMO EHP', () => {
    // Nejnebezpečnější případ celého souboru: prefix říká „eu", ale
    // Spojené království v EHP není. Kdo by četl prefix, vyrobil by
    // falešné „v pořádku" u přenosu do třetí země.
    expect(regionCountry('aws', 'eu-west-2')).toBe('GB');
    expect(regionCountry('aws', 'eu-west-1')).toBe('IE');
  });

  test('neznámý region dá null, ne dohad', () => {
    for (const r of ['vymysleny-region-1', '', null, undefined]) {
      expect(regionCountry('aws', r)).toBeFalsy();
    }
  });
});

describe('doplněno proti dokumentaci poskytovatele', () => {
  test('gcp:asia-southeast3 je Bangkok, Thajsko', () => {
    // „asia-southeast3-a  Bangkok, Thailand, APAC" — tabulka zón na
    // cloud.google.com/compute/docs/regions-zones, ověřeno 18. 9. 2026.
    expect(regionCountry('gcp', 'asia-southeast3')).toBe('TH');
  });
});

/**
 * REGIONY, KTERÉ POSKYTOVATEL ZVEŘEJŇUJE, ALE NEPŘIZNÁVÁ.
 *
 * Skript obnovy hlásí regiony bez převodu na zemi. U čtyř z nich jsem
 * prošel oficiální dokumentaci a NENAŠEL je — poskytovatel vydává
 * rozsahy pro region, který ještě neuvedl ve veřejném seznamu.
 *
 * Ověřeno, že nejde o chybu našeho zpracování: názvy služeb u těch
 * rozsahů odpovídají poskytovateli (`AzureCloud.northeurope2`,
 * `Google Cloud`, servisní tagy AWS).
 *
 * Tenhle test drží na místě rozhodnutí zemi NEDOPLNIT.
 */
describe('neohlášené regiony zůstávají neprůkazné', () => {
  test.each(REGIONY_BEZ_DOKUMENTACE.map((x) => [x]))('%s nemá zemi', (klic) => {
    const [poskytovatel, region] = klic.split(':');
    expect(regionCountry(poskytovatel, region)).toBeFalsy();
  });

  test('název svádí, ale dohad se nepřipouští', () => {
    // `northeurope2` vypadá na Irsko (Azure má `northeurope` = Irsko),
    // `me-west-1` na Izrael, `sa-west-1` na Chile. Všechno dohady
    // z názvu — přesně to, proti čemu tenhle soubor stojí.
    expect(regionCountry('azure', 'northeurope')).toBe('IE');
    expect(regionCountry('azure', 'northeurope2')).toBeFalsy();
  });

  test('seznam je zmrazený, aby se needitoval omylem', () => {
    expect(Object.isFrozen(REGIONY_BEZ_DOKUMENTACE)).toBe(true);
  });
});
