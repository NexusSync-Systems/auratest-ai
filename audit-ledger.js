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
export function canonicalize(value, seen = new WeakSet()) {
  // Typy, které JSON neumí, se ODMÍTAJÍ — netiší se na null.
  //
  // Dřív tudy prošlo všechno: `Date`, `Map`, `Set` i instance třídy skončily
  // jako `{}`, `NaN` a `Infinity` jako `null`. `digestOf({t: new Date()})`
  // se tak rovnalo `digestOf({t: {}})`. U otisku, jehož jediný smysl je
  // zachytit změnu obsahu, je tohle ta nejhorší možná vlastnost: změna
  // proběhne a otisk se nehne.
  const t = typeof value;
  if (t === 'bigint' || t === 'function' || t === 'symbol') {
    throw new TypeError(`Kanonizace: nepodporovaný typ ${t}`);
  }
  if (t === 'number' && !Number.isFinite(value)) {
    throw new TypeError(`Kanonizace: číslo ${value} nelze zapsat do JSON`);
  }
  // -0 a 0 jsou různé hodnoty, ale JSON.stringify z obou udělá "0".
  if (t === 'number' && Object.is(value, -0)) return '"-0"';

  if (value === null || t !== 'object') return JSON.stringify(value) ?? 'null';

  if (seen.has(value)) {
    throw new TypeError('Kanonizace: cyklický odkaz v datech');
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((v) => canonicalize(v, seen)).join(',')}]`;
    }

    // Date má jednoznačný textový zápis — použijeme ho místo prázdného objektu.
    if (value instanceof Date) {
      if (Number.isNaN(value.getTime())) {
        throw new TypeError('Kanonizace: neplatné datum');
      }
      return JSON.stringify(value.toISOString());
    }

    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new TypeError(
        `Kanonizace: nepodporovaný objekt ${value.constructor?.name || '(bez prototypu)'}`
      );
    }

    const keys = Object.keys(value).sort();
    const parts = keys
      // `undefined` se do JSON nedostane; kdyby se zahrnul, lišil by se otisk
      // podle toho, jestli klíč existoval s hodnotou undefined, nebo vůbec.
      .filter((k) => value[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalize(value[k], seen)}`);
    return `{${parts.join(',')}}`;
  } finally {
    seen.delete(value);
  }
}

/**
 * Co z běhu vstupuje do otisku výsledku.
 *
 * Vyexportované schválně: spis tímtéž předpisem otisk PŘEPOČÍTÁ a porovná.
 * Dokud tahle funkce žila jako objektový literál uvnitř server.js, byl otisk
 * ve spisu číslo, které nikdo nedokázal zkontrolovat — přesná struktura
 * nebyla nikde zapsaná a mezi cestami se dokonce lišila (crawler větev
 * neposílala `warnings`).
 *
 * Artefakty (screenshoty, video) se vynechávají: jejich cesty se mění
 * a otisk by pak nesouhlasil u nezměněného výsledku.
 */
export function auditResultOf(session) {
  return {
    status: session.status ?? null,
    bugs: session.bugs ?? [],
    warnings: session.warnings ?? [],
    // Chyby měření jsou součást zjištění o běhu, takže do otisku patří —
    // jen se nikdy nevydávají za nálezy na auditovaném webu.
    runErrors: session.runErrors ?? [],
    summary: session.summary ?? null,
    steps: (session.steps ?? []).map((step) => {
      // Cesta ke screenshotu je artefakt, ne zjištění.
      const { screenshot, ...rest } = step || {};
      return rest;
    }),
  };
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
        // Příznak se drží MIMO rozparsovaný objekt: `__malformed` je běžný
        // JSON klíč a záznam, který ho obsahuje, by se vydával za nečitelný
        // řádek — a jedna kontrola návaznosti by se kvůli tomu přeskočila.
        return {
          __malformed: true,
          line: i + 1,
          raw: line.slice(0, 200),
          error: err.message,
        };
      }
    });
}

/**
 * Otisk posledního záznamu — to, co se ukotvuje ven.
 *
 * Nečitelná nebo neúplná hlava vyhodí chybu, NEvrátí genesis.
 *
 * Dřív tu stálo `|| GENESIS_HASH`: nedopsaný poslední řádek (plný disk, pád
 * procesu) tak vypadal jako prázdný soubor a další zápis začal nový řetěz
 * od začátku. Ztráta celé dosavadní historie bez jediné hlášky je u důkazního
 * materiálu nepřijatelná — lepší je odmítnout zapsat.
 */
export function headHash(file = LEDGER_FILE) {
  const records = readLedger(file);
  if (records.length === 0) return GENESIS_HASH;
  const last = records[records.length - 1];
  if (last.__malformed) {
    throw new Error(
      `Poslední řádek záznamu je nečitelný (řádek ${last.line}). ` +
        'Zápis se zastavuje, aby nezaložil nový řetěz — soubor je potřeba opravit ručně.'
    );
  }
  if (typeof last.hash !== 'string' || last.hash.length !== 64) {
    throw new Error(
      'Poslední záznam nemá platný otisk. Zápis se zastavuje, aby nezaložil nový řetěz.'
    );
  }
  return last.hash;
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

  if (!entry?.sessionId || !entry?.target) {
    // Záznam bez cíle auditu je konzistentní a bezcenný: `canonicalize`
    // klíč s `undefined` tiše vypustí, takže by vznikla položka, která
    // nedokládá nic.
    throw new Error('appendRecord: chybí sessionId nebo target');
  }

  // Zámek kolem čtení hlavy i zápisu.
  //
  // Bez něj dva procesy (server + plánovač monitorů, nebo dvě instance)
  // přečtou tutéž hlavu a zapíšou stejný `prevHash`. `verifyChain` to pak
  // ohlásí jako „před tímhle místem někdo záznam změnil nebo odstranil" —
  // nástroj obviní z manipulace tam, kde k žádné nedošlo. U mechanismu,
  // který má manipulaci dokazovat, je falešné obvinění to nejhorší.
  const release = acquireLock(file);
  try {
    return writeRecord(entry, file);
  } finally {
    release();
  }
}

