import { jest } from '@jest/globals';

/**
 * Testy skutečného authenticateToken middleware.
 *
 * Ve všech ostatních server testech je auth.js vymockovaný na pass-through,
 * takže dosud neexistoval jediný test, který by ověřil, že neautentizovaný
 * požadavek dostane 401 nebo že podvržený token je odmítnut. Pro projekt
 * s CI jobem "Bezpečnostní testy" to byla největší mezera.
 */

jest.mock('../db.js', () => ({
  auth: { verifyIdToken: jest.fn() },
}));

import { authenticateToken } from '../auth.js';
import { auth } from '../db.js';

const verifyIdToken = auth.verifyIdToken;

function mockRes() {
  return {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

describe('authenticateToken', () => {
  beforeEach(() => {
    verifyIdToken.mockReset();
  });

  it('vrátí 401, když chybí hlavička Authorization', async () => {
    const req = { headers: {} };
    const res = mockRes();
    const next = jest.fn();

    await authenticateToken(req, res, next);

    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
    expect(verifyIdToken).not.toHaveBeenCalled();
  });

  it('vrátí 401, když je hlavička prázdná nebo bez tokenu', async () => {
    for (const header of ['', 'Bearer', 'Bearer ']) {
      const req = { headers: { authorization: header } };
      const res = mockRes();
      const next = jest.fn();

      await authenticateToken(req, res, next);

      expect(res.statusCode).toBe(401);
      expect(next).not.toHaveBeenCalled();
    }
  });

  it('vrátí 403 pro podvržený token', async () => {
    verifyIdToken.mockRejectedValue(new Error('Firebase ID token has invalid signature.'));

    const req = { headers: { authorization: 'Bearer podvrzeny.token.abc' } };
    const res = mockRes();
    const next = jest.fn();

    await authenticateToken(req, res, next);

    expect(res.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('vrátí 403 pro expirovaný token', async () => {
    verifyIdToken.mockRejectedValue(new Error('Firebase ID token has expired.'));

    const req = { headers: { authorization: 'Bearer expirovany' } };
    const res = mockRes();
    const next = jest.fn();

    await authenticateToken(req, res, next);

    expect(res.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('nastaví req.user a pustí dál platný token', async () => {
    verifyIdToken.mockResolvedValue({ uid: 'user-abc', email: 'kdo@example.com' });

    const req = { headers: { authorization: 'Bearer platny' } };
    const res = mockRes();
    const next = jest.fn();

    await authenticateToken(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBeNull();
    expect(req.user).toEqual({ userId: 'user-abc', email: 'kdo@example.com' });
  });

  it('nedůvěřuje uid z těla požadavku, ale jen z ověřeného tokenu', async () => {
    verifyIdToken.mockResolvedValue({ uid: 'skutecny-uid', email: 'a@example.com' });

    const req = {
      headers: { authorization: 'Bearer platny' },
      body: { userId: 'podvrzeny-uid' },
    };
    const res = mockRes();
    const next = jest.fn();

    await authenticateToken(req, res, next);

    expect(req.user.userId).toBe('skutecny-uid');
  });
});
