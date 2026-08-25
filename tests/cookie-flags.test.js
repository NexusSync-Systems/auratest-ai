import { auditCookieFlags, looksLikeSessionCookie } from '../cookie-flags.js';

/**
 * Příznaky cookies.
 *
 * Cookie bez `Secure` cestuje po nešifrovaném spojení, bez `HttpOnly` si ji
 * přečte jakýkoli skript a bez `SameSite` odejde i s požadavkem z cizího
 * webu. U přihlašovací cookie je každá z těch tří vlastností cesta
 * k převzetí účtu.
 */

const cookie = (over = {}) => ({
  name: 'volba_jazyka',
  domain: 'klient.cz',
  secure: true,
  httpOnly: true,
  sameSite: 'Lax',
  ...over,
});

const ids = (result) => result.findings.map((f) => f.id);
const high = (result) => result.findings.filter((f) => f.severity === 'high');

describe('rozpoznání relační cookie', () => {
  test('zachytí obvyklá jména', () => {
    for (const name of ['PHPSESSID', 'connect.sid', 'auth_token', 'jwt', 'XSRF-TOKEN']) {
      expect(looksLikeSessionCookie(name)).toBe(true);
    }
  });

  test('běžnou cookie za relační nepovažuje', () => {
    for (const name of ['_ga', 'volba_jazyka', 'theme']) {
      expect(looksLikeSessionCookie(name)).toBe(false);
    }
  });
});

describe('závažnost podle druhu cookie', () => {
  test('relační cookie bez HttpOnly je závažný nález', () => {
    // Jediné XSS pak znamená převzetí účtu.
    const result = auditCookieFlags([cookie({ name: 'PHPSESSID', httpOnly: false })]);
    expect(high(result).map((f) => f.id)).toContain('cookie.httponly.missing');
    expect(result.ok).toBe(false);
  });

  test('analytická cookie bez HttpOnly je jen poznámka', () => {
    // U měřicí cookie je čitelnost ze skriptu záměr, ne vada. Házet obojí
    // do jednoho pytle by nafouklo počet vad.
    const result = auditCookieFlags([cookie({ name: '_ga', httpOnly: false })]);
    expect(high(result)).toEqual([]);
    expect(result.ok).toBe(true);
  });

  test('relační cookie bez Secure je závažný nález', () => {
    const result = auditCookieFlags([cookie({ name: 'session_id', secure: false })]);
    expect(high(result).map((f) => f.id)).toContain('cookie.secure.missing');
  });
});

describe('SameSite', () => {
  test('None bez Secure je závažné — prohlížeč takovou cookie zahodí', () => {
    const result = auditCookieFlags([
      cookie({ name: 'vlozeny_obsah', sameSite: 'None', secure: false }),
    ]);
    expect(high(result).map((f) => f.id)).toContain('cookie.samesite.none-insecure');
  });

  test('None u relační cookie je střední nález kvůli CSRF', () => {
    const result = auditCookieFlags([
      cookie({ name: 'auth_token', sameSite: 'None', secure: true }),
    ]);
    expect(ids(result)).toContain('cookie.samesite.none-session');
    expect(high(result)).toEqual([]);
  });

  test('Lax ani Strict se nehlásí', () => {
    for (const value of ['Lax', 'Strict']) {
      const result = auditCookieFlags([cookie({ sameSite: value })]);
      expect(ids(result)).toEqual([]);
    }
  });
});

describe('kontext protokolu', () => {
  test('na HTTP se chybějící Secure nehlásí', () => {
    // Prohlížeč cookie s tímhle příznakem po nešifrovaném spojení vůbec
    // nepřijme — absence není volba provozovatele, ale důsledek protokolu.
    const result = auditCookieFlags([cookie({ secure: false })], { https: false });
    expect(ids(result)).not.toContain('cookie.secure.missing');
  });

  test('na HTTPS se hlásí', () => {
    const result = auditCookieFlags([cookie({ secure: false })], { https: true });
    expect(ids(result)).toContain('cookie.secure.missing');
  });
});

