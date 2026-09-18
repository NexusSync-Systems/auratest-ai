import { describe, test, expect } from 'vitest';
import { readFileSync } from 'fs';

/**
 * TROJSTAV SE NESMÍ PROTLAČIT PŘES FALSY TEST.
 *
 * Tahle chyba se opakovala ČTYŘIKRÁT, pokaždé jinde a pokaždé na
 * stejný způsob:
 *
 *   {loc.isEU ? 'EU/EEA' : 'Mimo EU'}
 *   {gdpr.isCompliant ? '#10b981' : '#ef4444'}
 *
 * `null` znamená „nepodařilo se posoudit". V JavaScriptu je ale falsy,
 * takže spadne do větve pro NESPLNĚNO — a neprůkazný výsledek se
 * uživateli ukáže jako doložené porušení. U rezidence dat to znamenalo
 * obvinění z přenosu do třetí země u všech pěti domén ukázkového skenu.
 *
 * Opravovat to po jednom nestačí: pokaždé se opravilo jedno místo a
 * druhé zůstalo. Tenhle test proto hlídá CELOU TŘÍDU — hledá v UI
 * ternární výraz nad polem, které může být `null`.
 *
 * Správně se používá `complianceColor` / `complianceLabel` /
 * `popisUmisteni`, které trojstav umí.
 */

/** Pole, která mohou být `true`, `false`, NEBO `null`. */
const TROJSTAVOVA_POLE = [
  'isCompliant',
  'isEU',
  'isEUCompliant',
  'isResilient',
  'isQuantumSafe',
  'supported',
  'headersComplete',
];

const SOUBORY = [
  'src/App.jsx',
  'src/components/print/PrintReport.jsx',
  'src/components/public/SampleReport.jsx',
];

describe('trojstav v UI', () => {
  for (const soubor of SOUBORY) test(`${soubor} nepoužívá falsy ternár nad trojstavem`, () => {
    // Cesta od kořene projektu — vitest běží z `frontend/`.
    const zdroj = readFileSync(`${process.cwd()}/${soubor}`, 'utf8');
    const nalezy = [];

    for (const pole of TROJSTAVOVA_POLE) {
      // `x.isCompliant ?` — ale NE `x.isCompliant === true ?`,
      // `x.isCompliant != null ?` a podobné, které trojstav ošetřují.
      const vzor = new RegExp(`\\.${pole}\\s*\\?(?!\\.)`, 'g');
      for (const m of zdroj.matchAll(vzor)) {
        const radek = zdroj.slice(0, m.index).split('\n').length;
        nalezy.push(`${soubor}:${radek} — .${pole} ?`);
      }
    }

    expect(nalezy).toEqual([]);
  });
});
