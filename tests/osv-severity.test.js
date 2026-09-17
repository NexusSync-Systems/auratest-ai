import { severityOf, severityLabel } from '../osv-severity.js';

/**
 * Závažnost se dřív při absenci pole doplňovala konstantou `'HIGH'`.
 *
 * `database_specific.severity` plní prakticky jen GHSA; u záznamů z jiných
 * zdrojů chybí, takže KAŽDÁ taková zranitelnost dostala vysokou závažnost
 * a v dokumentu pro úřad se vytiskla jako `CVE-… (HIGH)` — údaj, který
 * nikdo neměřil. Zákazníka to vede opravovat ve špatném pořadí a při
 * ověření mu to podryje důvěru i k údajům, které jsou správné.
 */

describe('severityOf', () => {
  it('záznam bez závažnosti ji nedomýšlí', () => {
    const r = severityOf({ id: 'OSV-2024-1', details: 'něco' });
    expect(r.label).toBeNull();
    expect(r.source).toBeNull();
  });

  it('slovní hodnotu z databáze přečte', () => {
    expect(severityOf({ database_specific: { severity: 'CRITICAL' } }).label).toBe('CRITICAL');
    expect(severityOf({ database_specific: { severity: 'low' } }).label).toBe('LOW');
  });

  it('MODERATE z GHSA odpovídá MEDIUM v CVSS', () => {
    expect(severityOf({ database_specific: { severity: 'MODERATE' } }).label).toBe('MEDIUM');
  });

  it('nesmyslnou slovní hodnotu nepřijme', () => {
    expect(severityOf({ database_specific: { severity: 'VELMI ZLÉ' } }).label).toBeNull();
  });

  /**
   * Číselné `score` OSV u typu `CVSS_V3` NEPOSÍLÁ — je tam vždy vektor.
   * Kontrolní vlna to ověřila proti živému api.osv.dev a potvrdila
   * mutací, že tahle větev v produkci nikdy neprošla; tenhle test tedy
   * hlídal moji představu o API.
   *
   * Zůstává jako test PRAHŮ (`scoreToLabel`), ne jako tvrzení o tom,
   * co OSV vrací. Tvar odpovědi OSV testuje případ níž — proti
   * skutečným vektorům ze skutečných záznamů.
   */
  it('prahy FIRST: číslo na stupeň závažnosti', () => {
    const s = (score) => severityOf({ severity: [{ type: 'CVSS_V3', score }] }).label;
    expect(s(9.8)).toBe('CRITICAL');
    expect(s(7.5)).toBe('HIGH');
    expect(s(5.3)).toBe('MEDIUM');
    expect(s(3.1)).toBe('LOW');
    expect(s(0)).toBe('NONE');
  });

  it('skóre má přednost před slovní hodnotou', () => {
    const r = severityOf({
      severity: [{ type: 'CVSS_V3', score: '3.1' }],
      database_specific: { severity: 'CRITICAL' },
    });
    expect(r.label).toBe('LOW');
    expect(r.source).toMatch(/CVSS/);
  });

  /**
   * TOHLE JE TVAR, KTERÝ OSV SKUTEČNĚ POSÍLÁ.
   *
   * Vektory jsou z reálných záznamů (`GHSA-35jh-r3h4-6jhm` pro lodash,
   * `GHSA-gxr4-xjj5-5px2` pro jQuery), ověřených proti živému
   * api.osv.dev. Dřív se vektor zahodil a rozhodovala slovní hodnota,
   * takže zranitelnost z jiného zdroje než GHSA neměla závažnost žádnou.
   */
  it('vektor ze skutečného záznamu OSV se spočítá', () => {
    const lodash = severityOf({
      severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:H/UI:N/S:U/C:H/I:H/A:H' }],
    });
    expect(lodash.label).toBe('HIGH');
    expect(lodash.source).toMatch(/CVSS/);

    const jquery = severityOf({
      severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:H/PR:N/UI:R/S:C/C:H/I:L/A:N' }],
    });
    expect(jquery.label).toBe('MEDIUM');
  });

  it('vektor CVSS 2.0 se nepřepočítává, spadne na slovní hodnotu', () => {
    // Jiná stupnice. Ticho je lepší než přepočet bez opory.
    const r = severityOf({
      severity: [{ type: 'CVSS_V2', score: 'AV:N/AC:M/Au:N/C:C/I:C/A:C' }],
      database_specific: { severity: 'MODERATE' },
    });
    expect(r.label).toBe('MEDIUM');
    expect(r.source).toBe('databáze zdroje');
  });

  it('nespočitatelný vektor závažnost neurčuje — ani z čísla verze', () => {
    // `parseFloat('3.1/AV:N/…')` by dalo 3.1, tedy LOW vycucané
    // z čísla verze schématu.
    const r = severityOf({
      severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L' }],
    });
    expect(r.label).toBeNull();
  });

  it('nesmyslný vstup nespadne', () => {
    for (const v of [null, undefined, 42, 'text']) {
      expect(severityOf(v).label).toBeNull();
    }
  });
});

describe('severityLabel', () => {
  it('neznámou závažnost pojmenuje, nezamlčí', () => {
    expect(severityLabel(null)).toBe('závažnost neuvedena');
    expect(severityLabel('HIGH')).toBe('HIGH');
  });
});
