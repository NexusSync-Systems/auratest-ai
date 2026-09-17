/**
 * Čtení bezpečnostních hlaviček tak, jak je čte prohlížeč.
 *
 * PROČ TO MÁ VLASTNÍ MODUL
 * Tyhle funkce dřív žily jako regulární výrazy uvnitř `analyzeNis2` v
 * `agent.js`, tedy uvnitř funkce, která potřebuje spuštěný prohlížeč.
 * Otestovat je samostatně nešlo, a tak se netestovaly vůbec — celý blok
 * skládající `isCompliant` neměl jediný test. Kontrolní vlna v něm našla
 * tři chyby najednou.
 *
 * SPOLEČNÝ JMENOVATEL VŠECH TŘÍ CHYB
 * Hlavička není řetězec, který se dá porovnat celý nebo prohledat
 * podřetězcem. Má gramatiku a prohlížeč podle ní vybírá, která hodnota
 * platí. Když ji nástroj čte jinak, vzniká nález na webu, který je
 * v pořádku, nebo naopak splněno na webu, který chráněný není.
 */

/**
 * ČÁRKA NESTAČÍ — PLAYWRIGHT SLUČUJE NOVÝM ŘÁDKEM.
 *
 * Tenhle modul vznikl kvůli hlavičce nastavené víckrát (typicky proxy
 * plus aplikace) a předpokládal, že ji příjemce dostane sloučenou
 * čárkou: `nosniff, nosniff`. To platí pro `Response.allHeaders()`,
 * kde `RawHeaders.get()` spojuje hodnoty `", "`.
 *
 * `agent.js` ale čte `response.headers()`, a to je jiná cesta:
 * `coreBundle.js:35080` volá `headersObjectToArray(responsePayload.headers)`
 * BEZ separátoru, takže hodnota zůstane tak, jak ji poskládalo CDP —
 * a to duplicity spojuje `\n`. Že je to `\n`, dokazuje sám Playwright
 * o dvě stě řádků níž (`:35327`, `:35333`), kde separátor předává
 * výslovně.
 *
 * Do `hasNosniff` tedy chodí `nosniff\nnosniff`, dělení čárkou nic
 * nerozdělí, porovnání celého řetězce selže — a web, který má hlavičku
 * nastavenou na proxy I v aplikaci, dostane do dokumentu pro úřad nález
 * „chybí". Tedy přesně ta chyba, kvůli které modul vznikl, jen o krok
 * dál. Test to nechytil, protože napodobenina používala čárku.
 *
 * Dělí se proto na OBOJE. Poznat, kterou cestou hodnota přišla, zvenčí
 * nejde a obě jsou legitimní.
 */
export const ODDELOVACE_HODNOT = /[,\n]/;

/** První hodnota hlavičky sloučené čárkou nebo novým řádkem, malými písmeny. */
export function firstHeaderValue(raw) {
  return String(raw || '').split(ODDELOVACE_HODNOT)[0].trim().toLowerCase();
}

/** Chrání X-Content-Type-Options proti hádání typu obsahu? */
export function hasNosniff(raw) {
  return firstHeaderValue(raw) === 'nosniff';
}

/**
 * Zakazuje `frame-ancestors` doopravdy vkládání do rámu?
 *
 * `frame-ancestors *` je platná direktiva, která povoluje kohokoli —
 * ochrana je nulová. Totéž `frame-ancestors https:`, které pustí každý
 * web na HTTPS. Dřív se hledal jen výskyt názvu direktivy, takže obojí
 * procházelo jako ochrana; web bez jakékoli obrany proti clickjackingu
 * tak dostal „splněno".
 */
export function framingProtected(csp) {
  const m = /frame-ancestors([^;]*)/i.exec(String(csp || ''));
  if (!m) return false;
  const zdroje = m[1].trim().split(/\s+/).filter(Boolean);
  // `frame-ancestors` bez zdrojů je vadná direktiva; nespoléhat na ni.
  if (zdroje.length === 0) return false;
  return !zdroje.some((z) => z === '*' || /^https?:$/i.test(z));
}

/** Hodnoty Referrer-Policy, kterým prohlížeče rozumí. */
const ZNAME_REFERRER = new Set([
  'no-referrer', 'no-referrer-when-downgrade', 'origin',
  'origin-when-cross-origin', 'same-origin', 'strict-origin',
  'strict-origin-when-cross-origin', 'unsafe-url',
]);

/**
 * Hodnoty, které skutečně brání úniku adresy stránky.
 *
 * `origin-when-cross-origin` mezi nimi je: cizímu webu pošle jen původ,
 * ne cestu, takže konkrétní stránku neprozradí.
 *
 * `no-referrer-when-downgrade` mezi nimi NENÍ: posílá celou adresu včetně
 * cesty na každý cizí web přes HTTPS. Dřív procházelo, protože se hledal
 * podřetězec „no-referrer" — a to i přes komentář v kódu, který tuhle
 * hodnotu výslovně jmenoval jako nedostatečnou.
 */
const CHRANICI_REFERRER = new Set([
  'no-referrer', 'same-origin', 'strict-origin',
  'origin-when-cross-origin', 'strict-origin-when-cross-origin',
]);

/**
 * Chrání Referrer-Policy adresu stránky, ze které uživatel odešel?
 *
 * Z čárkou odděleného seznamu použije prohlížeč POSLEDNÍ hodnotu, které
 * rozumí — právě proto se takové seznamy píšou, jako fallback pro starší
 * prohlížeče. Posuzovat se tedy musí ta.
 *
 * Podřetězcové hledání selhávalo v obou směrech: `unsafe-url,
 * strict-origin-when-cross-origin` dostalo nález, přestože prohlížeč
 * použije tu bezpečnou hodnotu.
 */
export function referrerProtected(raw) {
  const hodnoty = String(raw || '')
    .split(ODDELOVACE_HODNOT)
    .map((v) => v.trim().toLowerCase())
    .filter((v) => ZNAME_REFERRER.has(v));
  if (hodnoty.length === 0) return false;
  return CHRANICI_REFERRER.has(hodnoty[hodnoty.length - 1]);
}
