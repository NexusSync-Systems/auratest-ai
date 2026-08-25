import { describe, test, expect } from 'vitest';
import { authErrorMessage, isConfigurationError } from './auth-errors.js';

/**
 * Hlášky přihlášení.
 *
 * Motivace: uživatel viděl `Firebase: Error (auth/network-request-failed).`
 * Ta hláška mu neřekne nic a vývojáře pošle hledat výpadek internetu —
 * skutečnou příčinou přitom byla Content-Security-Policy na proxy, která
 * zakazovala spojení na Google API.
 */

const err = (code) => ({ code, message: `Firebase: Error (${code}).` });

describe('authErrorMessage', () => {
  test('neprozradí, které e-maily jsou registrované', () => {
    // Kdyby UI rozlišovalo „účet neexistuje" od „špatné heslo", šlo by
    // z něj vyčíst seznam uživatelů.
    const forUnknown = authErrorMessage(err('auth/user-not-found'));
    const forWrongPassword = authErrorMessage(err('auth/wrong-password'));
    expect(forUnknown).toBe(forWrongPassword);
  });

  test('u chyby konfigurace neobviňuje uživatele z hesla', () => {
    const message = authErrorMessage(err('auth/network-request-failed'));
    expect(message).not.toMatch(/heslo/i);
    expect(message).toMatch(/Content-Security-Policy|spojit/);
    expect(message).toMatch(/Opakovaný pokus nepomůže/);
  });

  test('nevrací syrový kód Firebase u známých případů', () => {
    for (const code of [
      'auth/invalid-email',
      'auth/weak-password',
      'auth/email-already-in-use',
      'auth/too-many-requests',
    ]) {
      expect(authErrorMessage(err(code))).not.toContain('Firebase');
      expect(authErrorMessage(err(code))).not.toContain(code);
    }
  });

  test('neznámý kód ukáže, ale s návodem co s ním', () => {
    // Schovat ho úplně by znemožnilo problém srozumitelně nahlásit.
    const message = authErrorMessage(err('auth/neco-noveho'));
    expect(message).toContain('auth/neco-noveho');
    expect(message).toMatch(/správci/);
  });

  test('chyba bez kódu nespadne', () => {
    for (const value of [undefined, null, {}, new Error('boom')]) {
      expect(typeof authErrorMessage(value)).toBe('string');
      expect(authErrorMessage(value).length).toBeGreaterThan(10);
    }
  });
});

describe('isConfigurationError', () => {
  test('rozpozná chyby nasazení', () => {
    expect(isConfigurationError(err('auth/network-request-failed'))).toBe(true);
    expect(isConfigurationError(err('auth/invalid-api-key'))).toBe(true);
  });

  test('špatné heslo chybou nasazení není', () => {
    expect(isConfigurationError(err('auth/wrong-password'))).toBe(false);
    expect(isConfigurationError(undefined)).toBe(false);
  });
});
