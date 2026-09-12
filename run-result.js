/**
 * Jediné místo, které převádí výsledek běhu na pole uložené session.
 *
 * PROČ TO TU JE
 * Tenhle převod byl trojmo: `/api/run-test`, crawlerová větev a plánovač
 * monitorů. Každá kopie se rozešla jinak a POKAŽDÉ to znamenalo tvrzení
 * bez opory:
 *
 *   • crawler neposílal `warnings` → otisk výsledku se mezi cestami lišil
 *     a nešel reprodukovat;
 *   • crawler ani monitor neukládaly `ukonceni` → běh useknutý limitem
 *     kroků dostal v reportu zelený odznak „agent na žádný problém
 *     nenarazil" a ve spisu „Bez nálezu" bez jediné výhrady o pokrytí.
 *
 * Obojí našla až kontrolní vlna, obojí je tatáž vada: pole, které MĚNÍ
 * VERDIKT, se na jedné ze tří cest zapomnělo. Dokud je převod na jednom
 * místě, zapomenout se nedá — a `KLICE_ZAZNAMU` to drží testem.
 *
 * Modul je čistý (žádné Firestore, žádný Playwright), aby šel testovat.
 */

/**
 * Pole, která nese uložený běh.
 *
 * Test hlídá, že `zaznamBehu` vrací PŘESNĚ tuhle sadu. Přidat pole bez
 * doplnění sem test shodí — a to je smysl: nové pole se musí propsat na
 * všechny cesty, jinak se jedna z nich bude tvářit líp než ostatní.
 */
export const KLICE_ZAZNAMU = [
  'status',
  'bugs',
  'warnings',
  'runErrors',
  'modelObservations',
  'runNotes',
  'ukonceni',
  'ukonceniPopis',
  'nerozhodnutychKroku',
  'nezmerenoBlokaci',
  'summary',
  'performanceMetrics',
  'generatedScript',
  'videoUrl',
];

/**
 * Nezměřený běh NENÍ `completed`.
 *
 * `completed` znamená ve spisu „výsledek platí". Kdyby sem spadl timeout
 * nebo pád prohlížeče, zapsal by se do neměnného záznamu jako platné
 * zjištění o zákazníkově webu.
 *
 * `measured === false` schválně, ne `!measured`: chybějící pole u staršího
 * nebo cizího tvaru výsledku neznamená „neměřeno".
 */
export function stavBehu(measured) {
  return measured === false ? 'failed' : 'completed';
}

/**
 * Pole session z výsledku běhu.
 *
 * Crawler předává agregované hodnoty pod stejnými jmény, takže sada klíčů
 * je u všech tří cest zaručeně stejná.
 */
export function zaznamBehu(result = {}) {
  return {
    status: stavBehu(result.measured),
    bugs: result.bugs ?? [],
    // Výkonnostní varování nejsou chyby funkčnosti. Dlouho je nečetl
    // žádný konzument, přestože je agent odděloval.
    warnings: result.warnings ?? [],
    // Chyby MĚŘENÍ, držené odděleně od nálezů, aby je nikdo nemohl číst
    // jako zjištění o auditovaném webu.
    runErrors: result.runErrors ?? [],
    // Text rozhodovacího modelu. Není to měření; do verdiktu se nepočítá.
    modelObservations: result.modelObservations ?? [],
    // Okolnosti běhu: kroky bez rozhodnutí modelu, blokace hlídačem.
    runNotes: result.runNotes ?? [],
    // Čím běh skončil. Bez toho spis neodliší „stránka sama hlásí hotovo"
    // od „doběhl limit kroků".
    ukonceni: result.ukonceni ?? null,
    ukonceniPopis: result.ukonceniPopis ?? null,
    // `?? null`, ne `|| 0`: nevím není nula. Nula by tvrdila, že se
    // změřilo, že žádný krok nechyběl.
    nerozhodnutychKroku: result.nerozhodnutychKroku ?? null,
    nezmerenoBlokaci: result.nezmerenoBlokaci ?? null,
    summary: result.summary ?? null,
    performanceMetrics: result.performanceMetrics ?? null,
    generatedScript: result.generatedScript ?? null,
    videoUrl: result.videoUrl ?? null,
  };
}

/**
 * Stav monitoru po běhu.
 *
 * Tři stavy, ne dva. Nezměřený běh není ani „v pořádku", ani „nález" —
 * je to chyba našeho měření a monitor to musí ukázat jako takovou.
 * `lastRunBugsCount` u nezměřeného běhu je 0, protože počet nálezů by
 * u neproběhlého měření byl tvrzení bez opory.
 */
export function stavMonitoru(result = {}) {
  if (result.measured === false) {
    return { lastRunStatus: 'error', lastRunBugsCount: 0 };
  }
  const pocet = Array.isArray(result.bugs) ? result.bugs.length : 0;
  return {
    lastRunStatus: pocet === 0 ? 'success' : 'failure',
    lastRunBugsCount: pocet,
  };
}
