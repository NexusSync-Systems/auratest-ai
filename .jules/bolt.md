## 2024-06-11 - React Polling Re-renders s Fetch API
**Learning:** `fetch().then(res => res.json())` vrací vždy novou referenci pole (i když jsou data identická z pohledu obsahu). Pokud tuto novou referenci bezmyšlenkovitě vložíme do React state pomocí polling intervalu (např. každých 5s), způsobíme masivní re-renderování celého stromu komponent každých 5s. Zvláště u velkých komponent jako `App.jsx` (1000+ řádků s hlubokým dom) to má razantní dopad na paměť a využití CPU i v naprostém idle režimu.
**Action:** Pro polling datových polí z API, které se nemusí změnit, je kritické před nastavením stavu provést porovnání obsahu (`JSON.stringify` nebo deep check) a v případě shody vrátit původní referenci (`return prev`).

## 2024-11-20 - Paralelní načítání a zpracování Playwright stránek
**Learning:** Načítání a scrapování dvou a více nezávislých stránek sekvenčně (`await page1.goto(...)`, potom `await page2.goto(...)`) výrazně prodlužuje dobu provádění. V kontextu porovnávání stránek, kde Playwright typicky čeká na plné načtení sítě (`networkidle`), sekvenční přístup zbytečně blokuje test a zdvojnásobuje délku procesu.
**Action:** Pro porovnávání nebo nezávislé extrakce z více stránek, je potřeba využívat `Promise.all` nebo `Promise.allSettled`, čímž se odstartuje I/O blokované čekání asynchronně a paralelně pro obě (všechny) instance. Zásadně se tak sníží latence.
