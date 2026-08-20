import { jest } from '@jest/globals';

// Mock the db.js layer to prevent Firestore initialization and database calls during tests
jest.mock('../db.js', () => {
  let monitors = [];
  let auraguardEvents = [];
  let projects = [
    { id: 'proj_test_123', userId: 'mock-user-123', name: 'Test Project', active: true, allowedOrigins: [] },
    { id: 'my-production-app', userId: 'mock-user-123', name: 'Production App', active: true, allowedOrigins: [] }
  ];
  let sessions = [];

  return {
    getProjects: jest.fn(() => Promise.resolve(projects)),
    createProject: jest.fn((userId, name, allowedOrigins) => {
      const p = { id: 'proj_test_new', userId, name, allowedOrigins, active: true };
      projects.push(p);
      return Promise.resolve(p);
    }),
    getProjectByKey: jest.fn((key) => Promise.resolve(projects.find(p => p.id === key) || null)),
    deleteProject: jest.fn(() => Promise.resolve(true)),

    getMonitors: jest.fn(() => Promise.resolve(monitors)),
    getAllActiveMonitors: jest.fn(() => Promise.resolve(monitors.filter(m => m.active))),
    createMonitor: jest.fn((userId, data) => {
      const m = { id: 'mon_test_new', userId, ...data, active: true };
      monitors.push(m);
      return Promise.resolve(m);
    }),
    getMonitorById: jest.fn((id) => Promise.resolve(monitors.find(m => m.id === id) || null)),
    updateMonitor: jest.fn((id, update) => {
      const idx = monitors.findIndex(m => m.id === id);
      if (idx !== -1) {
        monitors[idx] = { ...monitors[idx], ...update };
        return Promise.resolve(monitors[idx]);
      }
      return Promise.resolve(null);
    }),
    deleteMonitor: jest.fn((id) => {
      monitors = monitors.filter(m => m.id !== id);
      return Promise.resolve(true);
    }),

    getAuraGuardEvents: jest.fn(() => Promise.resolve(auraguardEvents)),
    createAuraGuardEvent: jest.fn((data) => {
      const e = { id: 'evt_test_new', ...data, timestamp: new Date().toISOString() };
      auraguardEvents.push(e);
      return Promise.resolve(e);
    }),

    getSessions: jest.fn(() => Promise.resolve(sessions)),
    getSession: jest.fn((id) => Promise.resolve(sessions.find(s => s.id === id) || null)),
    saveSession: jest.fn((id, data) => {
      const idx = sessions.findIndex(s => s.id === id);
      if (idx !== -1) {
        sessions[idx] = { ...sessions[idx], ...data };
      } else {
        sessions.push({ id, ...data });
      }
      return Promise.resolve(true);
    })
  };
});

// Mock SSRF guardu: testy nesmí záviset na DNS. Skutečné chování guardu
// pokrývá tests/ssrf-guard.test.js; tady jen simulujeme "veřejná adresa
// projde, interní ne", aby šlo ověřit, že ho routy vůbec volají.
jest.mock('../ssrf-guard.js', () => ({
  assertPublicHttpUrl: jest.fn(async (raw) => {
    const parsed = new URL(raw);
    if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.)/.test(parsed.hostname)) {
      throw new Error('Cílová adresa míří na neveřejný/interní rozsah IP.');
    }
    return parsed.toString();
  })
}));

// Mock the auth.js middleware
jest.mock('../auth.js', () => {
  return {
    authenticateToken: (req, res, next) => {
      req.user = { userId: 'mock-user-123', email: 'test@example.com' };
      next();
    }
  };
});

import request from 'supertest';
import { app } from '../server.js';
import fs from 'fs';

const originalExistsSync = fs.existsSync;
const originalWriteFileSync = fs.writeFileSync;
const originalReadFileSync = fs.readFileSync;

