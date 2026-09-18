/**
 * Zkrácené chyby Reactu — co doopravdy znamenají.
 *
 * PROČ TO TU JE
 * Smoke test proti cloudflare.com hlásí tohle, a hlásí to PRÁVEM:
 *
 *   [Error] Běhová chyba: Uncaught Error: Minified React error #418;
 *     visit https://react.dev/errors/418…
 *   [Error] Neošetřená výjimka: Minified React error #418; visit…
 *
 * Dvě věci jsou na tom špatně, a ani jedna z nich není ten nález sám.
 *
 * 1) DVĚ ZNĚNÍ TÉHOŽ FAKTU. Jednu výjimku ohlásí prohlížeč do konzole
 *    a Playwright zvlášť jako `pageerror`. Deduplikace podle celého
 *    řetězce je nechytí, takže se počet nálezů ve spisu nafoukne.
 *
 * 2) HLÁŠKA, ZE KTERÉ NIC NEPLYNE. „Minified React error #418" je pro
 *    čtenáře dokumentu pro úřad prázdné číslo. React ho v produkčním
 *    buildu zkracuje úmyslně a plné znění vydává na své stránce.
 *
 * ZNĚNÍ JSOU DOSLOVNÁ, NE MOJE.
 * Staženo z react.dev 18. 9. 2026:
 *   https://react.dev/errors/418
 *   https://react.dev/errors/423
 * Co jsem neověřil, tady není. Neznámé číslo se nepřekládá — zůstane
 * tak, jak ho vydal prohlížeč, i s odkazem.
 *
 * TOHLE NEJSOU FALEŠNÉ NÁLEZY.
 * Nesoulad při hydrataci je skutečná vada: server poslal jiný strom,
 * než jaký si klient vykreslil. React sám u #418 uvádí i příčinu, která
 * na webu nezáleží („if the client has a browser extension installed
 * which messes with the HTML"), ta ale na náš běh nesedí — prohlížeč
 * v kontejneru žádné rozšíření nemá. Nález tedy zůstává nálezem; mění
 * se jen to, že je čitelný a započítaný jednou.
 */

/** Doslovná znění z react.dev. Klíč je číslo chyby. */
export const ZNAMA_ZNENI = {
  418: 'Hydration failed because the server rendered HTML didn\'t match the client. '
    + 'As a result this tree will be regenerated on the client.',
  423: 'There was an error while hydrating but React was able to recover by instead '
    + 'client rendering the entire root.',
};

/** Krátké vysvětlení česky — dokument pro úřad čte i neprogramátor. */
export const VYSVETLENI = {
  418: 'Nesoulad při hydrataci: server poslal jiný obsah, než jaký si vykreslil '
    + 'prohlížeč, takže React tu část stránky zahodil a vykreslil znovu.',
  423: 'Hydratace selhala a React se z toho dostal tím, že celý kořen vykreslil '
    + 'znovu na klientovi.',
};

const CISLO_CHYBY = /Minified React error #(\d+)/;

/**
 * Doplní k zkrácené chybě Reactu její skutečné znění.
 *
 * @param {string} text
 * @returns {string} původní text, nebo text s doplněným významem
 */
export function doplnZnameZneni(text) {
  const t = String(text ?? '');
  const m = CISLO_CHYBY.exec(t);
  if (!m) return t;

  const cislo = Number(m[1]);
  const vysvetleni = VYSVETLENI[cislo];
  // Neověřené číslo se nedomýšlí — radši prázdné místo než vymyšlený
  // popis vady v dokumentu pro úřad.
  if (!vysvetleni) return t;

  return `${t}\nVýznam: ${vysvetleni}`;
}

/**
 * Klíč pro rozpoznání, že jde o TÉHOŽ výjimku.
 *
 * Jedna výjimka přijde dvakrát: z konzole a z `pageerror`, pokaždé
 * s jinou obálkou („Uncaught Error: …", „Neošetřená výjimka: …") a
 * jinak useknutým odkazem. Klíč obálky odloupne a nechá jádro.
 *
 * @returns {string|null} `null`, když text jako výjimka nevypadá
 */
export function klicVyjimky(text) {
  const t = String(text ?? '');

  // Zkrácená chyba Reactu má vlastní, spolehlivý klíč — číslo.
  const m = CISLO_CHYBY.exec(t);
  if (m) return `react:${m[1]}`;

  // Obecná výjimka: odloupnout naše i prohlížečovy prefixy, zahodit
  // stack a odkazy, zbytek porovnávat bez ohledu na velikost písmen.
  const jadro = t
    .replace(/^\[AuraAuraGuard-Error\]\s*/, '')
    .replace(/^(Běhová chyba|Neošetřená výjimka|Detekována chyba v konzoli):\s*/, '')
    .replace(/^Uncaught\s+/, '')
    .split(/\nStack:/)[0]
    .replace(/https?:\/\/\S+/g, '')
    .replace(/["\s]+/g, ' ')
    .trim()
    .toLowerCase();

  // Krátký zbytek není spolehlivý klíč — radši dva řádky než slepené
  // dva různé nálezy.
  return jadro.length >= 20 ? `vyjimka:${jadro.slice(0, 200)}` : null;
}
