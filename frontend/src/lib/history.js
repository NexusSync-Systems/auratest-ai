/**
 * Seznam běhů v sekci Historie testů.
 *
 * CO BYLO ŠPATNĚ
 * Položka nesla jen doménu, počet chyb a celý dlouhý `goal`. Čtyři běhy
 * na tutéž doménu tedy vypadaly identicky — nešlo poznat, který je
 * z kdy, který dopadl jak, ani který se vůbec nedokončil. Kliknout se
 * dalo jedině naslepo.
 *
 * STAV NENÍ POČET NÁLEZŮ
 * `bugsCount: 0` znamená pokaždé něco jiného podle toho, odkud přišlo:
 *
 *   dokončený agentní běh   nic se nenašlo
 *   selhaný běh             nikdo se nedíval
 *   předpisový sken         pole se nepoužívá, verdikt je v `checks`
 *   běh „running" ze včera  nikdo neví, jestli doběhl
 *
 * Sloučit je do jednoho zeleného „Bez nálezu" znamená tvrdit o webu
 * něco, co nikdo nezměřil — táž vada, jakou hlídají skenery, jen
 * v menším.
 */

import { STALE_AFTER_MS } from './run-status.js';

/** Zkrácený štítek typu testu. */
const TYPY = [
  [/monkey mode/i, 'Monkey'],
  [/smart monkey/i, 'Smart Monkey'],
  [/smoke test/i, 'Smoke test'],
  [/crawler/i, 'Crawler'],
  [/odolnostn|chaos/i, 'Chaos'],
  [/přístupnost|wcag|eaa/i, 'EAA'],
  [/nis2/i, 'NIS2'],
  [/green deal|uhlík/i, 'Green Deal'],
  [/sbom/i, 'SBOM'],
  [/zranitelnost|cve/i, 'CVE'],
  [/ai act/i, 'AI Act'],
  [/cookie/i, 'Cookies'],
  [/dostupnost/i, 'Dostupnost'],
  [/formulář/i, 'Formulář'],
];

/**
 * Z dlouhého `goal` udělá krátký štítek.
 *
 * Vlastní zadání uživatele se NEPŘEKLÁDÁ — zkrátí se, ale zůstane jeho.
 * Nahradit ho obecným „Agent" by zahodilo jedinou informaci o tom, co
 * po agentovi chtěl.
 */
export function zkracenyTyp(goal) {
  const text = String(goal ?? '').trim();
  if (text === '') return 'Neurčeno';
  for (const [vzor, stitek] of TYPY) {
    if (vzor.test(text)) return stitek;
  }
  return text.length > 28 ? `${text.slice(0, 27)}…` : text;
}

/**
 * Co který stav znamená.
 *
 * Rozdíl mezi „Bez nálezu", „Nedokončeno" a „Neprůkazné" je přesně to,
 * na čem celý nástroj stojí — a v seznamu jsou to tři podobně vypadající
 * odznaky. Bez vysvětlení je trojstav jen ozdoba: uživatel si všechny
 * tři přečte jako „asi dobrý" nebo „asi špatný".
 *
 * Vysvětlení je u zdroje, ne v šabloně, aby se nemohlo rozejít
 * s rozhodováním v `stavBehu` níž.
 */
export const VYSVETLENI = {
  ciste: 'Kontrola proběhla celá a v jejím rozsahu se nic nenašlo. '
    + 'Není to potvrzení souladu — rozsah je dán tím, co nástroj měří.',
  nalezy: 'Kontrola proběhla celá a něco našla. Podrobnosti jsou '
    + 'v záznamu běhu.',
  neprukazne: 'Kontrola proběhla, ale na závěr to nestačilo. Není to '
    + 'závada ani její nepřítomnost — o téhle oblasti se z běhu nedá '
    + 'nic tvrdit.',
  nedokonceno: 'Běh se nedokončil, takže nemá výsledek. Z toho neplyne, '
    + 'že je aplikace bez závad, ani že závady má.',
  bezodezvy: 'Běh zůstal rozdělaný déle, než trvá nejdelší povolené '
    + 'měření. Nejspíš se nedokončil; jeho výsledek se nedozvíme.',
  bezi: 'Měření právě probíhá. Výsledek zatím neexistuje.',
  neznamy: 'Záznam nenese údaj, ze kterého by se stav dal určit.',
};

/**
 * Stav běhu pro odznak v seznamu.
 *
 * @param {{status?: string, bugsCount?: number, kind?: string,
 *          verdict?: boolean|null, timestamp?: string}} s
 * @param {number} [now]
 * @returns {{stav: string, popisek: string, trida: string}}
 */
