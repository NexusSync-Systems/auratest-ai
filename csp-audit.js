/**
 * Posouzení obsahu Content-Security-Policy, ne jen její přítomnosti.
 *
 * PROČ TO NESTAČÍ ODŠKRTNOUT
 * `Content-Security-Policy: default-src *` je platná hlavička, kterou by
 * kontrola na přítomnost prohlásila za splněnou — a přitom nezakazuje nic.
 * Report by pak tvrdil ochranu, která neexistuje.
 *
 * Modul je čistá funkce nad textem hlavičky: žádná síť, žádný prohlížeč.
 * Klasifikace tak jde testovat proti skutečným politikám bez spouštění
 * Chromia.
 *
 * CO SE ZÁMĚRNĚ NEHLÁSÍ JAKO CHYBA
 * `'unsafe-inline'` prohlížeč IGNORUJE, pokud je v téže direktivě nonce
 * nebo hash (CSP Level 2 a výš). Politika s nonce a `'unsafe-inline'` je
 * běžný a správný zápis pro zpětnou kompatibilitu se starými prohlížeči.
 * Označit ji za díru by byl falešný nález — a falešný nález v compliance
 * reportu stojí zákazníka čas i důvěru.
 */

/** Direktivy, které se při své nepřítomnosti řídí `default-src`. */
const FALLS_BACK_TO_DEFAULT = new Set(['script-src', 'object-src', 'style-src', 'img-src', 'connect-src']);

/**
 * Rozebere hlavičku na direktivy.
 *
 * @param {string} header
 * @returns {Map<string, string[]>} název direktivy → seznam zdrojů
 */
export function parsePolicy(header) {
  const directives = new Map();
  for (const part of String(header || '').split(';')) {
    const tokens = part.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;
    const name = tokens[0].toLowerCase();
    // Opakovaná direktiva: prohlížeč použije PRVNÍ výskyt a další ignoruje.
    // Kdybychom brali poslední, posuzovali bychom něco jiného, než co platí.
    if (!directives.has(name)) directives.set(name, tokens.slice(1));
  }
  return directives;
}

/** Hodnoty direktivy včetně převzetí z `default-src`, pokud tam patří. */
function effective(directives, name) {
  if (directives.has(name)) return { values: directives.get(name), inherited: false };
  if (FALLS_BACK_TO_DEFAULT.has(name) && directives.has('default-src')) {
    return { values: directives.get('default-src'), inherited: true };
  }
  return { values: null, inherited: false };
}

const hasNonceOrHash = (values) =>
  values.some((v) => /^'nonce-/i.test(v) || /^'sha(256|384|512)-/i.test(v));

const isWildcard = (v) => v === '*' || v === 'https:' || v === 'http:' || v === 'data:';

const finding = (severity, id, message) => ({ severity, id, message });

/**
 * Posoudí politiku.
 *
 * @param {string|null|undefined} header hodnota hlavičky
 * @returns {{present: boolean, ok: boolean, findings: Array, directives: string[]}}
 */
export function auditCsp(header) {
  if (!header || !String(header).trim()) {
    return {
      present: false,
      ok: false,
      findings: [
        finding('high', 'csp.missing', 'Hlavička Content-Security-Policy chybí úplně.'),
      ],
      directives: [],
    };
  }

  const directives = parsePolicy(header);
  const findings = [];

  // ── Skripty ────────────────────────────────────────────────────────────
  const script = effective(directives, 'script-src');
  if (!script.values) {
    findings.push(
      finding(
        'high',
        'csp.script-src.missing',
        'Politika neurčuje, odkud se smí načítat skripty (chybí script-src i default-src). ' +
          'O nejčastějším způsobu útoku pak neříká nic.'
      )
    );
  } else {
    const wildcards = script.values.filter(isWildcard);
    if (wildcards.length > 0) {
      findings.push(
        finding(
          'high',
          'csp.script-src.wildcard',
          `script-src povoluje ${wildcards.join(', ')} — skript smí přijít odkudkoli. ` +
            'Politika tím pozbývá smysl.'
        )
      );
    }

    if (script.values.includes("'unsafe-eval'")) {
      findings.push(
        finding(
          'medium',
          'csp.script-src.unsafe-eval',
          "script-src povoluje 'unsafe-eval' — kód se smí vyhodnocovat z řetězce."
        )
      );
    }

    if (script.values.includes("'unsafe-inline'")) {
      // Nonce nebo hash `'unsafe-inline'` v prohlížeči přebíjí. Hlásit to
      // jako díru by byl falešný nález.
      if (hasNonceOrHash(script.values)) {
        findings.push(
          finding(
            'low',
            'csp.script-src.unsafe-inline-ignored',
            "script-src obsahuje 'unsafe-inline', ale zároveň nonce nebo hash — " +
              'prohlížeče podle CSP Level 2 a výš tuhle hodnotu ignorují. ' +
              'Není to díra, jen zápis pro starší prohlížeče.'
          )
        );
      } else {
        findings.push(
          finding(
            'high',
            'csp.script-src.unsafe-inline',
            "script-src povoluje 'unsafe-inline' bez nonce či hashe — vložený " +
              'skript projde, což je hlavní vektor XSS.'
          )
        );
      }
    }
  }

  // ── Direktivy, které se z default-src NEDĚDÍ ──────────────────────────
  //
  // Tohle je častý omyl: „mám default-src, takže je pokryto všechno."
  // U base-uri a frame-ancestors to neplatí.
  if (!directives.has('base-uri')) {
    findings.push(
      finding(
        'medium',
        'csp.base-uri.missing',
        'Chybí base-uri. Vložený prvek <base> pak umí přesměrovat relativní ' +
          'adresy skriptů jinam; default-src to nepokrývá.'
      )
    );
  }

  if (!directives.has('frame-ancestors')) {
    findings.push(
      finding(
        'medium',
        'csp.frame-ancestors.missing',
        'Chybí frame-ancestors. Ochranu proti vložení do rámu může zajišťovat ' +
          'X-Frame-Options, ale ta se posuzuje samostatně; default-src to nepokrývá.'
      )
    );
  }

  const object = effective(directives, 'object-src');
  if (!object.values) {
    findings.push(
      finding(
        'low',
        'csp.object-src.missing',
        "Chybí object-src i default-src. Doporučená hodnota je 'none' — " +
          'zásuvné moduly jsou dnes zbytečné a historicky rizikové.'
      )
    );
  }

  // Ohlašování porušení není povinnost, ale bez něj se o pokusech nikdo
  // nedozví. Hlásí se jako poznámka, ne jako nedostatek.
  if (!directives.has('report-uri') && !directives.has('report-to')) {
    findings.push(
      finding(
        'low',
        'csp.reporting.missing',
        'Politika nikam nehlásí svá porušení (report-uri ani report-to). ' +
          'Pokusy o obcházení tak zůstanou neviditelné.'
      )
    );
  }

  return {
    present: true,
    // Za splněné se považuje politika bez závažného nálezu. Střední a nízké
    // se vypisují, ale verdikt neshazují — jinak by „splněno" nedosáhl nikdo
    // a hodnocení by ztratilo rozlišovací schopnost.
    ok: !findings.some((f) => f.severity === 'high'),
    findings,
    directives: [...directives.keys()],
  };
}
