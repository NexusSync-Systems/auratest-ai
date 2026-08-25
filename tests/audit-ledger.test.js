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
