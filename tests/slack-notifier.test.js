import { sendSlackNotification } from '../slack-notifier.js';

/**
 * Odesílání do Slacku.
 *
 * Osmdesát dva řádků bez testu, které nese `server.js` i CLI. Tichý
 * výpadek hlášení o nálezu se nepozná — a u ukotvení otisku má dokonce
 * důkazní dopad: spis rozlišuje „kotva odešla" od „kotva zůstala
 * uvnitř" právě podle návratové hodnoty téhle funkce.
 *
 * Napodobenina `fetch` vrací PŘESNĚ to, co vrací Slack: HTTP 200
 * a v těle `{ok: false, error: '…'}`. Kdo se dívá jen na stavový kód,
 * vyhodnotí neúspěšné odeslání jako úspěch — a to je právě ta záměna,
 * kterou musí test hlídat.
 */
const puvodni = { ...process.env };
let volani;

beforeEach(() => {
  volani = [];
  process.env = { ...puvodni };
  delete process.env.SLACK_BOT_TOKEN;
  delete process.env.SLACK_UPTIME_BOT_TOKEN;
  delete process.env.SLACK_COMPLIANCE_BOT_TOKEN;
  delete process.env.SLACK_AI_BOT_TOKEN;
});

afterEach(() => {
  process.env = { ...puvodni };
  jest.restoreAllMocks();
});

/** @param {object} telo co Slack vrátí v těle odpovědi */
const odpoved = (telo, opts = {}) => {
  global.fetch = jest.fn(async (url, init) => {
    volani.push({ url, init });
    if (opts.vyhod) throw new Error(opts.vyhod);
    return { json: async () => telo };
  });
};

describe('bez tokenu se nic neodesílá', () => {
  test('vrací false, ne true — a nevolá síť', async () => {
    // Kdyby vracela true, spis by u ukotvení tvrdil „odesláno".
    odpoved({ ok: true });
    expect(await sendSlackNotification('#kanal', 'Nadpis', 'Text')).toBe(false);
    expect(volani).toHaveLength(0);
  });
});

describe('výběr tokenu podle typu bota', () => {
  test('compliance spadne zpět na obecný token', async () => {
    process.env.SLACK_BOT_TOKEN = 'xoxb-obecny';
    odpoved({ ok: true });
    await sendSlackNotification('#k', 'N', 'T', false, [], 'compliance');
    expect(volani[0].init.headers.Authorization).toBe('Bearer xoxb-obecny');
  });

  test('uptime na obecný token NESPADNE — a je to vidět', async () => {
    // Asymetrie oproti compliance a ai: `SLACK_UPTIME_BOT_TOKEN` se
    // nepřepisuje fallbackem, takže bez něj se hlášení o dostupnosti
    // neodešle, i když obecný token existuje. Test to nesoudí, jen to
    // drží na místě, aby se to nezměnilo nechtěně.
    process.env.SLACK_BOT_TOKEN = 'xoxb-obecny';
    odpoved({ ok: true });
    expect(await sendSlackNotification('#k', 'N', 'T', false, [], 'uptime')).toBe(false);
    expect(volani).toHaveLength(0);
  });

  test('ai má vlastní token a dva stupně fallbacku', async () => {
    process.env.SLACK_COMPLIANCE_BOT_TOKEN = 'xoxb-compliance';
    odpoved({ ok: true });
    await sendSlackNotification('#k', 'N', 'T', false, [], 'ai');
    expect(volani[0].init.headers.Authorization).toBe('Bearer xoxb-compliance');
  });
});

describe('neúspěch se nesmí tvářit jako úspěch', () => {
  beforeEach(() => { process.env.SLACK_BOT_TOKEN = 'xoxb-test'; });

  test('HTTP 200 s ok:false je NEÚSPĚCH', async () => {
    // Přesně to Slack dělá: chyba přijde se stavem 200 v těle.
    odpoved({ ok: false, error: 'channel_not_found' });
    expect(await sendSlackNotification('#neexistuje', 'N', 'T')).toBe(false);
  });

  test('výpadek sítě vrátí false, nevyhodí', async () => {
    // CLI v CI by na neodchycené výjimce spadlo místo toho, aby
    // dokončilo audit a jen nedoručilo zprávu.
    odpoved(null, { vyhod: 'ECONNREFUSED' });
    await expect(sendSlackNotification('#k', 'N', 'T')).resolves.toBe(false);
  });

  test('úspěch vrací true', async () => {
    odpoved({ ok: true });
    expect(await sendSlackNotification('#k', 'N', 'T')).toBe(true);
  });
});

describe('tvar požadavku', () => {
  beforeEach(() => { process.env.SLACK_BOT_TOKEN = 'xoxb-test'; });

  test('má timeout — bez něj CLI v CI viselo donekonečna', async () => {
    odpoved({ ok: true });
    await sendSlackNotification('#k', 'N', 'T');
    expect(volani[0].init.signal).toBeDefined();
  });

  test('kanál, nadpis i text dorazí do těla', async () => {
    odpoved({ ok: true });
    await sendSlackNotification('#compliance', 'Nalezeno porušení', 'Detail nálezu');
    const telo = JSON.parse(volani[0].init.body);
    expect(telo.channel).toBe('#compliance');
    expect(telo.text).toMatch(/Nalezeno porušení/);
    expect(JSON.stringify(telo.attachments)).toMatch(/Detail nálezu/);
  });

  test('extraBlocks se přidají, nezahodí', async () => {
    odpoved({ ok: true });
    await sendSlackNotification('#k', 'N', 'T', false, [{ type: 'divider' }]);
    const telo = JSON.parse(volani[0].init.body);
    expect(JSON.stringify(telo)).toMatch(/divider/);
  });

  test('chyba a informace se liší barvou', async () => {
    odpoved({ ok: true });
    await sendSlackNotification('#k', 'N', 'T', true);
    const chyba = JSON.parse(volani[0].init.body).attachments[0].color;
    volani = [];
    await sendSlackNotification('#k', 'N', 'T', false);
    const info = JSON.parse(volani[0].init.body).attachments[0].color;
    expect(chyba).not.toBe(info);
  });
});
