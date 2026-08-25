/**
 * Posouzení obsahu Content-Security-Policy, ne jen její přítomnosti.
 *
 * PROČ TO NESTAČÍ ODŠKRTNOUT
 * `Content-Security-Policy: default-src *` je platná hlavička, kterou by
 * kontrola na přítomnost prohlásila za splněnou — a přitom nezakazuje nic.
 * Report by pak tvrdil ochranu, která neexistuje.
 *
 * Modul je čistá funkce nad textem hlavičky: žádná síť, žádný prohlížeč.
 *
 * ČTYŘI VĚCI, KTERÉ TENHLE MODUL MUSÍ UMĚT, JINAK VYRÁBÍ FALEŠNÉ NÁLEZY
 *
 * 1. `'strict-dynamic'`. Doporučený tvar přísné politiky vypadá takto:
 *      script-src 'nonce-…' 'strict-dynamic' https: http:
 *    `https:` a `http:` tam jsou JEN jako fallback pro staré prohlížeče —
 *    ty, které rozumí CSP3, je při `'strict-dynamic'` ignorují. Hlásit tu
 *    politiku jako díru znamená potrestat nejlépe zabezpečeného zákazníka.
 *
 * 2. `'unsafe-inline'` vedle nonce nebo hashe. Prohlížeč od CSP2 tuhle
 *    hodnotu ignoruje; je to běžný zápis pro zpětnou kompatibilitu.
 *
 * 3. VÍC POLITIK V JEDNÉ HLAVIČCE. Když web pošle dvě hlavičky CSP, HTTP je
 *    slučuje čárkou. Prohlížeč pak vynucuje PRŮNIK: zdroj musí projít všemi
 *    politikami. Politika `script-src 'self'` vedle `default-src *` je proto
 *    přísná, ne děravá — a naopak `base-uri` stačí mít v kterékoli z nich.
 *
 * 4. Klíčová slova jsou podle specifikace case-insensitive. `'UNSAFE-INLINE'`
 *    prohlížeč respektuje, takže ho musíme poznat taky.
 */

/**
 * Řetěz dědění direktiv.
 *
 * Není to jeden krok na `default-src`: `script-src-elem` se ptá nejdřív
 * `script-src` a teprve pak `default-src`. Přeskočit prostřední článek
 * znamená posuzovat jinou politiku, než jakou vynucuje prohlížeč.
 *
 * `base-uri` a `frame-ancestors` v seznamu schválně nejsou — ty se
 * nedědí vůbec.
 */
const FALLBACK_CHAIN = {
  'script-src': ['script-src', 'default-src'],
  'script-src-elem': ['script-src-elem', 'script-src', 'default-src'],
  'script-src-attr': ['script-src-attr', 'script-src', 'default-src'],
  'object-src': ['object-src', 'default-src'],
  'style-src': ['style-src', 'default-src'],
  'img-src': ['img-src', 'default-src'],
  'connect-src': ['connect-src', 'default-src'],
};

/**
 * Rozdělí hlavičku na jednotlivé politiky.
 *
 * HTTP slučuje opakované hlavičky téhož jména čárkou a Playwright to dělá
 * taky. Bez tohohle kroku by se z dvou politik stala jedna nesmyslná směs
 * a parser by vyrobil nálezy v obou směrech naráz.
 *
 * Čárka se ve zdrojových výrazech CSP vyskytovat nemůže, takže dělení je
 * jednoznačné.
 */
