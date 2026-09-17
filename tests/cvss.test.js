/**
 * Základní skóre CVSS z vektoru.
 *
 * PROČ TENHLE TEST VYPADÁ TAKHLE
 * Skóre jde do dokumentu pro úřad jako závažnost zranitelnosti. Kdyby
 * vyšlo o stupeň jinak, zákazník dostane „HIGH" tam, kde patří „MEDIUM"
 * — nebo naopak. Formule má šest konstantních tabulek a dvě větve;
 * napsat ji z paměti a otestovat proti vlastnímu výpočtu by potvrdilo
 * jen to, že jsem dvakrát počítal stejně.
 *
 * Testuje se proto proti PÁRŮM VEKTOR→SKÓRE Z NVD. Ta čísla publikoval
 * někdo jiný a na našem kódu nezávisí. Kdyby se rozešla, chyba je naše.
 *
 * Zdroj párů: https://services.nvd.nist.gov/rest/json/cves/2.0
 * (dotazy `cveId=CVE-2021-44228` a `cvssV3Severity=MEDIUM|LOW`,
 * stažené 2026-09-17; `vectorString` a `baseScore` z téhož objektu).
 */
import { zakladniSkore, rozeberVektor, zaokruhliNahoru } from '../cvss.js';

/**
 * Páry z NVD. NEUPRAVOVAT podle výsledku — když test spadne, je špatně
 * náš výpočet, ne tahle tabulka.
 *
 * Pokrývá obě větve `Scope` (U i C), všechny čtyři `AttackVector`
 * hodnoty, které se v datech vyskytly, `PR:N` i `PR:L`, a hranici
 * u 10.0, kde se uplatní `Minimum(…, 10)`.
 */
const PARY_Z_NVD = [
  ['CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H', 10.0],
  ['CVSS:3.1/AV:L/AC:L/PR:L/UI:N/S:U/C:N/I:N/A:H', 5.5],
  ['CVSS:3.1/AV:L/AC:L/PR:L/UI:N/S:U/C:H/I:N/A:N', 5.5],
  ['CVSS:3.1/AV:L/AC:L/PR:L/UI:N/S:U/C:N/I:H/A:N', 5.5],
  ['CVSS:3.1/AV:L/AC:L/PR:N/UI:R/S:U/C:N/I:L/A:N', 3.3],
  ['CVSS:3.0/AV:N/AC:H/PR:N/UI:N/S:U/C:N/I:L/A:N', 3.7],
  ['CVSS:3.0/AV:L/AC:L/PR:N/UI:R/S:U/C:L/I:N/A:N', 3.3],
  ['CVSS:3.1/AV:N/AC:H/PR:N/UI:R/S:C/C:L/I:N/A:N', 3.4],
];

describe('proti publikovaným skóre z NVD', () => {
  test.each(PARY_Z_NVD)('%s → %s', (vektor, ocekavane) => {
    expect(zakladniSkore(vektor)).toBe(ocekavane);
  });

  test('žádný pár nechybí — tabulka se nesmí nepozorovaně vyprázdnit', () => {
    expect(PARY_Z_NVD).toHaveLength(8);
    expect(PARY_Z_NVD.filter(([v]) => v.includes('S:C'))).toHaveLength(2);
  });
});

describe('zaokruhliNahoru', () => {
  /**
   * Doslovný přepis pseudokódu z Přílohy A specifikace. Naivní
   * `Math.ceil(x * 10) / 10` dává jiné výsledky, protože `0.1 + 0.2`
   * je v plovoucí aritmetice `0.30000000000000004`.
   */
  test('specifikace: Roundup(4.02) = 4.1, Roundup(4.00) = 4.0', () => {
    expect(zaokruhliNahoru(4.02)).toBe(4.1);
    expect(zaokruhliNahoru(4.00)).toBe(4.0);
  });

  test('plovoucí nepřesnost nevyhodí číslo o stupeň výš', () => {
    // Naivní implementace by z 0.30000000000000004 udělala 0.4.
    expect(zaokruhliNahoru(0.1 + 0.2)).toBe(0.3);
  });
});

describe('co se odmítne', () => {
  test('CVSS 2.0 vektor se nepřepočítává na trojkovou škálu', () => {
    // Jiná stupnice, jiné metriky. Tiše to přepočítat by bylo tvrzení
    // bez opory.
    expect(zakladniSkore('AV:N/AC:M/Au:N/C:C/I:C/A:C')).toBeNull();
    expect(rozeberVektor('AV:N/AC:M/Au:N/C:C/I:C/A:C')).toBeNull();
  });

  test('chybějící metrika neznamená výchozí hodnotu', () => {
    // Dopočítat si ji by vyrobilo číslo, které ve vektoru není.
    expect(zakladniSkore('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H')).toBeNull();
  });

  test('neznámá hodnota metriky se nedohaduje', () => {
    expect(zakladniSkore('CVSS:3.1/AV:X/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H')).toBeNull();
  });

  test('nesmysl na vstupu nespadne', () => {
    expect(zakladniSkore(null)).toBeNull();
    expect(zakladniSkore('')).toBeNull();
    expect(zakladniSkore('CVSS:4.0/AV:N')).toBeNull();
  });

  test('nulový dopad dává nulu, ne chybu', () => {
    // C:N/I:N/A:N → ISS = 0 → Impact = 0 → skóre 0.
    expect(zakladniSkore('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:N')).toBe(0);
  });
});
