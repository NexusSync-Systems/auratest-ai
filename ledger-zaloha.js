/**
 * Záloha neměnného řetězu důkazů.
 *
 * PROČ TO VŮBEC EXISTUJE
 * `ledger/audit-ledger.jsonl` je jediná kopie doložitelnosti celého
 * nástroje. Je v `.gitignore` a montuje se bind mountem z disku jedné VM.
 * Ztráta toho disku = ztráta všeho, čím se dokládá, že audity proběhly.
 * Ukotvení otisku to nezachrání: kotva dokazuje, že se řetěz nezměnil,
 * ale sama ho neobnoví.
 *
 * CO TENHLE SKRIPT NENÍ
 * Není to ochrana proti smazání souboru omylem — na to by stačila kopie
 * vedle. Je to ochrana proti ztrátě disku, a ta má smysl jedině tehdy,
 * když kopie leží JINDE. Proto skript cíl na stejném svazku odmítne;
 * přebít to jde `POVOL_STEJNY_DISK=1`, ale pak to není záloha, jen
 * snímek, a manifest to tak i označí.
 *
 * OVĚŘENÍ PŘED ZÁLOHOU, NE MÍSTO NÍ
 * Řetěz se před kopírováním ověří. Porušený řetěz se ale zazálohuje
 * TAKY — zahodit ho by znamenalo přijít o důkaz, že k porušení došlo.
 * Výsledek ověření jde do manifestu a skript skončí jiným návratovým
 * kódem, takže se to nedá přehlédnout.
 *
 * Spouštěč je `scripts/zaloha-ledgeru.mjs`; tady je jen rozhodování,
 * aby šlo testovat bez `import.meta`, které babel v testech nepřeloží.
 *
 * Použití:
 *   node scripts/zaloha-ledgeru.mjs --cil /mnt/zalohy
 *   node scripts/zaloha-ledgeru.mjs --cil /mnt/zalohy --drzet 60
 *   node scripts/zaloha-ledgeru.mjs --overit /mnt/zalohy/auraguard-ledger-...
 *
 * Návratové kódy:
 *   0  záloha hotová, řetěz neporušený
 *   1  chyba skriptu (nedostupný cíl, chybějící řetěz, stejný disk)
 *   2  záloha hotová, ale ŘETĚZ JE PORUŠENÝ — vyžaduje pozornost
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { LEDGER_FILE, readLedger, verifyChain, headHash } from './audit-ledger.js';
import { ANCHOR_FILE } from './ledger-anchor.js';

const PREDPONA = 'auraguard-ledger-';

/** Rozbor argumentů. Bez knihovny — jsou tři. */
export function rozborArgumentu(argv) {
  const out = { cil: null, drzet: 30, overit: null, suchy: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--cil') out.cil = argv[++i] ?? null;
    else if (argv[i] === '--drzet') out.drzet = parseInt(argv[++i], 10);
    else if (argv[i] === '--overit') out.overit = argv[++i] ?? null;
    else if (argv[i] === '--suchy') out.suchy = true;
  }
  // Nesmyslná hodnota NESMÍ tiše propadnout na 0 — to by smazalo všechno.
  if (!Number.isInteger(out.drzet) || out.drzet < 1) out.drzet = 30;
  return out;
}

function sha256(soubor) {
  return crypto.createHash('sha256').update(fs.readFileSync(soubor)).digest('hex');
}

/**
 * Leží dva adresáře na stejném svazku?
 *
 * `st_dev` je jediné, co o tom jde zjistit přenositelně. U bind mountu
 * z hostitele se liší, u podadresáře téhož disku ne.
 */
export function stejnySvazek(a, b) {
  try {
    return fs.statSync(a).dev === fs.statSync(b).dev;
  } catch {
    // Nezjistitelné se NEVYDÁVÁ za „jiný disk". Radši ať se uživatel
    // rozhodne vědomě, než aby si myslel, že má zálohu jinde.
    return true;
  }
}

/** Snímky, které vyrobil tenhle skript — cizí adresáře se nemažou. */
export function najdiSnimky(cil) {
  if (!fs.existsSync(cil)) return [];
  return fs.readdirSync(cil)
    .filter((n) => n.startsWith(PREDPONA))
    // Rozepsaná záloha NENÍ snímek. Bez tohohle vylučování měl dočasný
    // adresář taky předponu, takže ho `najdiSnimky` vracela jako hotovou
    // zálohu — a celý smysl zápisu do `.rozepsany` (aby po přerušení
    // nezůstal adresář, který vypadá platně) tím padal. Odhalil to až
    // test, který zápis schválně shodil; do té doby test kontroloval jen
    // úspěšný průběh, kde žádný zbytek nevzniká tak jako tak.
    .filter((n) => !n.endsWith('.rozepsany'))
    .sort();
}

/**
 * Které snímky smazat, aby jich zůstalo `drzet`.
 *
 * Oddělené od mazání, aby šlo otestovat rozhodnutí bez souborů na disku.
 */
export function keSmazani(snimky, drzet) {
  if (!Number.isInteger(drzet) || drzet < 1) return [];
  return snimky.length <= drzet ? [] : snimky.slice(0, snimky.length - drzet);
}

