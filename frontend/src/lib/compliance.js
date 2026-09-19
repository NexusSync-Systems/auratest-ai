/**
 * Tříhodnotový výsledek compliance kontroly.
 *
 * Skenery vracejí `isCompliant: true | false | null`, kde `null` znamená
 * NEPRŮKAZNÉ — kontrola neproběhla dost spolehlivě na to, aby se z ní dal
 * vyvodit závěr (typicky prázdný SBOM u bundlované aplikace nebo AI Act
 * skener, který nevidí server-side integrace).
 *
 * Dřív UI používalo ternární operátor `isCompliant ? zelená : červená`,
 * takže se neprůkazný výsledek vybarvil jako FAIL. To je pro compliance
 * report stejně zavádějící jako ho vybarvit jako PASS — jen opačným směrem.
 */
export const COMPLIANCE = {
  PASS: 'pass',
  FAIL: 'fail',
  INCONCLUSIVE: 'inconclusive',
};

export function complianceState(isCompliant) {
  if (isCompliant === null || isCompliant === undefined) return COMPLIANCE.INCONCLUSIVE;
  return isCompliant ? COMPLIANCE.PASS : COMPLIANCE.FAIL;
}

/** Barva pro daný stav; neprůkazné je jantarové, ne červené. */
export function complianceColor(isCompliant) {
  switch (complianceState(isCompliant)) {
    case COMPLIANCE.PASS: return '#10b981';
    case COMPLIANCE.FAIL: return '#ef4444';
    default: return '#f59e0b';
  }
}

/** Třída pro tiskový report. */
export function complianceBadgeClass(isCompliant) {
  switch (complianceState(isCompliant)) {
    case COMPLIANCE.PASS: return 'success';
    case COMPLIANCE.FAIL: return 'error';
    default: return 'warning';
  }
}

/**
 * Stav jednotlivé povinnosti AI Actu (`pass` / `fail` / `inconclusive` /
 * `not_applicable`) na tříhodnotový model výš.
 */
export function obligationToCompliance(status) {
  if (status === 'pass') return true;
  if (status === 'fail') return false;
  return null; // inconclusive i not_applicable
}

/** Popisek stavu povinnosti — `not_applicable` má vlastní znění. */
export function obligationLabel(status) {
  if (status === 'not_applicable') return 'Netýká se';
  return complianceLabel(obligationToCompliance(status));
}

/** Barva stavu povinnosti; `not_applicable` je neutrální šedá. */
export function obligationColor(status) {
  if (status === 'not_applicable') return '#94a3b8';
  return complianceColor(obligationToCompliance(status));
}

/**
 * Post-kvantová výměna klíčů má vlastní škálu.
 *
 * Její absence dnes NENÍ porušení žádného předpisu — je to doporučení proti
 * strategii „sesbírej teď, dešifruj později". Vybarvit ji červeně jako
 * „Nesplněno" bylo přísnější než CLI, které u téhož čísla hlásí „DOPORUČENÍ",
 * a v compliance reportu to vypadalo jako závada.
 */
export function pqcLabel(supported) {
  if (supported === true) return 'Nasazeno';
  if (supported === false) return 'Doporučeno nasadit';
  return 'Neprůkazné';
}

export function pqcColor(supported) {
  if (supported === true) return '#10b981';
  return '#f59e0b'; // false i null jsou jantarové — ani jedno není závada
}

/** Krátký textový štítek — informace nesmí být nesena jen barvou. */
export function complianceLabel(isCompliant) {
  switch (complianceState(isCompliant)) {
    case COMPLIANCE.PASS: return 'Splněno';
    case COMPLIANCE.FAIL: return 'Nesplněno';
    default: return 'Neprůkazné';
  }
}

/**
 * Odolnostní experiment NENÍ předpisová kontrola.
 *
 * `complianceLabel(true)` tiskne „Splněno". Chaos test ale žádné pravidlo
 * neověřuje — `audit-scope.js` mu ze stejného důvodu dává `ok: null`
 * a do spisu píše, že z něj splnění ani porušení neplyne. Tiskový report
 * přesto vedle jeho výsledku tiskl zelené „[Splněno]", takže dokument
 * pro úřad tvrdil splnění povinnosti, kterou nikdo neměřil — a spis
 * o témže běhu tvrdil opak.
 *
 * Slovník je proto vlastní: mluví o chování v experimentu, ne o shodě.
 */
export function odolnostLabel(isResilient) {
  if (isResilient === true) return 'Odolala v experimentu';
  if (isResilient === false) return 'Neodolala';
  return 'Neprůkazné';
}

/**
 * Barva podle výsledku experimentu, ne podle shody.
 *
 * `true` zůstává zelená: aplikace skutečně přežila injektované poruchy,
 * to je změřený fakt. Text vedle ní ale nesmí říkat „Splněno" a sekce
 * musí uvést, že z experimentu předpisový závěr neplyne.
 */
export function odolnostBadgeClass(isResilient) {
  if (isResilient === true) return 'success';
  if (isResilient === false) return 'error';
  return 'warning';
}

