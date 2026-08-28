import {
  buildCaseFile,
  renderCaseFileHtml,
  verifyCaseFileDigest,
  CASE_FILE_LIMITS,
} from '../case-file.js';
import { RULES } from '../rule-registry.js';
import { auditResultOf, digestOf } from '../audit-ledger.js';

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
  test('spis nese plné znění pravidel, na která se běhy odvolávají', () => {
    // Za rok už soubor s registrem nemusí být po ruce a „nis2.headers.csp.v1"
    // by nikomu nic neřeklo.
    const file = build({
      sessions: [session()],
      records: [record({ rules: [`${RULES[0].id}.v${RULES[0].version}`] })],
    });
    expect(file.ruleset.rules.length).toBe(1);
    for (const rule of file.ruleset.rules) {
      expect(rule.ref).toMatch(/\.v\d+$/);
      expect(rule.method.length).toBeGreaterThan(20);
      expect(rule.limits.length).toBeGreaterThan(20);
    }
  });

  test('vypisují se JEN pravidla, která opravdu běžela', () => {
    // REGRESE: spis tiskl celý registr pod nadpisem „Znění použitých
    // pravidel" — včetně pravidla, jehož metoda zní „neexistuje automatická
    // kontrola". Kontrolor si z toho přečetl, že jsme kontrolovali věci,
    // které jsme nekontrolovali.
    const file = build({ sessions: [session()], records: [record({ rules: [] })] });
    expect(file.ruleset.rules).toHaveLength(0);
    expect(renderCaseFileHtml(file)).toMatch(/neodvolává na pravidlo/);
  });

  test('snapshot pravidel se označuje jako dnešní, ne jako tehdejší', () => {
    // Do záznamu jde jen otisk sady, ne její text. Tvrdit „znění platné
    // v době měření" je proto nad rámec doloženého.
    const file = build({ sessions: [session()], records: [record()] });
    expect(file.ruleset.snapshotOf).toBe('generated');
    expect(renderCaseFileHtml(file)).not.toMatch(/Verze platné v době měření/);
  });

  test('změna sady pravidel od měření se ve spisu ohlásí', () => {
    const file = build({
      sessions: [session()],
      records: [
        record({
          rules: [`${RULES[0].id}.v${RULES[0].version}`],
          ruleset: { digest: 'z'.repeat(64), count: 20 },
        }),
      ],
    });
    expect(file.ruleset.changedSinceMeasurement).toBe(true);
    expect(renderCaseFileHtml(file)).toMatch(/NEODPOVÍDÁ tomu, podle kterého se měřilo/);
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


describe('spis netvrdí víc, než co dokládá (regrese kontrolní vlny)', () => {
  test('chyba měření nedělá z běhu nález', () => {
    // Timeout sítě je selhání NAŠEHO měření. Dokud se zapisoval do `bugs`,
    // běh skončil jako „Nálezy: 1", uložil se do neměnného záznamu a ve spisu
    // se vytiskl jako doložená vada zákazníkova webu.
    const file = build({
      sessions: [
        session({
          bugs: ['Katastrofická chyba testu: timeout'],
          runErrors: ['Měření se nedokončilo: timeout'],
        }),
      ],
    });
    expect(file.runs[0].verdict.value).toBe('inconclusive');
    expect(file.runs[0].findings).toHaveLength(0);
    expect(file.runs[0].runErrors).toHaveLength(1);
  });

  test('u neprůkazného běhu bez záznamu se neříká „výsledek platí"', () => {
    const file = build({ sessions: [session({ status: 'failed' })] });
    expect(file.runs[0].evidence.note).not.toMatch(/Výsledek platí/);
    expect(file.runs[0].evidence.note).toMatch(/nedokončilo/);
  });

  test('konec období zahrnuje celý den', () => {
    // REGRESE: `to='2026-06-15'` se parsovalo jako půlnoc, takže běh
    // z 15. 6. v 10:00 z období vypadl. Frontend si to obcházel sám;
    // každý jiný konzument o den měření tiše přišel.
    const file = build({ sessions: [session()], from: '2026-06-01', to: '2026-06-15' });
    expect(file.summary.runs).toBe(1);
  });

  test('běh s nečitelným časem nezmizí beze stopy', () => {
    // Rozdíl mezi „nic neproběhlo" a „něco nám vypadlo" musí být vidět.
    const file = build({
      sessions: [session({ id: 'x', timestamp: 'nesmysl' })],
      from: '2026-06-01',
      to: '2026-06-30',
    });
    expect(file.summary.runs).toBe(0);
    expect(file.summary.undatable).toBe(1);
    expect(file.undatableRuns[0].sessionId).toBe('x');
  });

  test('duplicitní záznam k jedné session se ohlásí, ne zahodí', () => {
    // Kdo má právo zapisovat, mohl přidat druhý záznam téže session s jiným
    // otiskem. Ověření řetězu to odhalit nemůže — řetěz sám je v pořádku.
    const file = build({
      sessions: [session()],
      records: [record(), record({ hash: 'd'.repeat(64), resultDigest: 'e'.repeat(64) })],
    });
    expect(file.runs[0].evidence.duplicateRecords).toBe(true);
    expect(renderCaseFileHtml(file)).toMatch(/víc než jeden záznam/);
  });

  test('otisk výsledku se přepočítá a porovná', () => {
    // Bez toho je „Otisk výsledku" 64znakové číslo pod seznamem nálezů,
    // které nikdo nedokáže zkontrolovat — a čtenář si přitom vyvodí,
    // že ty nálezy kryje.
    const file = build({ sessions: [session()], records: [record()] });
    expect(file.runs[0].evidence.digestMatches).toBe(false);
    expect(renderCaseFileHtml(file)).toMatch(/liší/);
  });

  test('problémy řetězu neprozrazují cizí sessionId', () => {
    const file = build({
      sessions: [session()],
      chain: {
        ok: false,
        count: 9,
        problems: [{ index: 2, sessionId: 'cizi-session', problem: 'Otisk nesedí' }],
      },
    });
    expect(JSON.stringify(file.ledger)).not.toMatch(/cizi-session/);
  });

  test('spis odliší kontrolu vlastních záznamů od kontroly celého řetězu', () => {
    // REGRESE: spis tvrdil „řetěz je neporušený" na základě kontroly nad
    // podmnožinou vlastníka. Ta ale odstranění položky odhalit NEUMÍ —
    // mezi jeho záznamy leží cizí, takže navazování otisků ověřit nejde.
    const html = renderCaseFileHtml(build({ sessions: [session()], fullChainOk: true }));
    expect(html).toMatch(/Vaše záznamy/);
    expect(html).toMatch(/Celý řetěz/);
    expect(html).toMatch(/Prošel úplnou kontrolou/);
    // Bez kotvy musí spis říct, že vyloučit useknutí konce neumí.
    expect(html).toMatch(/vyloučit nelze/);
  });

  test('neprošlá úplná kontrola je ve spisu výstraha', () => {
    const html = renderCaseFileHtml(build({ sessions: [session()], fullChainOk: false }));
    expect(html).toMatch(/NEPROŠEL úplnou kontrolou/);
    expect(html).toMatch(/není dokladem o neporušenosti/);
  });

  test('u každého běhu je vidět, jestli ho kotva kryje', () => {
    // Souhrnné „kryje N záznamů" je údaj o celém řetězu včetně cizích
    // auditů — čtenář si ho přečte jako počet svých krytých běhů.
    const file = build({
      sessions: [session({ timestamp: '2026-06-01T10:00:00.000Z' }), session({ id: 'pozdejsi', timestamp: '2026-06-20T10:00:00.000Z' })],
      anchor: {
        state: 'anchored',
        anchoredAt: '2026-06-10T00:00:00.000Z',
        headHash: 'a'.repeat(64),
        rationale: 'Ukotveno.',
      },
    });
    const byId = Object.fromEntries(file.runs.map((r) => [r.sessionId, r.coveredByAnchor]));
    expect(byId['sess-1']).toBe(true);
    expect(byId['pozdejsi']).toBe(false);
    expect(renderCaseFileHtml(file)).toMatch(/vznikl až po posledním ukotvení/);
  });

  test('nález jako objekt se nevytiskne jako [object Object]', () => {
    const file = build({
      sessions: [session({ bugs: [{ severity: 'high', message: 'chybí CSP' }] })],
    });
    const html = renderCaseFileHtml(file);
    expect(html).not.toMatch(/\[object Object\]/);
    expect(html).toMatch(/chybí CSP/);
  });

  test('spis nese vlastní otisk a ten sedí', () => {
    const file = build({ sessions: [session()] });
    expect(file.selfDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyCaseFileDigest(file)).toBe(true);
    expect(renderCaseFileHtml(file)).toMatch(file.selfDigest);
  });

  test('časy ve spisu nesou zónu', () => {
    // Bez ní se čas tiskne v neurčené zóně serveru a na jiném stroji vyjde
    // jinak. U důkazu musí být čas jednoznačný.
    expect(renderCaseFileHtml(build({ sessions: [session()] }))).toMatch(/UTC/);
  });
});

describe('předpisová kontrola ve spisu (D5)', () => {
  const check = (ok, over = {}) => ({
    key: 'nis2.headers-tls',
    label: 'Bezpečnostní hlavičky a TLS',
    ok,
    rationale: 'Odůvodnění dostatečné délky pro kontrolu ve spisu.',
    ...over,
  });

  const scan = (checks, over = {}) =>
    session({
      kind: 'compliance-scan',
      auditSlug: 'analyze-nis2',
      goal: 'Bezpečnostní hlavičky a TLS (NIS2 § 14)',
      checks,
      ruleRefs: [`${RULES[0].id}.v${RULES[0].version}`],
      bugs: [],
      ...over,
    });

  test('neposouzená kontrola brání tvrdit „bez nálezu"', () => {
    // Jádro celého úkolu. Sken, u kterého část kontrol neproběhla, se nesmí
    // ve spisu tvářit jako v pořádku — kontrolor by z toho vyvodil doklad,
    // který neexistuje.
    const file = build({ sessions: [scan([check(true), check(null, { key: 'tls.pqc' })])] });
    expect(file.runs[0].verdict.value).toBe('inconclusive');
    expect(file.runs[0].verdict.rationale).toMatch(/nepodařilo posoudit/);
  });

  test('prokázané porušení dá nález s počtem', () => {
    const file = build({ sessions: [scan([check(false), check(true, { key: 'tls.pqc' })])] });
    expect(file.runs[0].verdict.value).toBe('findings');
    expect(file.runs[0].verdict.label).toBe('Nálezy: 1');
  });

  test('vše posouzeno a bez porušení → bez nálezu, ne „v souladu"', () => {
    const file = build({ sessions: [scan([check(true), check(true, { key: 'tls.pqc' })])] });
    expect(file.runs[0].verdict.value).toBe('no-findings');
    expect(file.runs[0].verdict.rationale).toMatch(/[Nn]ení důkazem shody/);
  });

  test('sken bez dílčích výsledků je neprůkazný', () => {
    const file = build({ sessions: [scan([])] });
    expect(file.runs[0].verdict.value).toBe('inconclusive');
  });

  test('spis rozliší předpisovou kontrolu od agentního běhu', () => {
    // Kontrolor musí poznat, co je měření podle pravidla a co posouzení
    // jazykovým modelem — váha těch dvou věcí není stejná.
    const file = build({ sessions: [scan([check(true)]), session({ id: 'agent-1' })] });
    const kinds = Object.fromEntries(file.runs.map((r) => [r.sessionId, r.kind]));
    expect(kinds['sess-1']).toBe('compliance-scan');
    expect(kinds['agent-1']).toBe('agent-run');
  });

  test('dílčí kontroly se vytisknou i s odůvodněním', () => {
    const html = renderCaseFileHtml(
      build({ sessions: [scan([check(true), check(null, { key: 'tls.pqc', label: 'PQC' })])] })
    );
    // „BEZ NÁLEZU", ne „SPLNĚNO" — absence nálezu není důkaz shody a
    // slovník kontrol se nesmí rozcházet s verdiktem o kapitolu níž.
    expect(html).toMatch(/BEZ NÁLEZU/);
    expect(html).not.toMatch(/SPLNĚNO/);
    expect(html).toMatch(/NEPRŮKAZNÉ/);
    expect(html).toMatch(/Předpisová kontrola/);
  });

  test('pravidla se vezmou i z běhu, když chybí záznam', () => {
    // Přednost má neměnný záznam; databáze slouží jen jako záloha pro běhy,
    // u kterých se zápis do řetězu nezdařil. Bez toho by spis u takového
    // běhu netiskl žádné znění pravidel.
    const file = build({ sessions: [scan([check(true)])], records: [] });
    expect(file.ruleset.rules.length).toBe(1);
  });
});

describe('ukotvení ve spisu (D6)', () => {
  test('bez kotvy spis netvrdí, že je konec řetězu neporušený', () => {
    const html = renderCaseFileHtml(build({ sessions: [session()] }));
    expect(html).toMatch(/Neukotveno/);
    expect(html).not.toMatch(/z prostřed řetězu[\s\S]{0,200}Useknutí konce/);
  });

  test('kotva nahradí výhradu tvrzením', () => {
    const file = build({
      sessions: [session()],
      anchor: {
        state: 'anchored',
        anchoredAt: '2026-08-20T06:00:00.000Z',
        headHash: 'a'.repeat(64),
        rationale: 'Otisk byl ukotven a v řetězu se stále nachází.',
      },
    });
    const html = renderCaseFileHtml(file);
    expect(html).toMatch(/Ukotveno/);
    expect(html).toMatch(/stále nachází/);
  });

  test('chybějící ukotvený otisk je ve spisu výstraha, ne poznámka', () => {
    // Řetěz sám může vypadat v pořádku — právě proto to musí být vidět.
    const file = build({
      sessions: [session()],
      anchor: {
        state: 'broken',
        anchoredAt: '2026-08-20T06:00:00.000Z',
        headHash: 'a'.repeat(64),
        rationale: 'Dříve ukotvený otisk se v řetězu nenachází.',
      },
    });
    const html = renderCaseFileHtml(file);
    expect(html).toMatch(/POZOR/);
    expect(html).toMatch(/class="warn"/);
  });

  test('meze spisu uvádějí, že přírůstky po ukotvení kryté nejsou', () => {
    expect(CASE_FILE_LIMITS.join(' ')).toMatch(/po posledním ukotvení kryté nejsou/);
  });
});

describe('ztráta důkazu (regrese druhé kontrolní vlny)', () => {
  test('chybějící znění pravidla se ve spisu přizná, nezmizí', () => {
    // Registr drží jen aktuální verzi. Záznam z doby, kdy platila starší,
    // se s dnešní neshoduje — a dokud se takové znění tiše vynechávalo,
    // viděl čtenář kontrolu s verdiktem a neměl podle čeho ho posoudit.
    const file = build({
      sessions: [session({ kind: 'compliance-scan', checks: [{ key: 'k', ok: true, rationale: 'r' }], ruleRefs: ['nis2.headers.csp.v1'] })],
    });
    expect(file.ruleset.rules).toHaveLength(1);
    expect(file.ruleset.rules[0].unavailable).toBe(true);
    expect(renderCaseFileHtml(file)).toMatch(/není k dispozici/);
  });

  test('otisk výsledku kryje verdikty předpisové kontroly', () => {
    // REGRESE P0: `auditResultOf` nezahrnovalo `checks`, takže KAŽDÝ
    // compliance sken měl týž otisk. Kdo uměl zapsat do databáze, přepsal
    // „NÁLEZ" na „BEZ NÁLEZU" a ověření otisku dál hlásilo shodu — a spis
    // to tiskl jako „Otisk souhlasí: Ano".
    const scan = (ok) => ({
      kind: 'compliance-scan',
      auditSlug: 'cookie-audit',
      status: 'completed',
      checks: [{ key: 'k', ok, rationale: 'r' }],
      verdict: ok,
      ruleRefs: [],
    });
    expect(digestOf(auditResultOf(scan(true)))).not.toBe(digestOf(auditResultOf(scan(false))));
  });
});
