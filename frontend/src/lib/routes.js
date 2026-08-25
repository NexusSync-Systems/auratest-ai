/**
 * Mapa sekcí na adresy.
 *
 * Sekce se dřív přepínaly jen ve stavu Reactu, takže adresa zůstávala pořád
 * stejná: nešlo poslat odkaz na konkrétní sekci, záložka vždy skončila
 * u agenta a tlačítko Zpět odešlo z aplikace.
 *
 * Cesty jsou české a čitelné — objevují se v adresním řádku a lidé je posílají
 * dál. Interní klíče (`agent`, `compare`, …) zůstávají anglické, aby se
 * nemusel přepisovat zbytek App.jsx.
 *
 * `server.js` má catch-all, který na neznámé cestě vrací `index.html`, takže
 * přímé otevření i obnovení stránky funguje.
 */

export const DEFAULT_TAB = 'auraguard';

export const TAB_TO_PATH = {
  agent: '/agent',
  compare: '/porovnani-verzi',
  audit: '/audit-prekladu',
  auraguard: '/hub',
  settings: '/nastaveni',
};

const PATH_TO_TAB = Object.fromEntries(
  Object.entries(TAB_TO_PATH).map(([tab, path]) => [path, tab])
);

/** Normalizuje cestu: bez koncového lomítka, bez rozlišení velikosti písmen. */
function normalize(pathname) {
  const trimmed = String(pathname || '').replace(/\/+$/, '').toLowerCase();
  return trimmed === '' ? '/' : trimmed;
}

/**
 * Kterou sekci má daná cesta zobrazit.
 *
 * Neznámá cesta spadne na výchozí sekci místo prázdné obrazovky — uživatel
 * se sem dostane i překlepem v adrese nebo starým odkazem.
 *
 * @param {string} pathname
 * @returns {string} klíč sekce
 */
export function tabFromPath(pathname) {
  return PATH_TO_TAB[normalize(pathname)] ?? DEFAULT_TAB;
}

/**
 * @param {string} tab klíč sekce
 * @returns {string} cesta, kterou má mít adresní řádek
 */
export function pathFromTab(tab) {
  return TAB_TO_PATH[tab] ?? TAB_TO_PATH[DEFAULT_TAB];
}

/**
 * Je tahle cesta známá?
 *
 * Kořen `/` známý JE — je to legitimní vstupní adresa, jen se překreslí
 * na cestu výchozí sekce.
 */
export function isKnownPath(pathname) {
  const p = normalize(pathname);
  return p === '/' || p in PATH_TO_TAB;
}
