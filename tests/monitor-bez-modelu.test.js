/**
 * @jest-environment node
 */
import { jest } from '@jest/globals';

/**
 * Monitor na instalaci BEZ jazykového modelu.
 *
 * NAMĚŘENO V PRODUKCI 19. 9. 2026: monitor s intervalem 1 minuta se šest
 * minut po sobě spustil, šestkrát spadl na „Selhání komunikace s Ollamou
 * (http://localhost:11434): fetch failed" a nezměřil ani jeden krok.
 *
 * `/api/run-test` takový běh odmítne — `llmUnavailableFor` existuje přesně
 * kvůli tomu a komentář u `isLlmConfigured()` ten scénář popisuje slovo za
 * slovem. Plánovač tu pojistku ale nevolal. Pošesté týž vzorec: pravidlo
 * ošetřené na jedné ze dvou cest.
 *
 * Vada se neprojevila v žádném testu ani ve smoke testu, protože smoke
 * test plánovač vůbec nespouští a testy běží s prázdnou konfigurací, kde
 * `ALLOWED_LLM_HOSTS` propadne na výchozí localhost — a instalace se pak
 * považuje za vybavenou modelem.
 *
 * Proto tohle MUSÍ být samostatný soubor: `ALLOWED_LLM_HOSTS` se čte při
 * načtení modulu, takže se nastavuje před `require`. Statický `import` se
 * hoistuje nad přiřazení a bylo by pozdě.
 */

// Prázdná hodnota = instalace bez modelu. Nikoli chybějící proměnná:
// ta propadne na výchozí localhost (`??` se uplatní jen na null/undefined).
process.env.ALLOWED_LLM_HOSTS = '';

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
    getAllActiveMonitors: jest.fn(async () => []),
    rezervujSlotMonitoru: jest.fn(async () => ({ stav: 'rezervovano', duvod: '' })),
  };
  return mockDb;
});
jest.mock('../ssrf-guard.js', () => ({
  assertPublicHttpUrl: jest.fn(async () => true),
  resolvePublicHttpTarget: jest.fn(async (u) => u),
}));
jest.mock('../agent.js', () => ({
  runAutonomousTest: jest.fn(async () => ({ steps: [], bugs: [], summary: 'mock' })),
  comparePages: jest.fn(), auditTranslations: jest.fn(), extractInternalLinks: jest.fn(),
  analyzeSecurityVulnerabilities: jest.fn(), auditAccessibility: jest.fn(),
  auditNIS2AndPQC: jest.fn(), auditGreenAndResidency: jest.fn(),
  generateAutoHealPatch: jest.fn(), auditCRA_SBOM: jest.fn(), runChaosTest: jest.fn(),
  getGridEnergyStatus: jest.fn(), auditAIAct: jest.fn(), auditStrictCookies: jest.fn(),
  auditCRAVulnerabilities: jest.fn(), checkPage: jest.fn(), checkForm: jest.fn(),
}));

// `require`, ne `import` — viz hlavička.
const { __test__, isLlmConfigured } = require('../server.js');

const monitor = {
  id: 'm1',
  userId: 'u1',
  name: 'Monitor bez modelu',
  url: 'https://example.com/',
  goal: 'cokoli',
  interval: '1m',
  lastRunTime: 0,
  active: true,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockDb.getAllActiveMonitors.mockResolvedValue([monitor]);
  __test__.browserSlots.inUse = 0;
});

describe('plánovač bez jazykového modelu', () => {
  it('kontrolní předpoklad: instalace se hlásí jako bez modelu', () => {
    // Bez tohohle by celý soubor mohl procházet z nesprávného důvodu.
    expect(isLlmConfigured()).toBe(false);
  });

  it('běh se vůbec nespustí', async () => {
    await __test__.schedulerTick();
    expect(mockDb.rezervujSlotMonitoru).not.toHaveBeenCalled();
    expect(mockDb.saveSession).not.toHaveBeenCalled();
  });

  it('monitor se vypne a důvod je vidět', async () => {
    // Přeskočit ho a nechat aktivní by znamenalo, že mlčí a nikdo neví
    // proč. `lastError` se zobrazuje v UI.
    await __test__.schedulerTick();
    expect(mockDb.updateMonitorIfExists).toHaveBeenCalledWith('m1', expect.objectContaining({
      active: false,
      lastError: expect.stringContaining('jazykový model'),
    }));
  });

  it('do neměnného záznamu nepřiteče nic', async () => {
    // Tohle je ta vlastní škoda: každou minutu řádek ve spisu pro úřad,
    // který o auditovaném webu neříká nic a smazat se nedá.
    await __test__.schedulerTick();
    expect(mockDb.saveSession).not.toHaveBeenCalled();
  });

  it('opakovaný tik nezaloží běh ani po deaktivaci', async () => {
    await __test__.schedulerTick();
    await __test__.schedulerTick();
    expect(mockDb.saveSession).not.toHaveBeenCalled();
  });
});
