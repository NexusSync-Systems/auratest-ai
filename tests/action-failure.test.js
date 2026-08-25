import { classifyActionFailure } from '../action-failure.js';

/**
 * Čí je to chyba, když agentovi selže akce.
 *
 * Na tomhle rozhodnutí stojí, jestli se do reportu o cizí aplikaci zapíše
 * „bug". Když si nástroj zapíše vlastní neschopnost kliknout, tvrdí závěr,
 * který nezměřil.
 *
 * Skutečné hlášky Playwrightu níž jsou zkrácené výpisy z běhu proti
 * www.cloudflare.com, kde cookie lišta OneTrust zachytávala kliknutí.
 */

const OVERLAY_ERROR = `page.click: Timeout 5000ms exceeded.
Call log:
  - waiting for locator('[data-qa-id="9"]')
    - locator resolved to <button type="button" data-qa-id="9" aria-label="Search Cloudflare">…</button>
  - attempting click action
    2 × waiting for element to be visible, enabled and stable
      - element is visible, enabled and stable
      - scrolling into view if needed
      - done scrolling
      - <div class="onetrust-pc-dark-filter ot-fade-in"></div> from <div data-nosnippet="true" id="onetrust-consent-sdk">…</div> subtree intercepts pointer events
    - retrying click action`;

describe('classifyActionFailure', () => {
  test('překryv jinou vrstvou není vada testované aplikace', () => {
    const r = classifyActionFailure('click', 1, OVERLAY_ERROR);
    expect(r.kind).toBe('overlay');
    expect(r.isAppFault).toBe(false);
  });

  test('hláška pojmenuje překrývající prvek, ne jen „timeout"', () => {
    const r = classifyActionFailure('click', 1, OVERLAY_ERROR);
    expect(r.message).toContain('onetrust-consent-sdk');
    expect(r.message).toContain('cookie lišta');
    // Původní hláška zněla „selhala: Timeout 5000ms exceeded" a čtenář z ní
    // usoudil, že je rozbitý web. Nová musí říct, že nejde o vadu aplikace.
    expect(r.message).toContain('Není to vada aplikace');
  });

  test('bez rozpoznatelného id se pořád klasifikuje jako překryv', () => {
    const r = classifyActionFailure(
      'click',
      2,
      'page.click: Timeout 5000ms exceeded.\n  - subtree intercepts pointer events'
    );
    expect(r.kind).toBe('overlay');
    expect(r.isAppFault).toBe(false);
    expect(r.message).not.toContain('undefined');
  });

  test('zablokování vlastní bezpečnostní politikou není vada aplikace', () => {
    const r = classifyActionFailure(
      'navigate',
      3,
      'Navigace na http://169.254.169.254/ byla zablokována: cíl je v interním rozsahu'
    );
    expect(r.kind).toBe('policy');
    expect(r.isAppFault).toBe(false);
  });

  test('obyčejný timeout bez překryvu JE nález na aplikaci', () => {
    const r = classifyActionFailure(
      'click',
      1,
      "page.click: Timeout 5000ms exceeded.\nCall log:\n  - waiting for locator('[data-qa-id=\"5\"]')"
    );
    expect(r.kind).toBe('app');
    expect(r.isAppFault).toBe(true);
    expect(r.message).toContain('Timeout 5000ms exceeded');
  });

  test('prázdná nebo chybějící hláška spadne do app, ne do výjimky', () => {
    for (const value of [undefined, null, '']) {
      const r = classifyActionFailure('click', 1, value);
      expect(r.isAppFault).toBe(true);
      expect(r.message).not.toContain('undefined');
      expect(r.message).not.toContain('null');
    }
  });

  test('do hlášky se propíše krok i název akce', () => {
    const r = classifyActionFailure('type', 7, OVERLAY_ERROR);
    expect(r.message).toContain("'type'");
    expect(r.message).toContain('kroku 7');
  });
});
