import { lazy } from 'react';

/**
 * `React.lazy`, které přežije nasazení nové verze.
 *
 * PROBLÉM, KTERÝ TO ŘEŠÍ
 * Vite pojmenovává části bundlu podle otisku obsahu — `PrintReport-H9jzyYzR.js`.
 * Po nasazení se otisk změní a starý soubor ze serveru zmizí. Prohlížeč, který
 * má aplikaci otevřenou od doby PŘED nasazením, si drží starou `index.html`
 * s odkazy na staré názvy. Jakmile uživatel otevře část načítanou až na
 * vyžádání, sáhne po souboru, který už neexistuje:
 *
 *   Failed to fetch dynamically imported module: …/PrintReport-H9jzyYzR.js
 *
 * Uvidí to KAŽDÝ, kdo měl aplikaci otevřenou během nasazení. U nás to
 * potkalo zrovna Doložitelnost — tedy tu část, kvůli které si zákazník
 * nástroj pořizuje.
 *
 * PROČ TLAČÍTKO „ZKUSIT ZNOVU" NESTAČÍ
 * Nestačí a nikdy nemohlo. Chybová obrazovka nabízela opakování, ale ten
 * soubor na serveru není a nebude; opakovaný pokus selže úplně stejně.
 * Prohlížeč si navíc odmítnutý modul pamatuje, takže se ani znovu nezeptá.
 * Jediné, co pomůže, je načíst stránku znovu — tím přijde nová
 * `index.html` s aktuálními názvy.
 *
 * POJISTKA PROTI SMYČCE
 * Kdyby soubor chyběl z jiného důvodu (rozbité nasazení, výpadek disku),
 * znamenalo by automatické načtení nekonečné blikání. Proto se to zkusí
 * JEDNOU za relaci prohlížeče; podruhé se chyba nechá probublat do
 * chybové obrazovky, kde ji uživatel aspoň vidí.
 */

/** Pozná chybu „část bundlu se nepodařilo stáhnout". */
function jeChybaNacteniCasti(err) {
  const zprava = String(err?.message || err || '');
  return (
    /Failed to fetch dynamically imported module/i.test(zprava)
    || /error loading dynamically imported module/i.test(zprava)
    // Safari a Firefox to formulují jinak.
    || /Importing a module script failed/i.test(zprava)
    || /'text\/html' is not a valid JavaScript MIME type/i.test(zprava)
  );
}

/**
 * @param {() => Promise<{default: React.ComponentType}>} importFn
 * @param {string} klic  odlišuje jednotlivé části, aby se pojistka
 *                       nevyčerpala kvůli jiné z nich
 */
export function lazyWithReload(importFn, klic) {
  return lazy(() =>
    importFn().catch((err) => {
      if (!jeChybaNacteniCasti(err)) throw err;

      const pojistka = `reload-po-nasazeni:${klic}`;
      let uzZkouseno = false;
      try {
        uzZkouseno = window.sessionStorage.getItem(pojistka) === '1';
        window.sessionStorage.setItem(pojistka, '1');
      } catch {
        // Bez sessionStorage (soukromý režim, zakázané úložiště) se
        // nenačítá znovu vůbec. Riskovat smyčku je horší než ukázat chybu.
        throw err;
      }

      if (uzZkouseno) throw err;

      // `reload()` bez argumentu vezme index.html znovu podle běžných
      // pravidel; ta se revaliduje, takže přijde aktuální.
      window.location.reload();

      // Reload je asynchronní. Vrácený příslib se schválně nikdy
      // nevyřeší — kdyby se odmítl, mihla by se chybová obrazovka.
      return new Promise(() => {});
    })
  );
}
