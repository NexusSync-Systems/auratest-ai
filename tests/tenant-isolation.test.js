import { jest } from '@jest/globals';

/**
 * Multi-tenant izolace: uživatel A nesmí číst ani měnit data uživatele B.
 *
 * Dosud takový test neexistoval — auth byl všude vymockovaný na jednoho
 * pevného uživatele, takže se izolace nikdy neověřovala.
 *
 * Zároveň se tu ověřuje, že audit endpointy skutečně volají SSRF guard
 * (samotný guard testuje ssrf-guard.test.js, ale jeho zapojení do rout ne).
 */

// Kdo je právě "přihlášený" — testy si to přepínají.
// Prefix `mock` je nutný: jest.mock factory se hoistuje nad deklarace a smí
// odkazovat jen na proměnné s tímto prefixem.
let mockCurrentUserId = 'user-a';

const mockStore = {
  monitors: [],
  projects: [],
  sessions: [],
  events: [],
};

jest.mock('../auth.js', () => ({
  authenticateToken: (req, res, next) => {
    req.user = { userId: mockCurrentUserId, email: `${mockCurrentUserId}@example.com` };
    next();
  },
}));

jest.mock('../db.js', () => ({
  auth: { verifyIdToken: jest.fn() },

  getProjects: jest.fn(async () => mockStore.projects.filter((p) => p.userId === mockCurrentUserId)),
  getProjectByKey: jest.fn(async (id) => mockStore.projects.find((p) => p.id === id) || null),
  createProject: jest.fn(async (userId, name, allowedOrigins) => {
    const p = { id: `proj_${mockStore.projects.length}`, userId, name, allowedOrigins, active: true };
    mockStore.projects.push(p);
    return p;
  }),
  deleteProject: jest.fn(async (id) => {
    mockStore.projects = mockStore.projects.filter((p) => p.id !== id);
    return true;
  }),

  getMonitors: jest.fn(async () => mockStore.monitors.filter((m) => m.userId === mockCurrentUserId)),
  getAllActiveMonitors: jest.fn(async () => mockStore.monitors.filter((m) => m.active)),
  createMonitor: jest.fn(async (userId, data) => {
    const m = { id: `mon_${mockStore.monitors.length}`, userId, ...data, active: true };
    mockStore.monitors.push(m);
    return m;
  }),
  getMonitorById: jest.fn(async (id) => mockStore.monitors.find((m) => m.id === id) || null),
  updateMonitor: jest.fn(async (id, update) => {
    const m = mockStore.monitors.find((x) => x.id === id);
    if (!m) return null;
    Object.assign(m, update);
    return m;
  }),
  deleteMonitor: jest.fn(async (id) => {
    mockStore.monitors = mockStore.monitors.filter((m) => m.id !== id);
    return true;
  }),

  getSessions: jest.fn(async () => mockStore.sessions.filter((s) => s.userId === mockCurrentUserId)),
  getSession: jest.fn(async (id) => mockStore.sessions.find((s) => s.id === id) || null),
  saveSession: jest.fn(async (id, data) => {
    const idx = mockStore.sessions.findIndex((s) => s.id === id);
    if (idx === -1) mockStore.sessions.push({ id, ...data });
    else mockStore.sessions[idx] = { ...mockStore.sessions[idx], ...data };
    return true;
  }),

  getAuraGuardEvents: jest.fn(async () => mockStore.events.filter((e) => e.userId === mockCurrentUserId)),
  createAuraGuardEvent: jest.fn(async (data) => {
    const e = { id: `evt_${mockStore.events.length}`, ...data };
    mockStore.events.push(e);
    return e;
  }),
}));

// SSRF guard: bez mocku by testy závisely na DNS.
jest.mock('../ssrf-guard.js', () => ({
  assertPublicHttpUrl: jest.fn(async (raw) => {
    const parsed = new URL(raw);
    if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.)/.test(parsed.hostname)) {
      throw new Error('Cílová adresa míří na neveřejný/interní rozsah IP.');
    }
    return parsed.toString();
  }),
}));

// Audity nesmí v testu opravdu spustit Chromium. Všechny sdílejí jednu
// mock funkci, takže jde ověřit, že se při zablokované URL vůbec nezavolala.
jest.mock('../agent.js', () => {
  const sharedAudit = jest.fn(async (url) => ({ success: true, url }));
  return {
  runAutonomousTest: jest.fn(async () => ({ bugs: [], steps: [], summary: '' })),
  comparePages: jest.fn(),
  auditTranslations: jest.fn(),
  extractInternalLinks: jest.fn(async () => []),
  analyzeSecurityVulnerabilities: jest.fn(async () => 'analýza'),
  auditAccessibility: sharedAudit,
  auditNIS2AndPQC: sharedAudit,
  auditGreenAndResidency: sharedAudit,
  generateAutoHealPatch: jest.fn(async () => ({ text: '' })),
  auditCRA_SBOM: sharedAudit,
  runChaosTest: sharedAudit,
  getGridEnergyStatus: jest.fn(() => ({ simulated: true })),
  auditAIAct: sharedAudit,
  auditStrictCookies: sharedAudit,
  auditCRAVulnerabilities: sharedAudit,
  checkPage: jest.fn(async (t) => ({ ok: true, url: t.url })),
  checkForm: jest.fn(async (t) => ({ ok: true, url: t.url })),
  };
});

import request from 'supertest';
import { app } from '../server.js';
import * as agent from '../agent.js';

const auditSpy = agent.auditAccessibility;

