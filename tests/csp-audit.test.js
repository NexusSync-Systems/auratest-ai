import { auditCsp, parsePolicy } from '../csp-audit.js';

/**
 * Posouzení obsahu CSP.
 *
 * Motivace: `default-src *` je platná hlavička, kterou kontrola na
 * přítomnost prohlásí za splněnou — a přitom nezakazuje nic. Report by pak
 * tvrdil ochranu, která neexistuje.
 *
 * Druhá polovina testů hlídá opačný směr: falešný nález v compliance
 * reportu stojí zákazníka čas i důvěru.
 */

const ids = (result) => result.findings.map((f) => f.id);
const high = (result) => result.findings.filter((f) => f.severity === 'high').map((f) => f.id);

describe('rozbor politiky', () => {
  test('rozdělí direktivy a jejich hodnoty', () => {
    const map = parsePolicy("default-src 'self'; script-src 'self' https://cdn.cz");
    expect(map.get('script-src')).toEqual(["'self'", 'https://cdn.cz']);
  });

  test('u opakované direktivy platí první výskyt', () => {
    // Prohlížeč použije první a další ignoruje. Kdybychom brali poslední,
    // posuzovali bychom něco jiného, než co reálně platí.
    const map = parsePolicy("script-src 'self'; script-src *");
    expect(map.get('script-src')).toEqual(["'self'"]);
  });

  test('názvy direktiv nerozlišují velikost písmen', () => {
    expect(parsePolicy("Script-SRC 'self'").has('script-src')).toBe(true);
  });
});

describe('bezzubé politiky se poznají', () => {
  test('chybějící hlavička je závažný nález', () => {
    const result = auditCsp(null);
    expect(result.present).toBe(false);
    expect(result.ok).toBe(false);
  });

  test('default-src * neprojde jako splněná politika', () => {
    // Přesně ten případ, kvůli kterému kontrola na přítomnost nestačí.
    const result = auditCsp('default-src *');
    expect(result.ok).toBe(false);
    expect(high(result)).toContain('csp.script-src.wildcard');
  });

  test('politika mlčící o skriptech je závažný nález', () => {
    // `upgrade-insecure-requests` neobsahuje unsafe-inline ani hvězdičku —
    // protože neobsahuje nic o skriptech.
    const result = auditCsp('upgrade-insecure-requests');
    expect(high(result)).toContain('csp.script-src.missing');
  });

  test('unsafe-inline bez nonce je závažný nález', () => {
    const result = auditCsp("script-src 'self' 'unsafe-inline'");
    expect(high(result)).toContain('csp.script-src.unsafe-inline');
  });

  test('unsafe-eval je střední nález, ne závažný', () => {
    const result = auditCsp("script-src 'self' 'unsafe-eval'; base-uri 'self'; frame-ancestors 'none'");
    expect(ids(result)).toContain('csp.script-src.unsafe-eval');
    expect(high(result)).toEqual([]);
  });

  test('https: jako zdroj skriptů je hvězdička jinými slovy', () => {
    expect(high(auditCsp("script-src https:"))).toContain('csp.script-src.wildcard');
  });
});

describe('falešné nálezy', () => {
  test('unsafe-inline s nonce se NEhlásí jako díra', () => {
    // Prohlížeče podle CSP Level 2 a výš `'unsafe-inline'` při přítomnosti
    // nonce ignorují. Je to běžný zápis pro zpětnou kompatibilitu.
    const result = auditCsp("script-src 'self' 'nonce-abc123' 'unsafe-inline'");
    expect(high(result)).toEqual([]);
    expect(ids(result)).toContain('csp.script-src.unsafe-inline-ignored');
  });

  test('unsafe-inline s hashem taky ne', () => {
    const result = auditCsp("script-src 'sha256-AbCdEf=' 'unsafe-inline'");
    expect(high(result)).toEqual([]);
  });

  test('script-src se dědí z default-src', () => {
    // Politika `default-src 'self'` o skriptech mluví, i když script-src
    // nemá. Hlásit „neurčuje skripty" by byl omyl.
    const result = auditCsp("default-src 'self'; base-uri 'self'; frame-ancestors 'none'");
    expect(ids(result)).not.toContain('csp.script-src.missing');
    expect(high(result)).toEqual([]);
  });

  test('base-uri a frame-ancestors se z default-src NEdědí', () => {
    // Častý omyl: „mám default-src, takže je pokryto všechno."
    const result = auditCsp("default-src 'self'");
    expect(ids(result)).toContain('csp.base-uri.missing');
    expect(ids(result)).toContain('csp.frame-ancestors.missing');
  });

  test('přísná politika projde bez závažného nálezu', () => {
    const result = auditCsp(
      "default-src 'self'; script-src 'self'; object-src 'none'; " +
        "base-uri 'self'; frame-ancestors 'none'; report-to csp"
    );
    expect(result.ok).toBe(true);
    expect(high(result)).toEqual([]);
  });
});

describe('vlastní politika nástroje', () => {
  test('CSP, kterou posílá náš Caddy, projde vlastní kontrolou', () => {
    // Nástroj vytýká cizím webům slabou CSP; bylo by trapné mít slabou
    // vlastní. Tenhle test to hlídá.
    const ours =
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' " +
      'https://fonts.googleapis.com; img-src \'self\' data: blob:; font-src \'self\' ' +
      "data: https://fonts.gstatic.com; connect-src 'self' " +
      'https://identitytoolkit.googleapis.com https://securetoken.googleapis.com ' +
      "https://firestore.googleapis.com; frame-ancestors 'none'; base-uri 'self'; " +
      "form-action 'self'";

    const result = auditCsp(ours);
    expect(result.ok).toBe(true);

    // Jediná zbylá mezera je hlášení porušení. `object-src` se u nás dědí
    // z `default-src 'self'`, takže nález nevzniká — a je to správně:
    // hlásit ho by byl falešný nález.
    expect(ids(result)).toEqual(['csp.reporting.missing']);
  });
});

describe('hraniční vstupy', () => {
  test('prázdný řetězec i mezery se berou jako chybějící hlavička', () => {
    for (const value of ['', '   ', null, undefined]) {
      expect(auditCsp(value).present).toBe(false);
    }
  });

  test('nesmyslná hlavička nespadne', () => {
    expect(() => auditCsp(';;;;')).not.toThrow();
    expect(auditCsp(';;;;').present).toBe(true);
  });
});
