import { describe, test, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import PrintReport from './PrintReport.jsx';

/**
 * Tiskový report je dokument, který zákazník odevzdává úřadu — a přesto
 * neměl jediný test.
 *
 * Kontrolní vlna v něm našla dvě místa, kde se trojstav ztrácel: sekce
 * přístupnosti byla binární (zelená/červená) a položky k ručnímu posouzení
 * se netiskly vůbec. Web s desítkami takových položek tedy dostal do
 * dokumentu zelený odznak „Nalezeno porušení: 0" a nic dalšího.
 */

const zaklad = {
  user: { email: 'test@example.com' },
  agentUrl: 'https://example.com',
  liveLogs: [],
};

const vykresli = (props) => render(<PrintReport {...zaklad} {...props} />);

/**
 * Sekce se hledá podle nadpisu, ne přes první `.print-badge` v dokumentu.
 *
 * Shrnutí pro vedení se renderuje PŘED všemi ostatními sekcemi a používá
 * stejná slova („Neprůkazné", „Bez nálezu"), takže neomezené
 * `screen.getByText` by sahalo do něj.
 */
const sekceEl = (nadpis) => screen.getByText(nadpis).closest('.print-section');
const sekce = (nadpis) => within(sekceEl(nadpis));
/** První odznak dané sekce — Green Deal jich má dva (eko třída, rezidence). */
const odznak = (nadpis) => sekceEl(nadpis).querySelector('.print-badge');


describe('sekce přístupnosti — tři stavy', () => {
  test('položky k ručnímu posouzení nedovolí tvrdit splnění', () => {
    vykresli({
      a11yResult: {
        violations: [],
        incomplete: [
          { id: 'color-contrast', description: 'Kontrast na obrázkovém pozadí' },
          { id: 'video-caption', description: 'Titulky u videa' },
        ],
      },
    });

    const s = sekce(/Výsledky EAA/);
    expect(s.getByText(/Neprůkazné/i)).toBeInTheDocument();
    expect(s.getByText(/k ručnímu posouzení: 2/i)).toBeInTheDocument();
    // Musí být vidět, CO se má posoudit — ne jen počet.
    expect(screen.getByText(/Kontrast na obrázkovém pozadí/)).toBeInTheDocument();
    expect(screen.getByText(/Titulky u videa/)).toBeInTheDocument();
  });

  test('čistý výsledek bez ručních položek je splněno', () => {
    vykresli({ a11yResult: { violations: [], incomplete: [] } });
    expect(sekce(/Výsledky EAA/).getByText(/Splněno/i)).toBeInTheDocument();
  });

  test('porušení je nález', () => {
    vykresli({
      a11yResult: {
        violations: [{ id: 'image-alt', impact: 'critical', description: 'Chybí alt' }],
        incomplete: [],
      },
    });
    expect(sekce(/Výsledky EAA/).getByText(/Nesplněno/i)).toBeInTheDocument();
  });

  test('nenačtená stránka se přizná, ne vydává za bez závad', () => {
    // Chybová stránka WAFu nemá žádná porušení. Bez tohohle rozlišení by
    // dostala zelený odznak.
    vykresli({
      a11yResult: {
        violations: [],
        incomplete: [],
        navigationError: 'Server odpověděl 403.',
      },
    });
    const s = sekce(/Výsledky EAA/);
    expect(s.getByText(/Neprůkazné/i)).toBeInTheDocument();
    expect(s.getByText(/neplyne, že je bez závad/i)).toBeInTheDocument();
  });
});

describe('sekce cookies — neprůkazné není nesplněno', () => {
  test('null dostane neutrální odznak, ne červený', () => {
    const { container } = vykresli({
      cookieResult: {
        gdpr: {
          isCompliant: null,
          rating: 'NEPRŮKAZNÉ: Stránku se nepodařilo načíst.',
          suspiciousItems: [],
        },
      },
    });
    // `null` je falsy, takže se dřív vybírala třída `error`.
    const badge = container.querySelector('.print-badge');
    expect(badge.className).not.toMatch(/error/);
  });
});


describe('NIS2 — hlavičky mají tři stavy, ne dva', () => {
  const nis2 = (nis2Detail) => ({
    nis2Result: {
      nis2: nis2Detail,
      pqc: { protocol: 'TLSv1.3', isQuantumSafe: true, issuer: 'Let\'s Encrypt' },
    },
  });

  const uplne = {
    hsts: true, csp: true, xContentTypeOptions: true, xFrameOptions: true,
    referrerPolicy: true, permissionsPolicy: true,
    missingHeaders: [], weakHeaders: [], inconclusiveHeaders: [],
    headersComplete: true, isCompliant: true,
  };

  test('neposouditelná hlavička se NEHLÁSÍ jako chybějící', () => {
    // Na http:// prohlížeč HSTS ignoruje, takže její absence není volbou
    // provozovatele. Agent proto vrací `null` a výslovně to zdůvodňuje.
    // Ternární operátor v reportu z toho dělal „Chybí" — tedy nález
    // v dokumentu pro úřad o něčem, co se neměřilo.
    vykresli(nis2({
      ...uplne, hsts: null,
      inconclusiveHeaders: ['Strict-Transport-Security'],
      isCompliant: null,
    }));

    const s = sekce(/NIS2 & PQC/);
    expect(s.queryByText('Chybí')).not.toBeInTheDocument();
    expect(s.getByText('Nelze posoudit')).toBeInTheDocument();
    expect(s.getByText(/Hlavičky, které se posoudit nepodařilo \(1\)/)).toBeInTheDocument();
  });

  test('neprůkazné se netváří jako „hlavičky jsou kompletní"', () => {
    // `headersComplete` je u neprůkazného běhu true — nic nechybí ani
    // neselhalo, jen se to nedalo posoudit. Odvozovat z něj větu odznaku
    // znamenalo napsat do dokumentu „hlavičky jsou kompletní" o webu,
    // kde se jedna z nich vůbec neměřila.
    vykresli(nis2({
      ...uplne, hsts: null,
      inconclusiveHeaders: ['Strict-Transport-Security'],
      isCompliant: null,
    }));

    const b = odznak(/NIS2 & PQC/);
    expect(b.className).toMatch(/warning/);
    expect(b.textContent).toMatch(/Neprůkazné/);
    expect(b.textContent).not.toMatch(/kompletní/);
    expect(b.textContent).toMatch(/posoudit nepodařilo/);
  });

  test('přítomná, ale nechránící hlavička se nevydává za chybějící', () => {
    // Verdikt je stejný, tvrzení ne — a provozovatel podle toho pozná,
    // jestli má hlavičku doplnit, nebo opravit.
    vykresli(nis2({
      ...uplne, csp: false,
      weakHeaders: ['Content-Security-Policy'],
      headersComplete: false, isCompliant: false,
    }));

    const s = sekce(/NIS2 & PQC/);
    expect(s.getByText('Přítomná, ale nechrání')).toBeInTheDocument();
    expect(s.getByText(/přítomné, ale nechrání \(1\)/)).toBeInTheDocument();
    expect(s.queryByText(/Chybějící hlavičky/)).not.toBeInTheDocument();
  });

  test('skutečně chybějící hlavička se vypíše jménem', () => {
    vykresli(nis2({
      ...uplne, hsts: false,
      missingHeaders: ['Strict-Transport-Security'],
      headersComplete: false, isCompliant: false,
    }));
    const s = sekce(/NIS2 & PQC/);
    expect(s.getByText('Chybí')).toBeInTheDocument();
    expect(s.getByText(/Chybějící hlavičky \(1\)/)).toBeInTheDocument();
  });

  test('starší uložený běh bez nových polí netvrdí „Chybí"', () => {
    // Bez `missingHeaders`/`weakHeaders` nelze rozhodnout, jestli
    // hlavička chybí, nebo je a nechrání. „Chybí" by bylo tvrzení
    // o webu, který ji klidně má.
    vykresli(nis2({ hsts: true, csp: false }));
    const s = sekce(/NIS2 & PQC/);
    expect(s.queryByText('Chybí')).not.toBeInTheDocument();
    expect(s.getByText('Nesplněno')).toBeInTheDocument();
  });

  test('všech šest posuzovaných hlaviček je v dokumentu vidět', () => {
    // Dřív tu byly jen HSTS a CSP; zbylé čtyři se objevily pouze jako
    // nález, takže čtenář nepoznal, jestli se vůbec kontrolovaly.
    vykresli(nis2(uplne));
    const s = sekce(/NIS2 & PQC/);
    for (const popisek of [
      'HSTS:', 'CSP:', 'X-Content-Type-Options:', 'Ochrana proti rámování:',
      'Referrer-Policy:', 'Permissions-Policy:',
    ]) {
      expect(s.getByText(popisek)).toBeInTheDocument();
    }
    expect(s.getAllByText('Aktivní')).toHaveLength(6);
  });

  test('verdikt se vztahuje k hlavičkám, ne k NIS2 jako celku', () => {
    // Odznak „[Splněno]" pod nadpisem NIS2 by znamenal tvrzení o splnění
    // směrnice na základě kontroly šesti HTTP hlaviček. Agent sám
    // v `scope` říká, že o to nejde — a `scope` se proto tiskne.
    vykresli(nis2({
      ...uplne,
      scope: 'Kontrola pokrývá bezpečnostní hlavičky a TLS. Nejde o posouzení shody s NIS2 jako celkem.',
    }));
    const s = sekce(/NIS2 & PQC/);
    expect(odznak(/NIS2 & PQC/).textContent).toMatch(/^Bezpečnostní hlavičky \[Splněno\]/);
    expect(s.getByText(/Nejde o posouzení shody s NIS2 jako celkem/)).toBeInTheDocument();
  });
});

describe('běh agenta — nálezy a závěr patří do dokumentu', () => {
  test('nalezený problém se vytiskne', () => {
    // Report dostával jen `liveLogs`, takže PDF z běhu, který nález MĚL,
    // obsahovalo deset kroků a o zjištění mlčelo.
    vykresli({
      activeSession: {
        status: 'completed',
        summary: 'Test dokončen.',
        bugs: ['Skript connect.facebook.net se načetl před udělením souhlasu.'],
      },
    });

    const s = sekce(/Výsledek běhu agenta/);
    expect(s.getByText(/Detekované problémy \(1\)/)).toBeInTheDocument();
    expect(s.getByText(/connect\.facebook\.net/)).toBeInTheDocument();
    expect(odznak(/Výsledek běhu agenta/).className).toMatch(/error/);
  });

  test('běh bez nálezu se nevydává za doklad souladu', () => {
    // Průzkumný běh prošel jen cesty, na které narazil. „Nic jsme
    // nenašli" proto nesmí být v dokumentu pro úřad tvrzení „Splněno".
    vykresli({ activeSession: { status: 'completed', bugs: [] } });

    const b = odznak(/Výsledek běhu agenta/);
    expect(b.textContent).toMatch(/agent na žádný problém nenarazil/);
    expect(b.textContent).not.toMatch(/Splněno/);
    expect(sekce(/Výsledek běhu agenta/).getByText(/Průzkumný běh není úplný test/))
      .toBeInTheDocument();
  });

  test('chybějící seznam nálezů není nula nálezů', () => {
    // `bugs: []` je změřená nepřítomnost nálezu, `bugs: undefined`
    // znamená, že se běh na nálezy nedíval. `?.length ?? 0` z toho
    // dělalo zelený odznak.
    vykresli({ activeSession: { status: 'completed' } });

    const b = odznak(/Výsledek běhu agenta/);
    expect(b.className).toMatch(/warning/);
    expect(b.textContent).toMatch(/seznam nálezů běh neobsahuje/);
    expect(b.textContent).not.toMatch(/nenarazil/);
  });

  test('předpisový sken se nevydává za běh agenta', () => {
    // `buildScanSession` zakládá předpisovou kontrolu s `bugs: []`
    // a `status: 'completed'` schválně. Bez rozlišení by PDF
    // z předpisové kontroly tvrdilo, že proběhl průzkumný běh
    // a nic nenašel — přitom žádný agent neběžel.
    vykresli({
      activeSession: {
        kind: 'compliance-scan', status: 'completed', bugs: [], steps: [],
      },
    });
    expect(screen.queryByText(/Výsledek běhu agenta/)).not.toBeInTheDocument();
  });

  test('tisk uprostřed běhu se přizná', () => {
    // `window.print()` jde zmáčknout kdykoli. Bez tohohle vypadal
    // nedokončený běh v PDF stejně jako dokončený.
    vykresli({ isRunning: true, activeSession: null });
    const b = odznak(/Výsledek běhu agenta/);
    expect(b.textContent).toMatch(/Běh nebyl dokončen/);
    expect(b.className).toMatch(/warning/);
  });

  test('nedokončený běh není nález a řekne proč', () => {
    vykresli({
      activeSession: {
        status: 'failed', bugs: [],
        runErrors: ['Navigace na /kosik vypršela po 30 s.'],
      },
    });
    const s = sekce(/Výsledek běhu agenta/);
    expect(odznak(/Výsledek běhu agenta/).className).not.toMatch(/error/);
    expect(s.getByText(/ani že závady má/)).toBeInTheDocument();
    // Chyby měření se nesmí číst jako nálezy o testovaném webu.
    expect(s.getByText(/Chyby měření \(1\)/)).toBeInTheDocument();
    expect(s.getByText(/nejsou nálezy o testované aplikaci/)).toBeInTheDocument();
    expect(s.queryByText(/Detekované problémy/)).not.toBeInTheDocument();
  });

  test('bez běhu agenta sekce vůbec nevzniká', () => {
    vykresli({});
    expect(screen.queryByText(/Výsledek běhu agenta/)).not.toBeInTheDocument();
  });
});

describe('eko třída se neurčuje podle podřetězce', () => {
  const green = (rating) => ({
    greenResult: {
      green: { rating, co2Grams: 0.5, totalMb: 0.6 },
      residency: { isEUCompliant: true, warning: 'EU', locations: [] },
    },
  });

  test('neznámé hodnocení nezezelená ani nezčervená', () => {
    vykresli(green(undefined));
    const b = odznak(/Green Deal & GDPR/);
    expect(b.className).toMatch(/warning/);
    expect(b.textContent).toMatch(/neurčena/);
  });

  test('rozhoduje první znak, ne výskyt písmene v popisu', () => {
    vykresli(green('F (Znečišťující A-třídou to není)'));
    expect(odznak(/Green Deal & GDPR/).className).toMatch(/error/);
  });
});

describe('shrnutí pro vedení', () => {
  test('bez jediného skenu se netiskne', () => {
    // Tabulka „0 porušení" o webu, na který se nikdo nepodíval, je
    // to nejnebezpečnější tvrzení, jaké může v shrnutí vzniknout.
    vykresli({ activeSession: { status: 'completed', bugs: [] } });
    expect(screen.queryByText('Shrnutí pro vedení')).not.toBeInTheDocument();
  });

  test('kladný stav se jmenuje „Bez nálezu", ne „Splněno"', () => {
    // Sken nedokazuje splnění předpisu — dokazuje jen, že v rozsahu,
    // který měří, nic nenašel.
    vykresli({ a11yResult: { violations: [], incomplete: [] } });
    const s = sekce('Shrnutí pro vedení');
    expect(s.getByText('Bez nálezu')).toBeInTheDocument();
    expect(s.queryByText('Splněno')).not.toBeInTheDocument();
  });

  test('neprůkazná oblast zablokuje kladný závěr', () => {
    vykresli({
      a11yResult: { violations: [], incomplete: [] },
      greenResult: {
        green: { rating: 'A (Zelený)', co2Grams: 0.5, totalMb: 0.6 },
        residency: { isEUCompliant: null, warning: 'za CDN', locations: [] },
      },
    });
    const b = odznak('Shrnutí pro vedení');
    expect(b.className).toMatch(/warning/);
    expect(b.textContent).toMatch(/Na doklad souladu to nestačí/);
  });

  test('porušení posune odznak do červené', () => {
    vykresli({
      cookieResult: {
        gdpr: { isCompliant: false, rating: 'NÁLEZ', suspiciousItems: ['_ga'] },
      },
    });
    expect(odznak('Shrnutí pro vedení').className).toMatch(/error/);
    expect(sekce('Shrnutí pro vedení').getByText('Vyžaduje nápravu')).toBeInTheDocument();
  });

  test('stav nese text, ne jen barvu', () => {
    // Černobílý tisk je u dokumentu pro úřad běžný.
    vykresli({ a11yResult: { violations: [], incomplete: [] } });
    const bunka = sekceEl('Shrnutí pro vedení').querySelector('.stav-success');
    expect(bunka.textContent.trim()).toBe('Bez nálezu');
  });
});

describe('cookie lišta v záznamu běhu', () => {
  test('vytiskne se, CO se zmáčklo', () => {
    vykresli({
      activeSession: {
        status: 'completed', bugs: [],
        preConsent: { cookies: [], storage: [] },
        cookieBanner: { clicked: true, label: 'Pouze nezbytné', reason: 'odmitnuto' },
      },
    });
    const s = sekce(/Výsledek běhu agenta/);
    expect(s.getByText(/Pouze nezbytné/)).toBeInTheDocument();
    expect(s.getByText(/bez souhlasu s marketingovými cookies/)).toBeInTheDocument();
  });

  test('stav před souhlasem se tiskne i když je čistý — a bez tvrzení o souladu', () => {
    vykresli({
      activeSession: {
        status: 'completed', bugs: [],
        preConsent: { cookies: [], storage: [] },
        cookieBanner: { clicked: false, label: null, reason: 'lista-nenalezena' },
      },
    });
    const s = sekce(/Výsledek běhu agenta/);
    expect(s.getByText(/Seznam není vyčerpávající — není to doklad souladu/))
      .toBeInTheDocument();
    expect(s.getByText(/lišta nebyla nalezena/i)).toBeInTheDocument();
  });

  test('trackery uložené před souhlasem se vypíšou jmény', () => {
    vykresli({
      activeSession: {
        status: 'completed', bugs: [],
        preConsent: { cookies: ['_ga (.example.cz)'], storage: ['_hjSession'] },
        cookieBanner: { clicked: true, label: 'Odmítnout vše', reason: 'odmitnuto' },
      },
    });
    const s = sekce(/Výsledek běhu agenta/);
    expect(s.getByText(/_ga \(\.example\.cz\)/)).toBeInTheDocument();
    expect(s.getByText(/_hjSession/)).toBeInTheDocument();
  });

  test('neodkliknutá lišta upozorní na následek', () => {
    // Běh pod překryvem je jiný běh než běh na odkryté stránce.
    vykresli({
      activeSession: {
        status: 'completed', bugs: [],
        cookieBanner: { clicked: false, label: null, reason: 'lista-nalezena-bez-odmitnuti' },
      },
    });
    expect(sekce(/Výsledek běhu agenta/).getByText(/pod překryvem/)).toBeInTheDocument();
  });
});
