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

/**
 * Adresy, které patří ochraně proti robotům.
 *
 * PROČ TO NENÍ NÁLEZ O WEBU
 * Ostrý běh proti cloudflare.com vrátil dvě „chyby":
 *
 *   [NetworkError] Selhání API: GET https://challenges.cloudflare.com/
 *     cdn-cgi/challenge-platform/h/g/…
 *   Selhal síťový požadavek: GET https://brunhild.challenges.cloudflare.com/
 *     cdn-cgi/challenge-platform/h/g/i/…
 *
 * Tyhle požadavky obsluhují detekci robotů — a selhaly právě proto, že na
 * stránku kouká automat. Způsobilo je tedy NAŠE měření, ne aplikace.
 * Zapsat je zákazníkovi jako vadu jeho webu je přesně ta záměna, které se
 * nástroj vyhýbá: chyba měření se nesmí vydávat za zjištění o webu.
 *
 * SEZNAM JE ÚMYSLNĚ KRÁTKÝ
 * Každá položka tady znamená „tohle selhání nehlásíme". Nadsazený seznam
 * proto zamlčí skutečné vady — a to je stejně vážná chyba jako nález na
 * webu, který je v pořádku. Proto jsou v něm jen adresy, které jsme
 * SKUTEČNĚ naměřili ve vlastním běhu, ne co si vybavuju o jiných
 * poskytovatelích. Až nějaká přibude z reálného běhu, přidá se sem i s
 * odkazem na ten běh.
 *
 * Cesta `/cdn-cgi/challenge-platform/` je vyhrazená Cloudflare (prefix
 * `/cdn-cgi/` si rezervuje pro vlastní služby), takže se hodnotí bez
 * ohledu na doménu — výzvu obsluhuje i doména zákazníka.
 */
const VYZVA_HOSTY = [
  /(^|\.)challenges\.cloudflare\.com$/i,
];
const VYZVA_CESTY = [
  '/cdn-cgi/challenge-platform/',
];

/**
 * Obsluhuje ta adresa ověřování, že návštěvník není robot?
 *
 * @param {string} url
 * @returns {boolean}
 */
export function jeOvereniRobota(url) {
  let parsed;
  try {
    parsed = new URL(String(url || ''));
  } catch {
    // Nerozebratelná adresa se NEPROHLAŠUJE za výzvu. Fail-closed tady
    // znamená „hlásit dál", protože zamlčení je horší než nález navíc.
    return false;
  }
  if (VYZVA_HOSTY.some((re) => re.test(parsed.hostname))) return true;
  return VYZVA_CESTY.some((cesta) => parsed.pathname.startsWith(cesta));
}

/**
 * Okolnost běhu, ne nález. Říká i to, PROČ se to nepočítá.
 */
export function poznamkaOvereniRobota(method, url, duvod) {
  return `Ochrana proti robotům neodpověděla (selhání způsobilo naše měření, `
    + `ne vada webu): ${method || '?'} ${url}${duvod ? ` - ${duvod}` : ''}`;
}

/**
 * Kam patří selhaný požadavek — a proč.
 *
 * PROČ TO NENÍ ROZHODNUTO V `agent.js`
 * Bylo, a nešlo to testovat: posluchač `requestfailed` se rozjede jedině
 * se skutečným prohlížečem, takže celé zatřídění zůstávalo bez testu
 * a ověřoval se jen predikát vedle něj. Přesně ten vzorec — kód a jeho
 * opis v testu — jsme už jednou platili u měření objemu.
 *
 * @param {object} p
 * @param {string} p.method
 * @param {string} p.url
 * @param {string} p.errText  text chyby od prohlížeče
 * @param {boolean} p.blokovanoNami  zablokovala to naše vlastní ochrana?
 * @returns {{kam: 'bugs'|'warnings'|'ticho', text: string|null,
 *            runtimeSignal: boolean}}
 *   `runtimeSignal` říká, jestli se selhání smí počítat mezi signály
 *   běhu — podle nich se vybírá další akce agenta.
 */
export function zatridSelhani({ method, url, errText, blokovanoNami = false }) {
  // Naše vlastní blokace se nehlásí vůbec: není to zjištění o webu ani
  // okolnost, kterou by čtenář mohl ovlivnit.
  if (blokovanoNami) {
    return { kam: 'ticho', text: null, runtimeSignal: false };
  }

  if (jeZruseny(errText)) {
    return {
      kam: 'warnings',
      text: poznamkaZruseneho(method, url),
      runtimeSignal: false,
    };
  }

  if (jeOvereniRobota(url)) {
    return {
      kam: 'warnings',
      text: poznamkaOvereniRobota(method, url, errText),
      runtimeSignal: false,
    };
  }

  return {
    kam: 'bugs',
    text: nalezSitoveChyby(method, url, errText),
    runtimeSignal: true,
  };
}
