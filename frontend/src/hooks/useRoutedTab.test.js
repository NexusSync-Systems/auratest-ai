import { describe, test, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useRoutedTab } from './useRoutedTab.js';
import { TAB_TO_PATH, PUBLIC_TAB_TO_PATH, DEFAULT_TAB } from '../lib/routes.js';

/**
 * Obrazovka vs. adresní řádek.
 *
 * Dřív se sekce držela jen ve stavu Reactu, takže adresa zůstávala pořád
 * stejná: odkaz na sekci neexistoval, obnovení stránky vrátilo uživatele na
 * začátek a Zpět odešlo z aplikace.
 */

function goTo(path) {
  window.history.replaceState({}, '', path);
}

describe('useRoutedTab', () => {
  beforeEach(() => {
    goTo('/');
  });

  test('adresa určuje obrazovku při startu', () => {
    goTo(TAB_TO_PATH.audit);
    const { result } = renderHook(() => useRoutedTab(true));
    expect(result.current[0]).toBe('audit');
  });

  test('kořen je úvodní stránka a adresa se nemění', () => {
    const { result } = renderHook(() => useRoutedTab(false));
    expect(result.current[0]).toBe('landing');
    expect(window.location.pathname).toBe('/');
  });

  test('přepnutí obrazovky změní adresu', () => {
    const { result } = renderHook(() => useRoutedTab(true));
    act(() => result.current[1]('compare'));
    expect(result.current[0]).toBe('compare');
    expect(window.location.pathname).toBe(TAB_TO_PATH.compare);
  });

  test('Zpět v prohlížeči vrátí předchozí obrazovku', () => {
    const { result } = renderHook(() => useRoutedTab(true));
    act(() => result.current[1]('agent'));
    act(() => result.current[1]('settings'));
    expect(result.current[0]).toBe('settings');

    // popstate simulujeme přímo: jsdom `history.back()` událost nevyvolá
    // synchronně a test by čekal na něco, co nepřijde.
    act(() => {
      goTo(TAB_TO_PATH.agent);
      window.dispatchEvent(new PopStateEvent('popstate', { state: { tab: 'agent' } }));
    });
    expect(result.current[0]).toBe('agent');
  });

  test('stav obrazovky se čte z adresy, ne z event.state', () => {
    // Do historie se lze dostat i bez našeho stavu — obnovením stránky nebo
    // ruční úpravou adresy. Spoléhat na `event.state` by tam selhalo.
    const { result } = renderHook(() => useRoutedTab(true));
    act(() => {
      goTo(TAB_TO_PATH.settings);
      window.dispatchEvent(new PopStateEvent('popstate', { state: null }));
    });
    expect(result.current[0]).toBe('settings');
  });

  test('opakované kliknutí na tutéž obrazovku nepřidá krok do historie', () => {
    const { result } = renderHook(() => useRoutedTab(true));
    act(() => result.current[1]('agent'));
    const lengthAfterFirst = window.history.length;
    act(() => result.current[1]('agent'));
    expect(window.history.length).toBe(lengthAfterFirst);
  });

  test('neznámá adresa zobrazí úvodní stránku a adresa se srovná', () => {
    goTo('/tohle-neexistuje');
    const { result } = renderHook(() => useRoutedTab(false));
    expect(result.current[0]).toBe('landing');
    expect(window.location.pathname).toBe(PUBLIC_TAB_TO_PATH.landing);
  });

  test('query parametry v adrese zůstanou zachované', () => {
    goTo('/?utm_source=email');
    const { result } = renderHook(() => useRoutedTab(false));
    act(() => result.current[1]('sample'));
    expect(window.location.search).toBe('?utm_source=email');
  });
});

describe('přístup podle přihlášení', () => {
  beforeEach(() => {
    goTo('/');
  });

  test('odhlášený uživatel se ze zamčené sekce dostane na přihlášení', () => {
    // Typicky po vypršení session: obrazovka by jinak zůstala viset na /hub
    // s prázdným obsahem a formulář by uživatel musel hledat.
    goTo(TAB_TO_PATH.auraguard);
    const { result } = renderHook(() => useRoutedTab(false));
    expect(result.current[0]).toBe('login');
    expect(window.location.pathname).toBe(PUBLIC_TAB_TO_PATH.login);
  });

  test('přihlášený uživatel z úvodní stránky pokračuje do aplikace', () => {
    const { result } = renderHook(() => useRoutedTab(true));
    expect(result.current[0]).toBe(DEFAULT_TAB);
    expect(window.location.pathname).toBe(TAB_TO_PATH[DEFAULT_TAB]);
  });

  test('přihlášený uživatel neuvízne na přihlašovacím formuláři', () => {
    goTo(PUBLIC_TAB_TO_PATH.login);
    const { result } = renderHook(() => useRoutedTab(true));
    expect(result.current[0]).toBe(DEFAULT_TAB);
  });

  test('ukázkový report zůstane dostupný i po přihlášení', () => {
    // Přesměrovat odsud by bylo protivné: má smysl ji ukázat i zevnitř.
    goTo(PUBLIC_TAB_TO_PATH.sample);
    const { result } = renderHook(() => useRoutedTab(true));
    expect(result.current[0]).toBe('sample');
  });

  test('odhlášený uživatel si ukázku prohlédne bez přesměrování', () => {
    goTo(PUBLIC_TAB_TO_PATH.sample);
    const { result } = renderHook(() => useRoutedTab(false));
    expect(result.current[0]).toBe('sample');
  });
});
