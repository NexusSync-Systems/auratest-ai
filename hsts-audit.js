/**
 * Obsah hlavičky Strict-Transport-Security, ne jen její přítomnost.
 *
 * PROČ TO NESTAČÍ HLÍDAT JAKO ANO/NE
 * `max-age=1` je platná hlavička. Prohlížeč si po ní pamatuje „jen přes
 * HTTPS" celou jednu sekundu — tedy prakticky nic. Dokud se posuzovala jen
 * přítomnost, dostal takový web stejný verdikt jako web s ročním max-age
 * a preloadem.
 *
 * CO SE MĚŘÍ
 * Délka `max-age`, zahrnutí subdomén a příznak `preload`. Všechno se čte
 * z hlavičky; žádné síťové volání není potřeba, takže je to čistá funkce.
 *
 * ČEHO SE MODUL DRŽÍ DÁL OD
 * Neposuzuje, jestli je HSTS pro daný web vhodné. U webu, který část obsahu
 * vydává po HTTP schválně (starý intranet, přechodné období), může být
 * krátké max-age vědomá volba. Nález proto zní „krátká platnost", ne
 * „špatně nastaveno".
 */

/**
 * Doporučená minimální platnost.
 *
 * Rok je hodnota, kterou vyžaduje seznam hstspreload.org a kterou uvádí
 * i OWASP. Kratší hodnota chrání jen do nejbližšího vypršení.
 */
export const RECOMMENDED_MAX_AGE = 31536000; // 365 dní

/** Pod touhle hranicí je ochrana spíš symbolická. */
export const WEAK_MAX_AGE = 86400; // 1 den

/**
 * Rozebere hlavičku.
 *
 * @param {string|null|undefined} header
 * @returns {{present: boolean, maxAge: number|null, includeSubDomains: boolean, preload: boolean}}
 */
export function parseHsts(header) {
  if (!header || typeof header !== 'string') {
    return { present: false, maxAge: null, includeSubDomains: false, preload: false };
  }

  // Direktivy odděluje středník, velikost písmen nerozhoduje (RFC 6797).
  const parts = header
    .split(';')
    .map((p) => p.trim())
    .filter(Boolean);

  let maxAge = null;
  let includeSubDomains = false;
  let preload = false;

  for (const part of parts) {
    const lower = part.toLowerCase();
    if (lower.startsWith('max-age')) {
      // Hodnota smí být v uvozovkách: max-age="31536000".
      const value = part.slice(part.indexOf('=') + 1).trim().replace(/^"|"$/g, '');
      const parsed = Number.parseInt(value, 10);
      // První výskyt vyhrává — stejně jako u CSP. Duplicitní direktiva je
      // vada hlavičky, ne důvod hádat, kterou myslel autor.
      if (maxAge === null && Number.isFinite(parsed) && parsed >= 0) maxAge = parsed;
    } else if (lower === 'includesubdomains') {
      includeSubDomains = true;
    } else if (lower === 'preload') {
      preload = true;
    }
  }

  return { present: true, maxAge, includeSubDomains, preload };
}

/**
 * Posoudí hlavičku.
 *
 * @param {string|null|undefined} header
 * @param {object} [options]
 * @param {boolean} [options.https] běží web po HTTPS?
 * @returns {{ok: boolean|null, findings: Array, rationale: string, parsed: object}}
 */
export function auditHsts(header, { https = true } = {}) {
  const parsed = parseHsts(header);

  if (!https) {
    // Na nešifrovaném spojení prohlížeč HSTS ignoruje. Absence hlavičky
    // tam není volba provozovatele, ale důsledek protokolu.
    return {
      ok: null,
      findings: [],
      parsed,
      rationale:
        'Web neběží po HTTPS, takže hlavička Strict-Transport-Security nemá ' +
        'co vynucovat — prohlížeč ji na nešifrovaném spojení ignoruje.',
    };
  }

  if (!parsed.present) {
    return {
      ok: false,
      findings: [
        {
          severity: 'high',
          key: 'hsts.missing',
          message:
            'Chybí hlavička Strict-Transport-Security. První požadavek na ' +
            'http:// tak jde nešifrovaně a dá se přesměrovat.',
        },
      ],
      parsed,
      rationale: 'Hlavička není přítomná.',
    };
  }

  const findings = [];

  if (parsed.maxAge === null) {
    // Hlavička bez `max-age` je podle RFC 6797 neplatná a prohlížeče ji
    // zahazují celou. Je to horší než krátká platnost.
    findings.push({
      severity: 'high',
      key: 'hsts.no-max-age',
      message:
        'Hlavička neobsahuje platnou direktivu max-age. Prohlížeče takovou ' +
        'hlavičku zahazují celou, takže nechrání vůbec.',
    });
  } else if (parsed.maxAge === 0) {
    // max-age=0 je platný způsob, jak HSTS ZRUŠIT.
    findings.push({
      severity: 'high',
      key: 'hsts.disabled',
      message:
        'max-age=0 znamená pokyn prohlížeči, aby si HSTS pro tenhle web ' +
        'zapomněl. Ochrana je tím vypnutá.',
    });
  } else if (parsed.maxAge < WEAK_MAX_AGE) {
    findings.push({
      severity: 'medium',
      key: 'hsts.max-age-short',
      message:
        `max-age je ${parsed.maxAge} s (necelý den). Ochrana vyprší dřív, ` +
        'než se uživatel vrátí, takže je spíš symbolická.',
    });
  } else if (parsed.maxAge < RECOMMENDED_MAX_AGE) {
    findings.push({
      severity: 'low',
      key: 'hsts.max-age-below-year',
      message:
        `max-age je ${parsed.maxAge} s, tedy méně než doporučovaný rok ` +
        `(${RECOMMENDED_MAX_AGE} s). Kratší hodnota chrání jen do vypršení.`,
    });
  }

  if (!parsed.includeSubDomains) {
    // Nízká závažnost schválně: u webu bez subdomén to nic neřeší a
    // zapnout to bez rozmyslu může subdomény odříznout.
    findings.push({
      severity: 'low',
      key: 'hsts.no-subdomains',
      message:
        'Chybí includeSubDomains, takže se ochrana nevztahuje na subdomény. ' +
        'Zapínat to má smysl jen tehdy, když všechny subdomény umí HTTPS.',
    });
  }

  const high = findings.filter((f) => f.severity === 'high').length;
  const medium = findings.filter((f) => f.severity === 'medium').length;

  return {
    // Za splněné se považuje hlavička bez závažného a středního nálezu.
    // Chybějící includeSubDomains samo o sobě verdikt neshazuje.
    ok: high === 0 && medium === 0,
    findings,
    parsed,
    rationale:
      high + medium > 0
        ? `Hlavička je přítomná, ale ${findings[0].message}`
        : `Platnost ${parsed.maxAge} s` +
          (parsed.includeSubDomains ? ', včetně subdomén' : '') +
          (parsed.preload ? ', s příznakem preload' : '') +
          '. Posuzuje se text hlavičky, ne to, jestli si ji prohlížeč ' +
          'skutečně zapamatoval.',
  };
}
