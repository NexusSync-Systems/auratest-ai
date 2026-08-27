import {
  AUDIT_RULE_SCOPE,
  AUDIT_TITLES,
  rulesForAudit,
  verdictsForAudit,
  overallVerdict,
  unknownRuleIds,
} from '../audit-scope.js';
import { RULES } from '../rule-registry.js';

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

  test('každé pravidlo registru někdo vyhodnocuje', () => {
    // Osiřelé pravidlo znamená jedno ze dvou: buď se kontrola nedělá a
    // registr slibuje víc, než nástroj umí, nebo se dělá a mapa ji zamlčuje.
    // Obojí je pro doložitelnost problém.
    const pokryta = new Set(Object.values(AUDIT_RULE_SCOPE).flat());
    const osirela = RULES.map((r) => r.id).filter((id) => !pokryta.has(id));
    expect(osirela).toEqual([]);
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

  test('NIS2: nepodporované PQC není porušení předpisu', () => {
    // Post-kvantovou výměnu klíčů dnes žádný předpis nevyžaduje.
    const v = verdictsForAudit('analyze-nis2', {
      nis2: { isCompliant: true },
      tls: { pqc: { supported: false, rationale: 'Nenabízí.' } },
    });
    expect(v.find((x) => x.key === 'tls.pqc').ok).toBeNull();
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

  test('zranitelnosti: nula nálezů není splněno', () => {
    // „Nic ze zjištěných verzí nesedí na známou zranitelnost" není totéž
    // co „aplikace je bez zranitelností" — sken nevidí serverové závislosti
    // a u části knihoven se verzi zjistit nedaří.
    const v = verdictsForAudit('cra-vuln-audit', {
      cra: { isCompliant: true, vulnerabilities: [], skipped: ['x'] },
    });
    expect(v[0].ok).toBeNull();
    expect(v[0].rationale).toMatch(/neplyne, že aplikace zranitelná není/);
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
