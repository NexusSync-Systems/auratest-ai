import { useState, useEffect, useCallback } from 'react';
import {
  tabFromPath,
  pathFromTab,
  isProtectedTab,
  DEFAULT_TAB,
} from '../lib/routes';

/**
 * Drží aktivní obrazovku a promítá ji do adresního řádku.
 *
 * Náhrada za `useState('auraguard')`, které adresu neměnilo. Rozhraní je
 * schválně stejné — `[tab, setTab]` — aby se v App.jsx měnil jediný řádek.
 *
 * Proč vlastní hook a ne react-router: obrazovky jsou ploché, je jich osm
 * a nemají parametry. Router by přinesl ~10 kB v bundlu a vlastní model
 * navigace kvůli hrstce tlačítek.
 *
 * Co to řeší:
 *   • odkaz na sekci jde poslat a založit do záložek
 *   • Zpět/Vpřed v prohlížeči přepíná obrazovky místo odchodu z aplikace
 *   • obnovení stránky zůstane tam, kde uživatel byl
 *
 * `pushState` vs `replaceState`: kliknutí v menu je nový krok v historii
 * (push), kdežto srovnání adresy při startu krok navíc není (replace). Jinak
 * by první Zpět jen vrátilo výchozí adresu a nic viditelného by se nestalo.
 *
 * @param {boolean} isAuthenticated je uživatel přihlášený?
 */
export function useRoutedTab(isAuthenticated = false) {
  const [tab, setTabState] = useState(() => {
    if (typeof window === 'undefined') return 'landing';
    return tabFromPath(window.location.pathname);
  });

  // Sjednotit adresu se stavem hned po startu.
  //
  // Uživatel přišel na neznámou cestu — vidí úvodní stránku a adresa má
  // odpovídat tomu, co je na obrazovce. Bez toho by `/neexistuje` a `/`
  // byly dvě adresy pro tutéž věc.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const target = pathFromTab(tab);
    if (window.location.pathname !== target) {
      window.history.replaceState({ tab }, '', target + window.location.search);
    }
    // Prázdné pole závislostí je záměr: tohle je jednorázové srovnání při
    // startu. `tab` se sem schválně nedává — dál už adresu mění setTab a
    // opakované spouštění by přepisovalo historii pod rukama.
  }, []);

  // Po přihlášení pokračovat do aplikace.
  //
  // Přihlášený uživatel nemá co dělat na úvodní stránce ani na
  // přihlašovacím formuláři — je to slepá ulička, ze které by se musel
  // proklikávat zpátky. Ukázkový report se ale nechává: má smysl ho
  // ukázat i po přihlášení.
  useEffect(() => {
    if (typeof window === 'undefined' || !isAuthenticated) return;
    if (tab === 'landing' || tab === 'login') {
      const target = pathFromTab(DEFAULT_TAB);
      window.history.replaceState({ tab: DEFAULT_TAB }, '', target + window.location.search);
      setTabState(DEFAULT_TAB);
    }
  }, [isAuthenticated, tab]);

  // Odhlášený uživatel nemá zůstat na zamčené sekci.
  //
  // Stane se to po vypršení session nebo po odhlášení: obrazovka by jinak
  // zůstala viset na `/hub` s prázdným obsahem a přihlašovací formulář by
  // uživatel musel hledat.
  useEffect(() => {
    if (typeof window === 'undefined' || isAuthenticated) return;
    if (isProtectedTab(tab)) {
      const target = pathFromTab('login');
      window.history.replaceState({ tab: 'login' }, '', target + window.location.search);
      setTabState('login');
    }
  }, [isAuthenticated, tab]);

  // Zpět/Vpřed v prohlížeči.
  //
  // Čte se z adresy, ne z `event.state` — do historie se lze dostat i odjinud
  // (obnovení, ruční úprava adresy) a stav pak chybí.
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const onPopState = () => setTabState(tabFromPath(window.location.pathname));
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const setTab = useCallback((next) => {
    setTabState((prev) => {
      const value = typeof next === 'function' ? next(prev) : next;
      if (typeof window !== 'undefined') {
        const target = pathFromTab(value);
        // Znovu kliknout na obrazovku, na které už jsem, nemá plodit záznam
        // v historii — jinak Zpět jen bliká na stejném místě.
        if (window.location.pathname !== target) {
          window.history.pushState({ tab: value }, '', target + window.location.search);
        }
      }
      return value;
    });
  }, []);

  return [tab, setTab];
}
