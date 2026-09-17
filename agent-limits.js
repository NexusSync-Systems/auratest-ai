/**
 * Stropy na agentní běh — na jednom místě.
 *
 * PROČ TENHLE SOUBOR VZNIKL
 * Výraz
 *
 *     Math.min(Math.max(parseInt(maxSteps) || 10, 1), MAX_AGENT_STEPS)
 *
 * byl v `server.js` zkopírovaný čtyřikrát: spuštění testu, plánovač
 * monitorů, založení monitoru, úprava monitoru. Na pátém místě —
 * `/api/trigger-test` — chyběl a stálo tam prosté `parseInt(maxSteps) || 10`.
 * Jeden požadavek s `maxSteps: 100000` tedy držel slot i Chromium prakticky
 * libovolně dlouho.
 *
 * Totéž u `headless`: čtyři místa ho v produkci vynucovala, `trigger-test`
 * ho bral z těla requestu. Na serveru bez GUI to buď selže, nebo otevře
 * okno, které nikdo nezavře.
 *
 * Kopírovaný výraz se takhle chová vždycky: přidá se šesté místo a někdo
 * ho zapomene. Proto je tu funkce, ne vzor k okopírování — a proto má
 * vlastní test.
 *
 * Je to stejná chyba jako u `green`, který byl jediný skener bez `scope`
 * a jediný, kdo nekontroloval HTTP status. „Všude kromě jednoho místa"
 * je v tomhle repozitáři opakovaný vzorec.
 */

/** Kolik kroků smí agent nejvýš udělat. */
export const MAX_AGENT_STEPS = parseInt(process.env.MAX_AGENT_STEPS, 10) || 50;

/** Kolik kroků dostane běh, který si o počet neřekl. */
export const VYCHOZI_KROKU = 10;

/**
 * Omezí požadovaný počet kroků do rozsahu 1…MAX_AGENT_STEPS.
 *
 * Nesmysl (text, záporné číslo, `undefined`) spadne na výchozí hodnotu —
 * ne na strop. Vyhodit chybu by rozbilo volající, kteří pole neposílají
 * vůbec, a pustit strop by z překlepu udělalo nejdražší možný běh.
 */
export function omezKroky(pozadovano, max = MAX_AGENT_STEPS) {
  const cislo = parseInt(pozadovano, 10);
  const zaklad = Number.isFinite(cislo) && cislo > 0 ? cislo : VYCHOZI_KROKU;
  return Math.min(Math.max(zaklad, 1), max);
}

/**
 * Smí běh otevřít okno prohlížeče?
 *
 * V produkci nikdy — klient si na serveru nesmí otevřít GUI prohlížeč.
 * Mimo produkci je to volba volajícího, protože sledovat běh na obrazovce
 * je při vývoji to nejrychlejší ladění.
 */
export function vynutHeadless(pozadovano, env = process.env) {
  if (env.NODE_ENV === 'production') return true;
  return pozadovano !== false;
}
