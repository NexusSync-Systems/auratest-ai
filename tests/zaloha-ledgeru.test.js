/**
 * @jest-environment node
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { appendRecord } from '../audit-ledger.js';
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
  let zdroj;
  let ledgerFile;

  /**
   * Test si nosí VLASTNÍ řetěz.
   *
   * První verze četla `ledger/audit-ledger.jsonl` z repozitáře. Ten je
   * v `.gitignore`, takže v čistém checkoutu neexistuje — a testy padaly
   * v CI, zatímco lokálně procházely. Lokálně ho totiž stihl vyrobit jiný
   * testovací soubor jako vedlejší efekt, takže závislost byla neviditelná
   * a závisela na pořadí, ve kterém jest soubory pustí.
   */
  beforeEach(() => {
    cil = fs.mkdtempSync(path.join(os.tmpdir(), 'zaloha-test-'));
    zdroj = fs.mkdtempSync(path.join(os.tmpdir(), 'zaloha-zdroj-'));
    ledgerFile = path.join(zdroj, 'audit-ledger.jsonl');
    for (let i = 1; i <= 3; i++) {
      appendRecord(
        { sessionId: `s${i}`, target: `https://priklad${i}.cz`, result: { i } },
        ledgerFile,
      );
    }
  });
  afterEach(() => {
    fs.rmSync(cil, { recursive: true, force: true });
    fs.rmSync(zdroj, { recursive: true, force: true });
    delete process.env.POVOL_STEJNY_DISK;
  });

  /**
   * Zdroj i cíl jsou v `/tmp`, tedy na stejném svazku — a skript to
   * schválně odmítá. Ostatní testy si tedy musí povolení vyžádat, jinak
   * by testovaly jen tuhle jedinou zábranu.
   *
   * Aby se tím zábrana nezakryla, má vlastní test hned pod tímhle.
   */
  const povolStejnyDisk = () => { process.env.POVOL_STEJNY_DISK = '1'; };

  it('cíl na stejném svazku se BEZ povolení odmítne', () => {
    // Celý smysl zálohy: kopie vedle originálu není ochrana proti ztrátě
    // disku. Kdyby tahle zábrana zmizela, vypadalo by zálohování funkčně
    // a nechránilo by před tím, kvůli čemu vzniklo.
    expect(() => zalohuj({ cil, drzet: 30, ledgerFile })).toThrow(/stejném svazku/);
  });

  it('odmítnutá záloha po sobě nenechá prázdný cíl', () => {
    // Jinak v cíli zůstane adresář, který vypadá, že se tam zálohuje.
    const novy = path.join(cil, 'jeste-neexistuje');
    expect(() => zalohuj({ cil: novy, drzet: 30, ledgerFile })).toThrow(/stejném svazku/);
    expect(fs.existsSync(novy)).toBe(false);
  });

  it('bez cíle odmítne pracovat', () => {
    expect(() => zalohuj({ cil: null, drzet: 30, ledgerFile })).toThrow(/--cil/);
  });

  it('suchý běh nic nezapíše', () => {
    povolStejnyDisk();
    povolStejnyDisk();
    const v = zalohuj({ cil, drzet: 30, suchy: true, ledgerFile });
    expect(v.suchy).toBe(true);
    expect(najdiSnimky(cil)).toEqual([]);
  });

  it('snímek nese manifest s otiskem hlavy a počtem záznamů', () => {
    // Bez otisku hlavy je to soubor s neznámým obsahem — po obnově by se
    // nedalo říct, KTERÝ stav řetězu snímek zachytil.
    povolStejnyDisk();
    const v = zalohuj({ cil, drzet: 30, ledgerFile });
    const manifest = JSON.parse(fs.readFileSync(path.join(v.cilovy, 'manifest.json'), 'utf8'));
    expect(manifest.hlava).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.zaznamu).toBe(v.zaznamu);
    expect(manifest.retez).toHaveProperty('ok');
  });

  it('pořízený snímek projde vlastním ověřením', () => {
    povolStejnyDisk();
    const v = zalohuj({ cil, drzet: 30, ledgerFile });
    expect(overSnimek(v.cilovy).ok).toBe(true);
  });

  it('změna v kopii se při ověření pozná', () => {
    // Tohle je celý smysl otisků v manifestu.
    povolStejnyDisk();
    const v = zalohuj({ cil, drzet: 30, ledgerFile });
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

    povolStejnyDisk();
    const v = zalohuj({ cil, drzet: 1, ledgerFile });

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

    povolStejnyDisk();
    const v = zalohuj({ cil, drzet: 1, ledgerFile });

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

    povolStejnyDisk();
    expect(() => zalohuj({ cil, drzet: 30, ledgerFile }, io)).toThrow('disk plný');
    expect(najdiSnimky(cil)).toEqual([]);
  });
});
