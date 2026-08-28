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
import {
  LEDGER_DIR,
  LEDGER_FILE,
  readLedger,
  GENESIS_HASH,
  acquireLock,
  appendLineSynced,
} from './audit-ledger.js';

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
export function createAnchor({
  ledgerFile = LEDGER_FILE,
  anchorFile = ANCHOR_FILE,
  note,
  delivered = null,
} = {}) {
  // Čtení řetězu POD ZÁMKEM a jedním průchodem.
  //
  // Dřív se soubor četl dvakrát — `readLedger` pro počet a `headHash` pro
  // otisk. Když mezi tím doběhl zápis, vznikla kotva s počtem N a otiskem
  // záznamu N+1. Po zpřísnění ověření (otisk musí sedět na pozici
  // `recordCount - 1`) by taková kotva hlásila falešné porušení.
  const release = acquireLock(ledgerFile);
  let anchor;
  try {
    const records = readLedger(ledgerFile);
    const last = records[records.length - 1];

    if (last?.__malformed) {
      throw new Error(
        `Poslední řádek řetězu je nečitelný (řádek ${last.line}) — kotva by ` +
          'ukotvila neúplný stav.'
      );
    }

    anchor = {
      anchoredAt: new Date().toISOString(),
      // Hlava se odvozuje z už načtených dat, ne dalším průchodem souborem.
      headHash: records.length === 0 ? GENESIS_HASH : last.hash,
      // Počet položek v okamžiku ukotvení. Slouží provozovateli ke kontrole;
      // uživateli se nezobrazuje, protože je to údaj o všech nájemcích.
      recordCount: records.length,
      note: note || null,
      // Kam a jestli kotva odešla. Bez toho hlásil nástroj „ukotveno"
      // i tehdy, když kopie systém nikdy neopustila — a taková kotva
      // důkazní hodnotu nemá, protože ji ovládá tentýž zapisovatel.
      delivered: delivered || null,
    };

    appendLineSynced(anchorFile, `${JSON.stringify(anchor)}\n`);
  } finally {
    release();
  }

  return { anchor, message: anchorMessage(anchor) };
}

/**
 * Doplní k poslední kotvě výsledek odeslání.
 *
 * Odesílá se až po zápisu — kdyby se zapisovalo až po odeslání, ztratila
 * by se kotva při pádu mezi tím. Zápis výsledku je proto samostatný krok.
 */
export function recordAnchorDelivery(anchoredAt, delivered, file = ANCHOR_FILE) {
  const list = readAnchors(file);
  const updated = list.map((a) =>
    !a.__malformed && a.anchoredAt === anchoredAt ? { ...a, delivered } : a
  );
  if (updated.length === 0) return false;
  // Přepis celého souboru: kotev jsou desítky, ne miliony, a částečná
  // aktualizace řádku v JSONL je zbytečně křehká.
  const text = updated
    .filter((a) => !a.__malformed)
    .map((a) => JSON.stringify(a))
    .join('\n');
  fs.writeFileSync(file, text ? `${text}\n` : '', 'utf8');
  return true;
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

/**
 * Načte kotvy.
 *
 * Poškozený řádek se NEZAHAZUJE — vrací se s příznakem `__malformed`.
 *
 * Tiché zahození bylo obcházecí cesta: po useknutí řetězu stačilo poškodit
 * jeden znak v souboru kotev, kotva zmizela a nález „broken" se změnil na
 * „neukotveno". Chybějící důkaz se tak proměnil v „nic tu nebylo" — přesně
 * to, čemu se `readLedger` u samotného řetězu brání.
 */
export function readAnchors(file = ANCHOR_FILE) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line, i) => {
      try {
        const parsed = JSON.parse(line);
        if (!isWellFormedAnchor(parsed)) {
          return { __malformed: true, line: i + 1, reason: 'neúplná nebo nesmyslná kotva' };
        }
        return parsed;
      } catch (err) {
        return { __malformed: true, line: i + 1, reason: err.message };
      }
    });
}

/**
 * Má kotva vůbec tvar kotvy?
 *
 * Kontroluje se i FORMÁT otisku. Bez toho prošel jako platná kotva
 * i řetězec „deadbeef", který v žádném řetězu nikdy nebude — a taková
 * kotva by trvale hlásila porušení tam, kde k žádnému nedošlo.
 */
