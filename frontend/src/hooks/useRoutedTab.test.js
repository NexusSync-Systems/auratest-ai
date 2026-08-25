import { describe, test, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useRoutedTab } from './useRoutedTab.js';
import { TAB_TO_PATH, DEFAULT_TAB } from '../lib/routes.js';

/**
 * Sekce vs. adresní řádek.
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

  test('adresa určuje sekci při startu', () => {
    goTo(TAB_TO_PATH.audit);
    const { result } = renderHook(() => useRoutedTab());
    expect(result.current[0]).toBe('audit');
  });

  test('kořen se překreslí na cestu výchozí sekce', () => {
    renderHook(() => useRoutedTab());
    expect(window.location.pathname).toBe(TAB_TO_PATH[DEFAULT_TAB]);
  });

  test('přepnutí sekce změní adresu', () => {
    const { result } = renderHook(() => useRoutedTab());
    act(() => result.current[1]('compare'));
    expect(result.current[0]).toBe('compare');
    expect(window.location.pathname).toBe(TAB_TO_PATH.compare);
  });

  test('Zpět v prohlížeči vrátí předchozí sekci', () => {
    const { result } = renderHook(() => useRoutedTab());
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

  test('stav sekce se čte z adresy, ne z event.state', () => {
    // Do historie se lze dostat i bez našeho stavu — obnovením stránky nebo
    // ruční úpravou adresy. Spoléhat na `event.state` by tam selhalo.
    const { result } = renderHook(() => useRoutedTab());
    act(() => {
      goTo(TAB_TO_PATH.settings);
      window.dispatchEvent(new PopStateEvent('popstate', { state: null }));
    });
    expect(result.current[0]).toBe('settings');
  });

  test('opakované kliknutí na tutéž sekci nepřidá krok do historie', () => {
    const { result } = renderHook(() => useRoutedTab());
    act(() => result.current[1]('agent'));
    const lengthAfterFirst = window.history.length;
    act(() => result.current[1]('agent'));
    expect(window.history.length).toBe(lengthAfterFirst);
  });

  test('neznámá adresa zobrazí výchozí sekci', () => {
    goTo('/tohle-neexistuje');
    const { result } = renderHook(() => useRoutedTab());
    expect(result.current[0]).toBe(DEFAULT_TAB);
  });

  test('query parametry v adrese zůstanou zachované', () => {
    goTo('/?utm_source=email');
    const { result } = renderHook(() => useRoutedTab());
    act(() => result.current[1]('audit'));
    expect(window.location.search).toBe('?utm_source=email');
  });
});
