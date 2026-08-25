import { buildCaseFile, renderCaseFileHtml, CASE_FILE_LIMITS } from '../case-file.js';

/**
 * Spis za období.
 *
 * Kontrolor se ptá: co jste měřili, kdy, jakým pravidlem, s jakým výsledkem
 * — a proč u některých položek nic netvrdíte. Na té poslední otázce běžné
 * skenery selhávají: buď neprůkazné výsledky zamlčí, nebo je vydají za
 * splněné. Většina testů níž hlídá právě tohle.
 */

const CHAIN_OK = { ok: true, count: 3, problems: [] };

const session = (over = {}) => ({
  id: 'sess-1',
  url: 'https://klient.cz',
  goal: 'Compliance sken',
  status: 'completed',
  bugs: [],
  warnings: [],
  summary: 'Bez nálezu.',
  timestamp: '2026-06-15T10:00:00.000Z',
  ...over,
});

const record = (over = {}) => ({
  sessionId: 'sess-1',
  hash: 'a'.repeat(64),
  resultDigest: 'b'.repeat(64),
  recordedAt: '2026-06-15T10:00:01.000Z',
  tool: { version: '1.0.0', build: 'abc123' },
  ruleset: { digest: 'c'.repeat(64), count: 18 },
  userId: 'u1',
  ...over,
});

const build = (over = {}) =>
  buildCaseFile({ sessions: [], records: [], chain: CHAIN_OK, head: 'h'.repeat(64), ...over });

describe('sestavení spisu', () => {
  test('běh bez nálezu není vydáván za doklad shody', () => {
    // „Bez nálezu" a „v souladu" nejsou totéž. Kdyby to spis stíral,
    // dodával by zákazníkovi falešnou jistotu právě tam, kde na ní záleží.
    const file = build({ sessions: [session()] });
    expect(file.runs[0].verdict.value).toBe('no-findings');
    expect(file.limits.join(' ')).toMatch(/[Nn]ení to ani splnění, ani porušení/);
  });

  test('neúspěšný běh je neprůkazný, ne nález na aplikaci', () => {
    // Splést tohle znamená připsat zákazníkovi vadu, kterou nikdo neprokázal.
    const file = build({
      sessions: [session({ status: 'failed', summary: 'Timeout sítě' })],
    });
    expect(file.runs[0].verdict.value).toBe('inconclusive');
    expect(file.runs[0].verdict.rationale).toMatch(/nedokončeného měření/);
    expect(file.summary.inconclusive).toBe(1);
  });

  test('každý verdikt nese odůvodnění', () => {
    const file = build({
      sessions: [
        session({ id: 'a' }),
        session({ id: 'b', bugs: ['chyba'], summary: 'Nález.' }),
        session({ id: 'c', status: 'failed' }),
      ],
    });
    for (const run of file.runs) {
      expect(run.verdict.rationale.length).toBeGreaterThan(10);
    }
  });

  test('varování se nepočítají mezi nálezy', () => {
    // Jsou to pozorování, ne porušení. Sloučit je by nafouklo počet vad.
    const file = build({
      sessions: [session({ warnings: ['Pomalá odezva'], bugs: [] })],
    });
    expect(file.runs[0].verdict.value).toBe('no-findings');
    expect(file.runs[0].observations).toEqual(['Pomalá odezva']);
    expect(file.summary.withFindings).toBe(0);
  });
});

describe('vazba na záznam auditů', () => {
  test('u zaznamenaného běhu je otisk výsledku i záznamu', () => {
    const file = build({ sessions: [session()], records: [record()] });
    expect(file.runs[0].evidence).toMatchObject({
      recorded: true,
      recordHash: 'a'.repeat(64),
      resultDigest: 'b'.repeat(64),
    });
  });

  test('běh bez záznamu se ze spisu nevypustí, jen se to přizná', () => {
    // Zamlčet ho by znamenalo upravovat historii.
    const file = build({ sessions: [session()], records: [] });
    expect(file.runs).toHaveLength(1);
    expect(file.runs[0].evidence.recorded).toBe(false);
    expect(file.runs[0].evidence.note).toMatch(/neporušenost.*doložit nelze/);
    expect(file.summary.unrecorded).toBe(1);
  });

  test('porušený řetěz se ve spisu objeví, ne skryje', () => {
    const chain = { ok: false, count: 3, problems: [{ index: 1, problem: 'Otisk nesedí' }] };
    const file = build({ sessions: [session()], chain });
    expect(file.ledger.chainOk).toBe(false);
    expect(file.ledger.problems).toHaveLength(1);
  });
});

