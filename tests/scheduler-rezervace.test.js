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
    uvolniZamekMonitoru: jest.fn(async () => ({ id: 'm1' })),
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
  // Sloty prohlížečů jsou globální stav. Nedoběhlý běh z předchozího
  // testu drží slot dál a další test pak `tryAcquire()` neprojde — běh
  // se vůbec nespustí a test spadne na tvrzení o něčem jiném, přestože
  // sám o sobě prochází. Nulování je tu proto, aby izolace testů byla
  // vynucená, ne doufaná.
  __test__.browserSlots.inUse = 0;
});

// Plánovač spouští běh jako plovoucí promise, na kterou `schedulerTick`
// schválně nečeká. Dokud nedoběhne, DRŽÍ SLOT PROHLÍŽEČE — a `browserSlots`
// je globální stav sdílený všemi testy v souboru.
//
// Původní verze tu měla jediný `setImmediate`. To na doběhnutí běhu
// nestačí (je v něm několik `await`), takže se sloty hromadily: osmý test
// v pořadí už žádný nedostal, `tryAcquire()` vrátil false, běh se vůbec
// nespustil a test spadl na tvrzení o něčem úplně jiném. Sám o sobě
// přitom procházel. Přesně ten druh nestability, který v CI vypadá jako
// náhodná chyba v kódu.
//
// Sto tiků je velkorysá rezerva, ne změřená mez; běh doběhne řádově
// v jednotkách.
afterEach(async () => {
  for (let i = 0; i < 100; i++) await new Promise((r) => setImmediate(r));
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
    expect(mockDb.rezervujSlotMonitoru).toHaveBeenCalledWith(
      'm1', expect.objectContaining({ ocekavanyLastRun: 1234 }),
    );
  });

  it('zámek se nastavuje do budoucnosti, ne na nulu', async () => {
    // Zámek s platností v minulosti (nebo 0) by nezamkl nic a překrývající
    // se běhy by se vrátily — celý smysl čtvrtého parametru.
    await __test__.schedulerTick();
    const [, volby] = mockDb.rezervujSlotMonitoru.mock.calls[0];
    expect(volby.zamekDo).toBeGreaterThan(volby.novyCas);
    // Bez identifikátoru běhu se mezera v měření nedá poznat.
    expect(volby.zamekSession).toMatch(/^session_monitor_/);
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

    // Ne `toHaveBeenCalledTimes(1)`: `provedBehMonitoru` session po
    // doběhnutí dopisuje, takže počet volání měří vedlejší efekt místo
    // toho, na čem záleží — KTERÝ monitor se založil.
    //
    // Pozn.: původní komentář tu mluvil o odložené větvi při vyčerpaných
    // slotech prohlížečů. Ta ale v tomhle testu nikdy nenastane (limit
    // jsou 3 sloty, monitory dva) a kdyby nastala, spadlo by tvrzení
    // o dvou voláních rezervace o dva řádky výš — vrácení rezervace je
    // volání třetí. Komentář popisoval chování, které test neprovede.
    const zalozene = mockDb.saveSession.mock.calls.map(([, data]) => data.monitorId);
    expect(zalozene).toContain('zdravy');
    expect(zalozene).not.toContain('rozbity');
  });
});

/**
 * Uvolnění zámku po běhu.
 *
 * Míří přímo na `provedBehMonitoru`, ne přes `schedulerTick`. Přes
 * plánovač to nešlo spolehlivě: běh je plovoucí promise, kterou test nemá
 * jak dočkat, a v sekvenci uvázne na sdíleném zápisu do řetězu auditů —
 * test pak procházel sám o sobě a padal v celé sadě. Test, který je
 * potřeba „dobrat frontou", netestuje to, co si myslí.
 *
 * `provedBehMonitoru` bere závislosti parametrem právě kvůli tomuhle.
 */
/**
 * Mezera v měření ve spisu.
 *
 * Rozhodnutí: vynechaný běh se DO SPISU zapisuje. Bez toho by mezi dvěma
 * měřeními bylo jen delší ticho a čtenář by nepoznal, jestli se neměřilo,
 * nebo se měřilo a výsledek se ztratil. To druhé je obvinění, to první
 * fakt — splývat nesmí.
 */
