/**
 * Záznam auditů — přidávání, otisky, řetězení (D1 + D3).
 *
 * PROČ
 * Report bez záznamu je snímek obrazovky. Zákazník musí při kontrole
 * prokázat *co* bylo změřeno, *kdy*, *jakou verzí pravidel* a že s tím
 * nikdo později nehýbal.
 *
 * CO TO DOKAZUJE
 * Každý záznam nese otisk toho předchozího. Změna jediného znaku
 * v kterémkoli starším záznamu rozbije všechny otisky za ním, takže
 * `verifyChain()` přesně ukáže, kde k zásahu došlo. Smazání záznamu
 * uprostřed se pozná stejně.
 *
 * CO TO NEDOKAZUJE — a je poctivé to říct nahlas
 *   • Kdo má právo zapisovat do souboru, může přepsat celý řetěz od začátku
 *     a přepočítat všechny otisky. Řetězení je důkaz o NEPORUŠENOSTI, ne
 *     o nemožnosti podvrhu.
 *   • Časové razítko je z hodin stroje, ne od důvěryhodné autority.
 *
 * Obojí se řeší ukotvením: pravidelně někam zveřejnit otisk poslední
 * položky (`headHash`) — do e-mailu, do jiného systému, k notáři. Od té
 * chvíle je přepis historie do toho okamžiku prokazatelný. Ukotvení tenhle
 * modul nedělá; poskytuje k němu `headHash()`.
 *
 * FORMÁT
 * JSONL — jedna položka na řádek, jen se přidává. Zvolený proto, že
 * poškození jednoho řádku neznehodnotí soubor a přidání nevyžaduje
 * přepsání celku (na rozdíl od jednoho velkého JSON pole).
 */

import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { PROJECT_ROOT, ensureDir } from './paths.js';
import { rulesetInfo } from './rule-registry.js';

/**
 * Vlastní adresář, ne kořen projektu.
 *
 * Dva důvody, oba provozní:
 *
 *   1. `docker-compose.yml` ho montuje jako svazek. Bez toho by záznam
 *      zmizel s každým `up --build` — u důkazního materiálu ta nejhorší
 *      možná vlastnost.
 *   2. `deploy/cleanup-artifacts.sh` maže screenshoty a videa podle stáří.
 *      Záznam do úklidu spadnout NESMÍ, takže nesdílí adresář s artefakty.
 */
export const LEDGER_DIR = path.join(PROJECT_ROOT, 'ledger');
export const LEDGER_FILE = path.join(LEDGER_DIR, 'audit-ledger.jsonl');

/** Otisk, kterým začíná řetěz. */
export const GENESIS_HASH = '0'.repeat(64);

/**
 * Kanonická podoba hodnoty pro hashování.
 *
 * `JSON.stringify` zachovává pořadí vložení klíčů, takže dva shodné
 * výsledky lišící se jen pořadím polí by daly různý otisk — a záznam by
 * vypadal jako změněný, přestože se nic nezměnilo. Klíče se proto třídí
 * rekurzivně.
 *
 * Pole se NEtřídí: jejich pořadí je součást informace (kroky testu,
 * seznam nálezů).
 */
