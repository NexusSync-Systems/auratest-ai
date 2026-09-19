import { doplnZnameZneni, klicVyjimky, VYSVETLENI } from '../minified-errors.js';

/**
 * Zkrácené chyby Reactu.
 *
 * Smoke test proti cloudflare.com hlásil PRÁVEM nesoulad při hydrataci,
 * jenže třikrát špatně podaný:
 *
 *   [Error] Běhová chyba: Uncaught Error: Minified React error #418; visit…
 *   [Error] Neošetřená výjimka: Minified React error #418; visit…
 *
 * Jedna vada, dva nálezy — a hláška, ze které čtenář dokumentu pro úřad
 * nezjistí nic, protože React v produkčním buildu znění zkracuje.
 *
 * Znění jsou stažená z react.dev 18. 9. 2026, ne napsaná z hlavy.
 */
describe('doplnění skutečného znění', () => {
  test('#418 dostane vysvětlení', () => {
    const v = doplnZnameZneni('Uncaught Error: Minified React error #418; visit https://react.dev/errors/418');
    expect(v).toMatch(/Nesoulad při hydrataci/);
    // Původní znění se NEZAHAZUJE — je to doklad.
    expect(v).toMatch(/Minified React error #418/);
  });

  test('#423 dostane vlastní vysvětlení, ne totéž co #418', () => {
    const v = doplnZnameZneni('Minified React error #423');
    expect(v).toMatch(/Hydratace selhala/);
    expect(VYSVETLENI[423]).not.toBe(VYSVETLENI[418]);
  });

  test('neověřené číslo se NEDOMÝŠLÍ', () => {
    // Radši prázdné místo než vymyšlený popis vady v dokumentu pro úřad.
    const t = 'Minified React error #999';
    expect(doplnZnameZneni(t)).toBe(t);
    expect(doplnZnameZneni(t)).not.toMatch(/Význam/);
  });

  test('cizí hláška se nemění', () => {
    for (const t of ['Uncaught TypeError: x is not a function', '', null]) {
      expect(doplnZnameZneni(t)).toBe(String(t ?? ''));
    }
  });
});

describe('jedna výjimka je jeden nález', () => {
  test('všechna tři znění téže chyby dávají stejný klíč', () => {
    // Přesně ty tři obálky ze skutečných běhů.
    const zKonzole = '[AuraGuard-Error] Běhová chyba: Uncaught Error: Minified React error #418; visit https://react.dev/errors/ v main.js:1';
    const zPageerror = 'Minified React error #418; visit https://react.dev/errors/418?args[]';
    const holy = 'Uncaught Error: Minified React error #418';
    expect(klicVyjimky(zKonzole)).toBe(klicVyjimky(zPageerror));
    expect(klicVyjimky(zKonzole)).toBe(klicVyjimky(holy));
  });

  test('různá čísla chyb se neslepí', () => {
    expect(klicVyjimky('Minified React error #418'))
      .not.toBe(klicVyjimky('Minified React error #423'));
  });

  test('obecná výjimka: obálka a stack klíč neovlivní', () => {
    const a = '[AuraGuard-Error] Neošetřená výjimka: TypeError: cannot read properties of null\nStack: at foo (bundle.js:1:2)';
    const b = 'Uncaught TypeError: cannot read properties of null';
    expect(klicVyjimky(a)).toBe(klicVyjimky(b));
  });

  test('různé výjimky se neslepí', () => {
    expect(klicVyjimky('TypeError: cannot read properties of null'))
      .not.toBe(klicVyjimky('RangeError: maximum call stack size exceeded'));
  });

  test('krátký zbytek klíč nedostane', () => {
    // Dva řádky navíc jsou menší škoda než dva různé nálezy slepené
    // do jednoho — z toho by se ztratil nález.
    expect(klicVyjimky('chyba')).toBeNull();
    expect(klicVyjimky('')).toBeNull();
    expect(klicVyjimky(null)).toBeNull();
  });
});

/**
 * NÁLEZ Z KONTROLNÍ VLNY: klíč slepil dvě RŮZNÉ výjimky.
 *
 * `klicVyjimky` zahazoval adresy a zkracoval na 200 znaků. Dvě různá
 * rozbitá API tak dostala týž klíč, druhý nález `addFinding` zahodil
 * a adresa druhého endpointu se ve spisu neobjevila vůbec.
 *
 * Slučovat se má jedna věc hlášená víckrát, ne dvě různé věci.
 */
describe('různé výjimky se neslévají', () => {
  test('dvě rozbitá API na různých adresách jsou dva nálezy', () => {
    const a = klicVyjimky('Uncaught TypeError: Failed to fetch https://api.klient.cz/objednavky');
    const b = klicVyjimky('Uncaught TypeError: Failed to fetch https://api.klient.cz/platby');
    expect(a).not.toBe(b);
    // Adresa v klíči ZŮSTÁVÁ — je to jediné, čím se ty dva nálezy liší.
    expect(a).toMatch(/objednavky/);
  });

  test('dvě dlouhé výjimky se shodným začátkem jsou dva nálezy', () => {
    const spolecne = 'TypeError: ' + 'x'.repeat(210);
    expect(klicVyjimky(`${spolecne} A`)).not.toBe(klicVyjimky(`${spolecne} B`));
  });
});

describe('obyčejná výjimka je taky jeden nález', () => {
  test('znění z window.onerror a z pageerror dají týž klíč', () => {
    // Tohle commit „Jedna vada Reactu je jeden čitelný nález" prohlašoval
    // za vyřešené, ale u chyb BEZ čísla Reactu vyřešené nebylo: náš
    // vlastní hook přidává ` v soubor.js:12`, což dalo jiný klíč.
    const zHooku = '[AuraGuard-Error] Běhová chyba: Uncaught TypeError: b is not a function v https://klient.cz/app.js:12';
    const zPageerror = 'TypeError: b is not a function';
    expect(klicVyjimky(zHooku)).toBe(klicVyjimky(zPageerror));
  });

  test('relativní jméno souboru taky', () => {
    expect(klicVyjimky('Běhová chyba: Uncaught TypeError: b is not a function v main.js:1'))
      .toBe(klicVyjimky('TypeError: b is not a function'));
  });

  test('dvojtečka s číslem UVNITŘ hlášky se neodřezává', () => {
    // Odřezává se jen koncovka `… v soubor:číslo`. „kód 402" ani
    // „řádek 12" uvnitř věty nesmí klíč zkrátit.
    const k = klicVyjimky('TypeError: platba selhala, kód 402 u zákazníka 9');
    expect(k).toMatch(/kód 402 u zákazníka 9/);
  });
});
