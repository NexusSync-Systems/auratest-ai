import fs from 'fs';
import os from 'os';
import path from 'path';
import { appendRecord, readLedger, verifyChain, digestOf } from '../audit-ledger.js';
import {
  createAnchor,
  readAnchors,
  verifyAnchors,
  anchorSummary,
  anchorMessage,
  recordAnchorDelivery,
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

/**
 * Kotva s potvrzeným odesláním.
 *
 * Bez potvrzení má stav `internal-only`: kopie neopustila systém, takže ji
 * ovládá tentýž zapisovatel jako záznam sám. Většina testů zkoumá ověření
 * proti řetězu, ne doručení, proto ho tahle pomůcka rovnou vyplní.
 */
const kotva = (note) =>
  createAnchor({
    ledgerFile: ledger,
    anchorFile: anchors,
    note,
    delivered: { channel: 'test', ok: true, at: new Date().toISOString(), by: 'operator' },
  });

/** Kotva, která systém neopustila. */
const kotvaBezOdeslani = () => createAnchor({ ledgerFile: ledger, anchorFile: anchors });
// Plná kontrola řetězu je součástí posouzení: nad porušeným řetězem
// kotva nedokládá nic.
const stav = () =>
  anchorSummary(readLedger(ledger), readAnchors(anchors), verifyChain(ledger).ok);

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
    expect(stav().rationale).toMatch(/chybí nebo je na jiné pozici/);
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

  test('kotva nad prázdným řetězem se netváří jako doklad', () => {
    // Formálně je pravda, že „žádný dřívější záznam nebyl změněn" — žádný
    // totiž neexistuje. Jenže přesně tak vypadá tvrzení slibující víc, než
    // čím je podložené: příjemce si zprávu uschová v domnění, že něco
    // dokládá. Vlastní stav to říká rovnou.
    const { message } = kotva();
    expect(stav().state).toBe('empty');
    expect(stav().coversRecords).toBe(0);
    expect(message).toMatch(/nekryje/);

    // Ani po přibytí běhu se zpětně nestane krycí — kotva je starší.
    zapis(1);
    expect(stav().state).toBe('empty');
  });

  test('ukotvení po prvním běhu už kryje', () => {
    kotva();
    zapis(1);
    kotva();
    const s = stav();
    expect(s.state).toBe('anchored');
    expect(s.coversRecords).toBe(1);
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
  test('poškozený řádek v kotvách se hlásí, nezahazuje', () => {
    // REGRESE a obcházecí cesta: po useknutí řetězu stačilo poškodit jeden
    // znak v souboru kotev, kotva zmizela a nález „broken" se změnil na
    // „neukotveno". Chybějící důkaz se tak proměnil v „nic tu nebylo".
    zapis(1);
    kotva();
    fs.appendFileSync(anchors, 'tohle není JSON\n');
    expect(readAnchors(anchors)).toHaveLength(2);
    expect(readAnchors(anchors)[1].__malformed).toBe(true);
    expect(stav().state).toBe('broken');
    expect(stav().rationale).toMatch(/poškozený/);
  });

  test('kotva s nesmyslným otiskem neprojde jako platná', () => {
    zapis(1);
    fs.writeFileSync(
      anchors,
      `${JSON.stringify({ anchoredAt: '2026-01-01T00:00:00Z', headHash: 'deadbeef', recordCount: 1 })}\n`
    );
    expect(readAnchors(anchors)[0].__malformed).toBe(true);
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

describe('obejití kotvy (regrese kontrolní vlny)', () => {
  test('duplikát hlavy na konci kotvu neudrží', () => {
    // ÚTOK: smazat záznam, přepočítat otisky za ním a na konec připojit
    // kopii původní hlavy, aby ukotvený otisk „zůstal v řetězu". Dokud se
    // otisk hledal kdekoli, prošlo to jako „anchored".
    zapis(1);
    zapis(2);
    zapis(3);
    kotva();

    const radky = fs.readFileSync(ledger, 'utf8').trim().split('\n');
    fs.writeFileSync(ledger, `${[...radky, radky[2]].join('\n')}\n`);

    // Zachytí to už úplná kontrola řetězu (duplikát rozbije navazování),
    // takže do posouzení kotvy se to ani nedostane. Podstatné je, že
    // výsledek NENÍ „anchored".
    expect(stav().state).toBe('broken');

    // Samotné ověření kotev duplikát pozná i bez plné kontroly.
    const bezPlne = anchorSummary(readLedger(ledger), readAnchors(anchors), true);
    expect(bezPlne.state).toBe('broken');
    expect(bezPlne.rationale).toMatch(/opakuje týž otisk/);
  });

  test('vložený záznam před ukotvené místo se pozná', () => {
    // ÚTOK: dopočítat self-konzistentní řádek a vložit ho. Navazování
    // `prevHash` se v uživatelské cestě nekontroluje, takže dokud se kotva
    // hledala kdekoli, krytí dokonce vzrostlo nad počet záznamů v okamžiku
    // ukotvení.
    zapis(1);
    zapis(2);
    kotva();

    const radky = fs.readFileSync(ledger, 'utf8').trim().split('\n');
    const podvrh = JSON.parse(radky[0]);
    delete podvrh.hash;
    podvrh.sessionId = 'podvrh';
    podvrh.target = 'https://podvrh.cz';
    const hash = digestOf(podvrh);
    fs.writeFileSync(ledger, `${[...radky, JSON.stringify({ ...podvrh, hash })].join('\n')}\n`);

    expect(stav().state).toBe('broken');
  });

  test('přepsání recordCount na nulu kontrolu nevypne', () => {
    // ÚTOK: `recordCount: 0` dřív znamenal „prázdný řetěz, nekontroluj" —
    // stačilo tedy po useknutí přepsat jedno číslo a nález zmizel.
    zapis(1);
    zapis(2);
    zapis(3);
    kotva();

    const radky = fs.readFileSync(ledger, 'utf8').trim().split('\n');
    fs.writeFileSync(ledger, `${radky.slice(0, 1).join('\n')}\n`);
    expect(stav().state).toBe('broken');

    const k = JSON.parse(fs.readFileSync(anchors, 'utf8').trim());
    k.recordCount = 0;
    fs.writeFileSync(anchors, `${JSON.stringify(k)}\n`);
    expect(stav().state).toBe('broken');
  });

  test('kotva nad porušeným řetězem nedokládá nic', () => {
    // Ověření kotvy říká „otisk sedí na své pozici". Nad řetězem, kde
    // otisky nenavazují, může sedět cokoli.
    zapis(1);
    zapis(2);
    kotva();
    expect(anchorSummary(readLedger(ledger), readAnchors(anchors), false).state).toBe('broken');
    expect(anchorSummary(readLedger(ledger), readAnchors(anchors), false).rationale).toMatch(
      /neprošel úplnou kontrolou/
    );
  });

  test('shrnutí neprozradí počet záznamů všech nájemců', () => {
    // Řetěz je společný. „Kryje N záznamů" je údaj o cizích auditech a
    // čtenář spisu si ho navíc přečte jako počet SVÝCH krytých běhů.
    zapis(1);
    zapis(2);
    zapis(3);
    kotva();
    const s = stav();
    expect(s.state).toBe('anchored');
    expect(s.rationale).not.toMatch(/\d+ záznam/);
    expect(JSON.stringify(s)).not.toMatch(/"recordCount"/);
  });
});

describe('kotva, která systém neopustila (regrese)', () => {
  test('bez potvrzeného odeslání se nehlásí jako doklad', () => {
    // Celý mechanismus stojí na tom, že kopie otisku je MIMO dosah toho,
    // kdo smí zapisovat do řetězu. Dokud se výsledek odeslání
    // nezaznamenával, hlásil nástroj „ukotveno" i u kotvy ležící vedle
    // záznamu — tedy u dvou souborů pod jednou rukou.
    zapis(1);
    kotvaBezOdeslani();
    const s = stav();
    expect(s.state).toBe('internal-only');
    expect(s.rationale).toMatch(/neopustila tenhle systém/);
  });

  test('potvrzené odeslání kotvu povýší', () => {
    zapis(1);
    const { anchor } = kotvaBezOdeslani();
    expect(stav().state).toBe('internal-only');

    recordAnchorDelivery(
      anchor.anchoredAt,
      { channel: 'e-mail', ok: true, at: new Date().toISOString(), by: 'operator' },
      anchors
    );
    expect(stav().state).toBe('anchored');
  });

  test('neúspěšné odeslání se nepočítá za doručení', () => {
    zapis(1);
    const { anchor } = kotvaBezOdeslani();
    recordAnchorDelivery(
      anchor.anchoredAt,
      { channel: '#slack', ok: false, at: new Date().toISOString(), by: 'slack' },
      anchors
    );
    expect(stav().state).toBe('internal-only');
  });

  test('kotva se zapíše pod zámkem a v jednom průchodu', () => {
    // Dřív se soubor četl dvakrát — pro počet a pro otisk. Když mezi tím
    // doběhl zápis, vznikla kotva s počtem N a otiskem záznamu N+1;
    // po zpřísnění ověření by hlásila falešné porušení.
    zapis(1);
    zapis(2);
    const { anchor } = kotva();
    expect(anchor.recordCount).toBe(2);
    expect(anchor.headHash).toBe(readLedger(ledger)[1].hash);
    expect(fs.existsSync(`${ledger}.lock`)).toBe(false);
  });

  test('nedopsaný konec řetězu kotvu nezaloží', () => {
    zapis(1);
    fs.appendFileSync(ledger, '{"schema":1,"nedopsan');
    expect(() => kotva()).toThrow(/nečitelný/);
  });
});
