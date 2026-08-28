import fs from 'fs';
import path from 'path';
import { PROJECT_ROOT } from '../paths.js';

/**
 * Content-Security-Policy v Caddyfile.
 *
 * Motivace: `connect-src 'self'` bez výjimek zamklo přihlášení. Firebase Auth
 * mluví z prohlížeče přímo na Google API, takže se to neprojevilo chybou
 * hesla, ale hláškou `auth/network-request-failed` — ta svádí hledat výpadek
 * sítě, ne vlastní konfiguraci proxy.
 *
 * Ironie, kterou tenhle projekt měl: nástroj cizím webům vytýká chybějící
 * CSP a vlastní CSP si nastavil tak, že si zamkl přihlášení.
 *
 * Test čte Caddyfile jako text — nasazuje se přesně ten soubor, takže
 * kontrola jeho obsahu je kontrola toho, co poběží.
 */

const caddyfile = fs.readFileSync(path.join(PROJECT_ROOT, 'deploy', 'Caddyfile'), 'utf8');
// Hledá se řádek s HODNOTOU, ne komentář o ní. Nad direktivou stojí
// vysvětlující blok, který slovo Content-Security-Policy taky obsahuje —
// bez uvozovky v podmínce test analyzoval komentář a hlásil prázdno.
const cspLine = caddyfile
  .split('\n')
  .find((line) => line.includes('Content-Security-Policy "'));

/** Vytáhne direktivu, např. `connect-src`, i s hodnotami. */
function directive(name) {
  const match = cspLine.match(new RegExp(`${name} ([^;"]+)`));
  return match ? match[1].trim() : null;
}

describe('CSP v Caddyfile', () => {
  test('hlavička v souboru vůbec je', () => {
    expect(cspLine).toBeTruthy();
  });

  test('connect-src pouští ověřovací službu Firebase', () => {
    // Bez tohohle se nikdo nepřihlásí a chyba ukazuje jinam.
    const connect = directive('connect-src');
    expect(connect).toContain('identitytoolkit.googleapis.com');
    expect(connect).toContain('securetoken.googleapis.com');
  });

  test('connect-src pouští Firestore', () => {
    // Projekty, session i monitory jdou z prohlížeče přímo do Firestore.
    expect(directive('connect-src')).toContain('firestore.googleapis.com');
  });

  test('connect-src obsahuje vlastní původ kvůli WebSocketu', () => {
    // Živé logy agenta jdou přes wss na vlastní doménu; to pokrývá 'self'.
    expect(directive('connect-src')).toContain("'self'");
  });

  test('výjimky jsou vyjmenované, ne zástupným znakem', () => {
    // `connect-src *` by problém taky „vyřešil" a zároveň zahodil smysl CSP.
    const connect = directive('connect-src');
    expect(connect).not.toContain('*');
    expect(connect.split(/\s+/).every((v) => v === "'self'" || v.startsWith('https://'))).toBe(true);
  });

  test('skripty smí jen z vlastního původu', () => {
    // Tohle je ta direktiva, na které CSP stojí. Uvolnit ji kvůli písmům
    // nebo analytice by z hlavičky udělala dekoraci.
    const script = directive('script-src');
    expect(script).toBe("'self'");
  });

  test('vkládání do rámu zůstává zakázané', () => {
    expect(cspLine).toContain("frame-ancestors 'none'");
  });

  test('font-src pouští Google Fonts, dokud se písma nehostují lokálně', () => {
    // Poznamenané vědomě: je to požadavek na třetí stranu, tedy přesně to,
    // co GDPR skener tohohle nástroje u cizích webů hlásí.
    expect(directive('font-src')).toContain('fonts.gstatic.com');
    expect(caddyfile).toMatch(/Vlastní hosting písem/);
  });
});

describe('access log neobsahuje query string', () => {
  test('maže se celý query, ne vyjmenované parametry', () => {
    // Log s retencí 720 h je špatné místo pro historii zákazníkových auditů
    // — a dřív i pro capability tokeny k artefaktům.
    //
    // Filtr na vyjmenované parametry chrání jen ty, které někoho napadly.
    // První nový parametr, na který se zapomene, začne tiše téct.
    const logBlock = caddyfile.slice(caddyfile.indexOf('log {'));
    expect(logBlock).toMatch(/format filter/);
    // Pole musí být adresované celou cestou. Samotné `uri` filtr netrefí —
    // v JSON logu je vnořené pod `request` — a tiše se neaplikuje.
    expect(logBlock).toMatch(/request>uri regexp/);
    // Výčet konkrétních jmen by znamenal návrat ke slabší variantě.
    expect(logBlock).not.toMatch(/delete \w/);
  });
});
