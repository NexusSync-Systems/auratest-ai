/**
 * @jest-environment node
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  rozborArgumentu, keSmazani, najdiSnimky, stejnySvazek, zalohuj, overSnimek,
} from '../ledger-zaloha.js';

/**
 * Záloha řetězu důkazů.
 *
 * `ledger/audit-ledger.jsonl` je jediná kopie doložitelnosti a leží na
 * disku jedné VM. Ukotvení otisku dokazuje, že se řetěz nezměnil, ale
 * neobnoví ho — ztráta disku znamená ztrátu všeho, čím se dokládá, že
 * audity proběhly.
 *
 * Testuje se hlavně to, co MŮŽE SELHAT TIŠE: retence (špatné číslo by
 * smazalo všechno), rozpoznání stejného svazku (kopie vedle originálu
 * vypadá jako záloha a není jí) a ověření snímku (záloha, kterou nikdo
 * nezkusil obnovit, není záloha).
 */

describe('rozborArgumentu', () => {
  it('přečte cíl, retenci i režim ověření', () => {
    const v = rozborArgumentu(['--cil', '/mnt/z', '--drzet', '7', '--suchy']);
    expect(v).toMatchObject({ cil: '/mnt/z', drzet: 7, suchy: true });
  });

  it.each([['0'], ['-5'], ['nesmysl'], [undefined]])(
    'nesmyslná retence (%p) propadne na výchozích 30, ne na nulu', (hodnota) => {
      // Nula by při mazání znamenala „nedrž nic" — tedy smazat i právě
      // pořízenou zálohu. Tichá ztráta všech snímků.
      const v = rozborArgumentu(['--cil', '/mnt/z', '--drzet', hodnota]);
      expect(v.drzet).toBe(30);
    });
});

describe('keSmazani', () => {
  const snimky = ['auraguard-ledger-a', 'auraguard-ledger-b', 'auraguard-ledger-c'];

  it('nemaže nic, dokud se nepřekročí limit', () => {
    expect(keSmazani(snimky, 3)).toEqual([]);
    expect(keSmazani(snimky, 5)).toEqual([]);
  });

  it('maže od nejstaršího', () => {
    expect(keSmazani(snimky, 1)).toEqual(['auraguard-ledger-a', 'auraguard-ledger-b']);
  });

  it.each([[0], [-1], [NaN], [null]])(
    'při nesmyslném limitu (%p) NEMAŽE nic', (limit) => {
      // Fail-closed. Chybný vstup nesmí vést ke smazání důkazů.
      expect(keSmazani(snimky, limit)).toEqual([]);
    });
});

describe('stejnySvazek', () => {
  it('adresář sám se sebou je týž svazek', () => {
    expect(stejnySvazek(os.tmpdir(), os.tmpdir())).toBe(true);
  });

  it('neexistující cesta se NEVYDÁVÁ za jiný disk', () => {
    // Kdyby nezjistitelné vracelo false, prošla by záloha na místo,
    // o kterém nic nevíme — a uživatel by si myslel, že má kopii jinde.
    expect(stejnySvazek('/takova/cesta/neexistuje', os.tmpdir())).toBe(true);
  });
});