function isWellFormedAnchor(a) {
  return (
    a &&
    typeof a === 'object' &&
    typeof a.headHash === 'string' &&
    /^[0-9a-f]{64}$/i.test(a.headHash) &&
    typeof a.anchoredAt === 'string' &&
    !Number.isNaN(Date.parse(a.anchoredAt)) &&
    Number.isInteger(a.recordCount) &&
    a.recordCount >= 0
  );
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

  // Poškozený řádek v souboru kotev je nález, ne nepřítomnost.
  const malformedAnchors = list.filter((a) => a?.__malformed);
  const usable = list.filter((a) => a && !a.__malformed);

  // Otisk → VŠECHNY pozice, na kterých se vyskytl.
  //
  // Duplicitní otisk je sám o sobě známka manipulace: útočník smazal
  // záznam, přepočítal otisky za ním a na konec připojil kopii původní
  // hlavy, aby ukotvený otisk „zůstal v řetězu". Držet jen poslední výskyt
  // ten trik propouštělo.
  const positionsOf = new Map();
  recs.forEach((r, i) => {
    if (r.__malformed || typeof r.hash !== 'string') return;
    if (!positionsOf.has(r.hash)) positionsOf.set(r.hash, []);
    positionsOf.get(r.hash).push(i);
  });
  const duplicateHashes = [...positionsOf.values()].filter((v) => v.length > 1).length;

  const evaluated = usable
    .slice()
    .sort((a, b) => Date.parse(a.anchoredAt) - Date.parse(b.anchoredAt))
    .map((a) => {
      const positions = positionsOf.get(a.headHash) || [];

      // Kotva ukotvuje HLAVU, ne „nějaký řádek".
      //
      // Hledat otisk kdekoli v řetězu znamenalo, že vložení podvrženého
      // záznamu před ukotvené místo prošlo — a `coversRecords` dokonce
      // vyrostlo nad počet záznamů v okamžiku ukotvení. Kotva musí sedět
      // přesně na pozici `recordCount - 1`.
      const expectedIndex = a.recordCount - 1;

      if (a.recordCount === 0) {
        // Prázdný řetěz má jedinou přípustnou hlavu. Bez téhle kontroly
        // stačilo v kotvě přepsat `recordCount` na nulu a ověření se
        // vyplo úplně, včetně už nalezeného porušení.
        const genesisOk = a.headHash === GENESIS_HASH;
        return {
          anchoredAt: a.anchoredAt,
          headHash: a.headHash,
          note: a.note ?? null,
          delivered: a.delivered ?? null,
          present: genesisOk,
          coversUpToIndex: genesisOk ? -1 : null,
          problem: genesisOk ? null : 'Kotva tvrdí prázdný řetěz, ale nenese výchozí otisk.',
        };
      }

      const present = positions.includes(expectedIndex);
      return {
        anchoredAt: a.anchoredAt,
        headHash: a.headHash,
        note: a.note ?? null,
        delivered: a.delivered ?? null,
        present,
        coversUpToIndex: present ? expectedIndex : null,
        problem: present
          ? null
          : positions.length
            ? `Ukotvený otisk je v řetězu na jiné pozici (${positions.join(', ')}), než na jaké byl ukotven (${expectedIndex}).`
            : 'Ukotvený otisk se v řetězu nenachází.',
      };
    });

  if (evaluated.length === 0 && malformedAnchors.length === 0) {
    // Bez kotvy se nedá tvrdit ani porušení, ani neporušenost konce.
    return {
      anchors: [],
      latest: null,
      coveredUpToIndex: null,
      malformedAnchors: 0,
      duplicateHashes,
      ok: null,
    };
  }

  const latest = evaluated.length ? evaluated[evaluated.length - 1] : null;
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
    malformedAnchors: malformedAnchors.length,
    duplicateHashes,
    // `false` při jakémkoli z těchto stavů: chybějící nebo přesunutý
    // ukotvený otisk, poškozená kotva, duplicitní otisky v řetězu.
    // Všechny tři znamenají, že se s podkladem hýbalo.
    ok: missing.length === 0 && malformedAnchors.length === 0 && duplicateHashes === 0,
  };
}

/**
 * Shrnutí ukotvení pro spis — v podobě, kterou lze ukázat uživateli.
 *
 * NEOBSAHUJE počty záznamů. Řetěz je společný všem nájemcům, takže
 * „kryje N záznamů" je údaj o cizích auditech; navíc si ho čtenář spisu
 * přečte jako počet SVÝCH krytých běhů, což není. Krytí se vyjadřuje
 * u jednotlivých běhů podle času, ne číslem.
 *
 * @param {Array} records  položky řetězu
 * @param {Array} anchors  kotvy
 * @param {boolean|null} chainOk výsledek ÚPLNÉ verifyChain; `false` znamená,
 *   že ukotvení nedokládá nic
 */
