import { describe, it, expect } from 'vitest';
import { extractInternalLinks } from '../../agent.js';
import fs from 'fs';
import path from 'path';

// Zjednodušený test, který kontroluje exporty a importy agenta
describe('Agent module', () => {
  it('mělo by existovat funkční propojení na agent API', () => {
    expect(typeof extractInternalLinks).toBe('function');
  });
});
