import { jeZruseny, nalezSitoveChyby, poznamkaZruseneho, jeOvereniRobota, poznamkaOvereniRobota, zatridSelhani,
} from '../network-findings.js';
import { sanitizeActionResponse } from '../agent.js';

/**
 * Regrese z OSTRÉHO běhu proti cloudflare.com.
 *
 * Web bez závady dostal dva nálezy a ani jeden nebyl pravdivý. Žádný
 * z 1015 tehdejších testů to nezachytil — projevilo se to až na skutečném
 * webu, protože obojí vyžaduje běžící prohlížeč.
 */

describe('zrušený požadavek není vada webu', () => {
  it('net::ERR_ABORTED se nehlásí jako nález', () => {
    // Zrušení znamená odchod ze stránky, AbortController v aplikaci,
    // zahozené přednačtení nebo HEAD ukončený po hlavičkách. Odlišit
    // „zrušila správně" od „zrušila omylem" zvenčí nejde.
    expect(jeZruseny('net::ERR_ABORTED')).toBe(true);
    expect(jeZruseny('  net::ERR_ABORTED  ')).toBe(true);
  });

  it('skutečné síťové chyby zrušením nejsou', () => {
    // Zúžit se smí jen na to jedno. Umlčet pravdivý nález váží stejně.
    for (const e of [
      'net::ERR_CONNECTION_REFUSED',
      'net::ERR_NAME_NOT_RESOLVED',
      'net::ERR_CERT_DATE_INVALID',
      'net::ERR_TIMED_OUT',
      'Unknown failure',
    ]) {
      expect(jeZruseny(e)).toBe(false);
    }
  });

  it('prázdná hodnota není zrušení', () => {
    expect(jeZruseny(null)).toBe(false);
    expect(jeZruseny(undefined)).toBe(false);
    expect(jeZruseny('')).toBe(false);
  });

  it('poznámka o zrušení se netváří jako nález', () => {
    const p = poznamkaZruseneho('HEAD', 'https://www.cloudflare.com/');
    expect(p).toMatch(/nejde o vadu webu/);
    expect(p).not.toMatch(/^Selhal/);
  });
});

describe('jeden fakt, jedno znění', () => {
  it('nález nese skutečnou metodu, ne natvrdo GET', () => {
    expect(nalezSitoveChyby('HEAD', 'https://x.cz/', 'net::ERR_TIMED_OUT'))
      .toBe('Selhal síťový požadavek: HEAD https://x.cz/ - net::ERR_TIMED_OUT');
  });

  it('chybějící údaje se nedomýšlí', () => {
    expect(nalezSitoveChyby(null, 'https://x.cz/', null))
      .toBe('Selhal síťový požadavek: ? https://x.cz/ - Unknown failure');
  });

  it('krokový souhrn zní JINAK než nález posluchače — proto se nesmí přidávat znovu', () => {
    // Tohle je ta past. `addFinding` deduplikuje podle celého řetězce,
    // takže obě formulace téhož faktu projdou a počet nálezů ve spisu
    // se nafoukne. Ověřeno ostrým během: dva nálezy z jedné chyby.
    const souhrn = sanitizeActionResponse(
      { reasoning: 'Kliknu', action: 'click', target: 1, value: null, detected_bugs: [] },
      {
        currentUrl: 'https://www.cloudflare.com/',
        title: 'Cloudflare',
        consoleLogs: [],
        networkErrors: [{ url: 'https://www.cloudflare.com/', error: 'net::ERR_TIMED_OUT' }],
        steps: [],
        interactiveElements: [{ id: 1, tagName: 'A', text: 'Detail', href: '/d' }],
      }
    ).detected_bugs[0];

    const posluchac = nalezSitoveChyby('HEAD', 'https://www.cloudflare.com/', 'net::ERR_TIMED_OUT');

    expect(souhrn).toBeDefined();
    expect(souhrn).not.toBe(posluchac);
  });
});

/**
 * OVĚŘENÍ, ŽE NÁVŠTĚVNÍK NENÍ ROBOT.
 *
 * Smoke test proti cloudflare.com — webu bez závady — vrátil tohle
 * jako dvě chyby aplikace:
 *
 *   [NetworkError] Selhání API: GET https://challenges.cloudflare.com/
 *     cdn-cgi/challenge-platform/h/g/…
 *   Selhal síťový požadavek: GET https://brunhild.challenges.cloudflare.com/
 *     cdn-cgi/challenge-platform/h/g/i/a3d0a…
 *
 * Oba požadavky obsluhují detekci robotů a selhaly proto, že na stránku
 * kouká automat. Způsobilo je naše měření, ne web. Adresy v testech jsou
 * doslova ty z toho běhu.
 */
