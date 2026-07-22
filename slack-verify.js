/**
 * Ověření pravosti příchozího Slack požadavku podle podpisu (v0).
 * Dokumentace: https://api.slack.com/authentication/verifying-requests-from-slack
 *
 * Podpis se počítá z NEZPARSOVANÉHO těla požadavku, proto route musí zachytit
 * raw Buffer (express.raw), ne až JSON.
 */
import crypto from 'node:crypto';

const FIVE_MINUTES = 60 * 5;

// Podepisovací tajemství obou Slack aplikací (compliance + uptime).
function signingSecrets() {
  return [
    process.env.SLACK_COMPLIANCE_SIGNING_SECRET,
    process.env.SLACK_UPTIME_SIGNING_SECRET,
  ].filter(Boolean);
}

/**
 * @param {Buffer|string} rawBody  nezparsované tělo požadavku
 * @param {object} headers         req.headers
 * @returns {{ ok: boolean, reason?: string }}
 */
export function verifySlackRequest(rawBody, headers) {
  const secrets = signingSecrets();
  if (secrets.length === 0) {
    return { ok: false, reason: 'Chybí SLACK_*_SIGNING_SECRET v konfiguraci.' };
  }

  const timestamp = headers['x-slack-request-timestamp'];
  const signature = headers['x-slack-signature'];
  if (!timestamp || !signature) {
    return { ok: false, reason: 'Chybí Slack podpisové hlavičky.' };
  }

  // Ochrana proti replay útoku — požadavek nesmí být starší než 5 minut.
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(timestamp)) > FIVE_MINUTES) {
    return { ok: false, reason: 'Slack timestamp je mimo povolené okno (replay).' };
  }

  const body = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody || '');
  const base = `v0:${timestamp}:${body}`;

  // Podpis musí sedět proti alespoň jednomu ze secretů (compliance/uptime).
  for (const secret of secrets) {
    const expected = 'v0=' + crypto.createHmac('sha256', secret).update(base).digest('hex');
    const a = Buffer.from(expected);
    const b = Buffer.from(signature);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
      return { ok: true };
    }
  }
  return { ok: false, reason: 'Neplatný Slack podpis.' };
}

/**
 * Vytáhne payload z raw těla (Slack interaktivita posílá form-urlencoded
 * `payload=<json>`; fallback na čisté JSON tělo).
 */
export function parseSlackPayload(rawBody) {
  const body = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody || '');
  if (!body) return null;

  // form-urlencoded s klíčem payload
  if (body.includes('payload=')) {
    const params = new URLSearchParams(body);
    const p = params.get('payload');
    if (p) return JSON.parse(p);
  }
  // fallback: JSON tělo
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}