describe('AuraAuraGuard Hub API & SDK Integration Tests', () => {
  beforeEach(() => {
    // Mock files system to isolate test data
    fs.existsSync = jest.fn().mockImplementation((path) => {
      if (path.includes('monitors.json') || path.includes('auraguard_events.json')) {
        return false;
      }
      return originalExistsSync(path);
    });

    fs.writeFileSync = jest.fn().mockImplementation(() => {});
    fs.readFileSync = jest.fn().mockImplementation(() => '[]');
  });

  afterEach(() => {
    fs.existsSync = originalExistsSync;
    fs.writeFileSync = originalWriteFileSync;
    fs.readFileSync = originalReadFileSync;
    jest.restoreAllMocks();
  });

  it('GET /api/monitors by měl vrátit prázdné pole, pokud soubor neexistuje', async () => {
    const res = await request(app).get('/api/monitors');
    expect(res.statusCode).toEqual(200);
    expect(Array.isArray(res.body)).toBeTruthy();
  });

  it('POST /api/monitors by měl vytvořit a uložit nový monitor', async () => {
    const newMonitor = {
      name: 'Test Monitor',
      url: 'https://example.com/test',
      goal: 'Zkontroluj chybové logy',
      interval: '5m',
      trackExceptions: true,
      slowApiThresholdMs: 2000
    };

    const res = await request(app)
      .post('/api/monitors')
      .send(newMonitor);

    expect(res.statusCode).toEqual(201);
    expect(res.body.id).toBeDefined();
    expect(res.body.name).toEqual('Test Monitor');
    expect(res.body.url).toEqual('https://example.com/test');
    expect(res.body.interval).toEqual('5m');
    expect(res.body.slowApiThresholdMs).toEqual(2000);
  });

  it('POST /api/monitors by měl odmítnout interní URL (SSRF)', async () => {
    const res = await request(app)
      .post('/api/monitors')
      .send({ name: 'Interní', url: 'http://169.254.169.254/latest/meta-data/' });

    expect(res.statusCode).toEqual(400);
    expect(res.body.error).toMatch(/neveřejn|interní/i);
  });

  it('PATCH /api/monitors/:id by měl ignorovat pokus o přepsání userId', async () => {
    const createRes = await request(app)
      .post('/api/monitors')
      .send({ name: 'Ownership', url: 'https://example.com/own' });

    const updateRes = await request(app)
      .patch(`/api/monitors/${createRes.body.id}`)
      .send({ active: false, userId: 'attacker-999', lastRunStatus: 'success' });

    expect(updateRes.statusCode).toEqual(200);
    expect(updateRes.body.userId).toEqual('mock-user-123');
    expect(updateRes.body.lastRunStatus).not.toEqual('success');
  });

  it('PATCH /api/monitors/:id by měl aktualizovat status monitoru', async () => {
    // Vytvoříme monitor
    const createRes = await request(app)
      .post('/api/monitors')
      .send({ name: 'Editable Monitor', url: 'https://example.com/editable' });

    const monitorId = createRes.body.id;

    // Upravíme status
    const updateRes = await request(app)
      .patch(`/api/monitors/${monitorId}`)
      .send({ active: false });

    expect(updateRes.statusCode).toEqual(200);
    expect(updateRes.body.active).toBe(false);
  });

  it('DELETE /api/monitors/:id by měl odstranit monitor ze seznamu', async () => {
    const createRes = await request(app)
      .post('/api/monitors')
      .send({ name: 'To Delete', url: 'https://example.com/delete' });

    const monitorId = createRes.body.id;

    const deleteRes = await request(app).delete(`/api/monitors/${monitorId}`);
    expect(deleteRes.statusCode).toEqual(200);
    expect(deleteRes.body.success).toBe(true);

    const getRes = await request(app).get('/api/monitors');
    const remains = getRes.body.find(m => m.id === monitorId);
    expect(remains).toBeUndefined();
  });

  it('POST /api/auraguard/report by měl přijmout a uložit produkční log a GET /api/auraguard/events jej vrátit', async () => {
    const eventPayload = {
      project: 'my-production-app',
      type: 'error',
      data: {
        message: 'Uncaught ReferenceError: x is not defined',
        filename: 'production.min.js',
        lineno: 110
      }
    };

    const postRes = await request(app)
      .post('/api/auraguard/report')
      .send(eventPayload);

    expect(postRes.statusCode).toEqual(200);
    expect(postRes.body.success).toBe(true);
    expect(postRes.body.eventId).toBeDefined();

    // Načteme events
    const getRes = await request(app).get('/api/auraguard/events');
    expect(getRes.statusCode).toEqual(200);
    const savedEvent = getRes.body.find(evt => evt.id === postRes.body.eventId);
    expect(savedEvent).toBeDefined();
    expect(savedEvent.project).toEqual('my-production-app');
    expect(savedEvent.data.message).toContain('ReferenceError');
  });

  it('GET /api/auraguard/sdk.js by měl sloužit platný javascript kód SDK', async () => {
    const res = await request(app).get('/api/auraguard/sdk.js');
    expect(res.statusCode).toEqual(200);
    expect(res.headers['content-type']).toContain('application/javascript');
    expect(res.text).toContain('auraguard/report');
    expect(res.text).toContain('PerformanceObserver');
  });
});