export function zalohuj({ cil, drzet, suchy }, io = fs) {
  if (!cil) throw new Error('Chybí --cil. Kam se má zálohovat?');
  if (!io.existsSync(LEDGER_FILE)) {
    throw new Error(`Řetěz ${LEDGER_FILE} neexistuje — není co zálohovat.`);
  }

  const zdrojovyAdresar = path.dirname(LEDGER_FILE);
  io.mkdirSync(cil, { recursive: true });

  const stejny = stejnySvazek(zdrojovyAdresar, cil);
  if (stejny && process.env.POVOL_STEJNY_DISK !== '1') {
    throw new Error(
      `Cíl ${cil} leží na stejném svazku jako řetěz. Kopie vedle originálu `
      + 'není ochrana proti ztrátě disku. Zvol jiný svazek, nebo spusť '
      + 's POVOL_STEJNY_DISK=1 (pak to ale není záloha, jen snímek).'
    );
  }

  // Ověření PŘED kopií. Porušený řetěz se zálohuje taky — viz hlavička.
  const kontrola = verifyChain();
  const zaznamy = readLedger();

  const razitko = new Date().toISOString().replace(/[:.]/g, '-');
  const cilovy = path.join(cil, `${PREDPONA}${razitko}`);
  // Zápis do dočasného adresáře a až pak přejmenování: přerušená záloha
  // nesmí zůstat ležet jako platně vypadající snímek.
  const docasny = `${cilovy}.rozepsany`;

  if (suchy) {
    return { cilovy, chainOk: kontrola.ok, zaznamu: zaznamy.length, suchy: true, smazano: [] };
  }

  io.mkdirSync(docasny, { recursive: true });
  const soubory = {};
  for (const zdroj of [LEDGER_FILE, ANCHOR_FILE]) {
    if (!io.existsSync(zdroj)) continue; // kotvy nemusí existovat
    const jmeno = path.basename(zdroj);
    io.copyFileSync(zdroj, path.join(docasny, jmeno));
    soubory[jmeno] = sha256(path.join(docasny, jmeno));
  }

  const manifest = {
    porizeno: new Date().toISOString(),
    // Otisk hlavy: podle něj se pozná, KTERÝ stav řetězu snímek zachytil.
    // Bez něj je to jen soubor s neznámým obsahem.
    hlava: headHash(),
    zaznamu: zaznamy.length,
    // Tři stavy, ne „ok: true". Výsledek ověření patří do zálohy,
    // protože po obnově se nikdo nedozví, jaký byl stav při pořízení.
    retez: {
      ok: kontrola.ok,
      pocet: kontrola.count,
      problemy: (kontrola.problems || []).map(({ index, problem }) => ({ index, problem })),
    },
    soubory,
    // Poctivé přiznání, když si uživatel vynutil stejný disk.
    stejnySvazekSeZdrojem: stejny,
    nastroj: process.env.BUILD_SHA || 'neznámá verze',
  };
  io.writeFileSync(path.join(docasny, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  io.renameSync(docasny, cilovy);

  // Retence NIKDY nesmaže snímek, který právě vznikl.
  //
  // Řazení je abecední a u skutečných snímků to sedí s časem, protože
  // jméno je časové razítko v ISO. Jenže adresář, který se do cíle dostal
  // jinudy (ruční kopie, jiné pojmenování), pořadí rozhodí — a nejhorší
  // možný důsledek je smazat zrovna čerstvou zálohu. Vyloučení je levnější
  // než spoléhat na to, že všechna jména budou vždycky razítka.
  const cerstvy = path.basename(cilovy);
  const snimky = najdiSnimky(cil);
  const smazat = keSmazani(snimky, drzet).filter((s) => s !== cerstvy);
  for (const s of smazat) io.rmSync(path.join(cil, s), { recursive: true, force: true });

  return { cilovy, chainOk: kontrola.ok, zaznamu: zaznamy.length, smazano: smazat, suchy: false };
}

/**
 * Ověření hotového snímku.
 *
 * Záloha, kterou nikdo nikdy nezkusil obnovit, není záloha. Tohle je
 * minimum: souhlasí otisky souborů s manifestem a drží řetěz v kopii?
 */
export function overSnimek(adresar) {
  const manifestCesta = path.join(adresar, 'manifest.json');
  if (!fs.existsSync(manifestCesta)) {
    throw new Error(`V ${adresar} není manifest.json — tohle není snímek zálohy.`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestCesta, 'utf8'));

  const rozpory = [];
  for (const [jmeno, otisk] of Object.entries(manifest.soubory || {})) {
    const cesta = path.join(adresar, jmeno);
    if (!fs.existsSync(cesta)) { rozpory.push(`${jmeno}: soubor ve snímku chybí`); continue; }
    const skutecny = sha256(cesta);
    if (skutecny !== otisk) rozpory.push(`${jmeno}: otisk nesouhlasí s manifestem`);
  }

  // Řetěz se ověřuje v KOPII, ne v originálu.
  const kopie = path.join(adresar, path.basename(LEDGER_FILE));
  const kontrola = fs.existsSync(kopie) ? verifyChain(kopie) : { ok: false, problems: [] };
  if (!kontrola.ok) rozpory.push('řetěz v kopii neprošel kontrolou navazování');

  return { manifest, rozpory, ok: rozpory.length === 0 };
}

