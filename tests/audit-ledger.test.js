import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  canonicalize,
  digestOf,
  appendRecord,
  readLedger,
  verifyChain,
  recordsForSession,
  headHash,
  auditResultOf,
  GENESIS_HASH,
} from '../audit-ledger.js';

/**
 * Doložitelnost auditů.
 *
 * Report bez záznamu je snímek obrazovky. Zákazník musí při kontrole
 * prokázat, co bylo změřeno, kdy, jakou verzí pravidel — a že s tím nikdo
 * později nehýbal.
 *
 * Testy pracují s dočasným souborem, ne s produkčním záznamem: zápis do
 * něj by byl přesně ten druh znečištění důkazního materiálu, proti kterému
 * celý modul stojí.
 */

let ledger;

beforeEach(() => {
  ledger = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-')), 'audit.jsonl');
});

const run = (sessionId, result = { ok: true }) =>
  appendRecord({ sessionId, target: `https://${sessionId}.example.com`, result }, ledger);

describe('kanonizace', () => {
  test('pořadí klíčů neovlivní otisk', () => {
    // Bez tohohle by dva shodné výsledky lišící se jen pořadím polí daly
    // různý otisk a záznam by vypadal jako změněný.
    expect(digestOf({ a: 1, b: { c: 2, d: 3 } })).toBe(digestOf({ b: { d: 3, c: 2 }, a: 1 }));
  });

  test('pořadí v poli otisk ovlivní — je to informace, ne uspořádání', () => {
    expect(digestOf({ kroky: [1, 2] })).not.toBe(digestOf({ kroky: [2, 1] }));
  });

  test('chybějící klíč a klíč s undefined dávají tentýž otisk', () => {
    expect(digestOf({ a: 1, b: undefined })).toBe(digestOf({ a: 1 }));
  });

  test('rozlišuje null, false, 0 a prázdný řetězec', () => {
    const digests = [null, false, 0, ''].map((v) => digestOf({ x: v }));
    expect(new Set(digests).size).toBe(4);
  });

  test('zvládne hluboko vnořenou strukturu bez pádu', () => {
    let deep = { v: 1 };
    for (let i = 0; i < 200; i++) deep = { nested: deep };
    expect(canonicalize(deep)).toContain('"v":1');
  });
});

describe('zápis a řetězení', () => {
  test('prázdný záznam má hlavu na genesis otisku', () => {
    expect(headHash(ledger)).toBe(GENESIS_HASH);
  });

  test('první záznam navazuje na genesis', () => {
    const r = run('s1');
    expect(r.prevHash).toBe(GENESIS_HASH);
  });

  test('každý další záznam nese otisk předchozího', () => {
    const a = run('s1');
    const b = run('s2');
    const c = run('s3');
    expect(b.prevHash).toBe(a.hash);
    expect(c.prevHash).toBe(b.hash);
    expect(headHash(ledger)).toBe(c.hash);
  });

  test('záznam obsahuje verzi nástroje a otisk sady pravidel', () => {
    // Bez nich nejde po roce doložit, co se tehdy testovalo.
    const r = run('s1');
    expect(r.tool.version).toBeTruthy();
    expect(r.ruleset.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(r.ruleset.count).toBeGreaterThan(0);
  });

  test('ukládá se otisk výsledku, ne výsledek sám', () => {
    // Záznam má být malý a dlouhověký; struktura výsledku se bude měnit.
    const r = appendRecord(
      { sessionId: 's1', target: 'https://x.cz', result: { tajnost: 'nemá tu být' } },
      ledger
    );
    expect(JSON.stringify(r)).not.toContain('nemá tu být');
    expect(r.resultDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  test('nedotčený řetěz projde ověřením', () => {
    run('s1');
    run('s2');
    expect(verifyChain(ledger)).toMatchObject({ ok: true, count: 2, problems: [] });
  });
});

describe('odhalení zásahu', () => {
  test('změna obsahu záznamu se pozná', () => {
    run('s1');
    run('s2');

    const lines = fs.readFileSync(ledger, 'utf8').trim().split('\n');
    const tampered = JSON.parse(lines[0]);
    tampered.target = 'https://podvrzeno.cz';
    lines[0] = JSON.stringify(tampered);
    fs.writeFileSync(ledger, `${lines.join('\n')}\n`);

    const result = verifyChain(ledger);
    expect(result.ok).toBe(false);
    expect(result.problems[0].index).toBe(0);
    expect(result.problems[0].problem).toMatch(/změněn/);
  });

  test('přepočítaný otisk u změněného záznamu rozbije návaznost dalšího', () => {
    // Chytřejší útok: uprav obsah A DOPOČÍTEJ otisk. Řetěz to odhalí
    // o položku dál — proto řetězení, ne jen otisk jednotlivého záznamu.
    run('s1');
    run('s2');

    const lines = fs.readFileSync(ledger, 'utf8').trim().split('\n');
    const { hash, ...body } = JSON.parse(lines[0]);
    body.target = 'https://podvrzeno.cz';
    lines[0] = JSON.stringify({ ...body, hash: digestOf(body) });
    fs.writeFileSync(ledger, `${lines.join('\n')}\n`);

    const result = verifyChain(ledger);
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => /Nenavazuje/.test(p.problem))).toBe(true);
  });

  test('smazání záznamu uprostřed se pozná', () => {
    run('s1');
    run('s2');
    run('s3');

    const lines = fs.readFileSync(ledger, 'utf8').trim().split('\n');
    lines.splice(1, 1);
    fs.writeFileSync(ledger, `${lines.join('\n')}\n`);

    const result = verifyChain(ledger);
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => /Nenavazuje/.test(p.problem))).toBe(true);
  });

  test('nečitelný řádek se nepřeskočí, ale nahlásí', () => {
    // Tiché přeskočení poškozeného řádku by z chybějícího důkazu udělalo
    // „nic tu nebylo".
    run('s1');
    fs.appendFileSync(ledger, '{tohle není JSON\n');

    const result = verifyChain(ledger);
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => /Nečitelný/.test(p.problem))).toBe(true);
  });
});

