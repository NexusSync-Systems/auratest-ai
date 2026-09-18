import { describe, test, expect } from 'vitest';
import { popisStavuSite } from './grid-status.js';

/**
 * SIMULOVANÉ ČÍSLO SE NESMÍ TVÁŘIT JAKO MĚŘENÍ.
 *
 * Widget v hlavičce tiskl zeleně „EU Grid: 65 % Zelené (Eco ON)".
 * Backend přitom v téže odpovědi posílá `simulated: true`, `source:
 * 'simulace podle denní doby (žádné reálné měření)'` a `disclaimer`
 * s odkazem na ENTSO-E — a UI z toho nepoužilo nic. Hodnota je natvrdo
 * 65 nebo 20 podle hodiny.
 *
 * V nástroji, který stojí na tom, že netvrdí nic, co nezměřil, to bylo
 * jediné místo se smyšleným číslem podaným jako údaj.
 */
describe('stav sítě — simulace je vidět', () => {
  const simulovany = {
    simulated: true,
    status: 'LOW_CARBON',
    renewablePercentage: 65,
    source: 'simulace podle denní doby (žádné reálné měření)',
    disclaimer: 'Simulovaná hodnota. Pro auditní účely použijte data od ENTSO-E.',
    recommendation: 'Ideální čas pro batch joby.',
  };

  test('slovo „simulace" je v POPISKU, ne schované v tooltipu', () => {
    const s = popisStavuSite(simulovany);
    expect(s.simulace).toBe(true);
    expect(s.text).toMatch(/simulace/i);
    expect(s.text).toMatch(/odhad/i);
    // Tooltip si nikdo nenajede — nesmí být jediným nositelem výhrady.
    expect(s.text).not.toBe('');
  });

  test('simulace nedostane zelenou ani oranžovou', () => {
    // Barva je nejsilnější signál „změřeno". Neutrální šedá říká
    // „tohle není měření" dřív, než kdo přečte text.
    const s = popisStavuSite(simulovany);
    expect(s.barva).not.toBe('#10b981');
    expect(s.barva).not.toBe('#f59e0b');
  });

  test('výhrada z backendu se použije, ne přepíše vlastní', () => {
    expect(popisStavuSite(simulovany).title).toBe(simulovany.disclaimer);
  });

  test('stará odpověď BEZ pole simulated se bere jako simulace', () => {
    // Fail-closed. Chybějící příznak nesmí projít jako naměřený údaj.
    const s = popisStavuSite({ status: 'LOW_CARBON', renewablePercentage: 65 });
    expect(s.simulace).toBe(true);
    expect(s.text).toMatch(/simulace/i);
  });
});

describe('skutečné měření se zobrazí normálně', () => {
  test('simulated: false přepne widget do běžné podoby', () => {
    // Až se napojí ENTSO-E, widget se přepne sám — žádný další zásah.
    const s = popisStavuSite({
      simulated: false, status: 'LOW_CARBON', renewablePercentage: 72,
      source: 'ENTSO-E', recommendation: 'Vhodná doba.',
    });
    expect(s.simulace).toBe(false);
    expect(s.barva).toBe('#10b981');
    expect(s.text).toMatch(/72 % OZE/);
    expect(s.text).not.toMatch(/simulace/i);
    expect(s.title).toMatch(/ENTSO-E/);
  });

  test('vysokouhlíková síť má vlastní barvu i slovo', () => {
    const s = popisStavuSite({ simulated: false, status: 'HIGH_CARBON', renewablePercentage: 20 });
    expect(s.barva).toBe('#f59e0b');
    expect(s.text).toMatch(/vysokouhlíková/);
  });
});

describe('nic k zobrazení se nevykreslí', () => {
  test('prázdná nebo vadná odpověď dá null', () => {
    for (const v of [null, undefined, {}, 'text', { renewablePercentage: 'nic' }]) {
      expect(popisStavuSite(v)).toBeNull();
    }
  });
});