describe('zalohuj a overSnimek', () => {
  let cil;

  beforeEach(() => {
    cil = fs.mkdtempSync(path.join(os.tmpdir(), 'zaloha-test-'));
  });
  afterEach(() => {
    fs.rmSync(cil, { recursive: true, force: true });
  });

  it('bez cíle odmítne pracovat', () => {
    expect(() => zalohuj({ cil: null, drzet: 30 })).toThrow(/--cil/);
  });

  it('suchý běh nic nezapíše', () => {
    const v = zalohuj({ cil, drzet: 30, suchy: true });
    expect(v.suchy).toBe(true);
    expect(najdiSnimky(cil)).toEqual([]);
  });

  it('snímek nese manifest s otiskem hlavy a počtem záznamů', () => {
    // Bez otisku hlavy je to soubor s neznámým obsahem — po obnově by se
    // nedalo říct, KTERÝ stav řetězu snímek zachytil.
    const v = zalohuj({ cil, drzet: 30 });
    const manifest = JSON.parse(fs.readFileSync(path.join(v.cilovy, 'manifest.json'), 'utf8'));
    expect(manifest.hlava).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.zaznamu).toBe(v.zaznamu);
    expect(manifest.retez).toHaveProperty('ok');
  });

  it('pořízený snímek projde vlastním ověřením', () => {
    const v = zalohuj({ cil, drzet: 30 });
    expect(overSnimek(v.cilovy).ok).toBe(true);
  });

  it('změna v kopii se při ověření pozná', () => {
    // Tohle je celý smysl otisků v manifestu.
    const v = zalohuj({ cil, drzet: 30 });
    const soubor = path.join(v.cilovy, 'audit-ledger.jsonl');
    fs.appendFileSync(soubor, '{"podvrzeno":true}\n');
    const o = overSnimek(v.cilovy);
    expect(o.ok).toBe(false);
    expect(o.rozpory.join(' ')).toMatch(/otisk nesouhlasí/);
  });

  it('adresář bez manifestu se nevydává za snímek', () => {
    const cizi = path.join(cil, 'auraguard-ledger-podvrh');
    fs.mkdirSync(cizi);
    expect(() => overSnimek(cizi)).toThrow(/není snímek zálohy/);
  });

  it('retence smaže jen vlastní snímky, cizí adresáře nechá', () => {
    // Cíl může být sdílený s jinými zálohami. Smazat cizí data by bylo
    // horší než nechat je ležet.
    //
    // Cizí adresář se jmenuje tak, aby byl v abecedě PRVNÍ. Původní verze
    // testu ho měla pojmenovaný `databaze-nekoho-jineho`, tedy poslední —
    // a mutace „retence si nevšímá předpony" jím prošla, protože smazání
    // jde od nejstaršího a na cizí adresář na konci nedošlo. Test tehdy
    // hlídal pořadí v abecedě, ne filtrování.
    fs.mkdirSync(path.join(cil, 'aaa-cizi-zaloha'));
    // Jména starých snímků jsou razítka, jako ve skutečnosti — jinak by
    // test měřil abecední řazení, ne retenci.
    fs.mkdirSync(path.join(cil, 'auraguard-ledger-2026-01-01T00-00-00-000Z'));
    fs.mkdirSync(path.join(cil, 'auraguard-ledger-2026-02-01T00-00-00-000Z'));

    const v = zalohuj({ cil, drzet: 1 });

    expect(fs.existsSync(path.join(cil, 'aaa-cizi-zaloha'))).toBe(true);
    // A právě pořízený snímek musí zůstat — retence nesmí smazat to,
    // co teď vzniklo.
    expect(fs.existsSync(v.cilovy)).toBe(true);
    expect(najdiSnimky(cil)).toEqual([path.basename(v.cilovy)]);
  });

  it('retence nesmaže čerstvý snímek ani při rozhozeném pořadí', () => {
    // Pojistka pro případ, že se do cíle dostane adresář s předponou,
    // ale bez razítka v názvu — pak abecední řazení neodpovídá času
    // a bez vyloučení čerstvého snímku by šel ke smazání jako první.
    fs.mkdirSync(path.join(cil, 'auraguard-ledger-zzz-rucni-kopie'));

    const v = zalohuj({ cil, drzet: 1 });

    expect(fs.existsSync(v.cilovy)).toBe(true);
  });

  it('přerušená záloha nezůstane ležet jako platně vypadající snímek', () => {
    // Původní verze tohohle testu jen kontrolovala, že po ÚSPĚŠNÉ záloze
    // nezbyl adresář `.rozepsany`. Jenže mutace „zapisuj rovnou do cíle,
    // bez přejmenování" jím prošla: po úspěchu totiž žádný zbytek nevzniká
    // ani tak. Nezbytnost dočasného adresáře se pozná JEDINĚ na selhání.
    //
    // Zápis manifestu proto schválně shodíme. S přejmenováním po sobě
    // zůstane leda `.rozepsany`, který `najdiSnimky` nevidí; bez něj by
    // v cíli ležel adresář s daty, bez manifestu, a tvářil by se jako
    // hotová záloha.
    const io = { ...fs, writeFileSync: () => { throw new Error('disk plný'); } };

    expect(() => zalohuj({ cil, drzet: 30 }, io)).toThrow('disk plný');
    expect(najdiSnimky(cil)).toEqual([]);
  });
});
