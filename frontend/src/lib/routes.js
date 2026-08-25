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
 *
 * VEŘEJNÉ VS. ZAMČENÉ
 * Tři cesty jsou dostupné bez přihlášení: úvodní stránka, ukázkový report
 * a přihlašovací formulář. Skenování za přihlášením zůstává schválně —
 * veřejný formulář by znamenal, že kdokoli pošle server na libovolnou
 * adresu, přičemž jeden běh drží prohlížeč až 70 sekund a odchozí spojení
 * jde z naší IP.
 */

export const DEFAULT_TAB = 'auraguard';

/** Sekce aplikace — vyžadují přihlášení. */
export const TAB_TO_PATH = {
  agent: '/agent',
  compare: '/porovnani-verzi',
  audit: '/audit-prekladu',
  auraguard: '/hub',
  evidence: '/dolozitelnost',
  settings: '/nastaveni',
};

/** Veřejné cesty. Klíče se nepřekrývají s klíči sekcí. */
export const PUBLIC_TAB_TO_PATH = {
  landing: '/',
  sample: '/ukazka',
  login: '/prihlaseni',
};

const PATH_TO_TAB = Object.fromEntries(
  Object.entries(TAB_TO_PATH).map(([tab, path]) => [path, tab])
);

const PATH_TO_PUBLIC_TAB = Object.fromEntries(
  Object.entries(PUBLIC_TAB_TO_PATH).map(([tab, path]) => [path, tab])
);

const ALL = { ...TAB_TO_PATH, ...PUBLIC_TAB_TO_PATH };

/** Normalizuje cestu: bez koncového lomítka, bez rozlišení velikosti písmen. */
function normalize(pathname) {
  const trimmed = String(pathname || '').replace(/\/+$/, '').toLowerCase();
  return trimmed === '' ? '/' : trimmed;
}

/** Je tahle cesta dostupná bez přihlášení? */
export function isPublicPath(pathname) {
  return normalize(pathname) in PATH_TO_PUBLIC_TAB;
}

/** Vyžaduje tahle sekce přihlášení? */
export function isProtectedTab(tab) {
  return tab in TAB_TO_PATH;
}

/**
 * Kterou obrazovku má daná cesta zobrazit.
 *
 * Neznámá cesta padá na úvodní stránku, ne na prázdnou obrazovku — uživatel
 * se sem dostane i překlepem v adrese nebo starým odkazem.
 *
 * @param {string} pathname
 * @returns {string} klíč obrazovky (sekce aplikace nebo veřejné stránky)
 */
export function tabFromPath(pathname) {
  const p = normalize(pathname);
  return PATH_TO_PUBLIC_TAB[p] ?? PATH_TO_TAB[p] ?? 'landing';
}

/**
 * @param {string} tab klíč obrazovky
 * @returns {string} cesta, kterou má mít adresní řádek
 */
export function pathFromTab(tab) {
  return ALL[tab] ?? PUBLIC_TAB_TO_PATH.landing;
}

/** Je tahle cesta známá? */
export function isKnownPath(pathname) {
  return normalize(pathname) in { ...PATH_TO_TAB, ...PATH_TO_PUBLIC_TAB };
}
