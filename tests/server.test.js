import { jest } from '@jest/globals';

// Mock the db.js layer to prevent Firestore initialization and database calls during tests
jest.mock('../db.js', () => {
  return {
    getSessions: jest.fn(() => Promise.resolve([])),
    getSession: jest.fn(() => Promise.resolve(null)),
    saveSession: jest.fn(() => Promise.resolve(true))
  };
});

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

describe('AuraTest AI API Smoke Tests', () => {
  it('GET /api/sessions by měl vrátit seznam relací (200 OK)', async () => {
    const res = await request(app).get('/api/sessions');
    expect(res.statusCode).toEqual(200);
    expect(Array.isArray(res.body)).toBeTruthy();
  });

  it('GET /api/mock-translations by měl vrátit překladový objekt (200 OK)', async () => {
    const res = await request(app).get('/api/mock-translations');
    expect(res.statusCode).toEqual(200);
    expect(res.body['hn.title']).toBeDefined();
    expect(res.body['hn.title']).toEqual('Hacker News');
  });
});
