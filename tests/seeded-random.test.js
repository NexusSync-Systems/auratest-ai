import { createSeededRandom, hashSeed, generateRunSeed } from '../seeded-random.js';

/**
 * Reprodukovatelnost chaos testu.
 *
 * Injektáž poruch dřív běžela na `Math.random()`. Když test spadl, nešlo ho
 * zopakovat — a co nejde zopakovat, to se nedá doložit ani opravit.
 */

describe('createSeededRandom', () => {
  it('stejný seed dá stejnou posloupnost', () => {
    const a = createSeededRandom('auraguard');
    const b = createSeededRandom('auraguard');
    const seqA = Array.from({ length: 50 }, a);
    const seqB = Array.from({ length: 50 }, b);
    expect(seqA).toEqual(seqB);
  });

  it('jiný seed dá jinou posloupnost', () => {
    const a = Array.from({ length: 20 }, createSeededRandom('seed-a'));
    const b = Array.from({ length: 20 }, createSeededRandom('seed-b'));
    expect(a).not.toEqual(b);
  });

  it('vrací hodnoty v intervalu [0, 1)', () => {
    const next = createSeededRandom(12345);
    for (let i = 0; i < 1000; i++) {
      const v = next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('přijme číslo i řetězec', () => {
    expect(typeof createSeededRandom(42)()).toBe('number');
    expect(typeof createSeededRandom('42')()).toBe('number');
  });

  it('rozdělení je zhruba rovnoměrné', () => {
    // Nejde o test kvality generátoru, ale o pojistku proti chybě, která by
    // injektovala poruchy do všech požadavků nebo do žádného.
    const next = createSeededRandom('rozdeleni');
    const buckets = new Array(10).fill(0);
    const N = 10000;
    for (let i = 0; i < N; i++) buckets[Math.floor(next() * 10)]++;
    for (const count of buckets) {
      expect(count).toBeGreaterThan(N / 10 * 0.8);
      expect(count).toBeLessThan(N / 10 * 1.2);
    }
  });

  it('reprodukuje konkrétní rozhodnutí o injektáži', () => {
    // Přesně to, co dělá runChaosTest: prahové porovnání.
    const decide = (seed) => Array.from({ length: 30 }, createSeededRandom(seed))
      .map((r) => (r < 0.1 ? 'abort' : r < 0.3 ? 'delay' : 'pass'));

    expect(decide('beh-2026-08-20')).toEqual(decide('beh-2026-08-20'));
    expect(decide('beh-2026-08-20')).not.toEqual(decide('beh-2026-08-21'));
  });
});

describe('hashSeed', () => {
  it('je deterministický', () => {
    expect(hashSeed('abc')).toBe(hashSeed('abc'));
  });

  it('různé vstupy dávají různé seedy', () => {
    expect(hashSeed('abc')).not.toBe(hashSeed('abd'));
  });

  it('vrací nezáporné 32bitové celé číslo', () => {
    for (const input of ['', 'a', 'dlouhý řetězec s diakritikou ěščřž', '12345']) {
      const h = hashSeed(input);
      expect(Number.isInteger(h)).toBe(true);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThanOrEqual(0xffffffff);
    }
  });
});

describe('generateRunSeed', () => {
  it('vrací neprázdný řetězec', () => {
    expect(typeof generateRunSeed()).toBe('string');
    expect(generateRunSeed().length).toBeGreaterThan(5);
  });

  it('dva běhy nedostanou stejný seed', () => {
    const seeds = new Set(Array.from({ length: 100 }, generateRunSeed));
    expect(seeds.size).toBe(100);
  });
});
