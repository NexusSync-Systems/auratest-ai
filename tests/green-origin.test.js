/**
 * Rozdělení objemu na vlastní a jiné domény.
 *
 * Zdejší riziko není v aritmetice, ale v tom, CO se o výsledku tvrdí.
 * „Cizí doména" a „třetí strana" nejsou totéž a sken rozliší jen to
 * první. Testy proto hlídají i znění, ne jen čísla.
 */
import { jeVlastni, rozdelPodlePuvodu, PRAVIDLO_PUVODU } from '../green-origin.js';

describe('jeVlastni', () => {
  test('shoda a poddomény patří k webu', () => {
    expect(jeVlastni('firma.cz', 'firma.cz')).toBe(true);
    expect(jeVlastni('img.firma.cz', 'firma.cz')).toBe(true);
    expect(jeVlastni('a.b.firma.cz', 'firma.cz')).toBe(true);
  });

  test('nadřazená doména taky — kvůli www', () => {
    // Sken běží na `www.firma.cz`, obrázky chodí z `firma.cz`.
    expect(jeVlastni('firma.cz', 'www.firma.cz')).toBe(true);
  });

  test('sourozenci přes www se spárují — nejběžnější rozložení', () => {
    // Bez odříznutí `www.` by vlastní obrázky vyšly jako cizí a celé
    // číslo by bylo k ničemu. Našla to první verze tohohle souboru.
    expect(jeVlastni('img.firma.cz', 'www.firma.cz')).toBe(true);
    expect(jeVlastni('static.firma.cz', 'www.firma.cz')).toBe(true);
  });

  /**
   * ZNÁMÁ MEZ, ne omyl.
   *
   * Test ji drží viditelnou. Spárovat je správně by chtělo registrovatelnou
   * doménu přes veřejný seznam přípon; ten mezi závislostmi serveru není
   * a hádat hranici u `firma.co.uk` by bylo horší než tahle mez.
   */
  test('sourozenci bez www se NEspárují — a je to v pravidle napsané', () => {
    expect(jeVlastni('img.firma.cz', 'shop.firma.cz')).toBe(false);
    expect(PRAVIDLO_PUVODU).toMatch(/[Ss]ourozenecké poddomény/);
  });

  test('cizí doména je cizí', () => {
    expect(jeVlastni('googletagmanager.com', 'firma.cz')).toBe(false);
    expect(jeVlastni('firma.cz.utocnik.example', 'firma.cz')).toBe(false);
  });

  test('podřetězec nestačí — hranice je tečka', () => {
    // `nefirma.cz` končí na `firma.cz`, ale poddoména to není.
    // Tohle je táž past, na kterou doplatilo poznávání trackerů.
    expect(jeVlastni('nefirma.cz', 'firma.cz')).toBe(false);
    expect(jeVlastni('mojefirma.cz', 'firma.cz')).toBe(false);
  });

  test('velikost písmen nerozhoduje', () => {
    expect(jeVlastni('IMG.Firma.CZ', 'firma.cz')).toBe(true);
  });

  test('chybějící vstup neznamená vlastní', () => {
    expect(jeVlastni(null, 'firma.cz')).toBe(false);
    expect(jeVlastni('firma.cz', null)).toBe(false);
  });
});

describe('rozdelPodlePuvodu', () => {
  const data = (dvojice) => new Map(
    dvojice.map(([d, b, p = 1]) => [d, { bajtu: b, pozadavku: p }])
  );

  test('spočítá objem i podíl', () => {
    const v = rozdelPodlePuvodu(data([
      ['www.firma.cz', 600_000, 10],
      ['img.firma.cz', 200_000, 5],
      ['googletagmanager.com', 150_000, 3],
      ['fonts.gstatic.com', 50_000, 2],
    ]), 'www.firma.cz');

    expect(v.rozdeleno).toBe(true);
    expect(v.vlastniBajtu).toBe(800_000);
    expect(v.ciziBajtu).toBe(200_000);
    expect(v.podilCizichProcent).toBe(20);
    expect(v.vlastnichDomen).toBe(2);
    expect(v.cizichDomen).toBe(2);
  });

  test('cizí domény jsou seřazené od největší', () => {
    const v = rozdelPodlePuvodu(data([
      ['firma.cz', 100],
      ['maly.example', 10],
      ['velky.example', 900],
      ['stredni.example', 400],
    ]), 'firma.cz');
    expect(v.nejvetsiCizi.map((c) => c.domena))
      .toEqual(['velky.example', 'stredni.example', 'maly.example']);
  });

  test('výpis největších se dá omezit', () => {
    const v = rozdelPodlePuvodu(data([
      ['firma.cz', 1], ['a.example', 5], ['b.example', 4], ['c.example', 3],
    ]), 'firma.cz', 2);
    expect(v.nejvetsiCizi).toHaveLength(2);
  });

  /**
   * Neúspěšná navigace nesmí vyrobit tvrzení o webu.
   *
   * „0 % cizích domén" by vypadalo jako pochvala. Ve skutečnosti to
   * znamená, že se nezměřilo nic.
   */
  test('bez domény auditovaného webu se nerozděluje', () => {
    const v = rozdelPodlePuvodu(data([['cokoli.example', 100]]), null);
    expect(v.rozdeleno).toBe(false);
    expect(v.podilCizichProcent).toBeUndefined();
    expect(v.duvod).toMatch(/nepodařilo určit/);
  });

  test('prázdné měření se nevydává za nulový podíl', () => {
    const v = rozdelPodlePuvodu(new Map(), 'firma.cz');
    expect(v.rozdeleno).toBe(false);
    expect(v.podilCizichProcent).toBeUndefined();
  });

  test('chybějící mapa nespadne', () => {
    expect(rozdelPodlePuvodu(undefined, 'firma.cz').rozdeleno).toBe(false);
  });

  test('web bez jediného cizího požadavku má podíl 0, a je rozdělený', () => {
    // Rozdíl proti předchozím dvěma: TADY se opravdu měřilo a nula je
    // výsledek, ne absence výsledku.
    const v = rozdelPodlePuvodu(data([['firma.cz', 500]]), 'firma.cz');
    expect(v.rozdeleno).toBe(true);
    expect(v.podilCizichProcent).toBe(0);
    expect(v.nejvetsiCizi).toEqual([]);
  });
});

describe('co se o výsledku tvrdí', () => {
  test('pravidlo cestuje s výsledkem, i s nerozděleným', () => {
    expect(rozdelPodlePuvodu(new Map([['a.cz', { bajtu: 1, pozadavku: 1 }]]), 'a.cz').pravidlo)
      .toBe(PRAVIDLO_PUVODU);
    expect(rozdelPodlePuvodu(new Map(), null).pravidlo).toBe(PRAVIDLO_PUVODU);
  });

  test('pravidlo přiznává, že měří jména, ne vlastnictví', () => {
    // Nazvat to „emise třetích stran" by bylo tvrzení, na které měření
    // nestačí: vlastní CDN na jiné doméně vyjde jako cizí.
    expect(PRAVIDLO_PUVODU).toMatch(/JMEN, ne vlastnictví/);
    expect(PRAVIDLO_PUVODU).toMatch(/vlastní CDN/);
  });
});