function reset() {
  mockStore.monitors = [];
  mockStore.projects = [];
  mockStore.sessions = [];
  mockStore.events = [];
  mockCurrentUserId = 'user-a';
  auditSpy.mockClear();
}

describe('Multi-tenant izolace', () => {
  beforeEach(reset);

  it('GET /api/monitors vrátí jen monitory přihlášeného uživatele', async () => {
    await request(app).post('/api/monitors').send({ name: 'A', url: 'https://a.example.com' });

    mockCurrentUserId = 'user-b';
    await request(app).post('/api/monitors').send({ name: 'B', url: 'https://b.example.com' });

    const resB = await request(app).get('/api/monitors');
    expect(resB.body).toHaveLength(1);
    expect(resB.body[0].name).toBe('B');

    mockCurrentUserId = 'user-a';
    const resA = await request(app).get('/api/monitors');
    expect(resA.body).toHaveLength(1);
    expect(resA.body[0].name).toBe('A');
  });

  it('PATCH cizího monitoru vrátí 403', async () => {
    const created = await request(app)
      .post('/api/monitors')
      .send({ name: 'A', url: 'https://a.example.com' });

    mockCurrentUserId = 'user-b';
    const res = await request(app)
      .patch(`/api/monitors/${created.body.id}`)
      .send({ active: false });

    expect(res.statusCode).toBe(403);
    expect(mockStore.monitors[0].active).toBe(true);
  });

  it('DELETE cizího monitoru vrátí 403 a monitor zůstane', async () => {
    const created = await request(app)
      .post('/api/monitors')
      .send({ name: 'A', url: 'https://a.example.com' });

    mockCurrentUserId = 'user-b';
    const res = await request(app).delete(`/api/monitors/${created.body.id}`);

    expect(res.statusCode).toBe(403);
    expect(mockStore.monitors).toHaveLength(1);
  });

  it('DELETE cizího projektu vrátí 403', async () => {
    const created = await request(app).post('/api/projects').send({ name: 'Projekt A' });

    mockCurrentUserId = 'user-b';
    const res = await request(app).delete(`/api/projects/${created.body.id}`);

    expect(res.statusCode).toBe(403);
    expect(mockStore.projects).toHaveLength(1);
  });

  it('GET cizí session vrátí 403', async () => {
    mockStore.sessions.push({ id: 'session_a', userId: 'user-a', url: 'https://a.example.com' });

    mockCurrentUserId = 'user-b';
    const res = await request(app).get('/api/sessions/session_a');

    expect(res.statusCode).toBe(403);
  });

  it('analyze-security nezanalyzuje cizí události', async () => {
    mockStore.events.push({ id: 'evt_a', userId: 'user-a', project: 'proj_a', data: {} });

    mockCurrentUserId = 'user-b';
    const res = await request(app)
      .post('/api/auraguard/analyze-security')
      .send({ eventIds: ['evt_a'] });

    expect(res.statusCode).toBe(404);
  });
});

describe('Artefakty vyžadují capability token', () => {
  beforeEach(reset);

  it('bez tokenu vrátí 401', async () => {
    const res = await request(app).get('/api/screenshots/session_abc_step_1.png');
    expect(res.statusCode).toBe(401);
  });

  it('se špatným tokenem vrátí 404', async () => {
    mockStore.sessions.push({ id: 'session_abc', userId: 'user-a', artifactToken: 'spravny-token' });

    const res = await request(app).get('/api/screenshots/session_abc_step_1.png?t=spatny');
    expect(res.statusCode).toBe(404);
  });

  it('odmítne pokus o path traversal v názvu souboru', async () => {
    const res = await request(app).get('/api/screenshots/..%2F..%2Fetc%2Fpasswd?t=x');
    expect([400, 404]).toContain(res.statusCode);
  });
});

describe('SSRF guard je zapojený do audit endpointů', () => {
  beforeEach(reset);

  const auditPaths = [
    '/api/auraguard/analyze-accessibility',
    '/api/auraguard/analyze-nis2',
    '/api/auraguard/analyze-green-gdpr',
    '/api/auraguard/analyze-cra',
    '/api/auraguard/chaos-test',
    '/api/auraguard/ai-act-audit',
    '/api/auraguard/cookie-audit',
    '/api/auraguard/cra-vuln-audit',
  ];

  it.each(auditPaths)('%s odmítne interní adresu', async (path) => {
    const res = await request(app)
      .post(path)
      .send({ url: 'http://169.254.169.254/latest/meta-data/' });

    expect(res.statusCode).toBe(400);
    // Audit se nesmí vůbec spustit.
    expect(auditSpy).not.toHaveBeenCalled();
  });

  it.each(auditPaths)('%s odmítne chybějící URL', async (path) => {
    const res = await request(app).post(path).send({});
    expect(res.statusCode).toBe(400);
  });

  it('monitor-page odmítne interní adresu v target.url', async () => {
    const res = await request(app)
      .post('/api/auraguard/monitor-page')
      .send({ target: { url: 'http://127.0.0.1:8080/admin' } });

    expect(res.statusCode).toBe(400);
  });

  it('monitor-form odmítne interní adresu v target.url', async () => {
    const res = await request(app)
      .post('/api/auraguard/monitor-form')
      .send({ target: { url: 'http://10.0.0.5/internal', method: 'POST', fields: {} } });

    expect(res.statusCode).toBe(400);
  });

  it('run-test odmítne interní adresu', async () => {
    const res = await request(app)
      .post('/api/run-test')
      .send({ url: 'http://192.168.1.1/', goal: 'cokoli' });

    expect(res.statusCode).toBe(400);
  });
});