export function splitPolicies(header) {
  return String(header || '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
}

/**
 * Rozebere JEDNU politiku na direktivy.
 *
 * @returns {Map<string, string[]>} název direktivy → seznam zdrojů
 */
export function parsePolicy(policy) {
  const directives = new Map();
  for (const part of String(policy || '').split(';')) {
    const tokens = part.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;
    const name = tokens[0].toLowerCase();
    // Opakovaná direktiva: prohlížeč použije PRVNÍ výskyt a další ignoruje.
    // Kdybychom brali poslední, posuzovali bychom něco jiného, než co platí.
    if (!directives.has(name)) directives.set(name, tokens.slice(1));
  }
  return directives;
}

/** Hodnoty direktivy v jedné politice, včetně dědění. */
function effective(directives, name) {
  for (const candidate of FALLBACK_CHAIN[name] || [name]) {
    if (directives.has(candidate)) return directives.get(candidate);
  }
  return null;
}

/**
 * Klíčová slova se porovnávají bez ohledu na velikost písmen.
 *
 * Hodnota nonce a hashe je case-sensitive, ale ta se neporovnává na shodu —
 * jen se zjišťuje, že tam je.
 */
const hasKeyword = (values, keyword) =>
  values.some((v) => v.toLowerCase() === keyword);

const hasNonceOrHash = (values) =>
  values.some((v) => /^'nonce-/i.test(v) || /^'sha(256|384|512)-/i.test(v));

/**
 * Zdroj, který znamená „odkudkoli".
 *
 * Kromě holé hvězdičky a schémat sem patří i `https://*` a spol. — je to
 * totéž zapsané jinak a modul, který by to nepoznal, by přísnější zápis
 * odměnil zelenou.
 */
function isWildcard(value) {
  const v = String(value).toLowerCase();
  if (v === '*' || v === 'https:' || v === 'http:' || v === 'data:') return true;
  // https://*, http://*, *://*, https://*:*
  // Schéma smí být i hvězdička, proto `\*` ve skupině pro schéma.
  return /^(?:(?:\*|[a-z][a-z0-9+.-]*):)?\/\/\*(?::\*)?$/.test(v);
}

const finding = (severity, id, message) => ({ severity, id, message });

/**
 * Posoudí jednu politiku z hlediska skriptů.
 *
 * Vrací, co ta politika o skriptech dovoluje — aby se výsledky napříč
 * politikami daly protnout.
 */
function scriptPosture(directives, directiveName) {
  const values = effective(directives, directiveName);

  // Politika, která o skriptech nic neříká, je pro ně bez omezení.
  if (!values) return { restricts: false, wildcard: true, inlineAllowed: true };

  const strictDynamic = hasKeyword(values, "'strict-dynamic'");
  const nonceOrHash = hasNonceOrHash(values);

  // Při `'strict-dynamic'` prohlížeč ignoruje host-source i scheme-source.
  // Hvězdička v takové politice není díra, ale mrtvá hodnota pro staré
  // prohlížeče.
  const wildcard = strictDynamic ? false : values.some(isWildcard);

  // `'unsafe-inline'` je účinné jen bez nonce a hashe. Se `'strict-dynamic'`
  // ho prohlížeče CSP3 rovněž ignorují.
  const inlineAllowed =
    hasKeyword(values, "'unsafe-inline'") && !nonceOrHash && !strictDynamic;

  return {
    restricts: true,
    wildcard,
    inlineAllowed,
    unsafeEval: hasKeyword(values, "'unsafe-eval'"),
    inlineWithNonce: hasKeyword(values, "'unsafe-inline'") && (nonceOrHash || strictDynamic),
    strictDynamic,
  };
}

/**
 * Posoudí politiku (nebo více politik v jedné hlavičce).
 *
 * @param {string|null|undefined} header hodnota hlavičky
 * @returns {{present: boolean, policies: number, ok: boolean, findings: Array, directives: string[]}}
 */
export function auditCsp(header) {
  if (!header || !String(header).trim()) {
    return {
      present: false,
      policies: 0,
      ok: false,
      findings: [
        finding('high', 'csp.missing', 'Hlavička Content-Security-Policy chybí úplně.'),
      ],
      directives: [],
    };
  }

  const parsed = splitPolicies(header).map(parsePolicy);
  const findings = [];
  const allDirectives = new Set();
  for (const p of parsed) for (const name of p.keys()) allDirectives.add(name);

  if (allDirectives.size === 0) {
    return {
      present: true,
      policies: parsed.length,
      ok: false,
      findings: [
        finding(
          'high',
          'csp.empty',
          'Hlavička je poslaná, ale neobsahuje žádnou platnou direktivu — nezakazuje nic.'
        ),
      ],
      directives: [],
    };
  }

  // ── Skripty ────────────────────────────────────────────────────────────
  //
  // Posuzují se dvě cesty zvlášť: `script-src-elem` přebíjí `script-src`
  // pro <script> prvky, `script-src-attr` pro inline obsluhy událostí.
  // Politika s přísným `script-src` a děravým `script-src-elem` je děravá.
  // Základ je `script-src`. Zvláštní kontexty se posuzují navíc, a to jen
  // když je politika výslovně uvádí — jinak by se tentýž nález vypsal
  // třikrát pod různými názvy.
  const CONTEXTS = [['script-src', 'skripty']];
  for (const [name, label] of [
    ['script-src-elem', 'prvky <script>'],
    ['script-src-attr', 'inline obsluhy událostí'],
  ]) {
    if (allDirectives.has(name)) CONTEXTS.push([name, label]);
  }

  for (const [directiveName, label] of CONTEXTS) {
    const postures = parsed.map((p) => scriptPosture(p, directiveName));

    // Žádná politika skripty neomezuje.
    if (postures.every((s) => !s.restricts)) {
      findings.push(
        finding(
          'high',
          'csp.script-src.missing',
          `Politika neurčuje, odkud se smí načítat skripty (${label}) — ` +
            'chybí script-src i default-src. O nejčastějším způsobu útoku ' +
            'pak neříká nic.'
        )
      );
      continue;
    }

    // Díra je dírou jen tehdy, když ji dovolí VŠECHNY politiky. Stačí
    // jediná přísná a prohlížeč zdroj zablokuje.
    if (postures.every((s) => s.wildcard)) {
      findings.push(
        finding(
          'high',
          'csp.script-src.wildcard',
          `Skript pro ${label} smí přijít odkudkoli — politika tím pozbývá smysl.`
        )
      );
    }

    if (postures.every((s) => s.inlineAllowed)) {
      findings.push(
        finding(
          'high',
          'csp.script-src.unsafe-inline',
          `Pro ${label} je povolen 'unsafe-inline' bez nonce, hashe či ` +
            "'strict-dynamic' — vložený skript projde, což je hlavní vektor XSS."
        )
      );
    } else if (postures.some((s) => s.inlineWithNonce)) {
      findings.push(
        finding(
          'low',
          'csp.script-src.unsafe-inline-ignored',
          `Pro ${label} je uveden 'unsafe-inline', ale zároveň nonce, hash nebo ` +
            "'strict-dynamic' — prohlížeče podle CSP Level 2 a výš tuhle hodnotu " +
            'ignorují. Není to díra, jen zápis pro starší prohlížeče.'
        )
      );
    }

    if (postures.every((s) => s.unsafeEval)) {
      findings.push(
        finding(
          'medium',
          'csp.script-src.unsafe-eval',
          `Pro ${label} je povolen 'unsafe-eval' — kód se smí vyhodnocovat z řetězce.`
        )
      );
    }
  }

  // ── Direktivy, které se z default-src NEDĚDÍ ──────────────────────────
  //
  // Častý omyl: „mám default-src, takže je pokryto všechno." U base-uri
  // a frame-ancestors to neplatí. Stačí, aby direktivu měla KTERÁKOLI
  // z politik — vynucují se všechny.
  if (!allDirectives.has('base-uri')) {
    findings.push(
      finding(
        'medium',
        'csp.base-uri.missing',
        'Chybí base-uri. Vložený prvek <base> pak umí přesměrovat relativní ' +
          'adresy skriptů jinam; default-src to nepokrývá.'
      )
    );
  }

  if (!allDirectives.has('frame-ancestors')) {
    findings.push(
      finding(
        'medium',
        'csp.frame-ancestors.missing',
        'Chybí frame-ancestors. Ochranu proti vložení do rámu může zajišťovat ' +
          'X-Frame-Options, ale ta se posuzuje samostatně; default-src to nepokrývá.'
      )
    );
  }

  if (!parsed.some((p) => effective(p, 'object-src'))) {
    findings.push(
      finding(
        'low',
        'csp.object-src.missing',
        "Chybí object-src i default-src. Doporučená hodnota je 'none' — " +
          'zásuvné moduly jsou dnes zbytečné a historicky rizikové.'
      )
    );
  }

  if (!allDirectives.has('report-uri') && !allDirectives.has('report-to')) {
    findings.push(
      finding(
        'low',
        'csp.reporting.missing',
        'Politika nikam nehlásí svá porušení (report-uri ani report-to). ' +
          'Pokusy o obcházení tak zůstanou neviditelné.'
      )
    );
  }

  // Stejný nález ze dvou kontextů je jeden problém, ne dva. Ponechává se
  // ten závažnější — u shodné závažnosti první.
  const RANK = { high: 3, medium: 2, low: 1 };
  const byId = new Map();
  for (const f of findings) {
    const existing = byId.get(f.id);
    if (!existing || RANK[f.severity] > RANK[existing.severity]) byId.set(f.id, f);
  }
  const deduped = [...byId.values()];

  return {
    present: true,
    policies: parsed.length,
    // Za splněné se považuje politika bez závažného nálezu. Střední a nízké
    // se vypisují, ale verdikt neshazují — jinak by „splněno" nedosáhl nikdo
    // a hodnocení by ztratilo rozlišovací schopnost.
    ok: !deduped.some((f) => f.severity === 'high'),
    findings: deduped,
    directives: [...allDirectives],
  };
}
