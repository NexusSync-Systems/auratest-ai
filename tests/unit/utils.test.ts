import { describe, it, expect } from 'vitest';
import { flattenObject, mapDbRowsToDict, validateReadOnlyQuery } from '../../db-connector.js';
import { generatePlaywrightScript } from '../../agent.js';

describe('Utility Functions Unit Tests', () => {
  describe('flattenObject', () => {
    it('by měla zploštit zanořený objekt s tečkovou notací', () => {
      const input = { a: { b: { c: 'hello' } }, d: 'world' };
      const result = flattenObject(input);
      expect(result).toEqual({ 'a.b.c': 'hello', 'd': 'world' });
    });

    it('by měla vrátit prázdný objekt pro null nebo nezabalený typ', () => {
      expect(flattenObject(null)).toEqual({});
      expect(flattenObject('string')).toEqual({});
      expect(flattenObject(123)).toEqual({});
    });

    it('by měla fungovat správně s prefixem', () => {
      const input = { a: '1', b: '2' };
      const result = flattenObject(input, 'test');
      expect(result).toEqual({ 'test.a': '1', 'test.b': '2' });
    });
  });

  describe('mapDbRowsToDict', () => {
    it('by měla vrátit prázdný objekt pro prázdné nebo neplatné pole', () => {
      expect(mapDbRowsToDict([])).toEqual({});
      expect(mapDbRowsToDict(null as any)).toEqual({});
      expect(mapDbRowsToDict('not array' as any)).toEqual({});
    });

    it('by měla správně mapovat sloupce s obvyklými názvy (key, value)', () => {
      const rows = [
        { key: 'hello', value: 'ahoj' },
        { key: 'world', value: 'světe' }
      ];
      expect(mapDbRowsToDict(rows)).toEqual({ 'hello': 'ahoj', 'world': 'světe' });
    });

    it('by měla mapovat první dva sloupce, pokud nezná jména sloupců', () => {
      const rows = [
        { col1: 'hello', col2: 'ahoj' },
        { col1: 'world', col2: 'světe' }
      ];
      expect(mapDbRowsToDict(rows)).toEqual({ 'hello': 'ahoj', 'world': 'světe' });
    });

    it('by měla vyhodit chybu, pokud řádek nemá alespoň dva sloupce', () => {
      const rows = [{ singleCol: 'value' }];
      expect(() => mapDbRowsToDict(rows)).toThrow(/musí vracet alespoň dva sloupce/i);
    });
  });

  describe('validateReadOnlyQuery', () => {
    it('by měla propustit validní jednoduchý SELECT dotaz', () => {
      const query = "SELECT * FROM users";
      expect(validateReadOnlyQuery(query)).toBe(query);
    });

    it('by měla propustit validní WITH dotaz', () => {
      const query = "WITH cte AS (SELECT 1) SELECT * FROM cte";
      expect(validateReadOnlyQuery(query)).toBe(query);
    });

    it('by měla vyhodit chybu pro dotaz s DROP', () => {
      const query = "SELECT * FROM users; DROP TABLE users;";
      expect(() => validateReadOnlyQuery(query)).toThrow(/Vícečetné \(stacked\) dotazy nejsou povoleny/i);

      const query2 = "SELECT 1 DROP TABLE users"; // Sice nesmysl, ale kontrolujeme regex
      expect(() => validateReadOnlyQuery(query2)).toThrow(/nepovolená klíčová slova/i);
    });

    it('by měla vyhodit chybu pro UPDATE dotaz', () => {
      const query = "UPDATE users SET name='test'";
      expect(() => validateReadOnlyQuery(query)).toThrow(/Dovoleno je pouze čtení přes SELECT nebo WITH dotazy/i);
    });
  });

  describe('generatePlaywrightScript', () => {
    it('by měla vygenerovat validní Playwright kód ze seznamu kroků', () => {
      const steps = [
        { step: 1, action: 'click', target: '1', reasoning: 'Ověření tlačítka' },
        { step: 2, action: 'type', target: '2', value: 'test_text', reasoning: 'Vyplnění pole' },
        { step: 3, action: 'navigate', target: 'https://example.com', reasoning: 'Přejít jinam' },
        { step: 4, action: 'finish', reasoning: 'Konec' }
      ];
      const script = generatePlaywrightScript(steps, 'https://start.com');

      expect(script).toContain("import { test, expect } from '@playwright/test'");
      expect(script).toContain("await page.goto('https://start.com')");
      expect(script).toContain("await page.click('[data-qa-id=\"1\"]')");
      expect(script).toContain("await page.fill('[data-qa-id=\"2\"]', 'test_text')");
      expect(script).toContain("await page.goto('https://example.com')");
      // "finish" should not generate code
      expect(script).not.toContain("finish");
    });

    it('by měla vygenerovat validní scrollovaní a čekání', () => {
      const steps = [
        { step: 1, action: 'scroll', value: 'down', reasoning: 'Scroll dolů' },
        { step: 2, action: 'wait', reasoning: 'Čekání' }
      ];
      const script = generatePlaywrightScript(steps, 'https://start.com');
      expect(script).toContain("await page.mouse.wheel(0, 500)");
      expect(script).toContain("await page.waitForTimeout(2000)");
    });
  });
});
