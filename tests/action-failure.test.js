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

  /**
   * ZMĚNA ROZHODNUTÍ, NE OPRAVA CHYBY.
   *
   * Tenhle test dřív tvrdil „obyčejný timeout bez překryvu JE nález na
   * aplikaci". To je ale tvrzení, na které měření nestačí: Playwright
   * čekal a prvek se nedal ovládnout, ale PROČ se z hlášky nepozná.
   * Může jít o nefunkční tlačítko (vada), o animaci, která prvek nikdy
   * neustálí, nebo o pomalou odpověď serveru.
   *
   * Řídící zásada nástroje říká, že neprůkazné se nevydává za nález —
   * a to platí i opačným směrem, než na který jsme zvyklí. Timeout
   * zůstává vidět mezi varováními i s původní hláškou, takže informace
   * se neztrácí; jen se z ní nedělá doložené porušení.
   */
  test('obyčejný timeout bez vodítka je neprůkazný, ne nález', () => {
    const r = classifyActionFailure(
      'click',
      1,
      "page.click: Timeout 5000ms exceeded.\nCall log:\n  - waiting for locator('[data-qa-id=\"5\"]')"
    );
    expect(r.kind).toBe('neurcitelne');
    expect(r.isAppFault).toBe(false);
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

/**
 * Skutečný běh na drinkboostup.cz: pod „Detekované problémy" stálo
 *
 *   Akce 'click' v kroku 7 selhala: page.click: Timeout 5000ms exceeded.
 *   Call log: - waiting for locator(…) - locator resolved to <button …>
 *   - attempting click action 2 × waiting for element to be visible,
 *   enabled and stable - element is visible, enabled and stable
 *   - scrolling into view if needed - done scrolling - element is outside
 *   of the viewport - retrying click action - waiting 20ms 2 × …
 *
 * Tedy jako NÁLEZ o zákazníkově webu. Přitom to znamená, že se agent na
 * prvek nedostal — stejná situace jako u překryvu, jen bez vlastní větve.
 */
const timeoutMimoViewport = `page.click: Timeout 5000ms exceeded.
Call log:
  - waiting for locator('[data-qa-id="73"]')
  - locator resolved to <button data-qa-id="73">Zavřít detail</button>
  - attempting click action
  - scrolling into view if needed
  - done scrolling
  - element is outside of the viewport
  - retrying click action - waiting 20ms
  - retrying click action - waiting 100ms
  - retrying click action - waiting 500ms`;

describe('prvek mimo viditelnou část okna', () => {
  test('není vada aplikace', () => {
    const r = classifyActionFailure('click', 7, timeoutMimoViewport);
    expect(r.kind).toBe('viewport');
    expect(r.isAppFault).toBe(false);
  });

  test('věta netvrdí ani vadu, ani její nepřítomnost', () => {
    const r = classifyActionFailure('click', 7, timeoutMimoViewport);
    expect(r.message).toMatch(/neplyne vada aplikace ani její nepřítomnost/);
    expect(r.message).toMatch(/agent se na prvek nedostal/);
  });

  test('vnitřní call log Playwrightu se do zprávy netáhne', () => {
    const r = classifyActionFailure('click', 7, timeoutMimoViewport);
    expect(r.message).not.toMatch(/retrying click action/);
    expect(r.message).not.toMatch(/waiting for locator/);
  });
});

describe('skutečné selhání aplikace se zkrátí, ale neztratí příčinu', () => {
  /**
   * Ukázka musí být SKUTEČNÁ vada aplikace.
   *
   * Dřív tu jako příklad „skutečného selhání aplikace" stálo
   * `Element is not attached to the DOM` — jenže to je artefakt měření:
   * komponenta se překreslila mezi čtením a kliknutím, což u Reactu
   * a Vue nastává běžně. Test tak cementoval právě to zařazení, které
   * do `bugs` posílalo hlášky o zákazníkově webu bez opory.
   *
   * Smysl testu je zkrácení call logu, ne klasifikace — použije se tedy
   * hláška, která nálezem opravdu je.
   */
  test('call log se ustřihne, první věta zůstane', () => {
    const r = classifyActionFailure('click', 3,
      'page.click: strict mode violation: locator resolved to 3 elements.\nCall log:\n  - '
      + 'retrying click action - waiting 20ms\n'.repeat(50));
    expect(r.kind).toBe('app');
    expect(r.isAppFault).toBe(true);
    expect(r.message).toMatch(/strict mode violation/);
    expect(r.message).not.toMatch(/retrying click action/);
    expect(r.message.length).toBeLessThan(400);
  });

  test('krátká zpráva bez call logu zůstane celá', () => {
    const r = classifyActionFailure('type', 2, 'Element is disabled.');
    expect(r.message).toMatch(/Element is disabled\.$/);
  });
});

/**
 * CHYBA MĚŘENÍ NENÍ VADA WEBU.
 *
 * Modul má v hlavičce napsané, že „když si vlastní neschopnost provést
 * kliknutí zapíše jako bug testovaného webu, tvrdí něco, co neizměřil".
 * Přesto do větve `app` — tedy do `bugs` v reportu pro úřad — padalo pět
 * hlášek, které o aplikaci neříkají nic. Ověřeno spuštěním, ne odhadem.
 *
 * Znění jsou opsaná z `playwright-core/lib/coreBundle.js`. Kdyby se
 * vymýšlela, opakovala by se chyba s `preactAttr` a `transferSize`.
 */
describe('rozpadlé prostředí se nehlásí jako vada aplikace', () => {
  const merici = [
    ['zavřený prohlížeč — způsobíme si ho obvykle sami',
      'page.click: Target page, context or browser has been closed'],
    ['navigace během kliknutí — běžné na živé aplikaci',
      'page.click: Execution context was destroyed, most likely because of a navigation'],
    ['překreslená komponenta — běžný stav Reactu a Vue',
      'page.click: Element is not attached to the DOM'],
    ['spadlý renderer',
      'page.click: Target crashed'],
  ];

  test.each(merici)('%s', (_popis, hlaska) => {
    const r = classifyActionFailure('click', 1, hlaska);
    expect(r.isAppFault).toBe(false);
    expect(r.kind).toBe('prostredi');
    // Původní hláška zůstává čitelná — bez ní se nedá dohledat, co se stalo.
    expect(r.message).toMatch(/neproběhla|prostředí/);
  });

  test('do bugs jde jen to, co je opravdu o aplikaci', () => {
    // Kontrolní protiklad: skutečná vada v selektoru zůstává nálezem.
    const r = classifyActionFailure('click', 1,
      'page.click: strict mode violation: locator resolved to 3 elements');
    expect(r.isAppFault).toBe(true);
    expect(r.kind).toBe('app');
  });
});

describe('timeout bez vodítka je neprůkazný, ne nález', () => {
  const holyTimeout = 'page.click: Timeout 5000ms exceeded.\nCall log:\n  - waiting for locator';

  test('nehlásí se jako vada webu', () => {
    // Může to být nefunkční tlačítko, animace, která prvek neustálí, nebo
    // pomalý server. Z jednoho pokusu se to nepozná — a řídící zásada
    // říká, že neprůkazné se nevydává za nález.
    const r = classifyActionFailure('click', 1, holyTimeout);
    expect(r.isAppFault).toBe(false);
    expect(r.kind).toBe('neurcitelne');
  });

  test('řekne se PROČ se to neví', () => {
    // „Nepodařilo se" bez důvodu je k ničemu; člověk musí poznat, že jsme
    // se nedívali, ne že jsme se dívali a nic nenašli.
    const r = classifyActionFailure('click', 1, holyTimeout);
    expect(r.message).toMatch(/důvod se určit nedá/);
    expect(r.message).toMatch(/nehlásí jako nález/);
  });

  /**
   * POŘADÍ ROZHODUJE.
   *
   * Překryv i viewport se v Playwrightu projeví JAKO timeout — konkrétní
   * důvod je až uvnitř call logu. Kdyby se obecný timeout testoval dřív,
   * spolkl by obě konkrétnější kategorie a report by přišel o vysvětlení.
   */
  test('překryv a viewport mají přednost před obecným timeoutem', () => {
    const prekryv = classifyActionFailure('click', 1,
      'page.click: Timeout 5000ms exceeded.\nCall log:\n  - <div> intercepts pointer events');
    expect(prekryv.kind).toBe('overlay');

    const mimo = classifyActionFailure('click', 1,
      'page.click: Timeout 5000ms exceeded.\nCall log:\n  - element is outside of the viewport');
    expect(mimo.kind).toBe('viewport');
  });
});
