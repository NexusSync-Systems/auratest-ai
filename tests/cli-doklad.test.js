import fs from 'fs';
import path from 'path';
import { PROJECT_ROOT } from '../paths.js';

/**
 * CLI JE BRÁNA, NE DOKLAD — a musí to říct.
 *
 * Kontrolní vlna zjistila, že `bin/auraguard-cli.js` nepíše do neměnného
 * záznamu auditů. Je to mezera, ne nepravda: README CLI nabízí jako
 * bránu pro pipeline. Jenže kdo ho pustí v CI, snadno uvěří, že mu
 * z toho vzniká doklad pro úřad.
 *
 * Zapsat to bez uložení běhu NEJDE: spis iteruje přes běhy, ne přes
 * záznamy, takže položka v řetězu bez protějšku by se ve spisu nikdy
 * neobjevila a důkaz by se ztratil tiše — to je přesně chyba, kterou
 * řešila úloha o pořadí zápisu. Proto se to nedoplňuje, ale ŘÍKÁ.
 *
 * Tenhle test je statický, protože CLI volá `process.exit` a tahá
 * Playwright; spustit ho v jestu by znamenalo skener naostro.
 */
const cli = fs.readFileSync(path.join(PROJECT_ROOT, 'bin', 'auraguard-cli.js'), 'utf8');
const readme = fs.readFileSync(path.join(PROJECT_ROOT, 'README.md'), 'utf8');

describe('CLI přiznává, co neumí', () => {
  test('vypisuje, že nevytváří záznam v řetězu', () => {
    expect(cli).toMatch(/NEVYTVÁŘÍ záznam v neměnném řetězu/);
    // A říká, kudy doložitelný sken spustit.
    expect(cli).toMatch(/přes server/);
  });

  test('to hlášení je na ZAČÁTKU, ne v poznámce po běhu', () => {
    // Kdo pustí audit v pipeline, konec výstupu často nečte — rozhoduje
    // ho návratový kód.
    const pozice = cli.indexOf('NEVYTVÁŘÍ záznam');
    const prvniSken = cli.indexOf('Spouštím: NIS2');
    expect(pozice).toBeGreaterThan(0);
    expect(pozice).toBeLessThan(prvniSken);
  });

  test('README slibuje totéž, ne víc', () => {
    expect(readme).toMatch(/CLI je brána, ne doklad/);
  });

  test('CLI skutečně do záznamu nepíše — jinak je tohle hlášení nepravdivé', () => {
    // Kdyby někdo zápis doplnil a hlášení nechal, nástroj by tvrdil, že
    // doklad NEvzniká, zatímco vzniká. Opačná nepravda, stejná vada.
    expect(cli).not.toMatch(/appendRecord|recordInLedger|audit-ledger/);
  });
});
