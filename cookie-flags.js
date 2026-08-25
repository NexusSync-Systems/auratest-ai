/**
 * Příznaky cookies: Secure, HttpOnly, SameSite.
 *
 * PROČ TO PATŘÍ K NIS2, NE JEN KE GDPR
 * Cookie bez `Secure` cestuje po nešifrovaném spojení, bez `HttpOnly` si ji
 * přečte jakýkoli skript na stránce a bez `SameSite` odejde i s požadavkem
 * z cizího webu. U přihlašovací cookie je každá z těch tří vlastností cesta
 * k převzetí účtu — tedy aplikační bezpečnost podle § 14 odst. 2.
 *
 * Data už sbírá GDPR audit přes `context.cookies()`; dosud se z nich četlo
 * jen jméno kvůli rozpoznání trackerů. Tenhle modul je vyhodnocuje.
 *
 * Čistá funkce nad polem cookies — testuje se bez prohlížeče.
 */

/**
 * Cookies, u kterých chybějící příznak váží nejvíc.
 *
 * Rozlišení je záměrné: chybějící `HttpOnly` u analytické cookie je
 * poznámka, u relační cookie je to cesta k převzetí účtu. Házet je do
 * jednoho pytle by buď nafouklo počet vad, nebo zamlčelo tu podstatnou.
 */
const SESSION_NAME_PATTERNS = [
  /sess/i,
  /^sid$/i,
  /token/i,
  /auth/i,
  /login/i,
  /jwt/i,
  /^csrf/i,
  /xsrf/i,
  /remember/i,
  /^phpsessid$/i,
  /^jsessionid$/i,
  /^connect\.sid$/i,
  /^asp\.net_sessionid$/i,
];

/** Vypadá tahle cookie na relační nebo autentizační? */
export function looksLikeSessionCookie(name) {
  return SESSION_NAME_PATTERNS.some((pattern) => pattern.test(String(name || '')));
}

const finding = (severity, id, cookie, message) => ({
  severity,
  id,
  cookie: cookie.name,
  domain: cookie.domain,
  message,
});

/**
 * Je cookie z domény auditovaného webu, nebo od třetí strany?
 *
 * Cookie vloženého přehrávače nebo widgetu nastavuje někdo jiný a
 * provozovatel s jejími příznaky nic nenadělá. Hlásit mu ji jako vadu
 * jeho aplikace je nález, který nemá jak opravit.
 */
export function isFirstParty(cookieDomain, siteHost) {
  if (!siteHost) return true; // Neznáme cíl → neodhadujeme, bereme jako vlastní.
  const cookie = String(cookieDomain || '').replace(/^\./, '').toLowerCase();
  const site = String(siteHost).toLowerCase();
  if (!cookie) return true;
  return site === cookie || site.endsWith(`.${cookie}`) || cookie.endsWith(`.${site}`);
}

/**
 * @param {Array} cookies z `context.cookies()` Playwrightu
 * @param {object} [options]
 * @param {boolean} [options.https] běží web po HTTPS?
 * @param {string} [options.host] hostitel auditovaného webu
 * @returns {{ok: boolean|null, total: number, findings: Array, rationale: string}}
 */
