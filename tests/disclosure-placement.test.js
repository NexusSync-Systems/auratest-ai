import {
  classifyOccurrence,
  assessDisclosurePlacement,
  placementToStatus,
  PLACEMENT,
} from '../disclosure-placement.js';

/**
 * Kvalita upozornění na AI (čl. 50 odst. 1).
 *
 * Motivace: dosud stačilo, aby se kdekoli na stránce vyskytlo slovo „AI".
 * Projde tím zmínka v patičce, v blogovém titulku i v marketingové větě —
 * a z toho plynul verdikt SPLNĚNO.
 */

const at = (over = {}) => ({
  rendered: true,
  inViewport: true,
  inFooter: false,
  nearConversation: false,
  ...over,
});

describe('klasifikace jednoho výskytu', () => {
  test('viditelné bez posouvání je v pořádku', () => {
    expect(classifyOccurrence(at())).toBe(PLACEMENT.PROMINENT);
  });

  test('u konverzačního prvku je v pořádku i pod ohybem', () => {
    // Uživatel ho uvidí ve chvíli, kdy začne psát — což je přesně ten
    // okamžik, na který čl. 50 míří.
    expect(classifyOccurrence(at({ inViewport: false, nearConversation: true })))
      .toBe(PLACEMENT.PROMINENT);
  });

  test('jen v patičce se pozná', () => {
    expect(classifyOccurrence(at({ inFooter: true }))).toBe(PLACEMENT.FOOTER_ONLY);
  });

  test('pod prvním zobrazením se pozná', () => {
    expect(classifyOccurrence(at({ inViewport: false }))).toBe(PLACEMENT.BELOW_FOLD);
  });

  test('nevykreslené je nevykreslené, i kdyby bylo u chatu', () => {
    // Nejhorší případ: upozornění v HTML, které nikdo neuvidí.
    expect(classifyOccurrence(at({ rendered: false, nearConversation: true })))
      .toBe(PLACEMENT.HIDDEN);
  });

  test('chybějící vstup nespadne', () => {
    expect(classifyOccurrence(undefined)).toBe(PLACEMENT.HIDDEN);
  });
});

describe('souhrn přes všechny výskyty', () => {
  test('rozhoduje NEJLEPŠÍ výskyt, ne první ani nejhorší', () => {
    // Stránka může mít zmínku v patičce i u chatu. Hodnotit nejhorší by
    // vyrábělo nálezy tam, kde je vše v pořádku.
    const result = assessDisclosurePlacement([
      at({ inFooter: true, inViewport: false }),
      at({ nearConversation: true }),
    ]);
    expect(result.placement).toBe(PLACEMENT.PROMINENT);
  });

  test('samá patička zůstane patičkou', () => {
    const result = assessDisclosurePlacement([
      at({ inFooter: true }),
      at({ inFooter: true }),
    ]);
    expect(result.placement).toBe(PLACEMENT.FOOTER_ONLY);
    expect(result.occurrences).toBe(2);
  });

  test('žádný výskyt', () => {
    expect(assessDisclosurePlacement([]).placement).toBe(PLACEMENT.NONE);
    expect(assessDisclosurePlacement(null).placement).toBe(PLACEMENT.NONE);
  });

  test('každý výsledek nese odůvodnění', () => {
    for (const input of [[], [at()], [at({ inFooter: true })], [at({ rendered: false })]]) {
      expect(assessDisclosurePlacement(input).rationale.length).toBeGreaterThan(30);
    }
  });
});

describe('převod na stav povinnosti', () => {
  test('viditelné upozornění je splněno', () => {
    expect(placementToStatus(PLACEMENT.PROMINENT)).toBe('pass');
  });

  test('skryté upozornění JE porušení', () => {
    // Jediný případ, kdy si sken může být jistý: co se nevykresluje,
    // nemůže informovat nikoho.
    expect(placementToStatus(PLACEMENT.HIDDEN)).toBe('fail');
    expect(placementToStatus(PLACEMENT.NONE)).toBe('fail');
  });

  test('patička je NEPRŮKAZNÁ, ne porušení', () => {
    // Jestli patička splňuje „nejpozději při první interakci", je právní
    // otázka. Tvrdit porušení by znamenalo vydávat výklad za měření.
    expect(placementToStatus(PLACEMENT.FOOTER_ONLY)).toBe('inconclusive');
  });

  test('pod ohybem je taky neprůkazné', () => {
    expect(placementToStatus(PLACEMENT.BELOW_FOLD)).toBe('inconclusive');
  });

  test('odůvodnění u patičky přiznává, co sken nerozhodne', () => {
    const result = assessDisclosurePlacement([at({ inFooter: true })]);
    expect(result.rationale).toMatch(/rozhodnout nedokáže|nedokáže/);
  });
});