describe('vyhledání', () => {
  test('záznamy k jedné session', () => {
    run('s1');
    run('s2');
    run('s1');
    expect(recordsForSession('s1', ledger)).toHaveLength(2);
    expect(recordsForSession('neexistuje', ledger)).toHaveLength(0);
  });

  test('čtení neexistujícího souboru vrátí prázdno, ne pád', () => {
    expect(readLedger(path.join(os.tmpdir(), 'nikdy-nevzniklo.jsonl'))).toEqual([]);
  });
});

describe('kanonizace odmítá, co neumí zapsat (regrese kontrolní vlny)', () => {
  test('Date se nekolabuje na prázdný objekt', () => {
    // REGRESE: digestOf({t: new Date()}) === digestOf({t: {}}). U otisku,
    // jehož jediný smysl je zachytit změnu obsahu, je to nejhorší možná
    // vlastnost — změna proběhne a otisk se nehne.
    expect(digestOf({ t: new Date(0) })).not.toBe(digestOf({ t: {} }));
    expect(canonicalize(new Date(0))).toBe('"1970-01-01T00:00:00.000Z"');
  });

  test('Map, Set a instance třídy se odmítnou', () => {
    for (const value of [new Map([['a', 1]]), new Set([1]), new (class X {})()]) {
      expect(() => canonicalize(value)).toThrow(/nepodporovaný objekt/);
    }
  });

  test('NaN a Infinity se odmítnou', () => {
    for (const value of [NaN, Infinity, -Infinity]) {
      expect(() => canonicalize({ x: value })).toThrow(/nelze zapsat do JSON/);
    }
  });

  test('BigInt, funkce a symbol se odmítnou', () => {
    expect(() => canonicalize({ x: 1n })).toThrow(/nepodporovaný typ/);
    expect(() => canonicalize({ x: () => {} })).toThrow(/nepodporovaný typ/);
    expect(() => canonicalize({ x: Symbol('s') })).toThrow(/nepodporovaný typ/);
  });

  test('cyklus nespadne na přetečení zásobníku', () => {
    const cyklus = {};
    cyklus.self = cyklus;
    expect(() => canonicalize(cyklus)).toThrow(/cyklický odkaz/);
  });

  test('-0 a 0 dávají různý otisk', () => {
    expect(digestOf({ x: -0 })).not.toBe(digestOf({ x: 0 }));
  });

  test('stejný objekt na dvou místech není cyklus', () => {
    const sdilene = { a: 1 };
    expect(() => canonicalize({ x: sdilene, y: sdilene })).not.toThrow();
  });
});

