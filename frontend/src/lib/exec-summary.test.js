import { describe, test, expect } from 'vitest';
import { execSummary, stavLabel } from './exec-summary.js';

/**
 * Manažerské shrnutí je první — a u většiny čtenářů jediná — strana
 * dokumentu, který jde úřadu. Právě ono se cituje dál, takže tvrzení
 * navíc je tu nebezpečnější než kdekoli jinde.
 *
 * Testy hlídají tři věci: že se nepočítá to, co neproběhlo; že
 * neprůkazné nespadne ani mezi splněné, ani mezi porušené; a že kladný
 * závěr nevznikne, dokud je něco nezměřeno.
 */

const cistyA11y = { violations: [], incomplete: [] };
const cistyNis2 = {
  nis2: {
    isCompliant: true, missingHeaders: [], weakHeaders: [],
    inconclusiveHeaders: [], tlsFindings: [],
  },
};

describe('rozsah shrnutí', () => {
  test('bez jediného skenu shrnutí nevzniká', () => {
    // Prázdná tabulka „0 porušení" by byla tvrzení o webu, na který se
    // nikdo nepodíval.
    expect(execSummary({})).toBeNull();
    expect(execSummary()).toBeNull();
  });

  test('nespuštěné oblasti se nepočítají ani nezmiňují', () => {
    const s = execSummary({ a11yResult: cistyA11y });
    expect(s.celkem).toBe(1);
    expect(s.polozky).toHaveLength(1);
    expect(s.polozky[0].nazev).toMatch(/Přístupnost/);
    expect(s.zaver).toMatch(/Posouzeno 1 oblast\./);
  });

  test('počty sedí se seznamem položek', () => {
    const s = execSummary({
      a11yResult: cistyA11y,
      nis2Result: cistyNis2,
      cookieResult: { gdpr: { isCompliant: false, suspiciousItems: ['x', 'y'] } },
      greenResult: { residency: { isEUCompliant: null, warning: 'za CDN' } },
    });
    expect(s.celkem).toBe(4);
    expect(s.splneno + s.nesplneno + s.neprukazne).toBe(s.celkem);
    expect(s.splneno).toBe(2);
    expect(s.nesplneno).toBe(1);
    expect(s.neprukazne).toBe(1);
  });
});

describe('tři koše, ne dva', () => {
  test('neprůkazné není ani splněno, ani porušeno', () => {
    const s = execSummary({
      greenResult: { residency: { isEUCompliant: null, warning: 'za CDN' } },
    });
    expect(s.neprukazne).toBe(1);
    expect(s.splneno).toBe(0);
    expect(s.nesplneno).toBe(0);
    expect(s.polozky[0].stav).toBe('inconclusive');
  });

  test('položky k ručnímu posouzení dělají z přístupnosti neprůkazné', () => {
    const s = execSummary({
      a11yResult: { violations: [], incomplete: [{ id: 'a' }, { id: 'b' }] },
    });
    expect(s.neprukazne).toBe(1);
    expect(s.polozky[0].duvod).toMatch(/2 položky k ručnímu posouzení/);
  });

  test('nenačtená stránka není „bez nálezu"', () => {
    const s = execSummary({
      a11yResult: { violations: [], incomplete: [], navigationError: 'HTTP 403' },
    });
    expect(s.polozky[0].stav).toBe('inconclusive');
    expect(s.polozky[0].duvod).toMatch(/nepodařilo posoudit/);
  });
});

