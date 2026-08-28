/**
 * Ukotvení otisku řetězu (D6).
 *
 * PROBLÉM, KTERÝ TO ŘEŠÍ
 * Řetězení otisků dokáže odhalit změnu nebo smazání záznamu UPROSTŘED —
 * všechny otisky za tím místem přestanou navazovat. Useknutí KONCE ale
 * odhalit neumí: zbylý řetěz je po odstranění posledních položek dokonale
 * konzistentní. A právě konec je to, co by někdo mazal, protože tam leží
 * nejnovější nepříjemný nález.
 *
 * Spis to dosud přiznával jako výhradu („průkaznost dodává až ukotvení
 * otisku mimo systém"), ale nic pro to nedělal. Výhrada, kterou nástroj sám
 * neumí odstranit, je slabší než mechanismus — tenhle modul ji odstraňuje.
 *
 * JAK TO FUNGUJE
 * V pravidelných intervalech se otisk poslední položky (`headHash`) vypíše
 * a odešle VEN ze systému — do Slacku, do logu, kamkoli, kde provozovatel
 * uchovává kopii. Od té chvíle platí:
 *
 *   Je-li ukotvený otisk v řetězu stále přítomen, pak žádný záznam
 *   pořízený PŘED ukotvením nebyl změněn ani odstraněn — ani z konce.
 *
 * Kdyby někdo řetěz usekl kdekoli před ukotveným místem, ukotvený otisk
 * by v souboru přestal existovat a porovnání by to ukázalo.
 *
 * CO TO POŘÁD NEDOKAZUJE — a je poctivé to říct
 *   • Záznamy pořízené PO posledním ukotvení kryté nejsou. Chrání je jen
 *     řetězení, tedy s toutéž mezerou jako dřív. Proto na četnosti záleží.
 *   • Kopie kotvy uložená uvnitř systému (`ledger/anchors.jsonl`) je jen
 *     pro pohodlí porovnání. Kdo smí zapisovat do řetězu, smí zapisovat
 *     i do ní. Důkazní hodnotu má výhradně ta kopie, která odešla PRYČ.
 *     Spis to musí říct, jinak by z pomůcky dělal důkaz.
 */

import fs from 'fs';
import path from 'path';
import { LEDGER_DIR, LEDGER_FILE, readLedger, headHash } from './audit-ledger.js';
import { ensureDir } from './paths.js';

export const ANCHOR_FILE = path.join(LEDGER_DIR, 'anchors.jsonl');

/** Výchozí perioda ukotvení. Kratší = menší nekrytá mezera na konci. */
export const DEFAULT_ANCHOR_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Zapíše kotvu.
 *
 * Vrací i text určený k odeslání ven — právě ta odeslaná kopie je to, co
 * má důkazní hodnotu.
 *
 * @param {object} [options]
 * @param {string} [options.ledgerFile]
 * @param {string} [options.anchorFile]
 * @param {string} [options.note] poznámka provozovatele
 */
export function createAnchor({ ledgerFile = LEDGER_FILE, anchorFile = ANCHOR_FILE, note } = {}) {
  const records = readLedger(ledgerFile);
  const head = headHash(ledgerFile);

  const anchor = {
    anchoredAt: new Date().toISOString(),
    headHash: head,
    // Počet položek v okamžiku ukotvení. Slouží provozovateli ke kontrole;
    // uživateli se nezobrazuje, protože je to údaj o všech nájemcích.
    recordCount: records.length,
    note: note || null,
  };

  ensureDir(path.dirname(anchorFile));
  fs.appendFileSync(anchorFile, `${JSON.stringify(anchor)}\n`, 'utf8');

  return { anchor, message: anchorMessage(anchor) };
}

/**
 * Text kotvy k odeslání ven.
 *
 * Záměrně obsahuje návod, co si s ním počít. Kotva, kterou příjemce
 * zahodí jako nesrozumitelný šum, nic neukotví.
 */
export function anchorMessage(anchor) {
  const head = [
    'AuraGuard — ukotvení otisku záznamu auditů',
    `Čas: ${anchor.anchoredAt}`,
    `Otisk hlavy: ${anchor.headHash}`,
    `Položek v záznamu: ${anchor.recordCount}`,
    '',
  ];

  // Kotva nad prázdným záznamem nekryje NIC.
  //
  // Formálně je pravda, že „žádný dřívější záznam nebyl změněn" — žádný
  // totiž neexistuje. Jenže přesně takhle vypadá tvrzení, které slibuje víc,
  // než čím je podložené: příjemce si zprávu uschová v domnění, že něco
  // dokládá. Musí se to říct rovnou.
  if (anchor.recordCount === 0) {
    return [
      ...head,
      'POZOR: záznam auditů je zatím prázdný, takže tahle kotva nekryje',
      'žádný běh. Uschovat ji můžete, ale důkazní hodnotu získá až tehdy,',
      'když ukotvíte znovu poté, co v záznamu nějaké běhy budou.',
    ].join('\n');
  }

  return [
    ...head,
    'Tuhle zprávu uschovejte. Dokud se stejný otisk nachází v řetězu,',
    `je prokázané, že žádný z ${anchor.recordCount} dřívějších záznamů nebyl`,
    'změněn ani odstraněn — a to včetně odstranění z konce, které samotné',
    'řetězení neodhalí.',
  ].join('\n');
}

/** Načte kotvy. Poškozený řádek nezneplatní ostatní. */
export function readAnchors(file = ANCHOR_FILE) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((a) => a && typeof a.headHash === 'string');
}

