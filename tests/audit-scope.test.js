import {
  AUDIT_RULE_SCOPE,
  AUDIT_TITLES,
  rulesForAudit,
  verdictsForAudit,
  overallVerdict,
  unknownRuleIds,
} from '../audit-scope.js';
import { RULES, isAutomated } from '../rule-registry.js';

/**
 * Vazba mezi skenem a pravidlem registru.
 *
 * Bez ní neměl neměnný záznam u předpisových kontrol žádnou oporu: dalo se
 * doložit, ŽE se měřilo, ale ne PODLE ČEHO. A spis, který vytiskne znění
 * kontroly, jež neproběhla, tvrdí její výsledek.
 */

describe('mapa skener → pravidla', () => {
  test('žádný odkaz nemíří na neexistující pravidlo', () => {
    // Překlep by vyrobil záznam odkazující na pravidlo, které nikdy
    // neexistovalo — a ten se z neměnného souboru nedá vzít zpátky.
    expect(unknownRuleIds()).toEqual([]);
  });

  test('odkazy nesou verzi', () => {
    for (const slug of Object.keys(AUDIT_RULE_SCOPE)) {
      for (const ref of rulesForAudit(slug)) {
        expect(ref).toMatch(/\.v\d+$/);
      }
    }
  });

  test('každý sken má název do spisu', () => {
    for (const slug of Object.keys(AUDIT_RULE_SCOPE)) {
      expect(AUDIT_TITLES[slug]).toBeTruthy();
    }
  });

  test('každé měřené pravidlo je v rozsahu nějakého skenu', () => {
    // Osiřelé měřené pravidlo znamená, že se kontrola dělá, ale mapa ji
    // zamlčuje — do záznamu se pak nedostane odkaz na to, podle čeho se
    // měřilo.
    const pokryta = new Set(Object.values(AUDIT_RULE_SCOPE).flat());
    const osirela = RULES.filter(isAutomated)
      .map((r) => r.id)
      .filter((id) => !pokryta.has(id));
    expect(osirela).toEqual([]);
  });

  test('pravidlo BEZ automatické kontroly v rozsahu naopak být nesmí', () => {
    // REGRESE: `aiact.cl50.4.deepfake-disclosure` má v registru metodu
    // „Neexistuje automatická kontrola" a přesto se dostalo do rozsahu.
    // Spis by pak pod nadpisem „Znění použitých pravidel" vytiskl kontrolu,
    // která nikdy neproběhla — a předchozí verze téhle sady testů tuhle
    // nepravdu dokonce vynucovala.
    const pokryta = new Set(Object.values(AUDIT_RULE_SCOPE).flat());
    const neměřená = RULES.filter((r) => !isAutomated(r));
    expect(neměřená.length).toBeGreaterThan(0);
    for (const rule of neměřená) {
      expect(pokryta.has(rule.id)).toBe(false);
    }
  });

  test('chaos test se nehlásí k žádnému pravidlu', () => {
    // Odolnostní experiment není předpisová kontrola. Přiřadit mu pravidlo
    // „aby tam nějaké bylo" by znamenalo tvrdit kontrolu, která neproběhla.
    expect(rulesForAudit('chaos-test')).toEqual([]);
  });

  test('neznámý sken nevrátí pravidla ani nespadne', () => {
    expect(rulesForAudit('neexistuje')).toEqual([]);
  });
});

describe('celkový verdikt', () => {
  const c = (ok) => ({ key: 'k', label: 'l', ok, rationale: '' });

  test('jediné porušení shodí celek', () => {
    expect(overallVerdict([c(true), c(false), c(true)])).toBe(false);
  });

  test('jediná neposouzená kontrola brání tvrdit splnění', () => {
    // Tohle je jádro věci: bez toho by sken, u kterého polovina kontrol
    // neproběhla, vyšel jako „v pořádku".
    expect(overallVerdict([c(true), c(null)])).toBeNull();
  });

  test('porušení má přednost před neprůkazným', () => {
    expect(overallVerdict([c(null), c(false)])).toBe(false);
  });

  test('vše posouzeno a bez porušení', () => {
    expect(overallVerdict([c(true), c(true)])).toBe(true);
  });

  test('prázdný seznam je neprůkazný, ne v pořádku', () => {
    expect(overallVerdict([])).toBeNull();
    expect(overallVerdict(null)).toBeNull();
  });
});