/** Jednoduchý zámek přes výhradní vytvoření souboru. */
function acquireLock(file, timeoutMs = 5000) {
  const lockPath = `${file}.lock`;
  const start = Date.now();
  for (;;) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return () => {
        try {
          fs.unlinkSync(lockPath);
        } catch {
          /* zámek už zmizel — nic k úklidu */
        }
      };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      // Osiřelý zámek po pádu procesu nesmí zablokovat zápis navždy.
      try {
        const age = Date.now() - fs.statSync(lockPath).mtimeMs;
        if (age > timeoutMs) {
          fs.unlinkSync(lockPath);
          continue;
        }
      } catch {
        continue; // zámek mezitím zmizel
      }
      if (Date.now() - start > timeoutMs) {
        throw new Error('Zápis do záznamu auditů: nepodařilo se získat zámek.');
      }
      // Krátké aktivní čekání. Zápis trvá jednotky milisekund, takže se sem
      // v praxi skoro nedostaneme; async varianta by si vyžádala async API
      // v celém volajícím řetězci.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
}

function writeRecord(entry, file) {
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

  // Nedopsaný předchozí řádek by se s tímhle zápisem slil do jednoho.
  // Pojistka: chybí-li koncový nový řádek, doplní se.
  let prefix = '';
  try {
    const { size } = fs.statSync(file);
    if (size > 0) {
      const fd = fs.openSync(file, 'r');
      const tail = Buffer.alloc(1);
      fs.readSync(fd, tail, 0, 1, size - 1);
      fs.closeSync(fd);
      if (tail[0] !== 0x0a) prefix = '\n';
    }
  } catch {
    /* soubor zatím neexistuje */
  }

  // fsync: `appendFileSync` vrátí řízení, jakmile data převezme systém.
  // Po pádu stroje může záznam zmizet, přestože jsme volajícímu potvrdili
  // uložení. U důkazního materiálu se to potvrzení musí opírat o disk.
  const fd = fs.openSync(file, 'a');
  try {
    fs.writeSync(fd, `${prefix}${JSON.stringify(record)}\n`, null, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return record;
}

/**
 * Projde řetěz a ověří jeho neporušenost.
 *
 * @returns {{ok: boolean, count: number, problems: Array<{index: number, sessionId?: string, problem: string}>}}
 */
export function verifyChain(file = LEDGER_FILE, records = null) {
  // Volitelná podmnožina: spis ověřuje jen záznamy svého vlastníka.
  // Ověřovat celý soubor znamenalo prozradit počet záznamů všech nájemců
  // a v `problems` i jejich sessionId.
  //
  // Pozn.: nad podmnožinou nelze ověřit NAVAZOVÁNÍ — mezi dvěma záznamy
  // téhož vlastníka leží cizí. Kontroluje se proto jen otisk obsahu a to,
  // že podmnožina je souvislá v původním pořadí.
  if (records) return verifySubset(records);
  return verifyFull(readLedger(file));
}

function verifySubset(records) {
  const problems = [];
  records.forEach((record, index) => {
    if (record.__malformed) {
      problems.push({ index, problem: `Nečitelný řádek ${record.line}: ${record.error}` });
      return;
    }
    const { hash, ...body } = record;
    let recomputed;
    try {
      recomputed = digestOf(body);
    } catch (err) {
      problems.push({ index, sessionId: record.sessionId, problem: `Záznam nelze zpracovat: ${err.message}` });
      return;
    }
    if (hash !== recomputed) {
      problems.push({
        index,
        sessionId: record.sessionId,
        problem: 'Otisk nesedí s obsahem — záznam byl po zapsání změněn.',
      });
    }
  });
  return { ok: problems.length === 0, count: records.length, problems, scope: 'subset' };
}

function verifyFull(records) {
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
    let recomputed;
    try {
      recomputed = digestOf(body);
    } catch (err) {
      problems.push({
        index,
        sessionId: record.sessionId,
        problem: `Záznam nelze zpracovat: ${err.message}`,
      });
      expectedPrev = hash;
      return;
    }
    if (hash !== recomputed) {
      problems.push({
        index,
        sessionId: record.sessionId,
        problem: 'Otisk nesedí s obsahem — záznam byl po zapsání změněn.',
      });
    }

    expectedPrev = hash;
  });

  return { ok: problems.length === 0, count: records.length, problems, scope: 'full' };
}

/** Záznamy k jedné session — typicky pro doložení jednoho auditu. */
export function recordsForSession(sessionId, file = LEDGER_FILE) {
  return readLedger(file).filter((r) => !r.__malformed && r.sessionId === sessionId);
}
