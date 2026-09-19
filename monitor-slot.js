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
 * DVĚ ODLIŠNÉ OCHRANY, KTERÉ SE PLETOU DOHROMADY
 * Předchozí verze tohohle komentáře tvrdila, že to celé řeší porovnej-a-
 * zapiš. Neřeší — kontrolní vlna to našla jako P1:
 *
 *  1. **Porovnej-a-zapiš přes `lastRunTime`** brání tomu, aby si TÝŽ
 *     plánovaný slot vzaly dvě instance. Zapiš nový čas jen tehdy, když
 *     `lastRunTime` je pořád ta hodnota ze snímku. Kdo první, ten běží.
 *
 *  2. **Zámek `bezimDo`** brání tomu, aby se překryly DVA RŮZNÉ plánované
 *     sloty téhož monitoru. `lastRunTime` se totiž zapisuje na začátku
 *     běhu a na konci už se neaktualizuje: u intervalu 1 minuta
 *     a desetiminutového běhu je po minutě další slot legitimně na řadě
 *     a porovnej-a-zapiš ho správně propustí, protože se opravdu nic
 *     nezměnilo. Bez zámku by běhy běžely přes sebe.
 *
 * Jedno bez druhého nestačí a ani jedno nenahrazuje to druhé.
 *
 * TŘETÍ VĚC: MEZERA V MĚŘENÍ
 * Když instance skončí (SIGTERM při nasazení, OOM) v okně mezi zápisem
 * rezervace a založením běhu, je `lastRunTime` posunutý, běh se nekonal
 * a session NEEXISTUJE. Hlídač zaseknutých běhů pracuje jen se session
 * v databázi, takže nemá co dopsat: monitor mlčel až do dalšího intervalu
 * — u `24h` celý den — a nikde nebyla stopa, že měření vypadlo. Pro řetěz
 * předkládaný úřadu je to chybějící důkaz bez důkazu o tom, že chybí.
 *
 * Pozná se to takhle: rezervace si do dokumentu zapíše i identifikátor
 * běhu (`bezimSession`). Doběhnutý i spadlý běh ho ve svém `finally`
 * uklidí. Když tedy zámek vypršel a identifikátor v dokumentu pořád je,
 * znamená to, že ten běh nikdy neskončil — proces zemřel. Rezervace to
 * ohlásí jako `mezera` a plánovač na to okno založí záznam „nespuštěno".
 *
 * PROČ JE ROZHODNUTÍ TADY A NE V `db.js`
 * Aby se dalo otestovat bez Firestoru — `db.js` tahá firebase-admin, který
 * jest neumí přeložit, takže se v testech celý podvrhuje a nic v něm se
 * nespustí. Proto tu není jen rozhodnutí, ale i celé tělo transakce
 * (`teloRezervace`): `db.rezervujSlotMonitoru` je už jen obal, který
 * otevře transakci a předá ji sem.
 */

/**
 * Pět možných výsledků pokusu o rezervaci.
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
  /** Předchozí běh téhož monitoru ještě neskončil. */
  BEZI: 'bezi',
  /** Monitor už v databázi není. */
  SMAZANO: 'smazano',
  /** Monitor byl mezitím vypnut. */
  NEAKTIVNI: 'neaktivni',
});

/**
 * Převede hodnotu z databáze na číslo (ms epoch).
 *
 * PROČ TO NENÍ JEN `|| 0`
 * Původní verze porovnávala `data.lastRunTime || 0 !== ocekavany || 0`
 * přísným `!==`. Dokument, který se do kolekce dostal jinudy než přes
 * `createMonitor` (import, ruční zápis, migrace), má ale `lastRunTime`
 * klidně jako Firestore `Timestamp` nebo řetězec. Takovou hodnotu `|| 0`
 * propustí beze změny a `!==` proti číslu pak vyjde VŽDYCKY jako různé:
 * monitor by byl navždy `obsazeno` a nespustil se nikdy. V logu by to
 * navíc vypadalo jako souběh (`lastRunTime se změnil (0 → [object
 * Object])`), ne jako vadný typ — tichá smrt monitoru s falešnou stopou.
 *
 * Nepřevoditelná hodnota se bere jako 0, tedy „neběželo nikdy". Obě
 * strany porovnání procházejí tímhle převodem, takže vyjdou stejně,
 * rezervace projde a zapíše se číslo — dokument se tím sám uzdraví.
 * Cena je nanejvýš jeden běh navíc u vadného dokumentu; alternativou je
 * monitor, který mlčí napořád.
 */
