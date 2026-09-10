import { describe, test, expect } from 'vitest';
import { normalizeUrlInput } from './normalize-url.js';

/**
 * Doplnění schématu do adresy zadané uživatelem.
 *
 * Bez něj odmítl adresu SSRF guard hláškou „Povoleno je pouze schéma http
 * nebo https" — technicky pravda, prakticky matoucí, protože uživatel
 * žádné schéma nezadal a neví tedy, co má opravit.
 */

describe('doplní https, když schéma chybí', () => {
  const bezSchematu = [
    ['test.drinkboostup.cz', 'https://test.drinkboostup.cz'],
    ['example.com', 'https://example.com'],
    ['example.com/cesta?a=1', 'https://example.com/cesta?a=1'],
    ['localhost:3000', 'https://localhost:3000'],
    ['192.168.1.1', 'https://192.168.1.1'],
    ['  example.com  ', 'https://example.com'],
  ];

  for (const [vstup, ocekavano] of bezSchematu) {
    test(`${JSON.stringify(vstup)} → ${ocekavano}`, () => {
      expect(normalizeUrlInput(vstup)).toBe(ocekavano);
    });
  }

  test('zápis //example.cz taky', () => {
    expect(normalizeUrlInput('//example.cz')).toBe('https://example.cz');
  });
});

describe('existující schéma nechá být', () => {
  test('http i https zůstanou', () => {
    expect(normalizeUrlInput('http://example.com')).toBe('http://example.com');
    expect(normalizeUrlInput('https://example.com')).toBe('https://example.com');
  });

  test('nesmyslné schéma se NEPŘEPISUJE', () => {
    // Odmítnout ho má guard a říct proč. Přepsat `ftp://` na `https://`
    // by znamenalo změřit něco jiného, než uživatel zadal — a to je
    // u nástroje, jehož výstup jde úřadu, nepřijatelné.
    expect(normalizeUrlInput('ftp://example.com')).toBe('ftp://example.com');
    expect(normalizeUrlInput('javascript:alert(1)')).toBe('javascript:alert(1)');
    expect(normalizeUrlInput('file:///etc/passwd')).toBe('file:///etc/passwd');
    expect(normalizeUrlInput('data:text/html,x')).toBe('data:text/html,x');
  });

  test('velikost písmen ve schématu nerozhoduje', () => {
    expect(normalizeUrlInput('HTTPS://example.com')).toBe('HTTPS://example.com');
  });
});

describe('prázdný vstup', () => {
  test('z ničeho se adresa nedělá', () => {
    for (const v of ['', '   ', null, undefined]) {
      expect(normalizeUrlInput(v)).toBe('');
    }
  });
});
