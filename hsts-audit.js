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
    return { present: false, maxAge: null, includeSubDomains: false, preload: false, valid: false };
  }

  // Víc hlaviček téhož jména Node slučuje čárkou. RFC 6797 § 8.1 říká, že
  // prohlížeč zpracuje POUZE PRVNÍ z nich a ostatní ignoruje.
  //
  // Dřív se to neřešilo vůbec a `parseInt` to zamaskoval: u
  // `max-age=31536000, max-age=1` utnul zbytek a náhodou vyšlo správně.
  // Jakmile ale za čárkou stálo něco jiného, rozešlo se to s prohlížečem —
  // `max-age=31536000; includeSubDomains, max-age=1` dalo
  // `includeSubDomains: false` a nález na webu, který subdomény kryje.
  const prvni = header.split(',')[0];

  // Direktivy odděluje středník, velikost písmen nerozhoduje.
  const parts = prvni.split(';').map((p) => p.trim());

  let maxAge = null;
  let maxAgeSeen = false;
  let includeSubDomains = false;
  let preload = false;
  let valid = true;

  for (const part of parts) {
    if (part === '') continue;
    const eq = part.indexOf('=');
    const name = (eq === -1 ? part : part.slice(0, eq)).trim().toLowerCase();
    const rawValue = eq === -1 ? null : part.slice(eq + 1).trim();

    if (name === 'max-age') {
      // Duplicitní direktiva je podle § 6.1 vadná hlavička, ne pozvánka
      // hádat, kterou autor myslel. Dřív „vyhrával první platný výskyt",
      // takže `max-age2=1; max-age=31536000` vzalo jedničku a hlásilo
      // krátkou platnost na webu s ročním nastavením.
      if (maxAgeSeen) { valid = false; continue; }
      maxAgeSeen = true;

      // Hodnota smí být v uvozovkách: max-age="31536000".
      const value = rawValue === null ? '' : rawValue.replace(/^"(.*)"$/, '$1');

      // ABNF § 6.1.1: max-age-value = delta-seconds = 1*DIGIT.
      //
      // Tady byl `parseInt`, který zbytek mlčky utne — `max-age=31536000s`
      // z něj vyleze jako rok. Prohlížeč takovou hlavičku podle § 6.1
      // ZAHODÍ CELOU, takže web ve skutečnosti HSTS nemá. Nástroj u něj
      // hlásil „bez nálezu", tedy doklad o ochraně, která neexistuje —
      // a to u běžného konfiguračního překlepu.
      if (!/^\d+$/.test(value)) { valid = false; continue; }

      const parsed = Number.parseInt(value, 10);
      // Hodnota nad rámec bezpečného rozsahu čísel: prohlížeč ji taky
      // nepřijme a my bychom počítali s číslem, které v hlavičce nestojí.
      if (!Number.isSafeInteger(parsed)) { valid = false; continue; }
      maxAge = parsed;
    } else if (name === 'includesubdomains') {
      includeSubDomains = true;
    } else if (name === 'preload') {
      preload = true;
    }
    // Neznámé direktivy prohlížeč ignoruje (§ 6.1), takže my taky.
  }

  // Bez `max-age` hlavička neplatí — direktiva je povinná.
  if (!maxAgeSeen) valid = false;

  return { present: true, maxAge, includeSubDomains, preload, valid };
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

  if (!parsed.valid) {
    // Hlavička, kterou prohlížeč zahodí, chrání stejně jako žádná.
    //
    // Nález se schválně jmenuje jinak než „chybí": provozovatel ji nastavil
    // a v odpovědi ji vidí, takže by u hlášení „chybí hlavička" hledal
    // marně. Vada je v jejím obsahu.
    findings.push({
      severity: 'high',
      key: 'hsts.invalid',
      message:
        'Hlavička neobsahuje platnou direktivu max-age podle RFC 6797 ' +
        '(povolené jsou jen číslice, direktivy odděluje středník a max-age ' +
        'smí být uvedena jen jednou). Prohlížeče takovou hlavičku zahazují ' +
        'celou, takže web je na tom stejně, jako by ji vůbec neposílal.',
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
    // Upozornění, ne nález.
    //
    // Bývalo to `medium`, což shazovalo verdikt na „prokazatelně
    // nesplněno". Jenže délku `max-age` nestanoví žádný předpis a
    // doporučený postup nasazení HSTS je náběh od krátkých hodnot
    // (300 → 86400 → rok). Web uprostřed správně prováděného náběhu tak
    // dostával doklad o porušení.
    //
    // Navíc to byl útes o jedné vteřině: 86399 s bylo porušení, 86400 s
    // v pořádku. Rozdíl v měřené skutečnosti nulový, rozdíl v tvrzení
    // maximální. Odstupňování „pod rok = low" zůstává, protože nesráží
    // verdikt a jen upozorňuje.
    findings.push({
      severity: 'low',
      key: 'hsts.max-age-short',
      message:
        `max-age je ${parsed.maxAge} s (necelý den). Ochrana vyprší dřív, ` +
        'než se uživatel vrátí, takže je spíš symbolická. Není to porušení ' +
        'předpisu — krátká hodnota je běžná při postupném nasazování HSTS.',
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
