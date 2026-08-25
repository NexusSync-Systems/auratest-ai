import { useState, useEffect, useCallback } from 'react';
import { tabFromPath, pathFromTab, DEFAULT_TAB } from '../lib/routes';

/**
 * Drží aktivní sekci a zároveň ji promítá do adresního řádku.
 *
 * Náhrada za `useState('auraguard')`, které adresu neměnilo. Rozhraní je
 * schválně stejné — `[tab, setTab]` — aby se v App.jsx měnil jediný řádek.
 *
 * Proč vlastní hook a ne react-router: sekce jsou ploché, je jich pět a nemají
 * parametry. Router by přinesl ~10 kB v bundlu a vlastní model navigace kvůli
 * pěti tlačítkům.
 *
 * Co to řeší:
 *   • odkaz na sekci jde poslat a založit do záložek
 *   • Zpět/Vpřed v prohlížeči přepíná sekce místo odchodu z aplikace
 *   • obnovení stránky zůstane tam, kde uživatel byl
 *
 * `pushState` vs `replaceState`: kliknutí v menu je nový krok v historii
 * (push), kdežto srovnání adresy při startu — třeba `/` na `/hub` — krok
 * navíc není (replace). Jinak by první Zpět jen vrátilo `/` a nic viditelného
 * by se nestalo.
 */
export function useRoutedTab() {
  const [tab, setTabState] = useState(() => {
    if (typeof window === 'undefined') return DEFAULT_TAB;
    return tabFromPath(window.location.pathname);
  });

  // Sjednotit adresu se stavem hned po startu.
  //
  // Uživatel přišel na `/` nebo na neznámou cestu — v obou případech vidí
  // výchozí sekci a adresa má odpovídat tomu, co je na obrazovce. Bez toho by
  // `/` a `/hub` byly dvě adresy pro tutéž věc.
  //
  // `replaceState`, ne push: srovnání adresy není krok, který by měl jít
  // vrátit tlačítkem Zpět.
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
        // Znovu kliknout na sekci, ve které už jsem, nemá plodit záznam
        // v historii — jinak Zpět jen bliká na stejné obrazovce.
        if (window.location.pathname !== target) {
          window.history.pushState({ tab: value }, '', target + window.location.search);
        }
      }
      return value;
    });
  }, []);

  return [tab, setTab];
}