/**
 * Ověří kotvy proti řetězu.
 *
 * Pro každou kotvu se hledá záznam s odpovídajícím otiskem. Když se najde
 * na indexu `i`, je tím doloženo, že položky 0..i jsou stále na svém místě.
 * Když se nenajde, znamená to, že s řetězem někdo hýbal PŘED tím místem —
 * nebo že kotva pochází z jiného řetězu.
 *
 * @returns {{
 *   anchors: Array<{anchoredAt: string, headHash: string, present: boolean, coversUpToIndex: number|null}>,
 *   latest: object|null,
 *   coveredUpToIndex: number|null,
 *   ok: boolean|null
 * }}
 */
export function verifyAnchors(records, anchors) {
  const list = Array.isArray(anchors) ? anchors : [];
  const recs = Array.isArray(records) ? records : [];

  // Index otisku → pozice. Genesis je zvláštní případ: kotva pořízená nad
  // prázdným řetězem nekryje nic, ale není chybná.
  const positionOf = new Map();
  recs.forEach((r, i) => {
    if (!r.__malformed && typeof r.hash === 'string') positionOf.set(r.hash, i);
  });

  const evaluated = list
    .slice()
    .sort((a, b) => Date.parse(a.anchoredAt) - Date.parse(b.anchoredAt))
    .map((a) => {
      const emptyChain = a.recordCount === 0;
      const index = positionOf.has(a.headHash) ? positionOf.get(a.headHash) : null;
      return {
        anchoredAt: a.anchoredAt,
        headHash: a.headHash,
        note: a.note ?? null,
        // Kotva nad prázdným řetězem je platná, jen nic nekryje.
        present: emptyChain ? true : index !== null,
        coversUpToIndex: emptyChain ? -1 : index,
      };
    });

  if (evaluated.length === 0) {
    // Bez kotvy se nedá tvrdit ani porušení, ani neporušenost konce.
    return { anchors: [], latest: null, coveredUpToIndex: null, ok: null };
  }

  const latest = evaluated[evaluated.length - 1];
  const missing = evaluated.filter((a) => !a.present);

  // Kryto je to, kam sahá NEJDÁL potvrzená kotva. Chybějící kotva krytí
  // neposkytuje, ale ani neruší to, co potvrdily ostatní.
  const covered = evaluated
    .filter((a) => a.present && a.coversUpToIndex !== null)
    .reduce((max, a) => Math.max(max, a.coversUpToIndex), -1);

  return {
    anchors: evaluated,
    latest,
    coveredUpToIndex: covered >= 0 ? covered : null,
    // `false` jen tehdy, když ukotvený otisk v řetězu CHYBÍ. To je tvrdý
    // nález: řetěz se od ukotvení změnil způsobem, který řetězení samo
    // neodhalí.
    ok: missing.length === 0,
  };
}

/**
 * Shrnutí ukotvení pro spis — v podobě, kterou lze ukázat uživateli.
 *
 * Neobsahuje počet položek ani nic dalšího o cizích nájemcích.
 */
export function anchorSummary(records, anchors) {
  const status = verifyAnchors(records, anchors);

  if (status.ok === null) {
    return {
      state: 'none',
      anchoredAt: null,
      headHash: null,
      coveredUpToIndex: null,
      coversRecords: 0,
      rationale:
        'Otisk řetězu nebyl dosud ukotven mimo tento systém. Řetězení proto ' +
        'dokládá jen to, že nikdo nezasáhl doprostřed historie; odstranění ' +
        'nejnovějších položek tímto spisem vyloučit nelze.',
    };
  }

  if (status.ok === false) {
    const chybi = status.anchors.filter((a) => !a.present);
    return {
      state: 'broken',
      anchoredAt: chybi[chybi.length - 1].anchoredAt,
      headHash: chybi[chybi.length - 1].headHash,
      coveredUpToIndex: status.coveredUpToIndex,
      coversRecords: status.coveredUpToIndex === null ? 0 : status.coveredUpToIndex + 1,
      rationale:
        `${chybi.length} dříve ukotvený otisk se v řetězu nenachází. ` +
        'Buď byla historie přepsána, nebo záznam pochází z jiného řetězu. ' +
        'Tenhle spis proto nelze považovat za doklad o neporušenosti.',
    };
  }

  // Kolik běhů kotva skutečně kryje. Nula znamená, že se ukotvoval prázdný
  // řetěz — kotva je platná, ale nedokládá nic.
  const coversRecords = status.coveredUpToIndex === null ? 0 : status.coveredUpToIndex + 1;

  if (coversRecords === 0) {
    return {
      state: 'empty',
      anchoredAt: status.latest.anchoredAt,
      headHash: status.latest.headHash,
      coveredUpToIndex: null,
      coversRecords: 0,
      rationale:
        `Otisk byl ukotven ${status.latest.anchoredAt}, ale v tu chvíli byl ` +
        'záznam auditů prázdný — kotva proto nekryje žádný běh. Dokud se ' +
        'neukotví znovu poté, co v záznamu nějaké běhy budou, nelze odstranění ' +
        'nejnovějších položek vyloučit.',
    };
  }

  return {
    state: 'anchored',
    anchoredAt: status.latest.anchoredAt,
    headHash: status.latest.headHash,
    coveredUpToIndex: status.coveredUpToIndex,
    coversRecords,
    rationale:
      `Otisk řetězu byl naposledy ukotven ${status.latest.anchoredAt} a v řetězu ` +
      `se stále nachází. Žádný z ${coversRecords} záznamů pořízených před tímto ` +
      'okamžikem tedy nebyl změněn ani odstraněn — a to včetně odstranění ' +
      'z konce, které samotné řetězení neodhalí. Záznamy pořízené po tomto ' +
      'okamžiku kryté nejsou. Důkazní hodnotu má kopie kotvy uchovaná MIMO ' +
      'tento systém; kopie uložená vedle záznamu slouží jen k porovnání.',
  };
}
