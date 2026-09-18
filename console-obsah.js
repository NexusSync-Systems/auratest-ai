/**
 * Má hláška z konzole vůbec nějaký obsah?
 *
 * PROČ TO VZNIKLO
 * Smoke test proti cloudflare.com vracel jako vadu aplikace:
 *
 *   Detekována chyba v konzoli: "%c%d font-size:0;color:transparent NaN"
 *
 * Prohlížeč to hlásí jako `error` — to je ověřené, posluchač jinou úroveň
 * nezapisuje. Jenže co z toho má zákazník? `%c` a `%d` jsou formátovací
 * direktivy, `font-size:0;color:transparent` je styl (a styl, který ten
 * výpis dělá NEVIDITELNÝM), `NaN` je dosazená hodnota. Po odečtení
 * formátování nezbude ani slovo. Nález, se kterým nejde nic udělat,
 * protože neříká nic.
 *
 * CO SE TÍM NETVRDÍ
 * Netvrdíme, že to NENÍ závada — to zvenčí nepoznáme a poznat nemusíme.
 * Tvrdíme slabší a jistou věc: hláška bez obsahu není zjištění o webu.
 * Zůstane vidět mezi okolnostmi běhu, i s původním zněním, takže kdo chce,
 * dohledá si ji.
 *
 * ÚZKÁ PŮSOBNOST — ÚMYSLNĚ
 * Pravidlo se uplatní JEN na hlášku s formátovací direktivou. Chybové
 * hlášky se slovy jimi neprocházejí, takže „%cSELHALO" se slovem SELHALO
 * zůstane nálezem. Kdyby se pravidlo vztáhlo šíř, zamlčelo by skutečné
 * chyby — a to je stejně vážná chyba jako nález na webu, který je
 * v pořádku.
 */

/**
 * Direktivy podle konzolového API (`%c` styl, `%s`, `%d`/`%i`, `%f`, `%o`/`%O`).
 *
 * DVĚ KONSTANTY ÚMYSLNĚ.
 * Regulární výraz s příznakem `g` si mezi voláními pamatuje `lastIndex`,
 * takže `test()` nad ním dává při opakovaném volání střídavé výsledky.
 * Tady to náhodou nevadí (`test` při neshodě `lastIndex` nuluje a
 * `replace` s `/g` ho nuluje taky), ale spoléhat na to znamená mít
 * v kódu past, která se spustí při první úpravě. Hledá se bez `g`,
 * nahrazuje s ním.
 */
const MA_DIREKTIVU = /%[csdifoO]/;
const DIREKTIVY = /%[csdifoO]/g;

/** Deklarace CSS — `color:transparent`, `font-size:0`. */
const CSS_DEKLARACE = /[a-z-]+\s*:\s*[^;\s]+;?/gi;

/** Dosazené hodnoty bez vlastního sdělení. */
const PRAZDNE_HODNOTY = /\b(NaN|undefined|null|true|false|Infinity)\b/g;

/**
 * Zbude po odečtení formátování něco ke čtení?
 *
 * @param {string} text  `msg.text()` z Playwrightu
 * @returns {boolean} `true`, když hláška nenese žádné sdělení
 */
export function jeHlaskaBezObsahu(text) {
  const puvodni = String(text ?? '');

  // Bez direktivy se pravidlo neuplatní vůbec. Obyčejná hláška je nález
  // i tehdy, když je krátká.
  if (!MA_DIREKTIVU.test(puvodni)) return false;

  const zbytek = puvodni
    .replace(DIREKTIVY, ' ')
    .replace(CSS_DEKLARACE, ' ')
    .replace(PRAZDNE_HODNOTY, ' ')
    // Čísla sama o sobě nejsou sdělení.
    .replace(/[-+]?\d+(\.\d+)?/g, ' ')
    .replace(/[\s;:,.()[\]{}'"|/\\-]+/g, '')
    .trim();

  // Zbylo aspoň jedno písmeno? Pak hláška něco říká.
  return !/\p{L}/u.test(zbytek);
}

/** Okolnost běhu. Původní znění se zachovává, ať je co dohledat. */
export function poznamkaBezObsahu(text) {
  const t = String(text ?? '');
  return 'Hláška v konzoli bez čitelného obsahu (jen formátování, '
    + `takže z ní neplyne zjištění o webu): "${t.length > 200 ? `${t.slice(0, 197)}…` : t}"`;
}
