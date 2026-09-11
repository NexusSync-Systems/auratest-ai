/**
 * Seznam běhů v postranním panelu.
 *
 * CO BYLO ŠPATNĚ
 * Položka nesla jen doménu, počet chyb a celý dlouhý `goal`. Čtyři běhy
 * na tutéž doménu tedy vypadaly identicky — nešlo poznat, který je
 * z kdy, který dopadl jak, ani který se vůbec nedokončil. Kliknout se
 * dalo jedině naslepo.
 *
 * TŘI STAVY, NE DVA
 * Počet nálezů sám o sobě nestačí: `0` u dokončeného běhu znamená „nic
 * se nenašlo", u nedokončeného „nikdo se nedíval". Vydávat druhé za
 * první je táž vada, jakou hlídají skenery — jen v menším.
 */

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
 * Stav běhu pro odznak v seznamu.
 *
 * @param {{status?: string, bugsCount?: number, kind?: string}} s
 * @returns {{stav: 'nalezy'|'ciste'|'bezi'|'nedokonceno'|'neznamy',
 *            popisek: string, trida: string}}
 */
export function stavBehu(s) {
  const status = s?.status;
  const nalezy = s?.bugsCount;

  if (status === 'running') {
    return { stav: 'bezi', popisek: 'Běží', trida: 'bezi' };
  }
  if (status === 'failed') {
    // Nedokončený běh NENÍ běh bez nálezu. Nikdo se nedíval.
    return { stav: 'nedokonceno', popisek: 'Nedokončeno', trida: 'nedokonceno' };
  }
  if (status !== 'completed') {
    return { stav: 'neznamy', popisek: 'Neznámý stav', trida: 'nedokonceno' };
  }
  if (typeof nalezy !== 'number') {
    // Záznam nenese počet nálezů — z toho se „bez nálezu" vyvodit nedá.
    return { stav: 'neznamy', popisek: 'Bez údaje o nálezech', trida: 'nedokonceno' };
  }
  if (nalezy > 0) {
    return { stav: 'nalezy', popisek: `${nalezy} ${vetNalez(nalezy)}`, trida: 'nalezy' };
  }
  return { stav: 'ciste', popisek: 'Bez nálezu', trida: 'ciste' };
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