export function stavBehu(s, now = Date.now()) {
  const status = s?.status;
  const nalezy = s?.bugsCount;

  if (status === 'running') {
    // „Běží" po dvou hodinách je domněnka, ne měření.
    //
    // Běh zůstane ve stavu `running` i tehdy, když proces spadl — nikdo
    // mu už status nepřepíše. Hlavička aplikace to rozlišuje od začátku
    // (`run-status.js`), seznam běhů ne, takže tvrdily každý něco jiného
    // o týchž záznamech: nahoře „3 běhy bez odezvy", dole „Běží".
    const zacatek = Date.parse(s?.timestamp);
    if (!Number.isNaN(zacatek) && now - zacatek >= STALE_AFTER_MS) {
      return { stav: 'bezodezvy', popisek: 'Bez odezvy', trida: 'nedokonceno', popis: VYSVETLENI.bezodezvy };
    }
    return { stav: 'bezi', popisek: 'Běží', trida: 'bezi', popis: VYSVETLENI.bezi };
  }
  if (status === 'failed') {
    // Nedokončený běh NENÍ běh bez nálezu. Nikdo se nedíval.
    return { stav: 'nedokonceno', popisek: 'Nedokončeno', trida: 'nedokonceno', popis: VYSVETLENI.nedokonceno };
  }
  if (status !== 'completed') {
    return { stav: 'neznamy', popisek: 'Neznámý stav', trida: 'nedokonceno', popis: VYSVETLENI.neznamy };
  }
  // Předpisový sken nese verdikt v `checks`, ne v `bugs`.
  //
  // `buildScanSession` mu `bugs: []` nastavuje schválně, takže počítat
  // u něj nálezy znamenalo tisknout „Bez nálezu" bez ohledu na to, co
  // sken zjistil. Sken, který našel porušení, tak v seznamu vypadal
  // úplně stejně jako čistý.
  if (s?.kind === 'compliance-scan') {
    if (s.verdict === false) {
      return { stav: 'nalezy', popisek: 'Porušení', trida: 'nalezy', popis: VYSVETLENI.nalezy };
    }
    if (s.verdict === true) {
      return { stav: 'ciste', popisek: 'Bez nálezu', trida: 'ciste', popis: VYSVETLENI.ciste };
    }
    return { stav: 'neprukazne', popisek: 'Neprůkazné', trida: 'nedokonceno', popis: VYSVETLENI.neprukazne };
  }

  if (typeof nalezy !== 'number') {
    // Záznam nenese počet nálezů — z toho se „bez nálezu" vyvodit nedá.
    return { stav: 'neznamy', popisek: 'Bez údaje o nálezech', trida: 'nedokonceno', popis: VYSVETLENI.neznamy };
  }
  if (nalezy > 0) {
    return { stav: 'nalezy', popisek: `${nalezy} ${vetNalez(nalezy)}`, trida: 'nalezy', popis: VYSVETLENI.nalezy };
  }
  return { stav: 'ciste', popisek: 'Bez nálezu', trida: 'ciste', popis: VYSVETLENI.ciste };
}

function vetNalez(n) {
  if (n === 1) return 'nález';
  if (n >= 2 && n <= 4) return 'nálezy';
  return 'nálezů';
}

/** Čas běhu ve tvaru HH:MM. */
export function casBehu(timestamp) {
  const d = new Date(timestamp);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' });
}

/** Nadpis skupiny: „Dnes", „Včera", jinak datum. */
export function nadpisDne(timestamp, now = Date.now()) {
  const d = new Date(timestamp);
  if (Number.isNaN(d.getTime())) return 'Bez data';

  const den = (x) => {
    const y = new Date(x);
    y.setHours(0, 0, 0, 0);
    return y.getTime();
  };
  const rozdil = Math.round((den(now) - den(d)) / 86400000);

  if (rozdil === 0) return 'Dnes';
  if (rozdil === 1) return 'Včera';
  return d.toLocaleDateString('cs-CZ', { day: 'numeric', month: 'numeric', year: 'numeric' });
}

/**
 * Rozdělí běhy do skupin po dnech, v pořadí od nejnovějšího.
 *
 * Vstup se NEPŘEDPOKLÁDÁ seřazený — server ho sice řadí, ale spoléhat
 * se na to by znamenalo, že se skupiny při jiném pořadí tiše rozsypou.
 *
 * @returns {Array<{nadpis: string, bezy: Array}>}
 */
export function seskupPodleDne(sessions, now = Date.now()) {
  const seznam = (Array.isArray(sessions) ? sessions : []).slice().sort((a, b) => {
    const ta = Date.parse(a?.timestamp);
    const tb = Date.parse(b?.timestamp);
    // Nečitelné datum patří na konec, ne doprostřed.
    if (Number.isNaN(ta) && Number.isNaN(tb)) return 0;
    if (Number.isNaN(ta)) return 1;
    if (Number.isNaN(tb)) return -1;
    return tb - ta;
  });

  const skupiny = [];
  for (const s of seznam) {
    const nadpis = nadpisDne(s?.timestamp, now);
    const posledni = skupiny[skupiny.length - 1];
    if (posledni && posledni.nadpis === nadpis) posledni.bezy.push(s);
    else skupiny.push({ nadpis, bezy: [s] });
  }
  return skupiny;
}
