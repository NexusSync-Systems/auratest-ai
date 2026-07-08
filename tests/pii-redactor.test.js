import { redactEventData } from '../pii-redactor.js';

describe('PII Redactor', () => {
  it('should redact emails', () => {
    const payload = {
      message: 'Uživatel jan.novak@example.com se nemohl přihlásit.'
    };
    const redacted = redactEventData(payload);
    expect(redacted.message).toBe('Uživatel [REDACTED_EMAIL] se nemohl přihlásit.');
  });

  it('should redact credit cards', () => {
    const payload = {
      data: { error: 'Platba kartou 4532 1234 5678 9012 selhala.' }
    };
    const redacted = redactEventData(payload);
    expect(redacted.data.error).toBe('Platba kartou [REDACTED_CREDIT_CARD] selhala.');
  });

  it('should not mutate original object', () => {
    const payload = { message: 'test@test.cz' };
    const redacted = redactEventData(payload);
    expect(payload.message).toBe('test@test.cz');
    expect(redacted.message).toBe('[REDACTED_EMAIL]');
  });
});
