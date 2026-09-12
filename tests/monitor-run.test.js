/**
 * @jest-environment node
 */
import { jest } from '@jest/globals';
import { zapisPokudExistuje } from '../firestore-errors.js';
import { KLICE_ZAZNAMU } from '../run-result.js';

const mockStore = { sessions: [] };

jest.mock('../auth.js', () => ({
  authenticateToken: (req, res, next) => { req.user = { userId: 'u' }; next(); },
}));

jest.mock('../db.js', () => ({
  auth: { verifyIdToken: jest.fn() },
  getRunningSessions: jest.fn(async () => []),
  getSession: jest.fn(async () => null),
  saveSession: jest.fn(async () => true),
  getSessions: jest.fn(async () => []),
  // Schválně vyhazuje: `oznamMonitory` nesmí nedostupnou databází položit
  // server, a bez tohohle by se to neotestovalo.
  getMonitors: jest.fn(async () => { throw new Error('Firestore nedostupný'); }),
  getAllActiveMonitors: jest.fn(async () => []),
  getProjects: jest.fn(async () => []),
  getAuraGuardEvents: jest.fn(async () => []),
  updateMonitorIfExists: jest.fn(async () => null),
}));

import { __test__ } from '../server.js';

/**
 * Běh monitoru — spojovací vrstva, ve které byl P0.
 *
 * Smazání monitoru ZA BĚHU shodilo celý server: `db.updateMonitor()`
 * v plovoucím `(async () => {})()` bez `.catch()` → `docRef.update()` na
 * smazaném dokumentu vyhodí → `unhandledRejection` → `shutdownWithError()`
 * → `process.exit(1)`. Jeden uživatel tím zabil rozdělané běhy všech
 * ostatních.
 *
 * Pure moduly (`run-result.js`, `firestore-errors.js`) byly v pořádku;
 * vada byla výhradně tady, kde nebyl žádný test. Jako pokaždé.
 */

describe('zapisPokudExistuje', () => {
  it('smazaný záznam vrátí null, ne výjimku', async () => {
    const chyba = Object.assign(new Error('5 NOT_FOUND: no document to update'), { code: 5 });
    await expect(zapisPokudExistuje(async () => { throw chyba; })).resolves.toBe(null);
  });

  it('skutečnou chybu databáze vyhodí dál', async () => {
    // Spolknout ji by znamenalo, že zápisy tiše mizí.
    const chyba = Object.assign(new Error('PERMISSION_DENIED'), { code: 7 });
    await expect(zapisPokudExistuje(async () => { throw chyba; }))
      .rejects.toThrow('PERMISSION_DENIED');
  });

  it('existující záznam se normálně zapíše', async () => {
    await expect(zapisPokudExistuje(async () => ({ id: 'm1' }))).resolves.toEqual({ id: 'm1' });
  });

  it('smazaný záznam se NEVZKŘÍSÍ', async () => {
    // Naivní oprava by byla `set(..., {merge:true})` — ten na chybějícím
    // dokumentu nevyhodí, ale smazaný monitor by se vrátil. Uživatel ho
    // smazal a on by byl zpátky.
    let zapisu = 0;
    const chyba = Object.assign(new Error('no document to update'), { code: 5 });
    await zapisPokudExistuje(async () => { zapisu++; throw chyba; });
    expect(zapisu).toBe(1);
  });
});

