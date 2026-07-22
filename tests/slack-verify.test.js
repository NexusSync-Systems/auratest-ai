import crypto from 'node:crypto';
import { verifySlackRequest, parseSlackPayload } from '../slack-verify.js';

const SECRET = 'test-signing-secret';

function sign(body, ts, secret = SECRET) {
  return 'v0=' + crypto.createHmac('sha256', secret).update(`v0:${ts}:${body}`).digest('hex');
}

beforeEach(() => {
  process.env.SLACK_COMPLIANCE_SIGNING_SECRET = SECRET;
  delete process.env.SLACK_UPTIME_SIGNING_SECRET;
});

describe('slack-verify — verifySlackRequest', () => {
  const body = 'payload=' + encodeURIComponent(JSON.stringify({ type: 'block_actions' }));

  test('platný podpis → ok', () => {
    const ts = Math.floor(Date.now() / 1000).toString();
    const res = verifySlackRequest(Buffer.from(body), {
      'x-slack-request-timestamp': ts,
      'x-slack-signature': sign(body, ts),
    });
    expect(res.ok).toBe(true);
  });

  test('neplatný podpis → odmítnuto', () => {
    const ts = Math.floor(Date.now() / 1000).toString();
    const res = verifySlackRequest(Buffer.from(body), {
      'x-slack-request-timestamp': ts,
      'x-slack-signature': 'v0=deadbeef',
    });
    expect(res.ok).toBe(false);
  });

  test('starý timestamp → replay odmítnut', () => {
    const oldTs = (Math.floor(Date.now() / 1000) - 9999).toString();
    const res = verifySlackRequest(Buffer.from(body), {
      'x-slack-request-timestamp': oldTs,
      'x-slack-signature': sign(body, oldTs),
    });
    expect(res.ok).toBe(false);
  });

  test('chybějící hlavičky → odmítnuto', () => {
    expect(verifySlackRequest(Buffer.from(body), {}).ok).toBe(false);
  });

  test('chybějící signing secret → odmítnuto', () => {
    delete process.env.SLACK_COMPLIANCE_SIGNING_SECRET;
    const ts = Math.floor(Date.now() / 1000).toString();
    const res = verifySlackRequest(Buffer.from(body), {
      'x-slack-request-timestamp': ts,
      'x-slack-signature': sign(body, ts),
    });
    expect(res.ok).toBe(false);
  });

  test('podpis sedící na uptime secret (druhá app) → ok', () => {
    delete process.env.SLACK_COMPLIANCE_SIGNING_SECRET;
    process.env.SLACK_UPTIME_SIGNING_SECRET = 'uptime-secret';
    const ts = Math.floor(Date.now() / 1000).toString();
    const res = verifySlackRequest(Buffer.from(body), {
      'x-slack-request-timestamp': ts,
      'x-slack-signature': sign(body, ts, 'uptime-secret'),
    });
    expect(res.ok).toBe(true);
  });
});

describe('slack-verify — parseSlackPayload', () => {
  test('form-urlencoded payload', () => {
    const obj = { type: 'block_actions', actions: [{ action_id: 'x' }] };
    const body = 'payload=' + encodeURIComponent(JSON.stringify(obj));
    expect(parseSlackPayload(Buffer.from(body)).type).toBe('block_actions');
  });

  test('čisté JSON tělo (fallback)', () => {
    expect(parseSlackPayload(Buffer.from('{"type":"event_callback"}')).type).toBe('event_callback');
  });

  test('prázdné tělo → null', () => {
    expect(parseSlackPayload(Buffer.from(''))).toBeNull();
  });
});
