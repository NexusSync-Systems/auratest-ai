/**
 * GDPR AI Sentinel - Rychlá RegEx vrstva pro maskování osobních údajů (PII).
 * Zpracovává AuraGuard logy před uložením do databáze.
 */

const PII_PATTERNS = [
  // Email
  { regex: /([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9_-]+)/gi, replacement: '[REDACTED_EMAIL]' },
  // Credit Card (zjednodušený vzor)
  { regex: /\b(?:\d[ -]*?){13,16}\b/g, replacement: '[REDACTED_CREDIT_CARD]' },
  // Telefonní číslo (české/mezinárodní)
  { regex: /(?:\+?420)? ?\d{3} ?\d{3} ?\d{3}\b/g, replacement: '[REDACTED_PHONE]' },
  // Rodné číslo (zjednodušený CZ/SK vzor)
  { regex: /\b\d{6}\/\d{3,4}\b/g, replacement: '[REDACTED_NATIONAL_ID]' }
];

function redactString(text) {
  if (typeof text !== 'string') return text;
  let redacted = text;
  for (const { regex, replacement } of PII_PATTERNS) {
    redacted = redacted.replace(regex, replacement);
  }
  return redacted;
}

function redactObject(obj) {
  if (obj === null || obj === undefined) return obj;
  
  if (typeof obj === 'string') {
    return redactString(obj);
  }
  
  if (Array.isArray(obj)) {
    return obj.map(item => redactObject(item));
  }
  
  if (typeof obj === 'object') {
    const redactedObj = {};
    for (const [key, value] of Object.entries(obj)) {
      redactedObj[key] = redactObject(value);
    }
    return redactedObj;
  }
  
  return obj;
}

export function redactEventData(eventPayload) {
  // Ošetříme payload (nechceme přepisovat ID nebo type, ale data/message)
  return redactObject(eventPayload);
}
