import { jeHlaskaBezObsahu, poznamkaBezObsahu } from '../console-obsah.js';

/**
 * Hláška z konzole bez obsahu.
 *
 * Smoke test proti cloudflare.com vracel jako vadu aplikace:
 *   Detekována chyba v konzoli: "%c%d font-size:0;color:transparent NaN"
 *
 * Prohlížeč to hlásí jako `error` — ověřeno tím, že posluchač jinou
 * úroveň nezapisuje. Jenže po odečtení formátovacích direktiv, stylu
 * a dosazené hodnoty nezbude ani slovo. Nález, se kterým nejde nic
 * dělat, protože neříká nic.
 *
 * NETVRDÍME, že to není závada — to zvenčí nepoznáme. Tvrdíme slabší
 * a jistou věc: hláška bez obsahu není zjištění o webu.
 */
describe('hláška bez čitelného obsahu', () => {
  test('přesné znění ze skutečného běhu', () => {
    expect(jeHlaskaBezObsahu('%c%d font-size:0;color:transparent NaN')).toBe(true);
  });

  test('samé direktivy a styly', () => {
    expect(jeHlaskaBezObsahu('%c%c%c color:red color:blue color:green')).toBe(true);
    expect(jeHlaskaBezObsahu('%s %d  42')).toBe(true);
    expect(jeHlaskaBezObsahu('%o undefined')).toBe(true);
  });
});

/**
 * OPAČNÁ CHYBA JE STEJNĚ VÁŽNÁ.
 *
 * Kdyby pravidlo sáhlo šíř, zamlčelo by skutečné chyby. Proto se
 * uplatní jen na hlášku s formátovací direktivou a jen tehdy, když
 * v ní po odečtení formátování nezbude ani písmeno.
 */
describe('skutečná chyba projde dál jako nález', () => {
  test('stylovaná hláška SE SLOVY zůstává nálezem', () => {
    expect(jeHlaskaBezObsahu('%cSELHALO color:red')).toBe(false);
    expect(jeHlaskaBezObsahu('%cPlatba neprošla font-weight:bold')).toBe(false);
  });

  test('běžná chybová hláška se pravidlem vůbec nezabývá', () => {
    for (const t of [
      'Uncaught TypeError: x is not a function',
      'Failed to load resource',
      'Minified React error #418',
      // Krátká hláška bez direktivy je pořád nález.
      'chyba',
      // Procento bez direktivy (sleva, poměr) nesmí pravidlo spustit.
      'Sleva 50% nebyla uplatněna',
    ]) {
      expect(jeHlaskaBezObsahu(t)).toBe(false);
    }
  });

  test('prázdný a nesmyslný vstup se za nález nevydává ani neschovává', () => {
    for (const t of ['', null, undefined, '   ']) {
      // Bez direktivy → pravidlo mlčí a rozhoduje původní cesta.
      expect(jeHlaskaBezObsahu(t)).toBe(false);
    }
  });

  test('opakované volání dává stejný výsledek', () => {
    // Regulární výraz s příznakem `g` si pamatuje `lastIndex`. Kdyby se
    // nevynuloval, každé druhé volání by vrátilo opak.
    const t = '%c%d font-size:0;color:transparent NaN';
    expect(jeHlaskaBezObsahu(t)).toBe(true);
    expect(jeHlaskaBezObsahu(t)).toBe(true);
    expect(jeHlaskaBezObsahu(t)).toBe(true);
  });
});

describe('poznámka zachovává původní znění', () => {
  test('text je v poznámce k dohledání', () => {
    const p = poznamkaBezObsahu('%c%d font-size:0;color:transparent NaN');
    expect(p).toMatch(/font-size:0;color:transparent/);
    expect(p).toMatch(/neplyne zjištění o webu/);
  });

  test('dlouhá hláška se ustřihne, ne zahodí', () => {
    const p = poznamkaBezObsahu(`%c${'x'.repeat(400)}`);
    expect(p.length).toBeLessThan(300);
    expect(p).toMatch(/…/);
  });
});
