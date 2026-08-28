import fs from 'fs';
import os from 'os';
import path from 'path';
import { appendRecord, readLedger, verifyChain } from '../audit-ledger.js';
import {
  createAnchor,
  readAnchors,
  verifyAnchors,
  anchorSummary,
  anchorMessage,
} from '../ledger-anchor.js';

/**
 * Ukotvení otisku řetězu.
 *
 * Řetězení odhalí zásah doprostřed historie. Useknutí KONCE ale neodhalí —
 * zbylý řetěz je po odstranění posledních položek dokonale konzistentní.
 * A právě konec je to, co by někdo mazal, protože tam leží nejnovější
 * nepříjemný nález. Ukotvení je jediné, co tuhle mezeru zavírá.
 */

let dir;
let ledger;
let anchors;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anchor-'));
  ledger = path.join(dir, 'audit.jsonl');
  anchors = path.join(dir, 'anchors.jsonl');
});

const zapis = (n) =>
  appendRecord({ sessionId: `s${n}`, target: `https://x${n}.cz`, result: { n } }, ledger);

const kotva = (note) => createAnchor({ ledgerFile: ledger, anchorFile: anchors, note });
const stav = () => anchorSummary(readLedger(ledger), readAnchors(anchors));

/** Odstraní z konce souboru posledních `n` řádků. */
const useknoutKonec = (n) => {
  const radky = fs.readFileSync(ledger, 'utf8').trim().split('\n');
  fs.writeFileSync(ledger, `${radky.slice(0, radky.length - n).join('\n')}\n`);
};

describe('to, co řetězení samo neumí', () => {
  test('useknutí konce nechá řetěz konzistentní, ale kotva ho odhalí', () => {
    // Tohle je celý důvod existence modulu.
    zapis(1);
    zapis(2);
    zapis(3);
    kotva();

    useknoutKonec(1);

    expect(verifyChain(ledger).ok).toBe(true); // řetěz nic nepozná
    expect(stav().state).toBe('broken'); // kotva ano
    expect(stav().rationale).toMatch(/nenachází/);
  });

  test('přírůstky po ukotvení nejsou kryté a spis to říká', () => {
    zapis(1);
    kotva();
    zapis(2);
    zapis(3);

    // Odstranění toho, co vzniklo PO ukotvení, kotva odhalit nemůže.
    useknoutKonec(2);
    expect(stav().state).toBe('anchored');
    expect(stav().rationale).toMatch(/po tomto okamžiku kryté nejsou/);
  });

  test('změna uprostřed se pozná dál řetězením', () => {
    zapis(1);
    zapis(2);
    kotva();
    const radky = fs.readFileSync(ledger, 'utf8').trim().split('\n');
    const zmeneny = JSON.parse(radky[0]);
    zmeneny.target = 'https://podvrzeno.cz';
    fs.writeFileSync(ledger, `${[JSON.stringify(zmeneny), radky[1]].join('\n')}\n`);

    expect(verifyChain(ledger).ok).toBe(false);
  });
});

describe('stavy ukotvení', () => {
  test('bez kotvy se netvrdí ani porušení, ani neporušenost', () => {
    zapis(1);
    const s = stav();
    expect(s.state).toBe('none');
    expect(s.rationale).toMatch(/vyloučit nelze/);
  });

  test('nedotčený řetěz s kotvou je ukotvený', () => {
    zapis(1);
    zapis(2);
    kotva();
    zapis(3);
    expect(stav().state).toBe('anchored');
  });

  test('kotva nad prázdným řetězem je platná, jen nic nekryje', () => {
    // Zapsat kotvu dřív, než vznikne první audit, není chyba.
    kotva();
    expect(stav().state).toBe('anchored');
    zapis(1);
    expect(stav().state).toBe('anchored');
  });

  test('novější kotva rozšíří krytí', () => {
    zapis(1);
    kotva();
    zapis(2);
    zapis(3);
    kotva();
    const status = verifyAnchors(readLedger(ledger), readAnchors(anchors));
    expect(status.coveredUpToIndex).toBe(2);
    expect(status.anchors).toHaveLength(2);
  });

  test('cizí kotva z jiného řetězu se pozná', () => {
    zapis(1);
    fs.writeFileSync(
      anchors,
      `${JSON.stringify({ anchoredAt: '2026-01-01T00:00:00Z', headHash: 'f'.repeat(64), recordCount: 5 })}\n`
    );
    expect(stav().state).toBe('broken');
  });
});

describe('odolnost a poctivost', () => {
  test('poškozený řádek v kotvách nezneplatní ostatní', () => {
    zapis(1);
    kotva();
    fs.appendFileSync(anchors, 'tohle není JSON\n');
    expect(readAnchors(anchors)).toHaveLength(1);
    expect(stav().state).toBe('anchored');
  });

  test('chybějící soubor kotev není chyba', () => {
    expect(readAnchors(path.join(dir, 'neexistuje.jsonl'))).toEqual([]);
  });

  test('text kotvy říká příjemci, co s ním má dělat', () => {
    // Kotva, kterou příjemce zahodí jako nesrozumitelný šum, nic neukotví.
    zapis(1);
    const { message } = kotva();
    expect(message).toMatch(/uschovejte/i);
    expect(message).toMatch(/[0-9a-f]{64}/);
  });

  test('shrnutí neprozradí počet záznamů všech nájemců', () => {
    // Kotva se ověřuje nad celým řetězem, ale ven jde jen stav a čas.
    zapis(1);
    zapis(2);
    kotva();
    const s = stav();
    expect(Object.keys(s)).not.toContain('recordCount');
    expect(JSON.stringify(s)).not.toMatch(/"recordCount"/);
  });

  test('shrnutí přiznává, že kopie uvnitř systému nic nedokazuje', () => {
    // Kdo smí zapisovat do řetězu, smí zapisovat i do souboru kotev.
    zapis(1);
    kotva();
    expect(stav().rationale).toMatch(/MIMO tento systém/);
  });

  test('anchorMessage je jediné znění — server i CLI posílají totéž', () => {
    const a = { anchoredAt: '2026-08-27T06:00:00.000Z', headHash: 'a'.repeat(64), recordCount: 3 };
    expect(anchorMessage(a)).toContain('a'.repeat(64));
    expect(anchorMessage(a)).toContain('2026-08-27T06:00:00.000Z');
  });
});
