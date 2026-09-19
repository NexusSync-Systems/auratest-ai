/**
 * @jest-environment node
 */
import { jest } from '@jest/globals';

/**
 * Plánovač a rezervace slotu — VOLAJÍCÍ KÓD.
 *
 * `monitor-slot.test.js` ověřuje samotné rozhodnutí. Tenhle soubor ověřuje,
 * že se podle něj plánovač opravdu řídí. Rozdíl mezi tím dvojím je celá
 * historie nálezů v tomhle projektu: rozhodovací funkce bývala v pořádku
 * a vada byla ve spojovací vrstvě, kde žádný test nebyl.
 *
 * `schedulerTick` proto musel být doplněn do `__test__` — dřív se zvenčí
 * spustit nedal vůbec.
 *
 * Co se kontroluje: že se běh ZALOŽÍ jen při úspěšné rezervaci. Zakládá
 * ho `db.saveSession`, a to dřív, než se sahá po prohlížeči — takže se to
 * dá ověřit bez Playwrightu.
 */

// Deklarace funkcí, ne `const`: `jest.mock` se hoistuje nad všechno
// ostatní a jeho tovární funkce běží už při importu `server.js`. Šipková
// funkce v `const` by v tu chvíli byla v dočasné mrtvé zóně.
function monitor(over = {}) {
  return {
    id: 'm1',
    userId: 'u1',
    name: 'Testovací monitor',
    url: 'https://example.com/',
    goal: 'zkontroluj hlavní stránku',
    interval: '1h',
    lastRunTime: 0,
    active: true,
    ...over,
  };
}

// `var` ze stejného důvodu — přiřadí se uvnitř továrny.
var mockDb;

jest.mock('../auth.js', () => ({
  authenticateToken: (req, res, next) => { req.user = { userId: 'u' }; next(); },
}));
jest.mock('../db.js', () => {
  mockDb = {
    auth: { verifyIdToken: jest.fn() },
    getRunningSessions: jest.fn(async () => []),
    getSession: jest.fn(async () => null),
    saveSession: jest.fn(async () => true),
    getSessions: jest.fn(async () => []),
    getMonitors: jest.fn(async () => []),
    getProjects: jest.fn(async () => []),
    getAuraGuardEvents: jest.fn(async () => []),
    updateMonitorIfExists: jest.fn(async () => ({ id: 'm1' })),
    // Prázdné: co plánovač uvidí, nastavuje každý test v `beforeEach`.
    // Tovární funkce `jest.mock` nesmí sáhnout ven na `monitor()`.
    getAllActiveMonitors: jest.fn(async () => []),
    rezervujSlotMonitoru: jest.fn(async () => ({ stav: 'rezervovano', duvod: 'slot rezervován' })),
  };
  return mockDb;
});
// Cíl je veřejný — hlídač SSRF tady není předmětem testu.
jest.mock('../ssrf-guard.js', () => ({
  assertPublicHttpUrl: jest.fn(async () => true),
  resolvePublicHttpTarget: jest.fn(async (u) => u),
}));

// `agent.js` MUSÍ být podvržený.
//
// Bez toho si tenhle test spustí skutečné Chromium: plánovač po rezervaci
// pustí `provedBehMonitoru` jako plovoucí promise a ta zavolá
// `runAutonomousTest`. V sandboxu prohlížeč spadne na chybějící knihovně,
// ale až po doběhnutí testu — jest pak hlásí „Cannot log after tests are
// done" a celá sada je nestabilní (jeden běh spadl, druhý prošel).
// V CI, kde Playwright funguje, by test navíc opravdu chodil na example.com.
jest.mock('../agent.js', () => ({
  runAutonomousTest: jest.fn(async () => ({ steps: [], bugs: [], summary: 'mock' })),
  comparePages: jest.fn(), auditTranslations: jest.fn(), extractInternalLinks: jest.fn(),
  analyzeSecurityVulnerabilities: jest.fn(), auditAccessibility: jest.fn(),
  auditNIS2AndPQC: jest.fn(), auditGreenAndResidency: jest.fn(),
  generateAutoHealPatch: jest.fn(), auditCRA_SBOM: jest.fn(), runChaosTest: jest.fn(),
  getGridEnergyStatus: jest.fn(), auditAIAct: jest.fn(), auditStrictCookies: jest.fn(),
  auditCRAVulnerabilities: jest.fn(), checkPage: jest.fn(), checkForm: jest.fn(),
}));