export function anchorSummary(records, anchors, chainOk = null) {
  const status = verifyAnchors(records, anchors);

  // Kotva nad porušeným řetězem nedokazuje NIC.
  //
  // Ověření kotvy říká „ukotvený otisk sedí na své pozici". To dává smysl
  // jen tehdy, když řetěz jako celek prochází kontrolou. Nad řetězem, kde
  // otisky nenavazují, může sedět cokoli — a hlásit „ukotveno" by z toho
  // udělalo doklad, který neexistuje.
  if (chainOk === false) {
    return {
      state: 'broken',
      anchoredAt: status.latest?.anchoredAt ?? null,
      headHash: null,
      coveredUpToIndex: null,
      coversRecords: 0,
      rationale:
        'Řetěz záznamů neprošel úplnou kontrolou, takže ukotvení nedokládá nic. ' +
        'Dokud se neporušenost řetězu neobnoví, nelze tento spis považovat ' +
        'za doklad o tom, že se se záznamy nehýbalo.',
    };
  }

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
    // Rozhoduje NEJSTARŠÍ vadná kotva — ta ohraničuje, jak hluboko zásah
    // sahá. Poslední by řekla jen to, kde skončil.
    const prvni = chybi[0] || null;
    const duvody = [];
    if (chybi.length) {
      duvody.push(
        `${chybi.length === 1 ? 'Jeden dříve ukotvený otisk' : `${chybi.length} dříve ukotvených otisků`} ` +
          'v řetězu chybí nebo je na jiné pozici, než na jaké byl ukotven.'
      );
    }
    if (status.malformedAnchors) {
      duvody.push(
        `${status.malformedAnchors} záznam o ukotvení je poškozený a nelze ho ověřit.`
      );
    }
    if (status.duplicateHashes) {
      duvody.push(
        `V řetězu se ${status.duplicateHashes}× opakuje týž otisk, což samo o sobě ` +
          'znamená zásah do historie.'
      );
    }
    return {
      state: 'broken',
      anchoredAt: prvni?.anchoredAt ?? null,
      headHash: prvni?.headHash ?? null,
      coveredUpToIndex: null,
      coversRecords: 0,
      rationale:
        `${duvody.join(' ')} Buď byla historie přepsána, nebo záznam pochází ` +
        'z jiného řetězu. Tenhle spis proto nelze považovat za doklad ' +
        'o neporušenosti.',
    };
  }

  // Kolik záznamů kotva kryje. Nula znamená, že se ukotvoval prázdný
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

  // Kotva, která systém nikdy neopustila, dokládá málo.
  //
  // Celý mechanismus stojí na tom, že kopie otisku je MIMO dosah toho, kdo
  // smí zapisovat do řetězu. Dokud se výsledek odeslání nezaznamenával,
  // hlásil nástroj „ukotveno" i u kotvy, která zůstala vedle záznamu —
  // tedy u dvou souborů, které ovládá tentýž zapisovatel.
  if (status.latest.delivered?.ok !== true) {
    return {
      state: 'internal-only',
      anchoredAt: status.latest.anchoredAt,
      headHash: status.latest.headHash,
      coveredUpToIndex: status.coveredUpToIndex,
      coversRecords,
      rationale:
        `Otisk byl ukotven ${status.latest.anchoredAt} a v řetězu se stále ` +
        'nachází na své pozici. Kopie kotvy ale neopustila tenhle systém ' +
        '(automatické odeslání není nastavené nebo se nezdařilo), takže ji ' +
        'ovládá tentýž zapisovatel jako záznam sám. Doložit odstranění ' +
        'nejnovějších položek jde teprve tehdy, když otisk porovnáte ' +
        's kopií uchovanou jinde — tu z výstupu skriptu nebo z logu ' +
        'uschovejte ručně.',
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
      'se stále nachází na své pozici. Žádný ze záznamů pořízených před tímto ' +
      'okamžikem tedy nebyl změněn ani odstraněn — a to včetně odstranění ' +
      'z konce, které samotné řetězení neodhalí. Záznamy pořízené po tomto ' +
      'okamžiku kryté nejsou. Důkazní hodnotu má kopie kotvy uchovaná MIMO ' +
      'tento systém; kopie uložená vedle záznamu slouží jen k porovnání.',
  };
}
