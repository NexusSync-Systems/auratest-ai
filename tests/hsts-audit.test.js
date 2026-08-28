import { auditHsts, parseHsts, RECOMMENDED_MAX_AGE, WEAK_MAX_AGE } from '../hsts-audit.js';

/**
 * Obsah hlavičky HSTS.
 *
 * `max-age=1` je platná hlavička. Prohlížeč si po ní pamatuje „jen přes
 * HTTPS" jednu sekundu. Dokud se posuzovala jen přítomnost, dostal takový
 * web stejný verdikt jako web s ročním max-age a preloadem.
 */

describe('rozbor hlavičky', () => {
  test('přečte všechny direktivy', () => {
    const p = parseHsts('max-age=31536000; includeSubDomains; preload');
    expect(p).toEqual({
      present: true,
      maxAge: 31536000,
      includeSubDomains: true,
      preload: true,
    });
  });

  test('velikost písmen nerozhoduje', () => {
    // RFC 6797 označuje direktivy za case-insensitive.
    const p = parseHsts('MAX-AGE=100; INCLUDESUBDOMAINS; PRELOAD');
    expect(p.maxAge).toBe(100);
    expect(p.includeSubDomains).toBe(true);
    expect(p.preload).toBe(true);
  });

  test('hodnota v uvozovkách projde', () => {
    expect(parseHsts('max-age="31536000"').maxAge).toBe(31536000);
  });

  test('duplicitní max-age: první vyhrává', () => {
    // Hádat, kterou hodnotu autor myslel, by znamenalo tvrdit něco navíc.
    expect(parseHsts('max-age=100; max-age=99999999').maxAge).toBe(100);
  });

  test('chybějící nebo nesmyslná hlavička nespadne', () => {
    for (const value of [null, undefined, '', 42, {}]) {
      expect(parseHsts(value).present).toBe(false);
    }
    expect(parseHsts('includeSubDomains').maxAge).toBeNull();
  });
});

describe('posouzení', () => {
  test('roční platnost se subdoménami projde', () => {
    const r = auditHsts(`max-age=${RECOMMENDED_MAX_AGE}; includeSubDomains`);
    expect(r.ok).toBe(true);
    expect(r.findings).toHaveLength(0);
  });

  test('chybějící hlavička je závažný nález', () => {
    const r = auditHsts(null);
    expect(r.ok).toBe(false);
    expect(r.findings[0].severity).toBe('high');
  });

  test('max-age=0 je vypnutá ochrana, ne krátká', () => {
    // Je to platný způsob, jak HSTS zrušit — musí se to říct přesně.
    const r = auditHsts('max-age=0');
    expect(r.ok).toBe(false);
    expect(r.findings[0].key).toBe('hsts.disabled');
  });

  test('hlavička bez max-age je horší než krátká platnost', () => {
    // Prohlížeče takovou hlavičku podle RFC 6797 zahazují celou.
    const r = auditHsts('includeSubDomains; preload');
    expect(r.ok).toBe(false);
    expect(r.findings[0].key).toBe('hsts.no-max-age');
  });

  test('platnost pod jeden den je symbolická', () => {
    const r = auditHsts(`max-age=${WEAK_MAX_AGE - 1}; includeSubDomains`);
    expect(r.ok).toBe(false);
    expect(r.findings[0].severity).toBe('medium');
  });

  test('půl roku je nález, ale verdikt neshodí', () => {
    // REGRESE: dřív se všechno pod rokem hlásilo mezi CHYBĚJÍCÍMI
    // hlavičkami. Tvrdit „chybí hlavička" o hlavičce, která existuje
    // a chrání — jen kratší dobu — je nepravdivé.
    const r = auditHsts('max-age=15768000; includeSubDomains');
    expect(r.ok).toBe(true);
    expect(r.findings.some((f) => f.key === 'hsts.max-age-below-year')).toBe(true);
    expect(r.findings.every((f) => f.severity === 'low')).toBe(true);
  });

  test('chybějící includeSubDomains je jen poznámka', () => {
    // U webu bez subdomén nic neřeší a zapnout to bez rozmyslu může
    // subdomény odříznout.
    const r = auditHsts(`max-age=${RECOMMENDED_MAX_AGE}`);
    expect(r.ok).toBe(true);
    expect(r.findings.map((f) => f.key)).toEqual(['hsts.no-subdomains']);
  });

  test('na nešifrovaném spojení se hlavička neposuzuje', () => {
    // Prohlížeč ji tam ignoruje, takže její absence není volba
    // provozovatele, ale důsledek protokolu.
    const r = auditHsts(null, { https: false });
    expect(r.ok).toBeNull();
    expect(r.findings).toHaveLength(0);
  });

  test('odůvodnění nikdy nechybí', () => {
    for (const header of [null, 'max-age=0', 'max-age=100', `max-age=${RECOMMENDED_MAX_AGE}`]) {
      expect(auditHsts(header).rationale.length).toBeGreaterThan(20);
    }
  });
});
