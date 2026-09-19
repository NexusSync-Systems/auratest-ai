/**
 * Rozhodnutí, jestli smí plánovač monitor spustit.
 *
 * PROČ TO NENÍ JEN `if (now - lastRun >= interval)`
 * Plánovač si monitory přečte hromadně (`getAllActiveMonitors`) a pak je
 * v cyklu jeden po druhém spouští. Mezi čtením snímku a zápisem rezervace
 * uběhne čas — a v něm může kdokoli jiný (druhá instance aplikace, ruční
 * spuštění, uživatel v UI) tentýž monitor spustit, vypnout nebo smazat.
 * Původní kód zapisoval `lastRunTime: now` bez ohledu na to, co v databázi
 * mezitím je. Dva procesy si tak oba mysleli, že slot mají, a monitor běžel
 * dvakrát — dva prohlížeče, dvě session, dva zápisy do řetězu auditů.
 *
 * Rezervace je proto porovnej-a-zapiš (CAS): zapiš nový čas JEN tehdy,
 * když `lastRunTime` je pořád ta hodnota, kterou jsme četli ze snímku.
 * Kdo zapíše první, ten běží; ostatní odejdou s prázdnou.
 *
 * PROČ JE ROZHODNUTÍ TADY A NE V `db.js`
 * Aby se dalo otestovat bez Firestoru. `db.js` kolem toho drží transakci,
 * tenhle modul rozhoduje. Rozdělení má smysl jen tak dlouho, dokud tohle
 * rozhodnutí opravdu nikdo jiný nedělá — proto `db.rezervujSlotMonitoru`
 * žádnou vlastní podmínku nemá a jen sem předává, co v transakci přečetl.
 */

/**
 * Čtyři možné výsledky pokusu o rezervaci.
 *
 * Nejsou to dva stavy s příznakem — každý znamená něco jiného a plánovač
 * na každý reaguje jinak. Slít „obsazeno" a „smazáno" do `false` by
 * znamenalo, že se v logu nepozná zdvojený tik od smazaného monitoru.
 */
export const STAV_SLOTU = Object.freeze({
  /** Slot je náš, monitor se smí spustit. */
  REZERVOVANO: 'rezervovano',
  /** `lastRunTime` se mezitím změnil — běh si vzal někdo jiný. */
  OBSAZENO: 'obsazeno',
  /** Monitor už v databázi není. */
  SMAZANO: 'smazano',
  /** Monitor byl mezitím vypnut. */
  NEAKTIVNI: 'neaktivni',
});

/**
 * Posoudí stav dokumentu přečteného UVNITŘ transakce.
 *
 * @param {object} vstup
 * @param {boolean} vstup.existuje `snapshot.exists`
 * @param {object|undefined} vstup.data `snapshot.data()`
 * @param {number} vstup.ocekavanyLastRun hodnota `lastRunTime` ze snímku,
 *   podle kterého se plánovač rozhodl monitor spustit
 * @returns {{stav: string, duvod: string}}
 */
export function posudRezervaci({ existuje, data, ocekavanyLastRun }) {
  if (!existuje || !data) {
    return { stav: STAV_SLOTU.SMAZANO, duvod: 'monitor mezitím smazán' };
  }

  // `active !== true`, ne `active === false`: chybějící pole znamená, že
  // o stavu nic nevíme, a spouštět prohlížeč na základě neznámého stavu
  // je horší než monitor nespustit. Tik se opakuje za minutu.
  if (data.active !== true) {
    return { stav: STAV_SLOTU.NEAKTIVNI, duvod: 'monitor mezitím vypnut' };
  }

  // `|| 0` na obou stranách: nový monitor má `lastRunTime: 0`, ale dokument
  // založený jinudy (import, ruční zápis) pole mít nemusí. Bez sjednocení
  // by `undefined !== 0` vyhodnotilo první běh jako obsazený a monitor by
  // se nespustil NIKDY.
  const skutecny = data.lastRunTime || 0;
  const ocekavany = ocekavanyLastRun || 0;

  if (skutecny !== ocekavany) {
    return {
      stav: STAV_SLOTU.OBSAZENO,
      duvod: `lastRunTime se změnil (${ocekavany} → ${skutecny})`,
    };
  }

  return { stav: STAV_SLOTU.REZERVOVANO, duvod: 'slot rezervován' };
}
