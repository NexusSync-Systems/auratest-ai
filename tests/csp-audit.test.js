import { auditCsp, parsePolicy, splitPolicies } from '../csp-audit.js';

/**
 * Posouzení obsahu CSP.
 *
 * Motivace: `default-src *` je platná hlavička, kterou kontrola na
 * přítomnost prohlásí za splněnou — a přitom nezakazuje nic.
 *
 * Druhá polovina testů hlídá opačný směr. Falešný nález v compliance
 * reportu stojí zákazníka čas i důvěru, a u přísně zabezpečeného webu je
 * to obzvlášť trapné.
 */

const ids = (result) => result.findings.map((f) => f.id);
const high = (result) => result.findings.filter((f) => f.severity === 'high').map((f) => f.id);

describe('rozbor politiky', () => {
  test('rozdělí direktivy a jejich hodnoty', () => {
    const map = parsePolicy("default-src 'self'; script-src 'self' https://cdn.cz");
    expect(map.get('script-src')).toEqual(["'self'", 'https://cdn.cz']);
  });

  test('u opakované direktivy platí první výskyt', () => {
    // Prohlížeč použije první a další ignoruje.
    const map = parsePolicy("script-src 'self'; script-src *");
    expect(map.get('script-src')).toEqual(["'self'"]);
  });

  test('názvy direktiv nerozlišují velikost písmen', () => {
    expect(parsePolicy("Script-SRC 'self'").has('script-src')).toBe(true);
  });

  test('čárka rozděluje víc politik v jedné hlavičce', () => {
    // HTTP slučuje opakované hlavičky čárkou.
    expect(splitPolicies("script-src 'self', default-src *")).toHaveLength(2);
  });
});

describe('bezzubé politiky se poznají', () => {
  test('chybějící hlavička je závažný nález', () => {
    const result = auditCsp(null);
    expect(result.present).toBe(false);
    expect(result.ok).toBe(false);
  });

  test('default-src * neprojde jako splněná politika', () => {
    const result = auditCsp('default-src *');
    expect(result.ok).toBe(false);
    expect(high(result)).toContain('csp.script-src.wildcard');
  });

  test('politika mlčící o skriptech je závažný nález', () => {
    expect(high(auditCsp('upgrade-insecure-requests'))).toContain('csp.script-src.missing');
  });

  test('unsafe-inline bez nonce je závažný nález', () => {
    expect(high(auditCsp("script-src 'self' 'unsafe-inline'")))
      .toContain('csp.script-src.unsafe-inline');
  });

  test('unsafe-eval je střední nález, ne závažný', () => {
    const result = auditCsp(
      "script-src 'self' 'unsafe-eval'; base-uri 'self'; frame-ancestors 'none'"
    );
    expect(ids(result)).toContain('csp.script-src.unsafe-eval');
    expect(high(result)).toEqual([]);
  });

  test('https: jako zdroj skriptů je hvězdička jinými slovy', () => {
    expect(high(auditCsp('script-src https:'))).toContain('csp.script-src.wildcard');
  });

  test('https://* taky', () => {
    // Sémanticky totožné s `https:`. Modul, který by to nepoznal, by
    // přísnější zápis odměnil zelenou.
    for (const src of ['https://*', 'http://*', '*://*', 'https://*:*', '//*']) {
      expect(high(auditCsp(`script-src ${src}`))).toContain('csp.script-src.wildcard');
    }
  });

  test('klíčová slova psaná velkými písmeny se poznají', () => {
    // Podle specifikace jsou case-insensitive a prohlížeče je respektují.
    const result = auditCsp(
      "default-src 'SELF'; script-src 'SELF' 'UNSAFE-INLINE'; base-uri 'none'; frame-ancestors 'none'"
    );
    expect(high(result)).toContain('csp.script-src.unsafe-inline');
  });

  test('script-src-elem přebíjí script-src a díra v něm je díra', () => {
    // `script-src-elem` platí pro prvky <script> místo `script-src`.
    const result = auditCsp(
      "default-src 'none'; script-src 'self'; script-src-elem 'unsafe-inline' *; " +
        "base-uri 'none'; frame-ancestors 'none'; report-uri /r"
    );
    expect(result.ok).toBe(false);
    expect(high(result)).toEqual(
      expect.arrayContaining(['csp.script-src.wildcard', 'csp.script-src.unsafe-inline'])
    );
  });

  test('hlavička bez jediné platné direktivy nic nezakazuje', () => {
    const result = auditCsp(';;;;');
    expect(result.present).toBe(true);
    expect(high(result)).toContain('csp.empty');
  });
});

