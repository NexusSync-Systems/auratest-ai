import fs from 'fs';
import path from 'path';
import { inspectImageBytes, SOURCE_TYPE } from '../c2pa.js';
import { PROJECT_ROOT } from '../paths.js';

/**
 * ČTENÁŘ C2PA PROTI SOUBORU, KTERÝ PODEPSAL NĚKDO JINÝ.
 *
 * Ostatní testy C2PA běží proti bajtům, které jsem napsal já — tedy proti
 * své vlastní představě o tom, jak kontejner JUMBF v souboru vypadá.
 * Hodnoty typu zdroje jsou ověřené proti slovníku IPTC, struktura
 * kontejneru NE. Kdybych se v ní mýlil, testy by se mýlily stejně
 * a nechytily by to.
 *
 * Rozhodnout to může jedině soubor od cizího podepisovatele. Ten se
 * v prostředí, kde tenhle kód vznikal, sehnat nepodařilo: npm registry
 * projde, ale nativní binárka `c2pa-node` se stahuje mimo něj.
 *
 * Test se proto ZAPNE SÁM, jakmile soubor přibude — návod je
 * v `tests/fixtures/c2pa/README.md`. Dokud tam není, hlásí se jako
 * přeskočený, ne jako splněný: „test neběžel" a „kód funguje" jsou dvě
 * různé věci a ta záměna je přesně to, čemu se tenhle nástroj vyhýbá.
 */
// `import.meta` jest (babel-jest, CommonJS) nepodporuje — kořen
// projektu je v `paths.js`, který používá i zbytek nástroje.
const DIR = path.join(PROJECT_ROOT, 'tests', 'fixtures', 'c2pa');

/** Skener čte prvních 64 kB (`Range: bytes=0-65535`) — test dělá totéž. */
const PRVNICH_64KB = 65536;

function nactiHlavicku(jmeno) {
  const soubor = path.join(DIR, jmeno);
  if (!fs.existsSync(soubor)) return null;
  const fd = fs.openSync(soubor, 'r');
  try {
    const buf = Buffer.alloc(PRVNICH_64KB);
    const precteno = fs.readSync(fd, buf, 0, PRVNICH_64KB, 0);
    return new TextDecoder('latin1').decode(buf.subarray(0, precteno));
  } finally {
    fs.closeSync(fd);
  }
}

const pripady = [
  ['podepsany-ai.jpg', SOURCE_TYPE.AI_GENERATED, 'vytvořeno generativní AI'],
  ['podepsany-foto.jpg', SOURCE_TYPE.CAPTURE, 'pořízeno fotoaparátem'],
];

describe('C2PA proti skutečně podepsanému souboru', () => {
  for (const [jmeno, ocekavano, popis] of pripady) {
    const hlavicka = nactiHlavicku(jmeno);
    const test_ = hlavicka === null ? test.skip : test;

    test_(`${jmeno} — manifest se najde a typ zdroje je ${popis}`, () => {
      const v = inspectImageBytes(hlavicka);
      expect(v.hasManifest).toBe(true);
      expect(v.sourceType).toBe(ocekavano);
    });
  }

  test('fixtury chybí — a je to vidět', () => {
    const chybi = pripady
      .map(([jmeno]) => jmeno)
      .filter((jmeno) => !fs.existsSync(path.join(DIR, jmeno)));

    if (chybi.length > 0) {
      // Ne `fail()`. Chybějící fixtura není chyba kódu, je to nedokončené
      // ověření — a to se hlásí nahlas, ne červeně.
      console.warn(
        `[C2PA] Struktura kontejneru zůstává neověřená proti cizímu `
        + `podepisovateli. Chybí: ${chybi.join(', ')}. `
        + `Návod: tests/fixtures/c2pa/README.md`
      );
    }
    expect(Array.isArray(chybi)).toBe(true);
  });
});