describe('závěr', () => {
  test('kladný závěr vznikne jen když je všechno změřené a čisté', () => {
    const s = execSummary({ a11yResult: cistyA11y, nis2Result: cistyNis2 });
    expect(s.zaver).toMatch(/bez nálezu/);
    // A ani pak to není potvrzení souladu — rozsah je dán tím, co
    // nástroj měří.
    expect(s.zaver).toMatch(/není to potvrzení souladu/);
  });

  test('jediná neprůkazná oblast kladný závěr zablokuje', () => {
    // Neprůkazné neznamená závadu. Znamená, že o té oblasti nikdo nic
    // neví — a z toho kladný závěr vzniknout nesmí.
    const s = execSummary({
      a11yResult: cistyA11y,
      greenResult: { residency: { isEUCompliant: null, warning: 'za CDN' } },
    });
    expect(s.zaver).toMatch(/nepodařilo určit/);
    expect(s.zaver).toMatch(/Na doklad souladu to nestačí/);
  });

  test('porušení se ve větě přizná i vedle neprůkazného', () => {
    const s = execSummary({
      cookieResult: { gdpr: { isCompliant: false, suspiciousItems: ['x'] } },
      greenResult: { residency: { isEUCompliant: null, warning: 'za CDN' } },
    });
    expect(s.zaver).toMatch(/vyžaduje nápravu/);
    expect(s.zaver).toMatch(/nepodařilo určit/);
    expect(s.zaver).toMatch(/nedokládá soulad/);
  });
});

describe('odolnost proti vadnému tvaru dat', () => {
  test('rozbitý výsledek se nezamlčí a shrnutí nespadne', () => {
    // Vypadnout z tabulky by znamenalo, že oblast v dokumentu chybí
    // bez vysvětlení. Spadnout by znamenalo prázdné PDF.
    const s = execSummary({ nis2Result: {} });
    expect(s.celkem).toBe(1);
    expect(s.polozky[0].stav).toBe('inconclusive');
  });
});

describe('popisky', () => {
  test('kladný stav se jmenuje „Bez nálezu", ne „Splněno"', () => {
    // Sken nedokazuje splnění předpisu — dokazuje jen, že v jeho
    // rozsahu nic nenašel.
    expect(stavLabel('pass')).toBe('Bez nálezu');
    expect(stavLabel('fail')).toBe('Vyžaduje nápravu');
    expect(stavLabel('inconclusive')).toBe('Neprůkazné');
  });
});

/**
 * Invariant: u NEKLADNÉHO verdiktu nesmí důvod znít uklidňujícím tónem.
 *
 * Kontrolní vlna našla tři místa, kde v tabulce stálo „Vyžaduje nápravu"
 * nebo „Neprůkazné" a hned vedle věta „všechny posuzované hlavičky
 * chrání" / „bez známých CVE" / „bez nálezu ze sledovaného seznamu".
 * Dokument si tím odporoval sám se sebou na jednom řádku.
 */
const UKLIDNUJICI = [
  /bez nálezu/i, /bez známých CVE/i, /chrání/i, /je v EU\/EHP/i,
];

const nesmiUklidnovat = (vysledky) => {
  const s = execSummary(vysledky);
  for (const p of s.polozky) {
    if (p.stav === 'pass') continue;
    for (const vzor of UKLIDNUJICI) {
      expect(`${p.nazev}: ${p.duvod}`).not.toMatch(vzor);
    }
  }
  return s;
};