describe('provedBehMonitoru', () => {
  const monitor = { id: 'm1', userId: 'u1', name: 'Objednávky', url: 'https://klient.cz', goal: 'cíl' };
  const vysledek = {
    measured: true, bugs: [], warnings: [], runErrors: [], steps: [],
    ukonceni: 'limit-kroku', ukonceniPopis: 'limit', summary: 'ok',
  };

  const spust = async (over = {}) => {
    const zapisy = [];
    const deps = {
      spustTest: async () => vysledek,
      saveSession: async (id, data) => { zapisy.push(['saveSession', id, data.status]); },
      updateMonitorIfExists: async (id, data) => { zapisy.push(['updateMonitor', id, data]); return { id }; },
      oznam: async (uid) => { zapisy.push(['oznam', uid]); },
      zapisDoZaznamu: () => { zapisy.push(['ledger']); },
      tepStop: (id) => { zapisy.push(['tepStop', id]); },
      uvolniSlot: () => { zapisy.push(['slot']); },
      broadcastKrok: () => {},
      pauza: async () => {},
      ...over,
    };
    const sessionData = { status: 'running', steps: [], bugs: [] };
    await __test__.provedBehMonitoru(
      { monitor, sessionId: 's1', sessionData, llmConfig: {} },
      deps
    );
    return { zapisy, sessionData };
  };

  it('smazaný monitor běh nezničí a výsledek se uloží', async () => {
    // TOHLE je ten P0. `updateMonitorIfExists` vrací null a funkce
    // nesmí vyhodit.
    const { zapisy, sessionData } = await spust({
      updateMonitorIfExists: async () => null,
    });

    expect(sessionData.status).toBe('completed');
    expect(zapisy.filter(([co]) => co === 'saveSession')).toHaveLength(1);
  });

  it('všechna pole z výsledku se propíšou do session', async () => {
    // Kontrolní vlna: testoval se jen `status`, takže vypadnutí kteréhokoli
    // dalšího pole by test nezachytil — a přesně „pole zapomenuté na jedné
    // ze tří cest" byla ta vada, kvůli které `run-result.js` vznikl.
    const { sessionData } = await spust({
      spustTest: async () => ({
        ...vysledek,
        bugs: ['n1'], warnings: ['w1'], runErrors: [],
        modelObservations: ['m1'], runNotes: ['r1'],
        nerozhodnutychKroku: 2, nezmerenoBlokaci: 1,
        performanceMetrics: { loadTimeMs: 10 }, generatedScript: 'g', videoUrl: 'v',
        preConsent: { cookies: [] }, cookieBanner: { clicked: true },
      }),
    });

    for (const klic of KLICE_ZAZNAMU) {
      expect(sessionData).toHaveProperty(klic);
    }
    expect(sessionData.bugs).toEqual(['n1']);
    expect(sessionData.modelObservations).toEqual(['m1']);
    expect(sessionData.runNotes).toEqual(['r1']);
    expect(sessionData.ukonceni).toBe('limit-kroku');
    expect(sessionData.nerozhodnutychKroku).toBe(2);
    expect(sessionData.nezmerenoBlokaci).toBe(1);
    // Okolnosti běhu mimo `KLICE_ZAZNAMU` — monitor je dřív neukládal.
    expect(sessionData.preConsent).toEqual({ cookies: [] });
    expect(sessionData.cookieBanner).toEqual({ clicked: true });
  });

  it('zápis výsledku se po přechodné chybě zkusí znovu', async () => {
    // Když tenhle jediný zápis selže, zůstane session `running`, zatímco
    // v neměnném záznamu už je položka o dokončeném běhu — a rozchod mezi
    // nimi spis tiskne jako „Otisk souhlasí: Ne", tedy jako manipulaci.
    const ulozeno = [];
    await spust({
      saveSession: async (id, data) => {
        ulozeno.push(data.status);
        if (ulozeno.length === 1) throw new Error('DEADLINE_EXCEEDED');
      },
      pauza: async () => {},
    });

    // Druhý pokus proběhl a uložil TÝŽ dokončený stav, ne „failed".
    expect(ulozeno).toEqual(['completed', 'completed']);
  });

  it('opakování se nezvrhne v nekonečnou smyčku', async () => {
    const ulozeno = [];
    await spust({
      saveSession: async () => { ulozeno.push(1); throw new Error('db down'); },
      pauza: async () => {},
    });
    expect(ulozeno).toHaveLength(2);
  });

  it('výsledek měření se ukládá PŘED zápisem do monitoru', async () => {
    // Smazaný monitor nesmí zahodit zjištění, které už vzniklo.
    const { zapisy } = await spust();
    const poradi = zapisy.map(([co]) => co);
    expect(poradi.indexOf('saveSession')).toBeLessThan(poradi.indexOf('updateMonitor'));
  });

  it('selhání zápisu do monitoru nezruší uložení session', async () => {
    const { zapisy } = await spust({
      updateMonitorIfExists: async () => { throw new Error('UNAVAILABLE'); },
    });
    expect(zapisy.some(([co]) => co === 'saveSession')).toBe(true);
    expect(zapisy.some(([co]) => co === 'tepStop')).toBe(true);
    expect(zapisy.some(([co]) => co === 'slot')).toBe(true);
  });

  it('selhání uložení session nezruší zápis do monitoru', async () => {
    const { zapisy } = await spust({
      saveSession: async () => { throw new Error('UNAVAILABLE'); },
    });
    expect(zapisy.some(([co]) => co === 'updateMonitor')).toBe(true);
  });

  it('pád měření se zapíše do runErrors, ne do bugs', async () => {
    const { zapisy, sessionData } = await spust({
      spustTest: async () => { throw new Error('Chromium spadl'); },
    });

    expect(sessionData.status).toBe('failed');
    expect(sessionData.bugs).toEqual([]);
    expect(sessionData.runErrors.join(' ')).toMatch(/Chromium spadl/);
    expect(zapisy.some(([, , data]) => data && data.lastRunStatus === 'error')).toBe(true);
  });

  it('ani při pádu VŠECH zápisů nic nevyletí a slot se uvolní', async () => {
    // Tohle je invariant, na kterém závisí, že plánovač nemůže položit
    // server. Selže měření i každý zápis i rozeslání.
    const { zapisy } = await spust({
      spustTest: async () => { throw new Error('pád'); },
      saveSession: async () => { throw new Error('db down'); },
      updateMonitorIfExists: async () => { throw new Error('db down'); },
      oznam: async () => { throw new Error('ws down'); },
    }).catch((err) => { throw new Error(`Vyletělo to: ${err.message}`); });

    expect(zapisy.some(([co]) => co === 'tepStop')).toBe(true);
    expect(zapisy.some(([co]) => co === 'slot')).toBe(true);
  });

  it('tep a slot se uvolní i na úspěšné cestě', async () => {
    // Neuvolněný slot znamená, že se po několika bězích monitoring
    // zasekne úplně — a přitom nic nehlásí.
    const { zapisy } = await spust();
    expect(zapisy.some(([co]) => co === 'tepStop')).toBe(true);
    expect(zapisy.some(([co]) => co === 'slot')).toBe(true);
  });

  it('seznam monitorů se rozešle na obou cestách', async () => {
    const uspech = await spust();
    expect(uspech.zapisy.some(([co]) => co === 'oznam')).toBe(true);

    const chyba = await spust({ spustTest: async () => { throw new Error('x'); } });
    expect(chyba.zapisy.some(([co]) => co === 'oznam')).toBe(true);
  });
});

describe('oznamMonitory', () => {
  it('nedostupná databáze server nepoloží', async () => {
    // `db.getMonitors` je v mocku nastavený tak, že vyhazuje. Dřív tenhle
    // await stál v `catch` bloku plovoucího async volání, takže neúspěch
    // rozeslání seznamu do UI shodil celý proces.
    await expect(__test__.oznamMonitory('u1')).resolves.toBeUndefined();
  });
});
