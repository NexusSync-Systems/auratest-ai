/**
 * Kdy vrátit `index.html` a kdy 404.
 *
 * Jednostránková aplikace potřebuje, aby server na `/hub` nebo `/ukazka`
 * vrátil `index.html` — jinak by přímé otevření odkazu i obnovení stránky
 * skončilo chybou. Naivní catch-all ale odpoví `index.html` na úplně
 * všechno, včetně souborů, které neexistují.
 *
 * A to je horší než 404, protože chyba se posune jinam a vypadá jako cizí:
 * frontend si vyžádá `sample-report.json`, dostane HTML se stavem 200,
 * `response.ok` je true a spadne až `JSON.parse` hláškou „The string did not
 * match the expected pattern". Kdo ji uvidí, hledá chybu v parsování dat —
 * ne chybějící soubor na serveru.
 *
 * Rozlišení je jednoduché: cesty SPA nemají příponu, statické soubory ano.
 *
 * Vlastní modul kvůli testovatelnosti — catch-all v `server.js` se registruje
 * jen když existuje `frontend/dist`, takže test by jinak závisel na tom,
 * jestli zrovna proběhl build.
 */

/** `/api/...` — klient čeká JSON, ne stránku. */
const API_PREFIX = '/api/';

/**
 * Přípona na konci cesty: `.json`, `.js`, `.woff2`, `.map` …
 *
 * Horní hranice délky brání tomu, aby se jako přípona vyhodnotil kus
 * legitimní cesty (`/verze/1.2.3-beta-kandidat`).
 */
const HAS_FILE_EXTENSION = /\.[a-z0-9]{1,8}$/i;

/**
 * @param {string} pathname cesta z requestu, bez query
 * @returns {{ serveIndex: boolean, status: number, reason: string }}
 */
export function resolveSpaFallback(pathname) {
  const p = String(pathname || '/');

  if (p.startsWith(API_PREFIX)) {
    return { serveIndex: false, status: 404, reason: 'Endpoint nenalezen.' };
  }

  if (HAS_FILE_EXTENSION.test(p)) {
    return { serveIndex: false, status: 404, reason: 'Soubor nenalezen.' };
  }

  return { serveIndex: true, status: 200, reason: '' };
}
