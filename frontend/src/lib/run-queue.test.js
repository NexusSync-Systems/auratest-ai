import { runWithConcurrency, fetchConcurrencyLimit, FALLBACK_CONCURRENCY } from './run-queue.js';

/**
 * Dávkované spouštění skenů.
 *
 * „Komplexní audit" pouštěl všech deset skenů naráz. Server má omezený počet
 * slotů pro prohlížeč, takže přijal dva a zbytek odmítl kódem 429 — uživatel
 * dostal chybovou hlášku místo výsledků, přestože se nic nepokazilo.
 */

const odlozeni = (ms) => new Promise((r) => setTimeout(r, ms));

test('nikdy neběží víc úloh, než dovoluje limit', async () => {
  let bezi = 0;
  let maximum = 0;
  const uloha = () => async () => {
    bezi += 1;
    maximum = Math.max(maximum, bezi);
    await odlozeni(5);
    bezi -= 1;
  };

  await runWithConcurrency(Array.from({ length: 10 }, uloha), 2);
  expect(maximum).toBe(2);
});

test('proběhnou všechny úlohy', async () => {
  const poradi = [];
  const tasks = Array.from({ length: 6 }, (_, i) => async () => {
    poradi.push(i);
    return i;
  });
  const vysledky = await runWithConcurrency(tasks, 3);
  expect(poradi).toHaveLength(6);
  expect(vysledky.map((v) => v.value).sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5]);
});

test('neúspěch jedné úlohy nezastaví ostatní', async () => {
  // Devět skenů nesmí přijít o výsledek kvůli jednomu, který selhal.
  const tasks = [
    async () => 'a',
    async () => {
      throw new Error('timeout');
    },
    async () => 'c',
  ];
  const vysledky = await runWithConcurrency(tasks, 2);
  expect(vysledky.map((v) => v.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
  expect(vysledky[1].reason.message).toBe('timeout');
});

test('nesmyslný limit se nebere doslova', async () => {
  // Limit 0 nebo záporný by znamenal, že se nespustí nic.
  for (const limit of [0, -3, NaN, undefined]) {
    const vysledky = await runWithConcurrency([async () => 1], limit);
    expect(vysledky).toHaveLength(1);
  }
});

test('prázdný seznam nespadne', async () => {
  expect(await runWithConcurrency([], 2)).toEqual([]);
  expect(await runWithConcurrency(null, 2)).toEqual([]);
});

describe('zjištění limitu ze serveru', () => {
  test('přečte se hodnota z /api/capabilities', async () => {
    const fake = async () => ({ ok: true, json: async () => ({ maxConcurrentBrowsers: 5 }) });
    expect(await fetchConcurrencyLimit(fake)).toBe(5);
  });

  test('při potížích se hádá opatrně, ne vysoko', async () => {
    // Hádat vysoko by vrátilo přesně ten problém, kvůli kterému modul vznikl.
    const varianty = [
      async () => {
        throw new Error('síť');
      },
      async () => ({ ok: false }),
      async () => ({ ok: true, json: async () => ({}) }),
      async () => ({ ok: true, json: async () => ({ maxConcurrentBrowsers: 0 }) }),
      async () => ({ ok: true, json: async () => ({ maxConcurrentBrowsers: 'hodně' }) }),
    ];
    for (const fake of varianty) {
      expect(await fetchConcurrencyLimit(fake)).toBe(FALLBACK_CONCURRENCY);
    }
  });
});