describe('období', () => {
  const sessions = [
    session({ id: 'stary', timestamp: '2026-01-01T00:00:00.000Z' }),
    session({ id: 'uvnitr', timestamp: '2026-06-15T00:00:00.000Z' }),
    session({ id: 'novy', timestamp: '2026-12-31T00:00:00.000Z' }),
  ];

  test('filtruje podle from i to', () => {
    const file = build({
      sessions,
      from: '2026-06-01T00:00:00.000Z',
      to: '2026-06-30T00:00:00.000Z',
    });
    expect(file.runs.map((r) => r.sessionId)).toEqual(['uvnitr']);
  });

  test('bez období projdou všechny běhy', () => {
    expect(build({ sessions }).runs).toHaveLength(3);
  });

  test('běhy jsou seřazené chronologicky', () => {
    // Spis se čte odshora jako průběh v čase, ne jako seznam od nejnovějšího.
    expect(build({ sessions }).runs.map((r) => r.sessionId)).toEqual([
      'stary',
      'uvnitr',
      'novy',
    ]);
  });

  test('běh s nečitelným časem se do spisu nedostane', () => {
    // Radši chybějící položka než položka zařazená do špatného období.
    const file = build({ sessions: [session({ timestamp: 'nesmysl' })] });
    expect(file.runs).toHaveLength(0);
  });
});

describe('znění pravidel a meze', () => {
  test('spis nese plné znění pravidel, ne jen odkazy', () => {
    // Za rok už soubor s registrem nemusí být po ruce a „nis2.headers.csp.v1"
    // by nikomu nic neřeklo.
    const file = build();
    expect(file.ruleset.rules.length).toBeGreaterThan(0);
    for (const rule of file.ruleset.rules) {
      expect(rule.ref).toMatch(/\.v\d+$/);
      expect(rule.method.length).toBeGreaterThan(20);
      expect(rule.limits.length).toBeGreaterThan(20);
    }
  });

  test('meze spisu zmiňují, co řetězení nedokazuje', () => {
    expect(CASE_FILE_LIMITS.join(' ')).toMatch(/[Nn]edokazuje nemožnost podvrhu/);
  });

  test('meze zmiňují, že jde o externí sken bez pohledu do serveru', () => {
    expect(CASE_FILE_LIMITS.join(' ')).toMatch(/serverové části/);
  });
});

describe('HTML podoba', () => {
  test('obsahuje oddíl o tom, co doloženo není', () => {
    const html = renderCaseFileHtml(build({ sessions: [session()] }));
    expect(html).toContain('Co tímto spisem doloženo NENÍ');
  });

  test('neprůkazné běhy jsou vidět, ne schované', () => {
    const html = renderCaseFileHtml(
      build({ sessions: [session({ status: 'failed' })] })
    );
    expect(html).toContain('class="run inconclusive"');
    expect(html).toContain('Neprůkazné');
  });

  test('uživatelský text se escapuje', () => {
    // Cíl auditu i souhrn pocházejí zvenčí. Bez escapování by šlo do spisu
    // propašovat značky — u dokumentu, který se odevzdává úřadu, nepřijatelné.
    const html = renderCaseFileHtml(
      build({ sessions: [session({ url: '<script>alert(1)</script>' })] })
    );
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  test('nevisí na externích zdrojích', () => {
    // Spis se archivuje a musí jít otevřít i za pět let bez internetu.
    const html = renderCaseFileHtml(build({ sessions: [session()] }));
    expect(html).not.toMatch(/<(link|script)[^>]+(href|src)=["']https?:/);
  });

  test('prázdné období to řekne místo prázdné stránky', () => {
    const html = renderCaseFileHtml(build());
    expect(html).toContain('neproběhl žádný audit');
  });
});
