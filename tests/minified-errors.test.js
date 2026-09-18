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
