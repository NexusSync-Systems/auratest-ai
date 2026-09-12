import { jest } from '@jest/globals';
import * as db from '../db.js';
import { __test__ } from '../server.js';

/**
 * Úklid zaseknutých běhů — ZAPOJENÍ, ne jen čistý modul.
 *
 * Kontrolní vlna nad první verzí našla tři P0 a všechny ležely tady:
 * v kódu, který sahá do databáze a na běhy tohohle procesu. Modul
 * `stale-runs.js` byl přitom v pořádku a měl patnáct testů — testovalo
 * se to, co se testovat dalo, ne to, kde chyby byly.
 *
 * Nejhorší možný následek je zabití ŽIVÉHO běhu: uživatel přijde
 * o výsledek a nedozví se proč. Testy jsou psané hlavně proti tomu.
 */

const mockStore = { sessions: [] };

// Neměnný záznam se mockuje, protože právě z něj teď pojistka čte.
const mockLedger = { records: [] };

jest.mock('../audit-ledger.js', () => {
  const skutecny = jest.requireActual('../audit-ledger.js');
  return {
    ...skutecny,
    recordsForSession: jest.fn((sessionId) => mockLedger.records.filter((r) => r.sessionId === sessionId)),
  };
});

jest.mock('../auth.js', () => ({
  authenticateToken: (req, res, next) => { req.user = { userId: 'u' }; next(); },
}));

jest.mock('../db.js', () => ({
  auth: { verifyIdToken: jest.fn() },
  getRunningSessions: jest.fn(async () => mockStore.sessions.filter((s) => s.status === 'running')),
  getSession: jest.fn(async (id) => mockStore.sessions.find((s) => s.id === id) || null),
  saveSession: jest.fn(async (id, data) => {
    const i = mockStore.sessions.findIndex((s) => s.id === id);
    if (i === -1) mockStore.sessions.push({ id, ...data });
    else mockStore.sessions[i] = { ...mockStore.sessions[i], ...data };
    return true;
  }),
  getSessions: jest.fn(async () => []),
  getMonitors: jest.fn(async () => []),
  getAllActiveMonitors: jest.fn(async () => []),
  getProjects: jest.fn(async () => []),
  getAuraGuardEvents: jest.fn(async () => []),
}));



const TED = Date.now();
const pred = (ms) => new Date(TED - ms).toISOString();
const DAVNO = pred(60 * 60 * 1000);

beforeEach(() => {
  mockStore.sessions = [];
  mockLedger.records = [];
  __test__.beziciBehy.clear();
  jest.clearAllMocks();
});

describe('hlídač nesmí zabít živý běh', () => {
  test('běh TOHOHLE procesu se nekontroluje vůbec', async () => {
    // Je v `beziciBehy`, takže z definice žije. Jediné chybné
    // rozhodnutí (třeba série neúspěšných tepů kvůli kvótě) by mu
    // zastavilo tep a připravilo ho o možnost doložit, že běží.
    mockStore.sessions.push({
      id: 'muj', status: 'running', heartbeatAt: DAVNO, timestamp: DAVNO,
    });
    __test__.beziciBehy.set('muj', setInterval(() => {}, 10 ** 6));

    expect(await __test__.doucistiZaseknuteBehy()).toBe(0);
    expect(mockStore.sessions[0].status).toBe('running');
    // A tep mu nikdo nezastavil.
    expect(__test__.beziciBehy.has('muj')).toBe(true);
    __test__.prestanTepat('muj');
  });

  test('běh, který mezitím doběhl, se NEPŘEPÍŠE', async () => {
    // Mezi dotazem a zápisem je několik síťových operací na položku.
    // Přepsat hotový výsledek na `failed` by ho zahodilo nenávratně
    // a spis by běh vykázal jako neprůkazný.
    mockStore.sessions.push({
      id: 'dobehl', status: 'running', heartbeatAt: DAVNO, timestamp: DAVNO,
    });
    db.getSession.mockImplementationOnce(async () => ({
      id: 'dobehl', status: 'completed', summary: 'Test dokončen.', bugs: [],
    }));

    expect(await __test__.doucistiZaseknuteBehy()).toBe(0);
    expect(db.saveSession).not.toHaveBeenCalled();
  });

  test('čerstvě tepající běh zůstane běžet', async () => {
    mockStore.sessions.push({
      id: 'zivy', status: 'running', heartbeatAt: pred(5000), timestamp: DAVNO,
    });
    expect(await __test__.doucistiZaseknuteBehy()).toBe(0);
    expect(mockStore.sessions[0].status).toBe('running');
  });
});