/**
 * Uhlíková stopa NENÍ předpisová kontrola.
 *
 * Stupnice A+ až F pochází ze Sustainable Web Design a porovnává objem
 * přenesených dat s percentily HTTP Archive. Žádný z předpisů, které
 * nástroj kontroluje, velikost stránky neupravuje — „F" tedy znamená
 * „nadprůměrně objemná stránka", ne závadu.
 *
 * ODZNAK JE PROTO VŽDY NEUTRÁLNÍ.
 * První verze téhle funkce vracela `error` pro E a F a `success` pro
 * A+/A/B — tedy přesně to, co komentář nad ní zakazoval. V tiskovém
 * reportu pak stál červený odznak „Eko třída: F" dva odznaky nad
 * červeným „GDPR Rezidence [Nesplněno]", se stejnou třídou a stejnou
 * barvou. Čtenář-úředník čte dva nálezy, ačkoli jeden z nich je
 * srovnání velikosti stránky s percentilem.
 *
 * Rozlišuje tedy písmeno a věta `ratingNote` vedle něj, ne barva.
 * Platí to i pro tři různé „bez známky" stavy (neúplné měření,
 * nezměřeno, starý záznam) — každý má vlastní text.
 */

/**
 * Běh uložený před opravou modelu se pozná podle chybějícího `scope`.
 *
 * Takový záznam nese známku z vymyšlené stupnice („A (Zelený)",
 * „F (Znečišťující)") a číslo spočítané s jednotkovou chybou. Přebarvit
 * ji podle nové stupnice by znamenalo vydávat staré číslo za nové —
 * stejná chyba jako u otisků, kde starý záznam ověřený novým předpisem
 * vycházel jako zmanipulovaný.
 *
 * Starou známku proto neukazujeme vůbec a řekneme proč.
 */
export function jeStaryEkoZaznam(green) {
  return Boolean(green) && !green.scope;
}

export const EKO_STARY_ZAZNAM =
  'Běh je z doby před opravou výpočtu uhlíkové stopy. Tehdejší číslo '
  + 'i známka vznikly z nesprávně použité konstanty, takže se neuvádějí. '
  + 'Nový sken je vrátí.';

export function ekoTridaLabel(rating, green) {
  if (green !== undefined && jeStaryEkoZaznam(green)) return 'Neuvádí se';
  return rating || 'Neurčena';
}

/** Vždy `neutral` — viz komentář výš. Argumenty zůstávají kvůli volajícím. */
export function ekoTridaBadgeClass() {
  return 'neutral';
}

/** Barva k neutrálnímu odznaku. Ani zelená, ani červená. */
export function ekoTridaColor() {
  return '#64748b';
}

/**
 * Jak vypsat samotné číslo.
 *
 * Čtyři stavy, ne jeden: starý záznam, nezměřeno, změřeno částečně
 * (dolní mez) a změřeno celé. Dřív se všechny tiskly stejně —
 * nezměřený objem vyšel jako „0 MB, 0 g CO2", což je tvrzení o webu,
 * ne o měření.
 */
export function ekoHodnoty(green) {
  if (jeStaryEkoZaznam(green)) {
    return {
      data: 'Neuvádí se',
      emise: 'Neuvádí se',
      dolniMez: false,
      vyhrada: EKO_STARY_ZAZNAM,
    };
  }
  if (!green || green.measured === false) {
    return {
      data: 'Nezměřeno',
      emise: 'Nezměřeno',
      dolniMez: false,
      vyhrada: green?.duvod || 'Objem přenesených dat se nepodařilo změřit.',
    };
  }
  const dolniMez = green.uplne === false;
  const predpona = dolniMez ? 'nejméně ' : '';
  return {
    data: `${predpona}${green.totalMb} MB`,
    emise: `${predpona}${green.co2Grams} g CO₂e`,
    dolniMez,
    vyhrada: green.duvod || null,
  };
}

/**
 * Rozpad objemu na vlastní a jiné domény — do reportu.
 *
 * Vrací `null`, když se rozdělit nedalo. Volající pak nesmí nic tisknout:
 * „0 % z jiných domén" nad neúspěšným měřením je pochvala, kterou nikdo
 * nezměřil.
 */
export function ekoPuvod(green) {
  const p = green?.puvod;
  if (!p || p.rozdeleno !== true) return null;
  const mb = (b) => `${(b / 1e6).toFixed(2)} MB`;
  return {
    vlastni: mb(p.vlastniBajtu),
    cizi: mb(p.ciziBajtu),
    podil: `${p.podilCizichProcent} %`,
    cizichDomen: p.cizichDomen,
    vlastnichDomen: p.vlastnichDomen,
    nejvetsi: (p.nejvetsiCizi || []).map((c) => ({
      domena: c.domena,
      objem: mb(c.bajtu),
      pozadavku: c.pozadavku,
    })),
    pravidlo: p.pravidlo,
    // Když bylo měření neúplné, je neúplný i jmenovatel podílu.
    dolniMez: green.uplne === false,
  };
}

