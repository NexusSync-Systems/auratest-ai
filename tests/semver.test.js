import { normalizeSemver } from '../semver.js';

/**
 * Verze, kterou nástroj posílá do databáze zranitelností OSV.
 *
 * Na tomhle čísle stojí verdikt „FAIL: okamžitě aktualizujte závislosti".
 * Když si ho nástroj domyslí, domýšlí si i ten verdikt.
 */

describe('normalizeSemver', () => {
  it('přijme úplnou verzi', () => {
    expect(normalizeSemver('3.6.0')).toBe('3.6.0');
    expect(normalizeSemver('v18.2.1')).toBe('18.2.1');
    expect(normalizeSemver('jQuery 3.5.1 (minified)')).toBe('3.5.1');
  });

  it('NEDOPLŇUJE chybějící patch verzi', () => {
    // Regrese: z „2.6" se dělalo „2.6.0" a na tohle domyšlené číslo se pak
    // zeptalo OSV. Nasazená 2.6.14 s opravenými CVE tak mohla dostat FAIL.
    // Neověřená knihovna je lepší výsledek než vymyšlený verdikt.
    expect(normalizeSemver('2.6')).toBeNull();
    expect(normalizeSemver('3.x')).toBeNull();
    expect(normalizeSemver('18')).toBeNull();
  });

  it('odmítne řetězce bez verze', () => {
    expect(normalizeSemver('detekováno')).toBeNull();
    expect(normalizeSemver('detekováno (přes DevTools)')).toBeNull();
    expect(normalizeSemver('')).toBeNull();
    expect(normalizeSemver(null)).toBeNull();
    expect(normalizeSemver(undefined)).toBeNull();
    expect(normalizeSemver(42)).toBeNull();
  });

  it('výsledek je vždy buď platný semver, nebo null', () => {
    const inputs = ['1.2.3', '2.6', 'x', '', 'v0.0.1', '10.20.30-beta', '3.x', 'detekováno'];
    for (const input of inputs) {
      const out = normalizeSemver(input);
      if (out !== null) expect(out).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });
});