describe('schedulerTick — mezera v měření', () => {
  const sMezerou = () => ({
    stav: 'rezervovano',
    duvod: '',
    mezera: { sessionId: 'session_mrtvy', od: 1_700_000_000_000 },
  });

  it('mezera se zapíše jako session se stavem failed a bez nálezů', async () => {
    mockDb.rezervujSlotMonitoru.mockResolvedValue(sMezerou());
    await __test__.schedulerTick();

    const zapis = mockDb.saveSession.mock.calls.find(([id]) => id === 'session_mrtvy');
    expect(zapis).toBeDefined();
    const [, data] = zapis;
    // NIKDY `completed`: ten stav ve spisu znamená „výsledek platí".
    expect(data.status).toBe('failed');
    // O webu se nezjistilo nic — nálezy musí zůstat prázdné.
    expect(data.bugs).toEqual([]);
    // Příčina patří mezi chyby měření, ne mezi nálezy o webu.
    expect(data.runErrors.join(' ')).toMatch(/nespustil/);
    // Čas začátku nezměřeného okna, ne čas zápisu — jinak by se mezera
    // ve spisu vytiskla jinde, než kam patří.
    expect(data.timestamp).toBe(new Date(1_700_000_000_000).toISOString());
  });

  it('po mezeře se vlastní běh přesto spustí', async () => {
    // Nezměřit teď kvůli tomu, že se nepovedlo popsat minulou mezeru,
    // by mezeru jen prodloužilo.
    mockDb.rezervujSlotMonitoru.mockResolvedValue(sMezerou());
    await __test__.schedulerTick();
    const bezne = mockDb.saveSession.mock.calls.filter(([id]) => id !== 'session_mrtvy');
    expect(bezne.length).toBeGreaterThan(0);
  });

  it('selhání zápisu mezery nezabrání běhu', async () => {
    mockDb.rezervujSlotMonitoru.mockResolvedValue(sMezerou());
    mockDb.saveSession.mockImplementation(async (id) => {
      if (id === 'session_mrtvy') throw new Error('Firestore nedostupný');
      return true;
    });
    await expect(__test__.schedulerTick()).resolves.toBeUndefined();
    const bezne = mockDb.saveSession.mock.calls.filter(([id]) => id !== 'session_mrtvy');
    expect(bezne.length).toBeGreaterThan(0);
  });

  it('bez mezery se nic navíc nezapisuje', async () => {
    mockDb.rezervujSlotMonitoru.mockResolvedValue({ stav: 'rezervovano', duvod: '', mezera: null });
    await __test__.schedulerTick();
    const idcka = mockDb.saveSession.mock.calls.map(([id]) => id);
    expect(new Set(idcka).size).toBe(1);
  });
});

describe('provedBehMonitoru — zámek', () => {
  const zaklad = () => ({
    monitor: monitor(),
    sessionId: 'session_x',
    sessionData: { id: 'session_x', monitorId: 'm1', bugs: [], steps: [] },
    llmConfig: { headless: true, maxSteps: 1, mode: 'ai' },
  });

  const zavislosti = (over = {}) => ({
    spustTest: jest.fn(async () => ({ steps: [], bugs: [], summary: 'ok' })),
    saveSession: jest.fn(async () => true),
    updateMonitorIfExists: jest.fn(async () => ({ id: 'm1' })),
    oznam: jest.fn(async () => {}),
    zapisDoZaznamu: jest.fn(async () => {}),
    tepStop: jest.fn(),
    uvolniSlot: jest.fn(),
    broadcastKrok: jest.fn(),
    pauza: jest.fn(async () => {}),
    uvolniZamek: jest.fn(async () => {}),
    ...over,
  });

  it('po úspěšném běhu se zámek uvolní', async () => {
    const d = zavislosti();
    await __test__.provedBehMonitoru(zaklad(), d);
    expect(d.uvolniZamek).toHaveBeenCalledWith('m1');
  });

  it('po spadlém běhu se zámek uvolní taky', async () => {
    // Jinak by monitor po jedné chybě mlčel celou platnost zámku.
    const d = zavislosti({ spustTest: jest.fn(async () => { throw new Error('prohlížeč spadl'); }) });
    await __test__.provedBehMonitoru(zaklad(), d);
    expect(d.uvolniZamek).toHaveBeenCalledWith('m1');
  });

  it('selhání uvolnění zámku nezabrání uvolnění slotu prohlížeče', async () => {
    // Výjimka z `finally` by přeskočila zbytek bloku. Několik takových
    // běhů monitoring zastaví úplně, a přitom nic nehlásí.
    const d = zavislosti({ uvolniZamek: jest.fn(async () => { throw new Error('Firestore'); }) });
    await expect(__test__.provedBehMonitoru(zaklad(), d)).resolves.toBeUndefined();
    expect(d.uvolniSlot).toHaveBeenCalled();
  });
});