// Statický import, ne `await import()`: babel-jest překládá do CJS, kde
// top-level await není. `jest.mock` se hoistuje nad importy, takže se
// server načte až s podvrženou databází.
import { __test__ } from '../server.js';

beforeEach(() => {
  jest.clearAllMocks();
  mockDb.getAllActiveMonitors.mockResolvedValue([monitor()]);
  mockDb.saveSession.mockResolvedValue(true);
});

// Plánovač spouští běh jako plovoucí promise, na kterou `schedulerTick`
// schválně nečeká. Bez dobrání fronty by zápisy z běhu dopadly až do
// dalšího testu a ovlivnily jeho počty volání.
afterEach(async () => {
  await new Promise((r) => setImmediate(r));
});

describe('schedulerTick — řídí se výsledkem rezervace', () => {
  it('při rezervaci slotu se běh založí', async () => {
    mockDb.rezervujSlotMonitoru.mockResolvedValue({ stav: 'rezervovano', duvod: '' });
    await __test__.schedulerTick();
    expect(mockDb.saveSession).toHaveBeenCalled();
  });

  // Tohle je ta vada, kvůli které se to celé měnilo: bez porovnej-a-zapiš
  // se běh založil VŽDYCKY, i když ho mezitím vzala jiná instance.
  it.each([
    ['obsazeno', 'běh už si vzal někdo jiný'],
    ['smazano', 'monitor mezitím smazán'],
    ['neaktivni', 'monitor mezitím vypnut'],
  ])('při stavu %s se běh NEzaloží', async (stav, duvod) => {
    mockDb.rezervujSlotMonitoru.mockResolvedValue({ stav, duvod });
    await __test__.schedulerTick();
    expect(mockDb.saveSession).not.toHaveBeenCalled();
  });

  it('rezervace se ptá na hodnotu ze snímku, ne na nulu natvrdo', async () => {
    // Kdyby se předávala konstanta, porovnej-a-zapiš by nic neporovnával
    // a ochrana proti souběhu by byla jen na papíře.
    mockDb.getAllActiveMonitors.mockResolvedValue([monitor({ lastRunTime: 1234 })]);
    await __test__.schedulerTick();
    expect(mockDb.rezervujSlotMonitoru).toHaveBeenCalledWith('m1', 1234, expect.any(Number));
  });

  it('monitor, na který ještě nedošel interval, se o slot vůbec nepokouší', async () => {
    mockDb.getAllActiveMonitors.mockResolvedValue([monitor({ lastRunTime: Date.now() })]);
    await __test__.schedulerTick();
    expect(mockDb.rezervujSlotMonitoru).not.toHaveBeenCalled();
  });

  it('selhání transakce nepoloží tik ani ostatní monitory', async () => {
    // Jeden nedostupný zápis nesmí připravit o běh monitory za ním
    // v cyklu — to byla vada u deaktivace při odmítnutém cíli.
    mockDb.getAllActiveMonitors.mockResolvedValue([
      monitor({ id: 'rozbity' }),
      monitor({ id: 'zdravy' }),
    ]);
    mockDb.rezervujSlotMonitoru
      .mockRejectedValueOnce(new Error('Firestore nedostupný'))
      .mockResolvedValueOnce({ stav: 'rezervovano', duvod: '' });

    await expect(__test__.schedulerTick()).resolves.toBeUndefined();
    expect(mockDb.rezervujSlotMonitoru).toHaveBeenCalledTimes(2);

    // Ne `toHaveBeenCalledTimes(1)`: odložený běh (vyčerpané sloty
    // prohlížečů) dopisuje session podruhé, takže by se tím měřil vedlejší
    // efekt místo toho, na čem záleží — KTERÝ monitor se založil.
    const zalozene = mockDb.saveSession.mock.calls.map(([, data]) => data.monitorId);
    expect(zalozene).toContain('zdravy');
    expect(zalozene).not.toContain('rozbity');
  });
});