describe('čtení verdiktů z výsledků skenerů', () => {
  test('poškozený nebo chybějící výsledek nedá nález', () => {
    // Odvodit z nepřítomnosti dat porušení by znamenalo hlásit nález
    // na základě vlastní chyby.
    for (const slug of Object.keys(AUDIT_RULE_SCOPE)) {
      for (const bad of [null, undefined, 'nesmysl', {}]) {
        const v = verdictsForAudit(slug, bad);
        expect(v.every((x) => x.ok !== false)).toBe(true);
      }
    }
  });

  test('NIS2: neprůkazné hlavičky se nepovyšují na splněno', () => {
    const v = verdictsForAudit('analyze-nis2', { nis2: { isCompliant: null } });
    expect(v.find((x) => x.key === 'nis2.headers-tls').ok).toBeNull();
  });

  test('NIS2: nepodporované PQC je pozorování, ne nález ani neprůkazné', () => {
    // Post-kvantovou výměnu klíčů dnes žádný předpis nevyžaduje.
    //
    // REGRESE: změřené `false` se balilo do `null`, což mělo dva zlé
    // následky — spis tvrdil „nepodařilo se posoudit" o měření, které
    // proběhlo, a NIS2 sken nemohl NIKDY vyjít bez nálezu.
    const v = verdictsForAudit('analyze-nis2', {
      nis2: { isCompliant: true, scope: 's' },
      tls: { pqc: { supported: false, rationale: 'Nenabízí.' } },
    });
    const pqc = v.find((x) => x.key === 'tls.pqc');
    expect(pqc.ok).toBe(false);
    expect(pqc.advisory).toBe(true);
    // A hlavně: celek tím nespadne.
    expect(overallVerdict(v)).toBe(true);
  });

  test('pozorování nebrání ani nezpůsobí verdikt', () => {
    const c = (ok, advisory) => ({ key: 'k', label: 'l', ok, rationale: '', advisory });
    expect(overallVerdict([c(true, false), c(null, true)])).toBe(true);
    expect(overallVerdict([c(true, false), c(false, true)])).toBe(true);
    // Samotné pozorování bez jediné skutečné kontroly nedá verdikt žádný.
    expect(overallVerdict([c(true, true)])).toBeNull();
  });

  test('AI Act: nepoužitelná povinnost se nevydává za splněnou', () => {
    const v = verdictsForAudit('ai-act-audit', {
      aiAct: {
        obligations: [
          { id: 'art50.1', status: 'pass', title: 'A' },
          { id: 'art50.3', status: 'not_applicable', title: 'B' },
          { id: 'art50.4', status: 'inconclusive', title: 'C' },
        ],
      },
    });
    expect(v.map((x) => x.ok)).toEqual([true, null, null]);
  });

  test('zranitelnosti: verdikt skeneru se přebírá, nepřepisuje', () => {
    // REGRESE: `vulnVerdict` dřív každé `true` přepsalo na `null`, takže
    // pravidlo nemohlo nikdy vyjít bez nálezu. Skener přitom `true` dává
    // jen tehdy, když ověřil všechny nalezené knihovny — zahodit to
    // znamenalo tvrdit „nepodařilo se posoudit" o měření, které proběhlo.
    //
    // Neúplný sken vrací `null` sám (nemá co ověřit u knihoven bez verze).
    expect(
      verdictsForAudit('cra-vuln-audit', {
        cra: { isCompliant: true, vulnerabilities: [], skipped: [] },
      })[0].ok
    ).toBe(true);
    expect(
      verdictsForAudit('cra-vuln-audit', {
        cra: { isCompliant: null, vulnerabilities: [], skipped: ['React'] },
      })[0].ok
    ).toBeNull();
    expect(
      verdictsForAudit('cra-vuln-audit', {
        cra: { isCompliant: true, vulnerabilities: [], skipped: ['x'] },
      })[0].rationale
    ).toMatch(/neplyne, že aplikace zranitelná není/);
  });

  test('zranitelnosti: nalezené se hlásí jako porušení', () => {
    const v = verdictsForAudit('cra-vuln-audit', {
      cra: { isCompliant: false, vulnerabilities: [{ id: 'CVE-1' }], skipped: [] },
    });
    expect(v[0].ok).toBe(false);
  });

  test('cookies: dva oddělené verdikty, ne jeden', () => {
    // Trackery před souhlasem řeší ePrivacy, příznaky cookies aplikační
    // bezpečnost. Sloučit je znamená, že web bez trackerů, ale s relační
    // cookie čitelnou ze skriptu, projde jako bezvadný.
    const v = verdictsForAudit('cookie-audit', {
      gdpr: { isCompliant: true, rating: 'BEZ NÁLEZU' },
      cookieFlags: { ok: false, rationale: 'Relační cookie bez HttpOnly.' },
    });
    expect(v).toHaveLength(2);
    expect(overallVerdict(v)).toBe(false);
  });

  test('SBOM a chaos test zůstávají neprůkazné', () => {
    // Ani jeden není kontrola, kterou lze splnit či nesplnit.
    expect(verdictsForAudit('analyze-cra', { sbom: [1, 2] })[0].ok).toBeNull();
    expect(verdictsForAudit('chaos-test', { success: true })[0].ok).toBeNull();
  });

  test('každý dílčí verdikt nese odůvodnění', () => {
    const v = verdictsForAudit('analyze-accessibility', { violations: [], incomplete: [] });
    expect(v[0].rationale.length).toBeGreaterThan(30);
    expect(v[0].rationale).toMatch(/není důkazem přístupnosti/);
  });
});
