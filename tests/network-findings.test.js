import { jeZruseny, nalezSitoveChyby, poznamkaZruseneho } from '../network-findings.js';
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
