/**
 * Deterministický generátor pseudonáhodných čísel.
 *
 * Chaos test se prodával jako testování odolnosti podle DORA, ale injektáž
 * poruch běžela na `Math.random()`. Když test spadne, nedá se zopakovat —
 * a neopakovatelný test není důkaz. Nařízení (EU) 2022/2554 v čl. 25 mluví
 * o testování „na základě jasně definované metodiky", což u nezaznamenaného
 * náhodného vstupu nelze doložit.
 *
 * Použitý algoritmus je mulberry32: 32bitový stavový generátor s periodou
 * 2^32. Na kryptografii je nepoužitelný — a taky k ní není určený. Pro výběr
 * požadavků, které se mají zahodit, je podstatné jen to, že stejný seed dá
 * pokaždé stejnou posloupnost.
 */

/**
 * Převede libovolný řetězec na 32bitový seed (FNV-1a).
 * Stejný řetězec musí dát vždy stejné číslo, jinak by seed nebyl seed.
 */
export function hashSeed(input) {
  let hash = 0x811c9dc5;
  const text = String(input);
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    // FNV prime 16777619, násobení po částech kvůli přesnosti double
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Vytvoří generátor. Vrací funkci `() => number` v intervalu [0, 1).
 *
 * @param {string|number} seed  Cokoli — text i číslo. Text se zahashuje.
 */
export function createSeededRandom(seed) {
  let state = typeof seed === 'number' ? (seed >>> 0) : hashSeed(seed);
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Vyrobí seed pro nový běh, když ho uživatel nezadal.
 *
 * Vrací se ve výsledku auditu, aby šlo běh přesně zopakovat — to je celý
 * smysl téhle změny.
 */
export function generateRunSeed() {
  return `run-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}