export function auditCookieFlags(cookies, { https = true, host = null } = {}) {
  const list = Array.isArray(cookies) ? cookies : [];

  if (list.length === 0) {
    // Žádná cookie není nález ani nedostatek. Vydávat „nic jsme nenašli" za
    // „vše v pořádku" je přesně to zaměňování, kterému se nástroj vyhýbá.
    return {
      ok: null,
      total: 0,
      findings: [],
      rationale:
        'Při načtení stránky nebyla nastavena žádná cookie, takže není co ' +
        'posoudit. Neznamená to, že aplikace cookies nepoužívá — mohou ' +
        'vzniknout až po přihlášení.',
    };
  }

  const findings = [];
  let thirdParty = 0;

  for (const cookie of list) {
    // Vadný záznam nesmí shodit celý audit — cookie bez jména je nanejvýš
    // nezajímavá, ne důvod přijít o výsledek.
    if (!cookie || typeof cookie !== 'object') continue;

    // Cookies třetích stran se ZAPOČÍTAJÍ, ale nehodnotí: provozovatel
    // auditovaného webu je nenastavuje a nemůže je opravit.
    if (!isFirstParty(cookie.domain, host)) {
      thirdParty += 1;
      continue;
    }

    const sensitive = looksLikeSessionCookie(cookie.name);

    // Secure má smysl posuzovat jen u HTTPS. Na http:// prohlížeč cookie
    // s tímhle příznakem vůbec nepřijme, takže její absence není volba
    // provozovatele, ale důsledek protokolu.
    if (https && !cookie.secure) {
      findings.push(
        finding(
          sensitive ? 'high' : 'medium',
          'cookie.secure.missing',
          cookie,
          sensitive
            ? 'Relační cookie bez příznaku Secure — odejde i po nešifrovaném spojení.'
            : 'Cookie bez příznaku Secure.'
        )
      );
    }

    if (!cookie.httpOnly) {
      findings.push(
        finding(
          sensitive ? 'high' : 'low',
          'cookie.httponly.missing',
          cookie,
          sensitive
            ? 'Relační cookie bez HttpOnly — přečte ji libovolný skript na stránce, ' +
                'takže jediné XSS znamená převzetí účtu.'
            : 'Cookie bez HttpOnly je čitelná ze skriptu. U analytické cookie to ' +
                'bývá záměr, protože ji čte měřicí kód.'
        )
      );
    }

    // Playwright vrací 'Strict' | 'Lax' | 'None' a chybějící atribut mapuje
    // na 'Lax', což odpovídá výchozímu chování Chromia. Rozlišit „výchozí
    // Lax" od „výslovně nastaveného Lax" proto nejde — a ani není potřeba,
    // protože obojí chrání stejně. Posuzuje se jen skutečně slabá hodnota.
    const sameSite = String(cookie.sameSite || '');
    if (sameSite === 'None' && !cookie.secure) {
      findings.push(
        finding(
          'high',
          'cookie.samesite.none-insecure',
          cookie,
          'SameSite=None bez Secure — takovou cookie moderní prohlížeče ' +
            'zahazují, takže funkce, která na ní stojí, tiše přestane fungovat.'
        )
      );
    } else if (sameSite === 'None' && sensitive) {
      findings.push(
        finding(
          'medium',
          'cookie.samesite.none-session',
          cookie,
          'Relační cookie se SameSite=None odejde i s požadavkem z cizího webu ' +
            '(CSRF). Pokud to není záměr kvůli vloženému obsahu, patří sem Lax.'
        )
      );
    }
  }

  const high = findings.filter((f) => f.severity === 'high').length;
  const own = list.length - thirdParty;
  const thirdPartyNote = thirdParty > 0
    ? ` ${thirdParty} cookies nastavila třetí strana (vložený obsah) — ty se ` +
      'neposuzují, protože je provozovatel webu nemá jak změnit.'
    : '';

  if (own === 0) {
    // Všechny cookies přišly od třetích stran. O aplikaci samotné z toho
    // neplyne nic.
    return {
      ok: null,
      total: list.length,
      firstParty: 0,
      thirdParty,
      findings: [],
      rationale:
        `Všech ${list.length} nalezených cookies nastavila třetí strana ` +
        '(vložený obsah). Příznaky vlastních cookies aplikace tak nebylo ' +
        'na čem posoudit.',
    };
  }

  return {
    ok: high === 0,
    total: list.length,
    firstParty: own,
    thirdParty,
    findings,
    rationale:
      (high > 0
        ? `Z ${own} vlastních cookies má ${high} závažný nedostatek v příznacích.`
        : `Zkontrolováno ${own} vlastních cookies, žádný závažný nedostatek v příznacích.`)
      + thirdPartyNote,
  };
}