export function jakoCislo(hodnota) {
  if (typeof hodnota === 'number' && Number.isFinite(hodnota)) return hodnota;
  // Firestore Timestamp
  if (hodnota && typeof hodnota.toMillis === 'function') {
    const ms = hodnota.toMillis();
    return Number.isFinite(ms) ? ms : 0;
  }
  if (typeof hodnota === 'string') {
    const ms = Number(hodnota);
    if (Number.isFinite(ms)) return ms;
    const t = Date.parse(hodnota);
    return Number.isFinite(t) ? t : 0;
  }
  return 0;
}

/**
 * Posoudí stav dokumentu přečteného UVNITŘ transakce.
 *
 * @param {object} vstup
 * @param {boolean} vstup.existuje `snapshot.exists`
 * @param {object|undefined} vstup.data `snapshot.data()`
 * @param {number} vstup.ocekavanyLastRun hodnota `lastRunTime` ze snímku,
 *   podle kterého se plánovač rozhodl monitor spustit
 * @param {number} vstup.ted současný čas (ms epoch) — kvůli platnosti zámku
 * @returns {{stav: string, duvod: string}}
 */
export function posudRezervaci({ existuje, data, ocekavanyLastRun, ted }) {
  if (!existuje || !data) {
    return { stav: STAV_SLOTU.SMAZANO, duvod: 'monitor mezitím smazán' };
  }

  // `active !== true`, ne `active === false`: chybějící pole znamená, že
  // o stavu nic nevíme, a spouštět prohlížeč na základě neznámého stavu
  // je horší než monitor nespustit. Tik se opakuje za minutu.
  if (data.active !== true) {
    return { stav: STAV_SLOTU.NEAKTIVNI, duvod: 'monitor mezitím vypnut' };
  }

  // ZÁMEK BĚHU — bez něj se překrývají běhy téhož monitoru.
  //
  // Samotné porovnej-a-zapiš přes `lastRunTime` tohle NEŘEŠÍ, i když to
  // původní komentář tvrdil. `lastRunTime` se zapisuje při rezervaci a na
  // konci běhu se už neaktualizuje. Monitor s intervalem `1m` a agentním
  // během, který trvá deset minut, tedy po minutě splní `now - lastRun >=
  // interval`, porovnej-a-zapiš legitimně projde (nikdo mezitím nic
  // nezměnil) a spustí se DRUHÝ běh souběžně s prvním. Dva prohlížeče,
  // dvě session a dva překrývající se záznamy v řetězu pro úřad.
  //
  // Zámek je proto časově omezený (`bezimDo`), ne booleovský: běžící
  // instance, která spadne nebo dostane SIGTERM, by příznak `bezi: true`
  // nikdy neuklidila a monitor by mlčel navždy. Platnost se odvozuje od
  // stejného stropu, po kterém pojistka odebírá slot prohlížeče, takže
  // zámek nepřežije běh, který už byl násilně ukončen.
  const bezimDo = jakoCislo(data.bezimDo);
  const nyni = jakoCislo(ted);
  if (bezimDo > nyni) {
    return {
      stav: STAV_SLOTU.BEZI,
      duvod: `předchozí běh drží zámek ještě ${Math.round((bezimDo - nyni) / 1000)} s`,
    };
  }

  // MEZERA V MĚŘENÍ — zámek vypršel, ale identifikátor běhu tu pořád je.
  //
  // Doběhnutý i spadlý běh po sobě `bezimSession` uklidí; přežije jen
  // tehdy, když proces zemřel dřív, než se k tomu dostal. Tohle je jediné
  // místo, kde se to dá poznat — zpětně už ne, protože dokument si dřívější
  // stav nepamatuje.
  //
  // Mezera NEBRÁNÍ rezervaci. Nový běh se má spustit; jen se k němu
  // přidá informace, že předchozí okno se nezměřilo.
  const mezera = data.bezimSession
    ? {
      sessionId: String(data.bezimSession),
      // Čas rezervace, která nikdy nedoběhla — začátek nezměřeného okna.
      od: jakoCislo(data.lastRunTime),
    }
    : null;

  // Obě strany přes `jakoCislo`, ne `|| 0` — viz komentář u té funkce.
  const skutecny = jakoCislo(data.lastRunTime);
  const ocekavany = jakoCislo(ocekavanyLastRun);

  if (skutecny !== ocekavany) {
    return {
      stav: STAV_SLOTU.OBSAZENO,
      duvod: `lastRunTime se změnil (${ocekavany} → ${skutecny})`,
      // Mezeru hlásí JEN ten, kdo slot skutečně dostal. Jinak by ji
      // ohlásila každá instance, která o slot marně zabojovala, a do spisu
      // by se týž nezměřený úsek zapsal několikrát.
    };
  }

  return { stav: STAV_SLOTU.REZERVOVANO, duvod: 'slot rezervován', mezera };
}

