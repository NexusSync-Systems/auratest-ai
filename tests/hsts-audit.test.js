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
      // `valid` říká, jestli by hlavičku přijal prohlížeč. Bez toho se
      // nedala odlišit platná hlavička od té, kterou prohlížeč zahodí.
      valid: true,
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

  test('duplicitní max-age hlavičku zneplatní', () => {
    // Dřív „vyhrával první výskyt". Podle RFC 6797 § 6.1 je ale opakovaná
    // direktiva vadou celé hlavičky a prohlížeč ji zahodí — hádat, kterou
    // hodnotu autor myslel, znamená tvrdit něco navíc.
    const p = parseHsts('max-age=100; max-age=99999999');
    expect(p.valid).toBe(false);
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
    expect(r.findings[0].key).toBe('hsts.invalid');
  });

  test('platnost pod jeden den se hlásí, ale verdikt neshazuje', () => {
    // Délku max-age nestanoví žádný předpis a nasazovat HSTS postupně od
    // krátkých hodnot je doporučený postup. Dřív to byl `medium` nález,
    // tedy „prokazatelně nesplněno" — web uprostřed správně prováděného
    // náběhu tak dostal doklad o porušení.
    const r = auditHsts(`max-age=${WEAK_MAX_AGE - 1}; includeSubDomains`);
    expect(r.ok).toBe(true);
    expect(r.findings[0].key).toBe('hsts.max-age-short');
    expect(r.findings[0].severity).toBe('low');
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

/**
 * Neplatné hlavičky (kontrolní vlna).
 *
 * RFC 6797 § 6.1.1: max-age-value = 1*DIGIT. Cokoli jiného hlavičku podle
 * § 6.1 zneplatní a prohlížeč ji zahodí CELOU. Dřív se hodnota četla přes
 * `parseInt`, který nečíselný zbytek mlčky utne — běžný konfigurační
 * překlep tak dostal doklad o ochraně, kterou web neměl.
 */
describe('neplatná hlavička znamená totéž co žádná', () => {
  const neplatne = [
    ['max-age=31536000s; includeSubDomains', 'jednotka za číslem'],
    ['max-age=31536000 includeSubDomains', 'chybí středník'],
    ['max-age=+31536000', 'znaménko'],
    ['max-age=31536000.5', 'desetinné číslo'],
    ['max-age=100abc', 'text za číslem'],
    ['max-age=0x1E133080', 'hexadecimálně'],
    ['max-age=99999999999999999999999999', 'přetečení rozsahu'],
    ['max-age', 'direktiva bez hodnoty'],
    ['max-agex=31536000', 'překlep v názvu direktivy'],
    ['max-age=1; max-age=31536000', 'direktiva uvedená dvakrát'],
    ['includeSubDomains; preload', 'chybí max-age úplně'],
  ];

  for (const [header, proc] of neplatne) {
    it(`${proc}: ${header}`, () => {
      const r = auditHsts(header, { https: true });
      expect(parseHsts(header).valid).toBe(false);
      expect(r.ok).toBe(false);
      expect(r.findings.some((f) => f.key === 'hsts.invalid')).toBe(true);
    });
  }

  it('neznámou direktivu vedle platné max-age ignoruje', () => {
    // Prohlížeč neznámé direktivy přeskočí. Dřív se ale „max-age2=1" četlo
    // jako max-age s hodnotou 1 a vzniknul nález na webu s roční platností.
    const r = parseHsts('max-age2=1; max-age=31536000; includeSubDomains');
    expect(r.valid).toBe(true);
    expect(r.maxAge).toBe(31536000);
    expect(auditHsts('max-age2=1; max-age=31536000; includeSubDomains').ok).toBe(true);
  });

  it('platná hlavička s uvozovkami projde', () => {
    const r = parseHsts('max-age="31536000"; includeSubDomains; preload');
    expect(r.valid).toBe(true);
    expect(r.maxAge).toBe(31536000);
    expect(r.preload).toBe(true);
  });
});

describe('víc hlaviček sloučených čárkou (RFC 6797 § 8.1)', () => {
  it('platí první hlavička, ne poslední hodnota', () => {
    const r = parseHsts('max-age=31536000; includeSubDomains, max-age=1');
    expect(r.maxAge).toBe(31536000);
    // Tady to dřív selhávalo: `parseInt` sice vzal správné číslo, ale
    // `includeSubDomains` se hledalo v celém řetězci rozděleném středníkem,
    // takže se ztratilo a vznikl nález na webu, který subdomény kryje.
    expect(r.includeSubDomains).toBe(true);
    expect(auditHsts('max-age=31536000; includeSubDomains, max-age=1').ok).toBe(true);
  });
});

describe('krátká platnost je upozornění, ne porušení', () => {
  it('max-age pod jeden den verdikt neshazuje', () => {
    // Délku nestanoví žádný předpis a náběh od krátkých hodnot je
    // doporučený postup nasazení. Dřív to byl `medium` nález, tedy
    // „prokazatelně nesplněno" ve spisu.
    const r = auditHsts('max-age=300; includeSubDomains', { https: true });
    expect(r.ok).toBe(true);
    expect(r.findings.some((f) => f.key === 'hsts.max-age-short')).toBe(true);
    expect(r.findings.every((f) => f.severity !== 'medium')).toBe(true);
  });

  it('mezi 86399 a 86400 s není útes', () => {
    expect(auditHsts('max-age=86399', { https: true }).ok)
      .toBe(auditHsts('max-age=86400', { https: true }).ok);
  });

  it('max-age=0 zůstává vypnutou ochranou', () => {
    const r = auditHsts('max-age=0', { https: true });
    expect(r.ok).toBe(false);
    expect(r.findings.some((f) => f.key === 'hsts.disabled')).toBe(true);
  });
});
