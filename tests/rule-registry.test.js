import { RULES, ruleRef, getRule, rulesetDigest, rulesetInfo } from '../rule-registry.js';

/**
 * Registr pravidel.
 *
 * Report starý rok tvrdí „hlavička CSP chybí". Bez záznamu, které pravidlo
 * tehdy běželo, ten nález nejde obhájit ani zpochybnit.
 */

describe('registr pravidel', () => {
  test('identifikátory jsou jedinečné', () => {
    const ids = RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('každé pravidlo říká, co ověřuje i co z něj neplyne', () => {
    // `limits` není poznámka pod čarou — je to součást zjištění. Pravidlo
    // bez popsaných mezí svádí ke čtení výsledku jako silnějšího, než je.
    for (const rule of RULES) {
      expect(rule.title.length).toBeGreaterThan(5);
      expect(rule.method.length).toBeGreaterThan(20);
      expect(rule.limits.length).toBeGreaterThan(20);
      expect(Number.isInteger(rule.version)).toBe(true);
      expect(rule.version).toBeGreaterThan(0);
    }
  });

  test('identifikátory používají tečkovou notaci bez verze', () => {
    for (const rule of RULES) {
      expect(rule.id).toMatch(/^[a-z0-9]+(\.[a-z0-9-]+)+$/);
      expect(rule.id).not.toMatch(/\.v\d+$/);
    }
  });

  test('ruleRef doplní verzi', () => {
    expect(ruleRef('nis2.headers.csp')).toBe('nis2.headers.csp.v1');
  });

  test('neznámé pravidlo vyhodí chybu, nevrátí tiše undefined', () => {
    // Překlep v id by jinak vyrobil záznam odkazující na pravidlo, které
    // nikdy neexistovalo — a takový důkaz je horší než žádný.
    expect(() => ruleRef('nis2.headers.csp.v1')).toThrow(/Neznámé pravidlo/);
    expect(() => ruleRef('vymyslene')).toThrow();
    expect(getRule('vymyslene')).toBeNull();
  });

  test('pokrývá všechny čtyři povinnosti čl. 50', () => {
    const ids = RULES.map((r) => r.id);
    for (const n of [1, 2, 3, 4]) {
      expect(ids.some((id) => id.startsWith(`aiact.cl50.${n}.`))).toBe(true);
    }
  });

  test('otisk sady je stabilní mezi voláními', () => {
    expect(rulesetDigest()).toBe(rulesetDigest());
    expect(rulesetDigest()).toMatch(/^[a-f0-9]{64}$/);
  });

  test('rulesetInfo nese počet i otisk', () => {
    const info = rulesetInfo();
    expect(info.count).toBe(RULES.length);
    expect(info.digest).toBe(rulesetDigest());
  });

  test('pravidla mimo dosah skenu to mají uvedené v mezích', () => {
    // Čl. 50 odst. 3 a 4 externí sken posoudit nedokáže. Kdyby to registr
    // netvrdil, mohl by report jejich neprůkaznost vydávat za nedostatek
    // měření místo za vlastnost povinnosti.
    for (const id of ['aiact.cl50.3.emotion-recognition', 'aiact.cl50.4.deepfake-disclosure']) {
      expect(getRule(id).limits).toMatch(/[Mm]imo dosah/);
    }
  });
});