describe('žádné cookies', () => {
  test('prázdný seznam je NEPRŮKAZNÝ, ne splněný', () => {
    // Vydávat „nic jsme nenašli" za „vše v pořádku" je přesně to
    // zaměňování, kterému se nástroj vyhýbá.
    const result = auditCookieFlags([]);
    expect(result.ok).toBeNull();
    expect(result.findings).toEqual([]);
    expect(result.rationale).toMatch(/není co.*posoudit/i);
  });

  test('odůvodnění zmiňuje, že cookies mohou vzniknout po přihlášení', () => {
    expect(auditCookieFlags([]).rationale).toMatch(/po přihlášení/);
  });

  test('nesmyslný vstup nespadne', () => {
    for (const value of [null, undefined, 'nesmysl']) {
      expect(auditCookieFlags(value).ok).toBeNull();
    }
  });
});

describe('souhrn', () => {
  test('bezvadné cookies projdou', () => {
    const result = auditCookieFlags([cookie(), cookie({ name: 'PHPSESSID' })]);
    expect(result.ok).toBe(true);
    expect(result.total).toBe(2);
    expect(result.findings).toEqual([]);
  });

  test('nález nese jméno i doménu cookie', () => {
    // Bez toho by report řekl „něco je špatně" a nechal hledat co.
    const result = auditCookieFlags([
      cookie({ name: 'session_id', domain: '.klient.cz', httpOnly: false }),
    ]);
    expect(result.findings[0]).toMatchObject({ cookie: 'session_id', domain: '.klient.cz' });
  });
});

describe('cizí cookies (regrese kontrolní vlny)', () => {
  const vlastni = cookie({ name: 'session_id', domain: 'klient.cz' });
  const cizi = cookie({
    name: 'YSC',
    domain: '.youtube.com',
    secure: false,
    httpOnly: false,
  });

  test('cookie třetí strany se nehlásí jako vada auditovaného webu', () => {
    // Provozovatel příznaky vloženého přehrávače nezmění. Nález, který
    // nemá jak opravit, je jen šum snižující důvěru v ostatní zjištění.
    const result = auditCookieFlags([vlastni, cizi], { https: true, host: 'klient.cz' });
    expect(result.findings).toHaveLength(0);
    expect(result.thirdParty).toBe(1);
    expect(result.firstParty).toBe(1);
    expect(result.ok).toBe(true);
  });

  test('jen cizí cookies → neprůkazné, ne v pořádku', () => {
    // O aplikaci samotné z toho neplyne nic, takže ani „splněno".
    const result = auditCookieFlags([cizi], { https: true, host: 'klient.cz' });
    expect(result.ok).toBeNull();
    expect(result.rationale).toMatch(/třetí strana/);
  });

  test('subdoména auditovaného webu je vlastní cookie', () => {
    const naSubdomene = cookie({
      name: 'session_id',
      domain: '.klient.cz',
      httpOnly: false,
    });
    const result = auditCookieFlags([naSubdomene], { https: true, host: 'www.klient.cz' });
    expect(result.firstParty).toBe(1);
    expect(result.findings.some((f) => f.id === 'cookie.httponly.missing')).toBe(true);
  });

  test('bez znalosti hostitele se nic za cizí nepovažuje', () => {
    // Neznáme-li cíl, odhadovat původ by znamenalo tiše zamlčet nálezy.
    const result = auditCookieFlags([cizi], { https: true });
    expect(result.thirdParty).toBe(0);
  });

  test('Secure se na nešifrovaném spojení neposuzuje', () => {
    // Prohlížeč cookie s příznakem Secure po http:// stejně nepřijme,
    // takže jeho absence není volba provozovatele.
    const result = auditCookieFlags([cookie({ secure: false })], {
      https: false,
      host: 'klient.cz',
    });
    expect(result.findings.some((f) => f.id === 'cookie.secure.missing')).toBe(false);
  });

  test('nesmyslný záznam v poli neshodí audit', () => {
    const result = auditCookieFlags([null, vlastni, 'x'], { https: true, host: 'klient.cz' });
    expect(result.ok).not.toBeUndefined();
  });
});