describe('důvod nesmí odporovat verdiktu', () => {
  test('NIS2: nález v TLS při kompletních hlavičkách', () => {
    // `isCompliant` se po výpočtu z hlaviček přepisuje podle TLS.
    // Důvod četl jen hlavičky → „Vyžaduje nápravu | všechny posuzované
    // hlavičky chrání".
    const s = nesmiUklidnovat({
      nis2Result: {
        nis2: {
          isCompliant: false,
          missingHeaders: [], weakHeaders: [], inconclusiveHeaders: [],
          tlsFindings: ['Server přijímá zastaralé verze TLS: TLSv1.'],
        },
      },
    });
    expect(s.polozky[0].duvod).toMatch(/1 nález v TLS/);
  });

  test('NIS2: neověřitelná TLS vrstva', () => {
    const s = nesmiUklidnovat({
      nis2Result: {
        nis2: {
          isCompliant: null,
          missingHeaders: [], weakHeaders: [], inconclusiveHeaders: [],
          tlsFindings: [],
        },
      },
    });
    expect(s.polozky[0].duvod).toMatch(/TLS vrstvu se nepodařilo ověřit/);
  });

  test('CRA: prázdný SBOM neověřil ani jednu komponentu', () => {
    // `vulnerabilities` i `skipped` jsou prázdné SOUČASNĚ. Původní
    // důvod z toho udělal „bez známých CVE u ověřených komponent" —
    // ověřených jich přitom bylo nula.
    const s = nesmiUklidnovat({
      craVulnResult: {
        cra: {
          isCompliant: null, vulnerabilities: [], skipped: [],
          rating: 'NEPRŮKAZNÉ: SBOM se nepodařilo sestavit — žádné čitelné skripty.',
        },
      },
    });
    expect(s.polozky[0].duvod).toMatch(/SBOM se nepodařilo sestavit/);
  });

  test('GDPR trackery: nenačtená stránka', () => {
    const s = nesmiUklidnovat({
      cookieResult: {
        navigationError: 'HTTP 403',
        gdpr: { isCompliant: null, suspiciousItems: [], rating: 'NEPRŮKAZNÉ' },
      },
    });
    expect(s.polozky[0].duvod).toMatch(/nepodařilo načíst/);
  });

  test('rezidence: důvod neprůkaznosti jde první, ne až za kladnou větou', () => {
    // `residency.warning` začíná „Všech 5 posouzených serverů je
    // v EU/EHP…" a výhrada je až za ní. Ve shrnutí je pořadí vět
    // tvrzením samo o sobě.
    const s = nesmiUklidnovat({
      greenResult: {
        residency: {
          isEUCompliant: null,
          originMeasured: false,
          measuredDomains: 5,
          warning: 'Všech 5 posouzených serverů je v EU/EHP (celkem domén: 8).',
        },
      },
    });
    expect(s.polozky[0].duvod).toBe('doménu webu se nepodařilo umístit');
  });
});

describe('chaos test není verdikt o předpisu', () => {
  test('má vlastní popisky, ne „Vyžaduje nápravu"', () => {
    // DORA dopadá jen na finanční subjekty. „Vyžaduje nápravu"
    // u běžného e-shopu je tvrzení o povinnosti, která na něj nedopadá.
    const s = execSummary({
      chaosResult: { chaos: { isResilient: false, rating: 'Aplikace se rozpadla.' } },
    });
    expect(s.polozky[0].popisek).toBe('Neošetřené výpadky');
    expect(s.polozky[0].popisek).not.toBe('Vyžaduje nápravu');
  });

  test('do závěru se nezapočítává', () => {
    const s = execSummary({
      chaosResult: { chaos: { isResilient: false, rating: 'x' } },
    });
    expect(s.celkem).toBe(0);
    expect(s.nesplneno).toBe(0);
    expect(s.zaver).toMatch(/Neproběhla žádná předpisová kontrola/);
  });

  test('vedle předpisové oblasti se počítá jen ta předpisová', () => {
    const s = execSummary({
      a11yResult: cistyA11y,
      chaosResult: { chaos: { isResilient: false, rating: 'x' } },
    });
    expect(s.polozky).toHaveLength(2);
    expect(s.celkem).toBe(1);
    expect(s.nesplneno).toBe(0);
  });
});

describe('řádek bez odpovídající sekce v dokumentu nevznikne', () => {
  test('výsledek bez nosného podobjektu je neprůkazný, ne tichý', () => {
    // Sekce chaosu se tiskne jen při `chaosResult.chaos`. Bez tohohle
    // by ve shrnutí vznikl řádek a věta „podrobnosti jsou v sekcích
    // níž" by byla nepravdivá.
    for (const vysledky of [
      { chaosResult: { ok: true } },
      { aiActResult: {} },
      { craVulnResult: {} },
      { cookieResult: {} },
    ]) {
      const s = execSummary(vysledky);
      expect(s.polozky[0].stav).toBe('inconclusive');
      expect(s.polozky[0].duvod).toBe('výsledek se nepodařilo přečíst');
    }
  });
});