export function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;

  const keys = Object.keys(value).sort();
  const parts = keys
    // `undefined` se do JSON nedostane; kdyby se zahrnul, lišil by se otisk
    // podle toho, jestli klíč existoval s hodnotou undefined, nebo vůbec.
    .filter((k) => value[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`);
  return `{${parts.join(',')}}`;
}

/** SHA-256 kanonické podoby. */
export function digestOf(value) {
  return createHash('sha256').update(canonicalize(value), 'utf8').digest('hex');
}

/**
 * Verze nástroje pro záznam.
 *
 * Bere se z package.json a z proměnné prostředí `AURAGUARD_BUILD`
 * (typicky git sha nastavená při buildu). Bez ní je verze jen `1.0.0`,
 * což u nástroje s denními změnami nestačí — proto se to v záznamu
 * poznamená jako `build: 'neznámý'` místo aby chyběl klíč.
 */
let cachedVersion = null;
export function toolVersion() {
  if (cachedVersion) return cachedVersion;
  let version = 'neznámá';
  try {
    // Přes PROJECT_ROOT, ne `import.meta.url`: testy běží přes babel-jest,
    // který ESM převádí na CommonJS a `import.meta` v něm neexistuje.
    const pkg = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8'));
    version = pkg.version || version;
  } catch {
    // Bez package.json se běží dál — chybějící verze je poznámka v záznamu,
    // ne důvod neuložit audit.
  }
  cachedVersion = { version, build: process.env.AURAGUARD_BUILD || 'neznámý' };
  return cachedVersion;
}

/** Načte všechny záznamy. Poškozené řádky se vrátí jako chyba, ne se přeskočí. */
export function readLedger(file = LEDGER_FILE) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line, i) => {
      try {
        return JSON.parse(line);
      } catch (err) {
        return { __malformed: true, line: i + 1, raw: line.slice(0, 200), error: err.message };
      }
    });
}

/** Otisk posledního záznamu — to, co se ukotvuje ven. */
export function headHash(file = LEDGER_FILE) {
  const records = readLedger(file);
  if (records.length === 0) return GENESIS_HASH;
  return records[records.length - 1].hash || GENESIS_HASH;
}

/**
 * Zapíše záznam o dokončeném auditu.
 *
 * Do otisku vstupuje VŠE kromě samotného pole `hash` — včetně `prevHash`,
 * čímž vzniká řetěz.
 *
 * @param {object} entry
 * @param {string} entry.sessionId
 * @param {string} entry.target      auditovaná adresa
 * @param {string} [entry.userId]
 * @param {object} entry.result      výsledek skenerů (vstupuje do otisku)
 * @param {string[]} [entry.rules]   plné identifikátory pravidel (`id.vN`)
 * @param {string} [file]
 */
export function appendRecord(entry, file = LEDGER_FILE) {
  ensureDir(path.dirname(file));

  const body = {
    // Verze schématu záznamu. Až se formát změní, staré záznamy musí zůstat
    // ověřitelné — bez tohohle pole by se nedalo poznat, podle jakých
    // pravidel se otisk počítal.
    schema: 1,
    recordedAt: new Date().toISOString(),
    tool: toolVersion(),
    ruleset: rulesetInfo(),
    sessionId: entry.sessionId,
    target: entry.target,
    userId: entry.userId ?? null,
    rules: entry.rules ?? [],
    // Otisk výsledku, ne výsledek sám: záznam má být malý a dlouhověký,
    // kdežto struktura výsledku se bude měnit. Samotný výsledek zůstává
    // v databázi u session.
    resultDigest: digestOf(entry.result),
    prevHash: headHash(file),
  };

  const record = { ...body, hash: digestOf(body) };
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');
  return record;
}

/**
 * Projde řetěz a ověří jeho neporušenost.
 *
 * @returns {{ok: boolean, count: number, problems: Array<{index: number, sessionId?: string, problem: string}>}}
 */
export function verifyChain(file = LEDGER_FILE) {
  const records = readLedger(file);
  const problems = [];
  let expectedPrev = GENESIS_HASH;

  records.forEach((record, index) => {
    if (record.__malformed) {
      problems.push({ index, problem: `Nečitelný řádek ${record.line}: ${record.error}` });
      // Dál se pokračovat nedá — neznáme otisk, na který má navazovat další.
      expectedPrev = null;
      return;
    }

    if (expectedPrev !== null && record.prevHash !== expectedPrev) {
      problems.push({
        index,
        sessionId: record.sessionId,
        problem:
          'Nenavazuje na předchozí záznam — před tímhle místem někdo záznam ' +
          'změnil nebo odstranil.',
      });
    }

    const { hash, ...body } = record;
    const recomputed = digestOf(body);
    if (hash !== recomputed) {
      problems.push({
        index,
        sessionId: record.sessionId,
        problem: 'Otisk nesedí s obsahem — záznam byl po zapsání změněn.',
      });
    }

    expectedPrev = hash;
  });

  return { ok: problems.length === 0, count: records.length, problems };
}

/** Záznamy k jedné session — typicky pro doložení jednoho auditu. */
export function recordsForSession(sessionId, file = LEDGER_FILE) {
  return readLedger(file).filter((r) => !r.__malformed && r.sessionId === sessionId);
}
