/**
 * Rozlišení „záznam už neexistuje" od skutečné chyby databáze.
 *
 * PROČ TO TU JE
 * `docRef.update()` na smazaném dokumentu vyhodí. V plánovači monitorů to
 * bylo `await db.updateMonitor(...)` uvnitř plovoucího `(async () => {})()`
 * bez `.catch()`, takže smazání monitoru ZA BĚHU skončilo jako
 * unhandledRejection → `shutdownWithError()` → `process.exit(1)`.
 * Jeden uživatel tím zabil rozdělané běhy VŠECH ostatních.
 *
 * Naivní oprava by byla `set(..., {merge:true})`, protože ten na chybějícím
 * dokumentu nevyhodí. Ta je ale horší: smazaný monitor by se tím vzkřísil.
 * Uživatel ho smazal a on by se vrátil. Proto se místo toho chybějící
 * dokument POZNÁ a bere se jako legitimní stav, ne jako chyba.
 *
 * ROZLIŠENÍ MUSÍ BÝT ÚZKÉ. Kdyby se pod „už neexistuje" schovala
 * nedostupná databáze nebo odepřené oprávnění, zápisy by tiše mizely
 * a nikdo by se to nedozvěděl. Proto se rozhoduje podle gRPC kódu 5
 * (NOT_FOUND) a jen sekundárně podle znění, které Firestore u téhle
 * jediné situace posílá.
 */

/** gRPC status NOT_FOUND. */
export const KOD_NENALEZENO = 5;

/**
 * Znění od Firestore Admin SDK, když `update()` narazí na chybějící
 * dokument. Záložní cesta pro případ, že chybí `code` (některé obálky
 * a emulátory ho nepřidají).
 */
const ZNENI_NENALEZENO = /no document to update|not_found|no entity to update/i;

export function jeChybiDokument(err) {
  if (!err) return false;
  if (err.code === KOD_NENALEZENO) return true;
  // Pozor: `code` bývá i řetězec ('5', 'NOT_FOUND').
  const kod = String(err.code ?? '').toUpperCase();
  if (kod === '5' || kod === 'NOT_FOUND') return true;
  // Podle znění jen tehdy, když `code` vůbec není. Se známým jiným kódem
  // by shoda ve zprávě znamenala, že přehlušíme skutečnou chybu.
  if (err.code !== undefined && err.code !== null) return false;
  return ZNENI_NENALEZENO.test(String(err.message ?? ''));
}

/**
 * Zápis, který smí narazit na smazaný záznam.
 *
 * Vrací `null`, když dokument už neexistuje — to je legitimní stav, ne
 * chyba. Skutečné chyby (nedostupná databáze, odepřené oprávnění) letí
 * dál; spolknout je by znamenalo, že zápisy tiše mizí.
 *
 * Tady schválně, ne v `db.js`: ten importuje `firebase-admin`, který se
 * v testovacím prostředí nedá načíst, takže by se tahle podmínka nedala
 * otestovat — a přesně netestovaná spojovací vrstva byla P0.
 */
export async function zapisPokudExistuje(akce) {
  try {
    return await akce();
  } catch (err) {
    if (jeChybiDokument(err)) return null;
    throw err;
  }
}
