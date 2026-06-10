import { describe, it, expect } from 'vitest';
import { flattenObject, validateReadOnlyQuery } from '../../db-connector.js';
import { generatePlaywrightScript } from '../../agent.js';

describe('db-connector.js - flattenObject', () => {
  it('should flatten a nested object correctly', () => {
    const input = {
      a: 1,
      b: {
        c: 2,
        d: {
          e: 3
        }
      }
    };
    const expected = {
      'a': '1',
      'b.c': '2',
      'b.d.e': '3'
    };
    expect(flattenObject(input)).toEqual(expected);
  });

  it('should handle null or non-object input gracefully', () => {
    expect(flattenObject(null)).toEqual({});
    expect(flattenObject('string')).toEqual({});
    expect(flattenObject(123)).toEqual({});
  });

  it('should handle arrays by stringifying them', () => {
    const input = { a: [1, 2, 3] };
    const expected = { a: '1,2,3' };
    expect(flattenObject(input)).toEqual(expected);
  });

  it('should handle empty objects', () => {
    expect(flattenObject({})).toEqual({});
  });
});

describe('db-connector.js - validateReadOnlyQuery', () => {
  it('should pass for standard SELECT queries', () => {
    expect(validateReadOnlyQuery('SELECT * FROM users')).toEqual('SELECT * FROM users');
    expect(validateReadOnlyQuery('  SELECT id, name FROM table  ')).toEqual('SELECT id, name FROM table');
  });

  it('should pass for standard WITH queries', () => {
    expect(validateReadOnlyQuery('WITH cte AS (SELECT 1) SELECT * FROM cte')).toEqual('WITH cte AS (SELECT 1) SELECT * FROM cte');
  });

  it('should ignore comments', () => {
    expect(validateReadOnlyQuery('-- this is a comment\nSELECT * FROM users')).toEqual('SELECT * FROM users');
    expect(validateReadOnlyQuery('/* inline comment */ SELECT * FROM users')).toEqual('SELECT * FROM users');
  });

  it('should throw error for UPDATE, INSERT, DELETE or DROP queries', () => {
    expect(() => validateReadOnlyQuery('UPDATE users SET name = "test"')).toThrow('Dovoleno je pouze čtení přes SELECT nebo WITH dotazy.');
    expect(() => validateReadOnlyQuery('INSERT INTO users (id) VALUES (1)')).toThrow('Dovoleno je pouze čtení přes SELECT nebo WITH dotazy.');
    expect(() => validateReadOnlyQuery('DELETE FROM users')).toThrow('Dovoleno je pouze čtení přes SELECT nebo WITH dotazy.');
    expect(() => validateReadOnlyQuery('DROP TABLE users')).toThrow('Dovoleno je pouze čtení přes SELECT nebo WITH dotazy.');
  });

  it('should throw error for stacked queries (containing semicolons)', () => {
    expect(() => validateReadOnlyQuery('SELECT * FROM users; DROP TABLE users')).toThrow('Vícečetné (stacked) dotazy nejsou povoleny.');
  });

  it('should throw error if query is missing', () => {
    expect(() => validateReadOnlyQuery(null)).toThrow('Chybí SQL dotaz (dbQuery).');
    expect(() => validateReadOnlyQuery('')).toThrow('Chybí SQL dotaz (dbQuery).');
  });
});

describe('agent.js - generatePlaywrightScript', () => {
  it('should generate a valid playwright script from actions', () => {
    const startUrl = 'http://localhost:3000';
    const steps = [
      { step: 1, action: 'click', target: 'login-btn', reasoning: 'Clicking login' },
      { step: 2, action: 'type', target: 'username-input', value: 'admin', reasoning: 'Entering username' },
      { step: 3, action: 'navigate', target: 'http://localhost:3000/dashboard', reasoning: 'Going to dashboard' },
      { step: 4, action: 'scroll', value: 'down', reasoning: 'Scrolling to see more' },
      { step: 5, action: 'finish', reasoning: 'Test complete' }
    ];

    const script = generatePlaywrightScript(steps, startUrl);

    expect(script).toContain(`import { test, expect } from '@playwright/test';`);
    expect(script).toContain(`await page.goto('http://localhost:3000');`);
    expect(script).toContain(`// Step 1: Clicking login`);
    expect(script).toContain(`await page.click('[data-qa-id="login-btn"]');`);
    expect(script).toContain(`// Step 2: Entering username`);
    expect(script).toContain(`await page.fill('[data-qa-id="username-input"]', 'admin');`);
    expect(script).toContain(`// Step 3: Going to dashboard`);
    expect(script).toContain(`await page.goto('http://localhost:3000/dashboard');`);
    expect(script).toContain(`// Step 4: Scrolling to see more`);
    expect(script).toContain(`await page.mouse.wheel(0, 500);`);
    expect(script).not.toContain(`Step 5`); // Finish is ignored
  });

  it('should handle wait action correctly', () => {
    const steps = [
      { step: 1, action: 'wait', reasoning: 'Waiting for load' }
    ];
    const script = generatePlaywrightScript(steps, 'http://test.com');
    expect(script).toContain(`await page.waitForTimeout(2000);`);
  });
});