/**
 * Jak popsat umístění jedné domény.
 *
 * DVA NÁLEZY V JEDNÉ VĚTĚ
 *
 * 1) `isEU: null` NENÍ „mimo EU". Na obrazovce stálo
 *
 *        {loc.isEU ? 'EU/EEA' : 'Mimo EU'}
 *
 *    a `null` je falsy, takže KAŽDÁ neposouzená doména se uživateli
 *    vypsala jako „Mimo EU" — tedy jako doložené porušení GDPR — zatímco
 *    verdikt kousek nad tím správně hlásil „neprůkazné". U ukázkového
 *    skenu se to týkalo všech pěti domén. Tiskový report tuhle opravu
 *    dostal dřív; obrazovka ne.
 *
 * 2) ZEMĚ SE NETISKNE HOLÁ. Vypadalo to takhle:
 *
 *        www.cloudflare.com (US) — za CDN, umístění dat z IP určit nelze
 *
 *    Jedna věta uvede zemi a hned vedle řekne, že zemi z IP určit nelze.
 *    Čtenáři zůstane „US". To „US" přitom pochází z geolokační databáze,
 *    tedy ze zdroje, který u adres za CDN sami prohlašujeme za
 *    nespolehlivý. Údaj se proto neskrývá, ale pojmenuje se, odkud je
 *    a co znamená.
 *
 * Společná funkce pro obrazovku i tisk, aby se příště neopravovalo
 * jedno místo ze dvou.
 *
 * @param {object} loc položka z `residency.locations`
 * @returns {{domena: string, popis: string, stav: boolean|null}}
 */
export function popisUmisteni(loc) {
  const domena = loc?.domain || 'neznámá doména';
  const stav = loc?.isEU === true ? true : (loc?.isEU === false ? false : null);

  if (stav === true) return { domena, stav, popis: `EU/EHP (${loc.country})` };
  if (stav === false) return { domena, stav, popis: `mimo EU/EHP (${loc.country})` };

  if (loc?.onCdn) {
    const kdo = loc.cdnProvider || 'neurčený poskytovatel';
    // Zemi z geolokace uvádíme JEN s tím, co doopravdy znamená:
    // adresu nejbližšího uzlu, ne místo uložení dat.
    const zGeo = loc.country
      ? ` Geolokace ukazuje na ${loc.country}, což je nejbližší uzel sítě, ne místo uložení dat.`
      : '';
    return { domena, stav, popis: `za CDN (${kdo}) — umístění dat z IP určit nelze.${zGeo}` };
  }

  return { domena, stav, popis: 'umístění se nepodařilo určit' };
}

/**
 * Stav jedné bezpečnostní hlavičky slovy.
 *
 * `agent.js` vrací u `hsts` a `csp` TROJSTAV — `true` / `false` / `null` —
 * a u `null` výslovně zdůvodňuje proč: na nešifrovaném spojení prohlížeč
 * HSTS ignoruje, takže její absence není volbou provozovatele a nálezem
 * být nemůže. Tiskový report to zplošťoval ternárním operátorem
 * `hsts ? 'Aktivní' : 'Chybí'`; `null` je falsy, takže v dokumentu pro
 * úřad stálo „Chybí" o hlavičce, kterou nikdo neměřil.
 *
 * `false` navíc znamená dvě různé věci: hlavička chybí, nebo je přítomná
 * a nechrání (`Referrer-Policy: unsafe-url`, CSP s `unsafe-inline`).
 * Agent to rozlišuje v `weakHeaders`; report to má tisknout taky, protože
 * provozovatel podle toho ví, jestli hlavičku doplnit, nebo opravit.
 *
 * PŘESUNUTO Z `PrintReport.jsx` PO KONTROLNÍ VLNĚ. Obrazovka tuhle
 * funkci neměla a tiskla `{nis2.hsts ? 'Aktivní' : 'Chybí'}`. `hsts`
 * je ale trojstav a `agent.js` ho u nedostupné stránky nastavuje na
 * `null` výslovně — takže web za bot-ochranou i každý web na `http://`
 * dostal na obrazovce červené „HSTS: Chybí". Právě to je vada, kvůli
 * které ta funkce v tisku vznikla: „zákazník, který CSP nastavenou MÁ,
 * dostal ve spisu prokázané porušení."
 *
 * Počtvrté týž vzorec (rezidence, cookie verdikt, teď hlavičky), a
 * potřetí ve prospěch obvinění. Proto je znění společné.
 */
export function headerStateLabel(ok, label, nis2) {
  if (ok === true) return 'Aktivní';
  if (ok === null || ok === undefined) return 'Nelze posoudit';
  if (nis2?.weakHeaders?.includes(label)) return 'Přítomná, ale nechrání';
  if (nis2?.missingHeaders?.includes(label)) return 'Chybí';
  // Starší uložený běh nová pole nemá. „Chybí" by pak bylo tvrzení
  // o webu, který hlavičku klidně má — jen ji má neúčinnou. Neutrální
  // znění říká jen to, co `false` skutečně znamená.
  return 'Nesplněno';
}
