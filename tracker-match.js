/**
 * Poznávání trackerů podle jmen — bez podřetězců.
 *
 * PROBLÉM, KTERÝ TO ŘEŠÍ
 * Klíče v úložišti prohlížeče se porovnávaly přes `includes`, tedy
 * podřetězcem, a to nad velmi krátkými jehlami (`_ga`, `heap`,
 * `segment`). Ověřené následky:
 *
 *   image_gallery  → obsahuje „_ga"      → tracker
 *   cheap_flights  → obsahuje „heap"     → tracker
 *   userSegment    → obsahuje „segment"  → tracker
 *
 * Jediný takový klíč stačil na verdikt „FAIL: ePrivacy Violation".
 * E-shop, který si drží `userSegment`, tedy dostal doklad o porušení
 * ePrivacy — a šel opravovat něco, co porušením není.
 *
 * Táž vada u cookies: prefix `IDE` (DoubleClick) chytal vlastní cookie
 * `IDENTITY`, prefix `_ga` chytal `_gallery`.
 *
 * JAK SE TO POZNÁVÁ TEĎ
 * Jméno se rozdělí na části podle oddělovačů, které se v názvech klíčů
 * používají (`_`, `-`, `.`, `:`, velké písmeno uvnitř slova), a porovnává
 * se celý úsek. `userSegment` se rozpadne na `user` + `segment`… což by
 * pořád sedělo — proto se u víceznačných jmen vyžaduje, aby shoda byla
 * na ZAČÁTKU klíče, ne kdekoli uvnitř.
 *
 * ČEHO SE TO NEDOTÝKÁ
 * Seznam zůstává neúplný a nikdy úplný nebude. Cílem není chytit víc,
 * ale přestat hlásit nálezy tam, kde žádné nejsou.
 */

/** Klíče úložiště, které nasazuje známý analytický nástroj. */
export const TRACKER_STORAGE_KEYS = [
  'amplitude', 'mixpanel', 'ga', '_ga', 'segment', 'ajs', 'hotjar',
  'clarity', 'fullstory', 'heap', 'posthog', 'intercom', 'hubspot',
];

/**
 * Rozdělí název na části.
 *
 * `_hjSessionUser` → ['hj','session','user']; `ajs_user_id` → ['ajs','user','id'].
 */
export function nameSegments(name) {
  return String(name || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+|\s+/)
    .filter(Boolean)
    .map((s) => s.toLowerCase());
}

/**
 * Je klíč úložiště klíčem trackeru?
 *
 * Vyžaduje se shoda na PRVNÍ části názvu. Analytické nástroje své klíče
 * prefixují (`amplitude_…`, `_hjSession…`, `ajs_anonymous_id`), kdežto
 * `userSegment` má vlastní slovo až na druhém místě — a je to název
 * aplikace, ne nástroje.
 */
export function isTrackerStorageKey(key) {
  const jmeno = String(key || '');
  if (jmeno === '') return false;
  const lower = jmeno.toLowerCase();

  return TRACKER_STORAGE_KEYS.some((tool) => {
    if (lower === tool) return true;
    if (!lower.startsWith(tool)) return false;
    // Za názvem nástroje musí být ODDĚLOVAČ, ne další písmeno.
    //
    // Velké písmeno se tu za hranici NEpovažuje, na rozdíl od cookies.
    // Nástroje své klíče v úložišti oddělují podtržítkem nebo pomlčkou
    // (`amplitude_id`, `intercom-state`), kdežto `heapSize` a
    // `clarityLevel` jsou názvy vlastní aplikace. Podle jména se to
    // jinak rozlišit nedá, a když nelze, nehlásí se nález.
    return /[^a-z0-9]/.test(lower.charAt(tool.length));
  });
}

/**
 * Cookies s PEVNÝM názvem.
 *
 * Nástroj je pojmenovává vždy stejně a nic za ně nepřipojuje, takže se
 * porovnává celý název. Zrovna tady na tom záleží nejvíc: prefix `IDE`
 * od DoubleClicku chytal vlastní cookie `IDENTITY`, a to stačilo na
 * verdikt o porušení ePrivacy.
 */
export const TRACKER_COOKIE_EXACT = [
  '_gid', '_fbp', '_fbc', '_uetsid', '_uetvid', '_clck', '_clsk',
  'IDE', 'test_cookie', 'DSID',
  'li_sugr', 'bcookie', 'lidc',
  '_pin_unauth', '_ttp', 'ttclid', '_scid', '_schn',
  '__hstc', '__hssrc', 'hubspotutk',
];

/**
 * Předpony cookies, za které si nástroj připojuje vlastní identifikátor.
 *
 * `_ga` → `_ga_G1XYZ`, `_hj` → `_hjSessionUser_123`, `mp` → `mp_<token>`.
 * Za předponou proto musí následovat HRANICE: oddělovač, číslice, nebo
 * velké písmeno. Bez té podmínky by `_ga` chytalo `_gallery`.
 */
export const TRACKER_COOKIE_PREFIXES = [
  '_ga',                                     // koliduje s `_gallery`
  'mp', 'ajs',                               // krátké, kolidovaly by snadno
];

/**
 * Předpony natolik výmluvné, že za nimi může následovat cokoli.
 *
 * `_hjid`, `_hjSessionUser_123`, `_gat_gtag_UA_1_1` jsou skutečné cookies
 * a hranice by je zamítla. Riziko kolize je u nich zanedbatelné — žádná
 * běžná vlastní cookie nezačíná na `_hj` nebo `amplitude`.
 */
export const TRACKER_COOKIE_PLAIN_PREFIXES = [
  '_hj',                                     // Hotjar
  '_gat', '_gac', '_gcl_au',                 // Google Analytics / Ads
  '_pinterest',                              // Pinterest
  'amplitude',                               // Amplitude
  'intercom',                                // Intercom
];

/** Je název cookie názvem trackeru? */
export function isTrackerCookieName(name) {
  const jmeno = String(name || '');
  if (jmeno === '') return false;
  const lower = jmeno.toLowerCase();

  if (TRACKER_COOKIE_EXACT.some((n) => n.toLowerCase() === lower)) return true;

  if (TRACKER_COOKIE_PLAIN_PREFIXES.some((p) => lower.startsWith(p.toLowerCase()))) return true;

  return TRACKER_COOKIE_PREFIXES.some((prefix) => {
    const p = prefix.toLowerCase();
    if (lower === p) return true;
    if (!lower.startsWith(p)) return false;
    // Hranice se posuzuje na PŮVODNÍM názvu — velké písmeno je taky
    // hranice (`_hjSessionUser`), a po převedení na malá by zmizela.
    const dalsi = jmeno.charAt(p.length);
    return /[^A-Za-z]/.test(dalsi) || /[A-Z]/.test(dalsi);
  });
}
