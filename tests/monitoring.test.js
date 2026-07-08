import { jest } from '@jest/globals';

const mockPage = {
  addInitScript: jest.fn().mockResolvedValue(null),
  goto: jest.fn(),
  url: jest.fn().mockReturnValue('https://example.com/test-page'),
  title: jest.fn().mockResolvedValue('AuraAuraGuard Test Page'),
  screenshot: jest.fn().mockResolvedValue(Buffer.from([])),
  on: jest.fn(),
  evaluate: jest.fn().mockResolvedValue([]),
  mouse: {
    wheel: jest.fn().mockResolvedValue(null)
  }
};

const mockContext = {
  newPage: jest.fn().mockResolvedValue(mockPage),
  close: jest.fn().mockResolvedValue(null),
  pages: jest.fn().mockReturnValue([mockPage])
};

const mockBrowser = {
  newContext: jest.fn().mockResolvedValue(mockContext),
  close: jest.fn().mockResolvedValue(null)
};

// Mock playwright module at the top of the file
jest.mock('playwright', () => ({
  chromium: {
    launch: jest.fn().mockImplementation(() => Promise.resolve(mockBrowser))
  }
}));

import { runAutonomousTest } from '../agent.js';
import { chromium } from 'playwright';
import fs from 'fs';

const originalFetch = global.fetch;
const originalExistsSync = fs.existsSync;
const originalWriteFileSync = fs.writeFileSync;

describe('AuraAuraGuard Page Monitoring Unit Tests', () => {
  let listeners = {};

  beforeEach(() => {
    listeners = {};

    // Reset mocks
    jest.clearAllMocks();

    // Catch page.on events
    mockPage.on.mockImplementation((event, handler) => {
      listeners[event] = handler;
    });

    // Mock global fetch to return LLM response to exit loop
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({
        choices: [
          {
            message: {
              content: JSON.stringify({
                action: 'finish',
                reasoning: 'Splněno - test ukončen.'
              })
            }
          }
        ]
      }),
      text: () => Promise.resolve('{}')
    });

    // Mock fs methods to avoid writing to disk
    fs.existsSync = jest.fn().mockReturnValue(true);
    fs.writeFileSync = jest.fn().mockImplementation(() => {});
  });

  afterEach(() => {
    global.fetch = originalFetch;
    fs.existsSync = originalExistsSync;
    fs.writeFileSync = originalWriteFileSync;
  });

  it('by měl úspěšně zachytit běhovou chybu z console listeneru', async () => {
    mockPage.goto.mockImplementation(async () => {
      // Trigger console events during page navigation
      if (listeners['console']) {
        listeners['console']({
          type: () => 'error',
          text: () => '[AuraAuraGuard-Error] Běhová chybová hláška'
        });
        listeners['console']({
          type: () => 'error',
          text: () => '[AuraAuraGuard-Promise] Selhání slibu (Promise): API call failed'
        });
      }
      return null;
    });

    const result = await runAutonomousTest(
      'https://example.com',
      'Najdi chyby',
      {
        provider: 'apfel',
        model: 'llama3',
        host: 'http://localhost:11434/v1/chat/completions',
        maxSteps: 1
      },
      () => {},
      'session_test_auraguard'
    );

    // Ověříme výsledné bugs
    expect(result.bugs).toBeDefined();
    expect(result.bugs).toContain('[AuraAuraGuard-Error] Běhová chybová hláška');
    expect(result.bugs).toContain('[AuraAuraGuard-Promise] Selhání slibu (Promise): API call failed');
  });

  it('by měl úspěšně zachytit performance varování z console listeneru', async () => {
    mockPage.goto.mockImplementation(async () => {
      if (listeners['console']) {
        listeners['console']({
          type: () => 'warning',
          text: () => '[AuraAuraGuard-Performance] Zaseknutí UI (Long Task): 180ms'
        });
      }
      return null;
    });

    const result = await runAutonomousTest(
      'https://example.com',
      'Test plynulosti',
      {
        provider: 'apfel',
        model: 'llama3',
        host: 'http://localhost:11434/v1/chat/completions',
        maxSteps: 1
      },
      () => {},
      'session_test_perf'
    );

    expect(result.bugs).toContain('[AuraAuraGuard-Performance] Zaseknutí UI (Long Task): 180ms');
  });

  it('by měl zachytit neošetřené výjimky přes pageerror a síťové chyby přes response', async () => {
    mockPage.goto.mockImplementation(async () => {
      // Vyvoláme pageerror
      if (listeners['pageerror']) {
        listeners['pageerror'](new Error('Fatal exception occurred'));
      }

      // Vyvoláme response se statusem 500
      if (listeners['response']) {
        listeners['response']({
          url: () => 'https://example.com/api/data',
          status: () => 500,
          request: () => ({
            method: () => 'POST',
            resourceType: () => 'fetch'
          })
        });
      }
      return null;
    });

    const result = await runAutonomousTest(
      'https://example.com',
      'Test exception',
      {
        provider: 'apfel',
        model: 'llama3',
        host: 'http://localhost:11434/v1/chat/completions',
        maxSteps: 1
      },
      () => {},
      'session_test_exception'
    );

    expect(result.bugs.some(b => b.includes('Fatal exception occurred'))).toBe(true);
    expect(result.bugs).toContain('[AuraAuraGuard-NetworkError] Selhání API: POST https://example.com/api/data - HTTP 500');
  });
});
