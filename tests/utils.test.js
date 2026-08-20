import { flattenObject, mapDbRowsToDict, validateReadOnlyQuery } from '../db-connector.js';
import { generatePlaywrightScript, sanitizeActionResponse } from '../agent.js';

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
      expect(mapDbRowsToDict(null)).toEqual({});
      expect(mapDbRowsToDict('not array')).toEqual({});
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
      // Hodnoty se escapují přes JSON.stringify (dvojité uvozovky) — viz test
      // na injektáž níž.
      expect(script).toContain('await page.goto("https://start.com")');
      expect(script).toContain('await page.click("[data-qa-id=\\"1\\"]")');
      expect(script).toContain('await page.fill("[data-qa-id=\\"2\\"]", "test_text")');
      expect(script).toContain('await page.goto("https://example.com")');
      // "finish" should not generate code
      expect(script).not.toContain("finish");
    });

    it('by neměla dovolit injektáž kódu přes hodnotu z LLM', () => {
      const payload = "'); require('child_process').exec('rm -rf /'); //";
      const steps = [
        {
          step: 1,
          action: 'type',
          target: 'email',
          value: payload,
          reasoning: 'Zlomyslny\nviceradkovy reasoning */'
        }
      ];
      const script = generatePlaywrightScript(steps, 'https://start.com');

      // Payload musi zustat uvnitr retezcoveho literalu (JSON.stringify),
      // ne se stat kodem.
      expect(script).toContain(`await page.fill("[data-qa-id=\\"email\\"]", ${JSON.stringify(payload)});`);

      // Reasoning nesmi rozbit komentar na dalsi radek ani ukoncit blok.
      const commentLine = script.split('\n').find((l) => l.includes('Step 1:'));
      expect(commentLine).toBe('  // Step 1: Zlomyslny viceradkovy reasoning * /');

      // Cely vystup musi byt syntakticky validni JS (Function() kod pouze
      // zkompiluje, nespousti ho).
      expect(() => new Function(script.replace(/^import .*$/m, ''))).not.toThrow();
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

  describe('sanitizeActionResponse', () => {
    const baseContext = {
      currentUrl: 'http://localhost:3000/articles',
      consoleLogs: [],
      networkErrors: [],
      steps: [],
      interactiveElements: [
        { id: 1, tagName: 'A', text: 'Přejít na hlavní stránku', href: '/' },
        { id: 2, tagName: 'A', text: 'Článek: Jak testovat s AI', href: '/articles/1' },
        { id: 3, tagName: 'INPUT', type: 'email', placeholder: 'Váš e-mail' },
        { id: 4, tagName: 'BUTTON', type: 'submit', text: 'Přihlásit se' }
      ]
    };

    it('přesměruje obecný home link na konkrétní obsahový odkaz', () => {
      const result = sanitizeActionResponse(
        { reasoning: 'Kliknu domů', action: 'click', target: 1, value: null, detected_bugs: [] },
        baseContext
      );

      expect(result.action).toBe('click');
      expect(result.target).toBe(2);
      expect(result.detected_bugs).toEqual([]);
    });

    it('vyplní neotestovaný input před submit tlačítkem', () => {
      const result = sanitizeActionResponse(
        { reasoning: 'Odešlu formulář', action: 'click', target: 4, value: null, detected_bugs: [] },
        baseContext
      );

      expect(result.action).toBe('type');
      expect(result.target).toBe(3);
      expect(result.value).toBe('neplatny-email@');
    });

    it('nahradí opakovanou akci bezpečným dalším krokem', () => {
      const result = sanitizeActionResponse(
        { reasoning: 'Zkusím stejný odkaz', action: 'click', target: 2, value: null, detected_bugs: [] },
        { ...baseContext, steps: [{ step: 1, action: 'click', target: 2 }] }
      );

      expect(actionTarget(result)).not.toBe('click:2');
    });

    it('převede relativní navigate na absolutní URL', () => {
      const result = sanitizeActionResponse(
        { reasoning: 'Přejdu dál', action: 'navigate', target: '/checkout', value: null, detected_bugs: [] },
        baseContext
      );

      expect(result.action).toBe('navigate');
      expect(result.target).toBe('http://localhost:3000/checkout');
    });

    it('odstraní falešné bugy při čistých runtime signálech', () => {
      const result = sanitizeActionResponse(
        {
          reasoning: 'Kliknu na článek',
          action: 'click',
          target: 2,
          value: null,
          detected_bugs: ['Kliknu na článek', 'Neexistující chyba']
        },
        baseContext
      );

      expect(result.detected_bugs).toEqual([]);
    });

    it('nahradí odpověď bez validní akce bezpečným fallbackem', () => {
      const result = sanitizeActionResponse(
        { reasoning: 'Kliknu na odkaz', href: '/' },
        {
          ...baseContext,
          interactiveElements: [
            { id: 1, tagName: 'A', text: 'Přejít na hlavní stránku', href: '/' },
            { id: 2, tagName: 'A', text: 'Článek: Jak testovat s AI', href: '/articles/1' },
            { id: 3, tagName: 'A', text: 'Článek: Checklist QA', href: '/articles/2' }
          ]
        }
      );

      expect(result.action).toBe('click');
      expect(result.target).toBe(2);
    });

    it('nevyplňuje znovu input, který už má hodnotu', () => {
      const result = sanitizeActionResponse(
        { reasoning: 'Zkusím znovu email', action: 'type', target: 1, value: 'tester@example.com', detected_bugs: [] },
        {
          ...baseContext,
          interactiveElements: [
            { id: 1, tagName: 'INPUT', type: 'email', placeholder: 'E-mail', value: 'tester@example.com' },
            { id: 2, tagName: 'INPUT', type: 'password', placeholder: 'Heslo' },
            { id: 3, tagName: 'BUTTON', type: 'submit', text: 'Přihlásit' }
          ],
          steps: [{ step: 1, action: 'type', target: 1, value: 'tester@example.com' }]
        }
      );

      expect(result.action).toBe('type');
      expect(result.target).toBe(2);
    });

    it('vybere file input před kliknutím na import', () => {
      const result = sanitizeActionResponse(
        { reasoning: 'Kliknu na import', action: 'click', target: 2, value: null, detected_bugs: [] },
        {
          ...baseContext,
          interactiveElements: [
            { id: 1, tagName: 'INPUT', type: 'file', placeholder: 'Vyberte CSV' },
            { id: 2, tagName: 'BUTTON', type: 'submit', text: 'Importovat' }
          ]
        }
      );

      expect(result.action).toBe('type');
      expect(result.target).toBe(1);
      expect(result.value).toBe('fixtures/import-valid.csv');
    });

    it('zaškrtne checkbox před submit tlačítkem', () => {
      const result = sanitizeActionResponse(
        { reasoning: 'Kliknu registrovat', action: 'click', target: 3, value: null, detected_bugs: [] },
        {
          ...baseContext,
          interactiveElements: [
            { id: 1, tagName: 'INPUT', type: 'email', placeholder: 'E-mail', value: 'new@example.com' },
            { id: 2, tagName: 'INPUT', type: 'checkbox', text: 'Souhlasím s podmínkami' },
            { id: 3, tagName: 'BUTTON', type: 'submit', text: 'Registrovat' }
          ],
          steps: [{ step: 1, action: 'type', target: 1, value: 'new@example.com' }]
        }
      );

      expect(result.action).toBe('click');
      expect(result.target).toBe(2);
    });

    it('při skutečné síťové chybě doplní chybějící detected_bugs', () => {
      const result = sanitizeActionResponse(
        { reasoning: 'Zkusím znovu načíst profil', action: 'click', target: 1, value: null, detected_bugs: [] },
        {
          ...baseContext,
          networkErrors: [{ url: 'http://localhost:3000/api/profile', error: 'net::ERR_FAILED' }],
          interactiveElements: [
            { id: 1, tagName: 'BUTTON', type: 'button', text: 'Znovu načíst profil' }
          ]
        }
      );

      expect(result.detected_bugs.length).toBeGreaterThan(0);
      expect(result.detected_bugs[0]).toMatch(/síťový požadavek/i);
    });

    it('při obecném home odkazu bez lepšího linku zvolí formulářový fallback', () => {
      const result = sanitizeActionResponse(
        { reasoning: 'Kliknu zpět', action: 'click', target: 3, value: null, detected_bugs: [] },
        {
          ...baseContext,
          interactiveElements: [
            { id: 1, tagName: 'INPUT', type: 'text', placeholder: 'Název týmu' },
            { id: 2, tagName: 'BUTTON', type: 'submit', text: 'Uložit', disabled: true },
            { id: 3, tagName: 'A', text: 'Zpět na dashboard', href: '/' }
          ]
        }
      );

      expect(result.action).toBe('type');
      expect(result.target).toBe(1);
    });

    it('na dokončené success stránce převede návrat domů na finish', () => {
      const result = sanitizeActionResponse(
        { reasoning: 'Vrátím se do obchodu', action: 'click', target: 1, value: null, detected_bugs: [] },
        {
          ...baseContext,
          currentUrl: 'http://localhost:3000/checkout/success',
          title: 'Objednávka dokončena',
          goal: 'Verify checkout completion',
          interactiveElements: [
            { id: 1, tagName: 'A', text: 'Zpět do obchodu', href: '/products' }
          ]
        }
      );

      expect(result.action).toBe('finish');
      expect(result.target).toBeNull();
    });

    it('převede kliknutí na textový input na type', () => {
      const result = sanitizeActionResponse(
        { reasoning: 'Kliknu do pole', action: 'click', target: 1, value: null, detected_bugs: [] },
        {
          ...baseContext,
          interactiveElements: [
            { id: 1, tagName: 'INPUT', type: 'text', placeholder: 'Jméno a příjmení' },
            { id: 2, tagName: 'BUTTON', type: 'submit', text: 'Odeslat objednávku' }
          ]
        }
      );

      expect(result.action).toBe('type');
      expect(result.target).toBe(1);
    });

    it('při síťové chybě preferuje retry tlačítko před navigací', () => {
      const result = sanitizeActionResponse(
        { reasoning: 'Otevřu vytvoření objednávky', action: 'click', target: 2, value: null, detected_bugs: [] },
        {
          ...baseContext,
          networkErrors: [{ url: 'http://localhost:3000/api/orders', error: 'HTTP 500' }],
          interactiveElements: [
            { id: 1, tagName: 'BUTTON', type: 'button', text: 'Znovu načíst objednávky' },
            { id: 2, tagName: 'A', text: 'Vytvořit objednávku', href: '/orders/new' }
          ]
        }
      );

      expect(result.action).toBe('click');
      expect(result.target).toBe(1);
      expect(result.detected_bugs.length).toBeGreaterThan(0);
    });

    it('při rozbité schema odpovědi zachová runtime bug ve fallbacku', () => {
      const result = sanitizeActionResponse(
        { reasoning: 'Objednávky', type: 'button', value: null },
        {
          ...baseContext,
          networkErrors: [{ url: 'http://localhost:3000/api/orders', error: 'HTTP 500' }],
          interactiveElements: [
            { id: 1, tagName: 'BUTTON', type: 'button', text: 'Znovu načíst objednávky' },
            { id: 2, tagName: 'A', text: 'Vytvořit objednávku', href: '/orders/new' }
          ]
        }
      );

      expect(result.action).toBe('click');
      expect(result.target).toBe(1);
      expect(result.detected_bugs.length).toBeGreaterThan(0);
    });

    it('při console erroru preferuje obnovovací tlačítko před detailem', () => {
      const result = sanitizeActionResponse(
        { reasoning: 'Otevřu detail uživatele', action: 'click', target: 2, value: null, detected_bugs: ['ReferenceError: userRole is not defined'] },
        {
          ...baseContext,
          consoleLogs: [{ type: 'error', text: 'ReferenceError: userRole is not defined' }],
          interactiveElements: [
            { id: 1, tagName: 'BUTTON', type: 'button', text: 'Obnovit seznam' },
            { id: 2, tagName: 'A', text: 'Detail uživatele Jana', href: '/admin/users/jana' }
          ]
        }
      );

      expect(result.action).toBe('click');
      expect(result.target).toBe(1);
    });

    it('po vybraném souboru klikne na submit místo odkazu na šablonu', () => {
      const result = sanitizeActionResponse(
        { reasoning: 'Vyberu CSV soubor znovu', action: 'type', target: 1, value: 'fixtures/import-valid.csv', detected_bugs: [] },
        {
          ...baseContext,
          interactiveElements: [
            { id: 1, tagName: 'INPUT', type: 'file', placeholder: 'Vyberte CSV', value: 'fixtures/import-valid.csv' },
            { id: 2, tagName: 'BUTTON', type: 'submit', text: 'Importovat' },
            { id: 3, tagName: 'A', text: 'Stáhnout šablonu', href: '/template.csv' }
          ],
          steps: [{ step: 1, action: 'type', target: 1, value: 'fixtures/import-valid.csv' }]
        }
      );

      expect(result.action).toBe('click');
      expect(result.target).toBe(2);
    });

    it('při runtime chybě nechá konkrétní obsahový odkaz a doplní bug', () => {
      const result = sanitizeActionResponse(
        { reasoning: 'Otevřu zákazníka ACME', action: 'click', target: 1, value: null, detected_bugs: [] },
        {
          ...baseContext,
          consoleLogs: [{ type: 'error', text: 'TypeError: customer.name is undefined' }],
          interactiveElements: [
            { id: 1, tagName: 'A', text: 'Zákazník: ACME', href: '/customers/acme' },
            { id: 2, tagName: 'BUTTON', type: 'button', text: 'Obnovit seznam' }
          ]
        }
      );

      expect(result.action).toBe('click');
      expect(result.target).toBe(1);
      expect(result.detected_bugs.length).toBeGreaterThan(0);
    });

    it('při ukládání a spinneru vrátí wait místo odchodu', () => {
      const result = sanitizeActionResponse(
        { reasoning: 'Kliknu zpět', action: 'click', target: 2, value: null, detected_bugs: [] },
        {
          ...baseContext,
          currentUrl: 'http://localhost:3000/profile/save',
          title: 'Ukládání profilu',
          visibleState: 'Saving spinner is visible and save button is disabled.',
          interactiveElements: [
            { id: 1, tagName: 'BUTTON', type: 'submit', text: 'Uložit profil', disabled: true },
            { id: 2, tagName: 'A', text: 'Zpět na profil', href: '/profile' }
          ]
        }
      );

      expect(result.action).toBe('wait');
      expect(result.target).toBeNull();
    });

    it('na uložené success stránce ukončí test', () => {
      const result = sanitizeActionResponse(
        { reasoning: 'Kliknu na nastavení', action: 'click', target: 2, value: null, detected_bugs: [] },
        {
          ...baseContext,
          currentUrl: 'http://localhost:3000/profile/saved',
          title: 'Profil uložen',
          goal: 'Verify profile save flow',
          interactiveElements: [
            { id: 1, tagName: 'A', text: 'Zpět na profil', href: '/profile' },
            { id: 2, tagName: 'A', text: 'Nastavení', href: '/profile/settings' }
          ]
        }
      );

      expect(result.action).toBe('finish');
      expect(result.target).toBeNull();
    });

    it('bez interaktivních prvků převede navigate na scroll', () => {
      const result = sanitizeActionResponse(
        { reasoning: 'Přejdu domů', action: 'navigate', target: 'http://localhost:3000/', value: null, detected_bugs: [] },
        {
          ...baseContext,
          interactiveElements: [],
          steps: []
        }
      );

      expect(result.action).toBe('scroll');
      expect(result.target).toBeNull();
    });

    it('po opakovaném refreshi použije suggested full URL', () => {
      const result = sanitizeActionResponse(
        { reasoning: 'Zkusím znovu obnovit', action: 'click', target: 1, value: null, detected_bugs: [] },
        {
          ...baseContext,
          currentUrl: 'http://localhost:3000/admin',
          suggestedUrl: 'http://localhost:3000/admin/audit',
          interactiveElements: [
            { id: 1, tagName: 'BUTTON', type: 'button', text: 'Obnovit stav' }
          ],
          steps: [{ step: 1, action: 'click', target: 1 }]
        }
      );

      expect(result.action).toBe('navigate');
      expect(result.target).toBe('http://localhost:3000/admin/audit');
    });
  });
});

function actionTarget(step) {
  return `${step.action}:${step.target}`;
}