/**
 * Tělo transakce rezervace — rozhodnutí i pokyn k zápisu.
 *
 * PROČ TO NENÍ V `db.js`
 * Tam to původně bylo a nekryl ho ŽÁDNÝ test: `db.js` tahá firebase-admin,
 * který jest neumí přeložit, takže se v testech celý podvrhuje a tělo
 * transakce se nikdy nespustilo. Hlavička `monitor-slot.test.js` přitom
 * tvrdila „testuje se OBOJÍ". Byl to týž vzorec jako u ostatních nálezů
 * — vytažená funkce otestovaná, spojovací vrstva ne — jen o patro níž
 * a s komentářem, který ho prohlašoval za vyřešený.
 *
 * `t` i `docRef` jsou parametry, takže v testu stačí dvojník s `get`
 * a `update`. Skutečný Firestore k tomu potřeba není.
 *
 * @param {{get: Function, update: Function}} t transakce
 * @param {object} docRef odkaz na dokument monitoru
 */
/**
 * Co se zapisuje při uvolnění zámku po doběhnutí běhu.
 *
 * Vlastní funkce, a ne dvojice polí přímo v `db.js`, protože `db.js` tahá
 * firebase-admin a v testech se celý podvrhuje — cokoli v něm je, nikdo
 * nespustí. Mutační zkouška to ukázala přesně: vynechání `bezimSession`
 * neshodilo jediný test, přestože je to ze všech možných chyb v téhle
 * změně ta nejhorší.
 *
 * Kdyby se totiž nulovalo jen `bezimDo`, přežil by identifikátor běhu po
 * KAŽDÉM úspěšném běhu a příští rezervace by po vypršení zámku ohlásila
 * mezeru v měření. Do spisu pro úřad by se zapsalo „v tomhle okně se
 * neměřilo" u běhu, který proběhl bez chyby. Nástroj by tvrdil nepravdu
 * o vlastním měření — horší než mezeru vůbec nehlásit.
 */
export function poleProUvolneniZamku() {
  return { bezimDo: 0, bezimSession: null };
}

export async function teloRezervace(
  t, docRef, { ocekavanyLastRun, novyCas, zamekDo, zamekSession = null, ted },
) {
  const snap = await t.get(docRef);
  const vysledek = posudRezervaci({
    existuje: snap.exists,
    data: snap.exists ? snap.data() : undefined,
    ocekavanyLastRun,
    ted,
  });

  if (vysledek.stav === STAV_SLOTU.REZERVOVANO) {
    // Všechna tři pole TOUTÉŽ transakcí. Samostatné zápisy by znamenaly
    // okno, ve kterém je slot rezervovaný, ale nezamčený — nebo zamčený
    // bez identifikátoru, takže by se mezera nedala poznat.
    //
    // `null`, ne `undefined`: Firestore `undefined` odmítá.
    t.update(docRef, {
      lastRunTime: novyCas,
      bezimDo: zamekDo,
      bezimSession: zamekSession,
    });
  }
  return vysledek;
}
