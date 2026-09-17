/**
 * Stropy na agentní běh.
 *
 * PROČ TENHLE TEST EXISTUJE
 * Ne kvůli tomu, že by ta aritmetika byla složitá. Kvůli tomu, že výraz
 * byl zkopírovaný na pět míst v `server.js` a na jednom z nich chyběl —
 * `/api/trigger-test` neměl ani strop na počet kroků, ani vynucený
 * `headless`. Test hlídá chování jedné funkce, kterou teď volají všechna
 * místa; šesté místo si ji buď zavolá, nebo je to vidět v diffu.
 */
import { omezKroky, vynutHeadless, MAX_AGENT_STEPS, VYCHOZI_KROKU } from '../agent-limits.js';

describe('omezKroky', () => {
  test('rozumný požadavek projde beze změny', () => {
    expect(omezKroky(25)).toBe(25);
    expect(omezKroky('25')).toBe(25);
  });

  test('nad stropem se usekne', () => {
    // Přesně tohle drželo slot i Chromium libovolně dlouho.
    expect(omezKroky(100000)).toBe(MAX_AGENT_STEPS);
    expect(omezKroky(MAX_AGENT_STEPS + 1)).toBe(MAX_AGENT_STEPS);
  });

  test('nula a záporné číslo padnou na výchozí, ne na strop', () => {
    // Kdyby nesmysl padal na strop, byl by z překlepu nejdražší běh.
    expect(omezKroky(0)).toBe(VYCHOZI_KROKU);
    expect(omezKroky(-5)).toBe(VYCHOZI_KROKU);
  });

  test('chybějící i nesmyslná hodnota padne na výchozí', () => {
    expect(omezKroky(undefined)).toBe(VYCHOZI_KROKU);
    expect(omezKroky(null)).toBe(VYCHOZI_KROKU);
    expect(omezKroky('spousta')).toBe(VYCHOZI_KROKU);
    expect(omezKroky({})).toBe(VYCHOZI_KROKU);
    expect(omezKroky(NaN)).toBe(VYCHOZI_KROKU);
  });

  test('desetinné číslo se ořízne, nevrátí se zlomek kroku', () => {
    expect(omezKroky(7.9)).toBe(7);
  });

  test('vlastní strop se respektuje', () => {
    expect(omezKroky(40, 5)).toBe(5);
  });
});

describe('vynutHeadless', () => {
  test('v produkci vždy true, ať si klient řekne cokoli', () => {
    // Klient si na serveru nesmí otevřít GUI prohlížeč.
    expect(vynutHeadless(false, { NODE_ENV: 'production' })).toBe(true);
    expect(vynutHeadless(undefined, { NODE_ENV: 'production' })).toBe(true);
  });

  test('mimo produkci rozhoduje volající', () => {
    // Sledovat běh na obrazovce je při vývoji nejrychlejší ladění.
    expect(vynutHeadless(false, { NODE_ENV: 'development' })).toBe(false);
    expect(vynutHeadless(true, { NODE_ENV: 'development' })).toBe(true);
  });

  test('nezadaná hodnota znamená headless i mimo produkci', () => {
    expect(vynutHeadless(undefined, {})).toBe(true);
  });
});
