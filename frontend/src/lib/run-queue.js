/**
 * Dávkované spouštění skenů.
 *
 * PROČ TO EXISTUJE
 * „Komplexní audit" pouštěl všech deset skenů naráz přes `Promise.allSettled`.
 * Server má ale omezený počet slotů pro prohlížeč (MAX_CONCURRENT_BROWSERS),
 * takže přijal dva a zbytek odmítl kódem 429. Uživatel viděl chybovou hlášku
 * „Server právě zpracovává maximum souběžných testů" — přestože server
 * fungoval přesně tak, jak měl, a nic se nepokazilo.
 *
 * Limit se čte z `/api/capabilities`, aby klient nehádal.
 */

/** Kolik skenů pustit zároveň, když se limit nepodaří zjistit. */
export const FALLBACK_CONCURRENCY = 2;

/**
 * Spustí úlohy s omezenou souběžností.
 *
 * Vrací totéž co `Promise.allSettled` — tedy i neúspěchy, ne výjimku.
 * Jeden neúspěšný sken nesmí shodit zbylých devět.
 *
 * @param {Array<() => Promise<unknown>>} tasks
 * @param {number} limit
 */
export async function runWithConcurrency(tasks, limit = FALLBACK_CONCURRENCY) {
  const list = Array.isArray(tasks) ? tasks : [];
  const size = Math.max(1, Math.floor(limit) || 1);
  const results = new Array(list.length);
  let next = 0;

  const worker = async () => {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= list.length) return;
      try {
        results[i] = { status: 'fulfilled', value: await list[i]() };
      } catch (reason) {
        results[i] = { status: 'rejected', reason };
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(size, list.length) }, worker));
  return results;
}

/**
 * Zjistí, kolik skenů smí běžet zároveň.
 *
 * Při jakémkoli problému vrací opatrnou výchozí hodnotu. Hádat vysoko by
 * vrátilo přesně ten problém, kvůli kterému tenhle modul vznikl.
 */
export async function fetchConcurrencyLimit(fetchImpl = fetch) {
  try {
    const res = await fetchImpl('/api/capabilities');
    if (!res.ok) return FALLBACK_CONCURRENCY;
    const data = await res.json();
    const limit = Number(data?.maxConcurrentBrowsers);
    return Number.isFinite(limit) && limit > 0 ? limit : FALLBACK_CONCURRENCY;
  } catch {
    return FALLBACK_CONCURRENCY;
  }
}