describe('falešné nálezy', () => {
  test('doporučená přísná politika s strict-dynamic PROJDE', () => {
    // Doslovný tvar z csp.withgoogle.com. `https:` a `http:` jsou fallback
    // pro staré prohlížeče — ty, které rozumí CSP3, je při 'strict-dynamic'
    // ignorují. Hlásit tuhle politiku jako díru znamená potrestat nejlépe
    // zabezpečeného zákazníka.
    const result = auditCsp(
      "script-src 'nonce-r4nd0m' 'strict-dynamic' https: http:; object-src 'none'; " +
        "base-uri 'none'; frame-ancestors 'none'; report-uri /r"
    );
    expect(result.ok).toBe(true);
    expect(high(result)).toEqual([]);
  });

  test('unsafe-inline s nonce se NEhlásí jako díra', () => {
    const result = auditCsp("script-src 'self' 'nonce-abc123' 'unsafe-inline'");
    expect(high(result)).toEqual([]);
    expect(ids(result)).toContain('csp.script-src.unsafe-inline-ignored');
  });

  test('unsafe-inline s hashem taky ne', () => {
    expect(high(auditCsp("script-src 'sha256-AbCdEf=' 'unsafe-inline'"))).toEqual([]);
  });

  test('přísná politika vedle volné je PRŮNIK, tedy přísná', () => {
    // Prohlížeč vynucuje obě; zdroj musí projít každou z nich.
    const result = auditCsp("script-src 'self', default-src *");
    expect(high(result)).not.toContain('csp.script-src.wildcard');
  });

  test('base-uri stačí mít v kterékoli z politik', () => {
    const result = auditCsp("script-src 'self', base-uri 'none'; frame-ancestors 'none'");
    expect(ids(result)).not.toContain('csp.base-uri.missing');
  });

  test('script-src se dědí z default-src', () => {
    const result = auditCsp("default-src 'self'; base-uri 'self'; frame-ancestors 'none'");
    expect(ids(result)).not.toContain('csp.script-src.missing');
    expect(high(result)).toEqual([]);
  });

  test('script-src-elem dědí ze script-src, ne rovnou z default-src', () => {
    // Přeskočit prostřední článek řetězu znamená posuzovat jinou politiku,
    // než jakou vynucuje prohlížeč.
    const result = auditCsp(
      "default-src *; script-src 'self'; script-src-elem 'self'; " +
        "base-uri 'none'; frame-ancestors 'none'; object-src 'none'; report-uri /r"
    );
    expect(high(result)).toEqual([]);
  });

  test('base-uri a frame-ancestors se z default-src NEdědí', () => {
    const result = auditCsp("default-src 'self'");
    expect(ids(result)).toContain('csp.base-uri.missing');
    expect(ids(result)).toContain('csp.frame-ancestors.missing');
  });

  test('tentýž nález se nevypíše dvakrát', () => {
    const result = auditCsp("script-src 'unsafe-inline'; script-src-elem 'unsafe-inline'");
    const unsafe = ids(result).filter((id) => id === 'csp.script-src.unsafe-inline');
    expect(unsafe).toHaveLength(1);
  });

  test('přísná politika projde bez závažného nálezu', () => {
    const result = auditCsp(
      "default-src 'self'; script-src 'self'; object-src 'none'; " +
        "base-uri 'self'; frame-ancestors 'none'; report-to csp"
    );
    expect(result.ok).toBe(true);
  });
});

describe('vlastní politika nástroje', () => {
  test('CSP, kterou posílá náš Caddy, projde vlastní kontrolou', () => {
    // Nástroj vytýká cizím webům slabou CSP; bylo by trapné mít slabou
    // vlastní.
    const ours =
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' " +
      "https://fonts.googleapis.com; img-src 'self' data: blob:; font-src 'self' " +
      "data: https://fonts.gstatic.com; connect-src 'self' " +
      'https://identitytoolkit.googleapis.com https://securetoken.googleapis.com ' +
      "https://firestore.googleapis.com; frame-ancestors 'none'; base-uri 'self'; " +
      "form-action 'self'";

    const result = auditCsp(ours);
    expect(result.ok).toBe(true);
    // Jediná zbylá mezera je hlášení porušení; `object-src` se dědí
    // z `default-src 'self'`.
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
    expect(() => auditCsp('@#$%^&*')).not.toThrow();
  });
});
