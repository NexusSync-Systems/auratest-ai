/**
 * Selhané síťové požadavky — co z nich je nález o webu a co ne.
 *
 * PROČ TO TU JE
 * Ostrý běh proti cloudflare.com (web bez závady) vrátil dva nálezy,
 * a ani jeden nebyl pravdivý:
 *
 *   • „Selhal síťový požadavek: HEAD https://www.cloudflare.com/ -
 *      net::ERR_ABORTED" — zrušený požadavek není vada.
 *   • „Selhal síťový požadavek: https://www.cloudflare.com/" — druhé
 *     znění TÉHOŽ faktu, které do `bugs` přidávala smyčka běhu.
 *
 * Obojí je táž chyba: web, který je v pořádku, dostal nález. Ve spisu
 * z toho je „Nálezy: 2".
 *
 * JEDEN ZAPISOVATEL, JEDNO ZNĚNÍ
 * `addFinding` deduplikuje podle celého řetězce, takže dvě formulace
 * téhož faktu projdou obě a počet nálezů v dokumentu pro úřad se
 * nafoukne. Znění proto vyrábí jedna funkce a nikdo jiný.
 */

/**
 * Byl požadavek zrušen?
 *
 * `net::ERR_ABORTED` znamená, že požadavek někdo zrušil: odchod ze
 * stránky, `AbortController` v aplikaci, spekulativní přednačtení, které
 * prohlížeč zahodil, nebo HEAD ukončený po hlavičkách.
 *
 * Nic z toho není závada — a odlišit „aplikace si požadavek zrušila
 * správně" od „zrušila ho omylem" zvenčí nejde. Neurčitelné se podle
 * řídící zásady nástroje nehlásí jako nález.
 */
export function jeZruseny(errText) {
  return String(errText || '').trim() === 'net::ERR_ABORTED';
}

/**
 * Nález o webu. JEDINÉ přípustné znění.
 *
 * Metoda se bere ze skutečného požadavku, ne natvrdo „GET" — nález
 * v dokumentu pro úřad má popisovat, co se opravdu stalo.
 */
export function nalezSitoveChyby(method, url, errText) {
  return `Selhal síťový požadavek: ${method || '?'} ${url} - ${errText || 'Unknown failure'}`;
}

/**
 * Okolnost běhu, ne nález. Zůstává vidět, do verdiktu se nepočítá.
 */
export function poznamkaZruseneho(method, url) {
  return `Požadavek byl zrušen (nejde o vadu webu): ${method || '?'} ${url}`;
}