describe('hlídač dopíše, co je opravdu mrtvé', () => {
  test('běh bez tepu se zapíše jako nedokončený, ne jako dokončený', async () => {
    mockStore.sessions.push({
      id: 'mrtvy', status: 'running', heartbeatAt: DAVNO, timestamp: DAVNO, bugs: [],
    });

    expect(await __test__.doucistiZaseknuteBehy()).toBe(1);
    const s = mockStore.sessions[0];
    expect(s.status).toBe('failed');
    // Důvod patří mezi chyby MĚŘENÍ, ne mezi nálezy o webu.
    expect(s.runErrors[0]).toMatch(/nedoběhl/);
    expect(s.bugs).toEqual([]);
  });

  test('běh už zapsaný v neměnném záznamu se NEPŘEPISUJE', async () => {
    // `recordInLedger` se volá PŘED finálním zápisem session. Přepsat
    // `status`/`summary`/`runErrors` by rozbilo otisk a spis by
    // vytiskl „Otisk souhlasí: Ne" — signál o porušené integritě
    // záznamu, který způsobil náš vlastní úklid.
    mockStore.sessions.push({
      id: 'v-ledgeru', status: 'running', heartbeatAt: DAVNO, timestamp: DAVNO,
      ledger: { recorded: true, hash: 'abc' },
    });

    expect(await __test__.doucistiZaseknuteBehy()).toBe(0);
    expect(db.saveSession).not.toHaveBeenCalled();
    expect(mockStore.sessions[0].status).toBe('running');
  });

  test('běh v záznamu se nepřepíše ANI KDYŽ příznak v databázi chybí', async () => {
    // Tohle je ta vada, kterou našla kontrolní vlna. `ledger.recorded`
    // zapisuje do databáze právě ten zápis, jehož selhání celou situaci
    // vytváří — příznak tedy chybí přesně v případě, na který má pojistka
    // reagovat. Hlídač běh přepsal, otisk přestal souhlasit a spis by
    // zákazníka obvinil z manipulace se záznamem.
    mockLedger.records.push({ sessionId: 'jen-v-ledgeru', hash: 'abc' });
    mockStore.sessions.push({
      id: 'jen-v-ledgeru', status: 'running', heartbeatAt: DAVNO, timestamp: DAVNO,
      // ŽÁDNÉ `ledger` pole — zápis do databáze selhal.
    });

    expect(await __test__.doucistiZaseknuteBehy()).toBe(0);
    expect(db.saveSession).not.toHaveBeenCalled();
    expect(mockStore.sessions[0].status).toBe('running');
  });

  test('nečitelný záznam se bere jako „možná tam je"', async () => {
    // Přepsat běh, o kterém nevíme, je horší než ho nechat k ručnímu
    // posouzení.
    const { recordsForSession } = await import('../audit-ledger.js');
    recordsForSession.mockImplementationOnce(() => { throw new Error('ledger nečitelný'); });
    mockStore.sessions.push({
      id: 'neznamo', status: 'running', heartbeatAt: DAVNO, timestamp: DAVNO,
    });

    expect(await __test__.doucistiZaseknuteBehy()).toBe(0);
    expect(db.saveSession).not.toHaveBeenCalled();
  });

  test('běh, který v záznamu NENÍ, se dopíše', async () => {
    mockStore.sessions.push({
      id: 'nikde', status: 'running', heartbeatAt: DAVNO, timestamp: DAVNO,
    });

    expect(await __test__.doucistiZaseknuteBehy()).toBe(1);
    expect(mockStore.sessions[0].status).toBe('failed');
  });

  test('nedostupná databáze úklid nepoloží', async () => {
    db.getRunningSessions.mockImplementationOnce(async () => { throw new Error('timeout'); });
    await expect(__test__.doucistiZaseknuteBehy()).resolves.toBe(0);
  });

  test('selhání zápisu u jednoho běhu nezastaví ostatní', async () => {
    mockStore.sessions.push(
      { id: 'a', status: 'running', heartbeatAt: DAVNO, timestamp: DAVNO },
      { id: 'b', status: 'running', heartbeatAt: DAVNO, timestamp: DAVNO },
    );
    db.saveSession.mockImplementationOnce(async () => { throw new Error('kvóta'); });

    expect(await __test__.doucistiZaseknuteBehy()).toBe(1);
  });

  test('vrací počet SKUTEČNÝCH zápisů, ne pokusů', async () => {
    // Provozní log se při vyšetřování čte jako důkaz, takže platí
    // totéž pravidlo jako pro dokument: netvrdit víc, než se stalo.
    mockStore.sessions.push(
      { id: 'mrtvy', status: 'running', heartbeatAt: DAVNO, timestamp: DAVNO },
      { id: 'zivy', status: 'running', heartbeatAt: pred(1000), timestamp: DAVNO },
      { id: 'hotovy', status: 'completed' },
    );
    expect(await __test__.doucistiZaseknuteBehy()).toBe(1);
  });
});

describe('tep', () => {
  test('zastavení tepu vyjme běh z evidence', () => {
    __test__.zacniTepat('x');
    expect(__test__.beziciBehy.has('x')).toBe(true);
    __test__.prestanTepat('x');
    expect(__test__.beziciBehy.has('x')).toBe(false);
  });

  test('zastavení neznámého běhu nespadne', () => {
    expect(() => __test__.prestanTepat('neexistuje')).not.toThrow();
  });
});