describe('ochrana proti robotům není vada webu', () => {
  test('adresy ze skutečného běhu se rozpoznají', () => {
    expect(jeOvereniRobota('https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/g/jsd/r/abc'))
      .toBe(true);
    expect(jeOvereniRobota('https://brunhild.challenges.cloudflare.com/cdn-cgi/challenge-platform/h/g/i/a3d0a'))
      .toBe(true);
  });

  test('výzva na doméně zákazníka se pozná podle cesty', () => {
    // Cloudflare obsluhuje výzvu i z domény samotného webu — prefix
    // `/cdn-cgi/` si vyhrazuje pro vlastní služby.
    expect(jeOvereniRobota('https://www.klient.cz/cdn-cgi/challenge-platform/h/b/orchestrate/jsch/v1'))
      .toBe(true);
  });

  test('obyčejné API zákazníka NENÍ výzva', () => {
    // Nadsazený seznam by zamlčel skutečné vady — to je stejně vážná
    // chyba jako nález na webu, který je v pořádku.
    for (const url of [
      'https://www.klient.cz/api/objednavky',
      'https://www.klient.cz/cdn-cgi/trace',
      'https://cloudflare.com/plans',
      'https://challenges.cloudflare.com.evil.example/cdn-cgi/x',
      'https://jinychallenges.cloudflare.com.cz/api',
    ]) {
      expect(jeOvereniRobota(url)).toBe(false);
    }
  });

  test('nerozebratelná adresa se za výzvu nevydává', () => {
    // Fail-closed tady znamená „hlásit dál": zamlčení je horší než
    // nález navíc.
    for (const url of ['', null, undefined, 'nesmysl', '/relativni/cesta']) {
      expect(jeOvereniRobota(url)).toBe(false);
    }
  });

  test('poznámka říká, proč se to nepočítá', () => {
    const p = poznamkaOvereniRobota('GET', 'https://challenges.cloudflare.com/x', 'HTTP 403');
    expect(p).toMatch(/naše měření/);
    expect(p).toMatch(/ne vada webu/);
    expect(p).toMatch(/HTTP 403/);
    expect(p).toMatch(/GET https:\/\/challenges\.cloudflare\.com\/x/);
  });
});

/**
 * ZATŘÍDĚNÍ SELHÁNÍ — to, co dřív bylo uvnitř posluchače v `agent.js`.
 *
 * Posluchač `requestfailed` se rozjede jedině se skutečným prohlížečem,
 * takže rozhodnutí „nález, nebo okolnost běhu?" zůstávalo bez testu
 * a ověřoval se jen predikát vedle něj. Tenhle vzorec — kód a jeho opis
 * v testu — jsme už jednou platili u měření objemu.
 */
describe('zatřídění selhaného požadavku', () => {
  const selhani = (p) => zatridSelhani({ method: 'GET', errText: 'net::ERR_FAILED', ...p });

  test('skutečné selhání je nález a signál běhu', () => {
    const v = selhani({ url: 'https://www.klient.cz/api/objednavky' });
    expect(v.kam).toBe('bugs');
    expect(v.runtimeSignal).toBe(true);
    expect(v.text).toMatch(/Selhal síťový požadavek: GET/);
  });

  test('zrušený požadavek je okolnost, ne nález', () => {
    const v = selhani({ url: 'https://www.klient.cz/', errText: 'net::ERR_ABORTED' });
    expect(v.kam).toBe('warnings');
    // Do signálů běhu NE: jinak by naše vlastní odchod ze stránky
    // přepnul výběr další akce na „zkus to znovu".
    expect(v.runtimeSignal).toBe(false);
  });

  test('ochrana proti robotům je okolnost, ne nález', () => {
    const v = selhani({ url: 'https://brunhild.challenges.cloudflare.com/cdn-cgi/challenge-platform/h/g/i/a3d0a' });
    expect(v.kam).toBe('warnings');
    expect(v.runtimeSignal).toBe(false);
    expect(v.text).toMatch(/naše měření/);
  });

  test('vlastní blokace se nehlásí vůbec', () => {
    const v = selhani({ url: 'http://169.254.169.254/', blokovanoNami: true });
    expect(v.kam).toBe('ticho');
    expect(v.text).toBeNull();
    expect(v.runtimeSignal).toBe(false);
  });

  test('blokace přebíjí i ostatní důvody', () => {
    // Pořadí je podstatné: o naší vlastní blokaci nemá čtenář co číst,
    // ani jako o okolnosti.
    expect(selhani({
      url: 'https://challenges.cloudflare.com/cdn-cgi/challenge-platform/x',
      blokovanoNami: true,
    }).kam).toBe('ticho');
  });
});