describe('zápis do řetězu (regrese kontrolní vlny)', () => {
  test('neúplný poslední řádek zastaví zápis místo nového řetězu', () => {
    // REGRESE: `headHash` vracela genesis, takže další zápis začal nový
    // řetěz a slil se s troskou předchozího. Ztráta celé historie bez hlášky.
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-')), 'audit.jsonl');
    appendRecord({ sessionId: 's1', target: 'https://a.cz', result: {} }, file);
    fs.appendFileSync(file, '{"schema":1,"nedopsan');
    expect(() =>
      appendRecord({ sessionId: 's2', target: 'https://b.cz', result: {} }, file)
    ).toThrow(/nečitelný/);
  });

  test('záznam bez cíle auditu se nezapíše', () => {
    // Konzistentní a bezcenný: canonicalize klíč s undefined tiše vypustí,
    // takže by vznikla položka, která nedokládá nic.
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-')), 'audit.jsonl');
    expect(() => appendRecord({ sessionId: 's1', result: {} }, file)).toThrow(/target/);
    expect(() => appendRecord({ target: 'https://a.cz', result: {} }, file)).toThrow(/sessionId/);
  });

  test('zámek se po zápisu uklidí', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-')), 'audit.jsonl');
    appendRecord({ sessionId: 's1', target: 'https://a.cz', result: {} }, file);
    expect(fs.existsSync(`${file}.lock`)).toBe(false);
  });

  test('ověření podmnožiny nehlásí manipulaci kvůli cizím záznamům mezi nimi', () => {
    // Spis ověřuje jen záznamy svého vlastníka. Mezi dvěma jeho záznamy leží
    // cizí, takže navazování ověřit nelze — hlásit kvůli tomu manipulaci by
    // bylo falešné obvinění.
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-')), 'audit.jsonl');
    appendRecord({ sessionId: 'a', target: 'https://a.cz', userId: 'u1', result: {} }, file);
    appendRecord({ sessionId: 'b', target: 'https://b.cz', userId: 'u2', result: {} }, file);
    appendRecord({ sessionId: 'c', target: 'https://c.cz', userId: 'u1', result: {} }, file);

    const mine = readLedger(file).filter((r) => r.userId === 'u1');
    const result = verifyChain(undefined, mine);
    expect(result.ok).toBe(true);
    expect(result.count).toBe(2);
    expect(result.scope).toBe('subset');
  });

  test('podmnožina odhalí změněný obsah', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-')), 'audit.jsonl');
    appendRecord({ sessionId: 'a', target: 'https://a.cz', userId: 'u1', result: {} }, file);
    const mine = readLedger(file).filter((r) => r.userId === 'u1');
    mine[0].target = 'https://podvrzeno.cz';
    expect(verifyChain(undefined, mine).ok).toBe(false);
  });
});

describe('auditResultOf — předpis otisku je zapsaný, ne odvozený', () => {
  test('cesty k artefaktům do otisku nevstupují', () => {
    // Cesty se mění a otisk by pak nesouhlasil u nezměněného výsledku.
    const a = auditResultOf({ status: 'completed', steps: [{ action: 'klik', screenshot: '/api/screenshots/x.png' }] });
    const b = auditResultOf({ status: 'completed', steps: [{ action: 'klik', screenshot: '/api/screenshots/y.png' }] });
    expect(digestOf(a)).toBe(digestOf(b));
  });

  test('sada klíčů je stejná bez ohledu na to, co běh vyplnil', () => {
    // Crawler větev dřív neposílala `warnings`, takže se struktura mezi
    // cestami lišila a otisk nešlo reprodukovat.
    expect(Object.keys(auditResultOf({})).sort()).toEqual(
      ['bugs', 'runErrors', 'status', 'steps', 'summary', 'warnings']
    );
  });

  test('chyby měření do otisku patří, ale odděleně od nálezů', () => {
    const r = auditResultOf({ status: 'failed', runErrors: ['timeout'], bugs: [] });
    expect(r.runErrors).toEqual(['timeout']);
    expect(r.bugs).toEqual([]);
  });
});
