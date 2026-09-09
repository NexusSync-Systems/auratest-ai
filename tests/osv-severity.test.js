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

  it('číselné skóre převede podle prahů FIRST', () => {
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

  it('samotný vektor CVSS bez skóre závažnost neurčuje', () => {
    // Vektor by se musel spočítat; přečíst z něj číslo nejde.
    const r = severityOf({
      severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H' }],
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
