/**
 * Odhad uhlíkové stopy načtení stránky.
 *
 * PROČ TENHLE SOUBOR VZNIKL
 * V `agent.js` stálo:
 *
 *     const co2Grams = mbTransferred * 0.81;
 *
 * a výsledek se v reportu tiskl jako „g CO2 / načtení". Tři chyby v jednom
 * řádku:
 *
 *  1. JEDNOTKOVÁ CHYBA. `0.81` není gram CO₂ na megabajt. Je to
 *     `0.81 kWh/GB` — energetická náročnost přenosu dat ze Sustainable Web
 *     Design Model verze 3 (1988 TWh ročně / 2444 EB ročního provozu).
 *     Je to spotřeba ENERGIE na GIGAbajt, ne emise na MEGAbajt. Kód ji
 *     použil jako emisní faktor a ještě na jiné jednotce objemu. Výsledek
 *     v dokumentu pro úřad byl zhruba 5,5× vyšší než co model říká.
 *  2. MÍCHANÉ VELIKOSTI. Sčítalo se `content-length` (bajty na drátě)
 *     s `response.body().length` (bajty po dekompresi). Odpovědi bez
 *     `content-length` — chunked přenos, HTTP/2 — tedy vstupovaly
 *     nafouknuté.
 *  3. VYMYŠLENÁ STUPNICE. Prahy `< 1 g = A`, `< 3 g = C`, jinak
 *     `F (Znečišťující)` neměly v repozitáři ani na webu žádný zdroj.
 *     Známkou v dokumentu pro úřad nálepkujeme cizí web bez opory.
 *
 * CO TU TEĎ JE
 * Sustainable Web Design Model verze 4 — aktuální vydání modelu, celé
 * odvozené z publikovaných čísel, a k tomu JEJICH vlastní hodnoticí
 * stupnice, ne naše.
 *
 * Zůstává to ODHAD, ne měření. Model je atribuční a shora dolů: bere
 * celosvětovou spotřebu energie a dělí ji celosvětovým objemem přenesených
 * dat. O tom, kolik energie spotřebovalo načtení konkrétně téhle stránky,
 * neříká nic. Proto `zdroj`, `predpoklady` a `jeOdhad` cestují spolu
 * s číslem až do reportu — viz `POPIS_MODELU`.
 *
 * ZDROJE (ověřeno 2026-09-17)
 *  • Model, energetické intenzity, uhlíková intenzita sítě:
 *    https://sustainablewebdesign.org/estimating-digital-emissions/
 *  • Hodnoticí stupnice A+…F:
 *    https://sustainablewebdesign.org/digital-carbon-ratings/
 *  • Legacy v3, odkud pochází ono `0.81 kWh/GB`:
 *    https://sustainablewebdesign.org/estimating-digital-emissions-version-3/
 */

/**
 * Energetické intenzity přenosu dat podle SWDM v4, v kWh/GB.
 *
 * Model dělí systém na tři segmenty (datová centra, síť, zařízení
 * uživatele) a u každého odděluje provozní emise od vázaných (výroba
 * hardwaru). Necháváme je rozepsané, protože report má umět ukázat,
 * z čeho číslo vzniklo.
 */
export const INTENZITY_KWH_NA_GB = {
  provozniDatovaCentra: 0.055,
  provozniSit: 0.059,
  provozniZarizeni: 0.080,
  vazaneDatovaCentra: 0.012,
  vazaneSit: 0.013,
  vazaneZarizeni: 0.081,
};

/** Součet všech šesti složek: 0.300 kWh/GB. */
export const INTENZITA_CELKEM_KWH_NA_GB = Object.values(INTENZITY_KWH_NA_GB)
  .reduce((a, b) => a + b, 0);

/**
 * Celosvětový průměr uhlíkové intenzity elektřiny, gCO2e/kWh.
 * SWDM v4 ji bere z datasetu „World" Ember Data Exploreru.
 *
 * Model umožňuje dosadit regionální hodnotu pro PROVOZNÍ emise, pokud je
 * známá. My ji nedosazujeme: kde běží datová centra a odkud se stránka
 * načítá, z jednoho skenu nevíme. Výroba hardwaru je globální dodavatelský
 * řetězec, u vázaných emisí sám model regionální hodnotu nedoporučuje.
 */
export const UHLIKOVA_INTENZITA_G_NA_KWH = 494;

/**
 * Emisní faktor na gigabajt přenesených dat, gCO2e/GB.
 * 0.300 kWh/GB × 494 gCO2e/kWh = 148.2 gCO2e/GB.
 */
export const EMISNI_FAKTOR_G_NA_GB =
  INTENZITA_CELKEM_KWH_NA_GB * UHLIKOVA_INTENZITA_G_NA_KWH;

/**
 * GB = 10⁹ bajtů, ne 2³⁰.
 *
 * Není to kosmetika: stupnice níž je odvozená z HTTP Archive, který počítá
 * v desítkových jednotkách. Kdybychom dělili 1024³, vyšlo by o 7,4 % míň
 * a známka by u hraničních stránek padala na jinou třídu. Původní kód
 * dělil 1024² a výsledek nazýval MB.
 */
export const BAJTU_NA_GB = 1e9;
export const BAJTU_NA_MB = 1e6;

/**
 * Hodnoticí stupnice Sustainable Web Design.
 *
 * Prahy jsou percentily velikosti stránky z crawlu HTTP Archive
 * z 1. června 2023: A+ = 5. percentil, … , E = 50. percentil. Stupnice je
 * záměrně přísná — hranice propadnutí leží na celosvětovém PRŮMĚRU
 * velikosti stránky, takže „F" znamená „nadprůměrně objemná stránka",
 * ne „závada".
 *
 * KLASIFIKUJE SE PODLE BAJTŮ, NE PODLE GRAMŮ
 * Tabulka uvádí obojí, ale primární je sloupec s kilobajty; gramy jsou
 * z něj dopočítané a zaokrouhlené na tři desetinná místa. To zaokrouhlení
 * vyrábí díru: 2419.57 kB dává 0.3586 g, tabulka k témuž řádku píše
 * „≥ 0.360". Stránka mezi 0.359 a 0.360 g by podle sloupce s gramy
 * nespadala nikam. (Zjistil to test v `tests/green-model.test.js` —
 * nechávám ho tam i s tímhle vysvětlením.)
 *
 * Klasifikace podle bajtů odpovídá zdroji stupnice a díra je o tři řády
 * menší: mezi „E ≤ 2419.56 kB" a „F ≥ 2419.57 kB" zbývá devět bajtů,
 * které kód přiřazuje k F. To je naše volba, ne údaj ze zdroje, a test
 * ji tak pojmenovává.
 * Protože zelený hosting nezapočítáváme, jsou gramy bajtům přímo úměrné
 * a obě cesty dávají tentýž výsledek — až na tuhle hranici.
 *
 * `doBajtu` je horní mez včetně. `gramyVTabulce` se needituje ani nepočítá
 * — slouží testu, který ověřuje, že naše odvození reprodukuje publikovaná
 * čísla.
 */
export const STUPNICE_SWD = [
  { znamka: 'A+', doBajtu: 272_510, gramyVTabulce: 0.040, percentil: 5 },
  { znamka: 'A', doBajtu: 531_150, gramyVTabulce: 0.079, percentil: 10 },
  { znamka: 'B', doBajtu: 975_850, gramyVTabulce: 0.145, percentil: 20 },
  { znamka: 'C', doBajtu: 1_410_390, gramyVTabulce: 0.209, percentil: 30 },
  { znamka: 'D', doBajtu: 1_875_010, gramyVTabulce: 0.278, percentil: 40 },
  { znamka: 'E', doBajtu: 2_419_560, gramyVTabulce: 0.359, percentil: 50 },
  { znamka: 'F', doBajtu: Infinity, gramyVTabulce: null, percentil: 100 },
];

/** Známka podle publikované stupnice SWD. `null` pro nečíslo. */
export function hodnoceniSWD(bajtu) {
  if (!Number.isFinite(bajtu) || bajtu < 0) return null;
  return STUPNICE_SWD.find((s) => bajtu <= s.doBajtu).znamka;
}

/**
 * Slovní vysvětlení známky. Bez něj čtenář čte „F" jako vadu.
 */
export function popisHodnoceni(znamka) {
  if (!znamka) return null;
  const stupen = STUPNICE_SWD.find((s) => s.znamka === znamka);
  if (znamka === 'F') {
    return 'Objem přenesených dat je nad celosvětovým průměrem velikosti '
      + 'stránky (2,42 MB). Není to vada ani porušení předpisu — stupnice '
      + 'porovnává objem dat, ne shodu s právní úpravou.';
  }
  return `Objem přenesených dat odpovídá nejlehčím ${stupen.percentil} % `
    + 'stránek v datech HTTP Archive. Je to srovnání objemu dat, '
    + 'ne posouzení shody s předpisem.';
}

/**
 * Popis rozsahu měření — do reportu, vedle čísla.
 *
 * `green` byl jediný skener bez pole `scope`. Chaos, SBOM i ostatní ho
 * mají, protože čtenář musí poznat, co číslo pokrývá. U odhadu, který se
 * tváří jako měření, to platí dvojnásob.
 */
export const POPIS_MODELU = {
  model: 'Sustainable Web Design Model, verze 4',
  zdroj: 'https://sustainablewebdesign.org/estimating-digital-emissions/',
  stupniceZdroj: 'https://sustainablewebdesign.org/digital-carbon-ratings/',
  emisniFaktorGNaGb: EMISNI_FAKTOR_G_NA_GB,
  uhlikovaIntenzitaGNaKwh: UHLIKOVA_INTENZITA_G_NA_KWH,
  jeOdhad: true,
  predpoklady: [
    'Model je atribuční a shora dolů: dělí celosvětovou spotřebu energie '
      + 'celosvětovým objemem přenesených dat. O spotřebě konkrétně tohoto '
      + 'načtení neříká nic.',
    'Použita celosvětová průměrná uhlíková intenzita elektřiny '
      + `(${UHLIKOVA_INTENZITA_G_NA_KWH} gCO2e/kWh). Umístění datových center `
      + 'ani uživatelů se nezohledňuje.',
    'Zelený hosting se nezapočítává (faktor 0) — z jednoho skenu ho '
      + 'nezjistíme. Web na obnovitelné energii má tedy skutečnou stopu nižší.',
    'Počítá se jedno načtení novým návštěvníkem bez mezipaměti. Vratní '
      + 'návštěvníci přenesou méně.',
    'Autoři modelu volí široké hranice systému a sami uvádějí, že model '
      + 'spíš nadhodnocuje.',
  ],
  nepokryva: [
    'skutečnou spotřebu energie serveru, sítě ani zařízení návštěvníka',
    'emise z provozu, který nevznikne načtením stránky (API, zpracování dat)',
    'shodu s jakýmkoli předpisem — stupnice A+ až F je srovnání objemu dat',
  ],
  // Co přesně se sčítá. Bez toho čtenář neví, jestli „1,23 MB" je totéž
  // číslo, jaké mu ukáže panel Network v prohlížeči.
  coSePocita: [
    'bajty těla odpovědi tak, jak je přijal prohlížeč — tedy '
      + 'komprimované, je-li odpověď komprimovaná (`responseBodySize` '
      + 'z Playwrightu)',
    'u odpovědí, které posílají i `content-length`, bývá toto číslo '
      + 'o jednotky procent vyšší — zahrnuje režii přenosu; hlavičky '
      + 'odpovědi se proto nepřičítají zvlášť, aby se režie nezapočetla '
      + 'dvakrát',
    'bajty požadavku (hlavičky a tělo odesílané k serveru) se nepočítají; '
      + 'stejně je nepočítá ani HTTP Archive, ze kterého je odvozená stupnice',
    'odpověď, u níž prohlížeč velikost neohlásí (mimo jiné trefa do '
      + 'mezipaměti), se nesčítá ani jako nula — počítá se zvlášť a výsledek '
      + 'je pak označen jako dolní mez',
    'obsah vložený přímo v HTML přes `data:` URL vlastní požadavek '
      + 'nevytvoří, je součástí objemu rodičovského dokumentu',
  ],
};

/** Jediný tvar neprůkazného výsledku — aby se nelišil podle větve. */
function neprukazne(duvod, { zmerenych, nezmerenych }) {
  return {
    measured: false,
    totalBytes: null,
    totalMb: null,
    co2Grams: null,
    rating: null,
    ratingNote: null,
    uplne: false,
    zmerenychPozadavku: zmerenych,
    nezmerenychPozadavku: nezmerenych,
    duvod,
    scope: POPIS_MODELU,
  };
}

/**
 * Odhad ze změřených bajtů NA DRÁTĚ.
 *
 * @param {number} bajtuNaDrate  součet přenesených bajtů (komprimovaných,
 *   včetně hlaviček), jak je hlásí `request.sizes()`
 * @param {object} [pokryti]
 * @param {number} [pokryti.zmerenychPozadavku]
 * @param {number} [pokryti.nezmerenychPozadavku] požadavky, u nichž se
 *   velikost zjistit nepodařilo. Dokud je > 0, je číslo DOLNÍ ODHAD.
 */
export function odhadniEmise(bajtuNaDrate, pokryti = {}) {
  const zmereno = Number.isFinite(bajtuNaDrate) && bajtuNaDrate >= 0
    ? bajtuNaDrate
    : null;
  const nezmerenych = pokryti.nezmerenychPozadavku || 0;
  const zmerenych = pokryti.zmerenychPozadavku ?? null;

  // Nula změřených požadavků NENÍ velmi lehká stránka.
  //
  // Kontrolní vlna to reprodukovala: `odhadniEmise(0, {zmerenych: 0,
  // nezmerenych: 0})` vracelo `measured: true, co2Grams: 0, rating: 'A+'`.
  // `uplne` se počítalo jen z počtu NEzměřených, takže „nezměřili jsme
  // nic" bylo k nerozeznání od „změřili jsme nejlehčí stránku na webu"
  // — a do dokumentu pro úřad šla nejlepší známka publikované stupnice.
  //
  // Nastane to pokaždé, když prohlížeč žádný požadavek neohlásí:
  // navigace selhala, kontext se zavřel dřív, stránka je jen `data:` URL.
  if (zmerenych === 0) {
    return neprukazne(
      'Prohlížeč neohlásil ani jeden dokončený požadavek, takže objem '
      + 'přenesených dat není z čeho spočítat.',
      { zmerenych, nezmerenych },
    );
  }

  if (zmereno === null) {
    return neprukazne(
      'Objem přenesených dat se nepodařilo změřit.',
      { zmerenych, nezmerenych },
    );
  }

  const gigabajty = zmereno / BAJTU_NA_GB;
  const gramy = gigabajty * EMISNI_FAKTOR_G_NA_GB;
  const uplne = nezmerenych === 0;

  // Známka se tiskne jen z úplného měření. U neúplného je číslo dolní
  // odhad a známka by mohla být o třídu lepší, než jaká patří — to je
  // přesně ten případ „vydávat neprůkazné za splněné".
  const znamka = uplne ? hodnoceniSWD(zmereno) : null;

  return {
    measured: true,
    totalBytes: zmereno,
    totalMb: parseFloat((zmereno / BAJTU_NA_MB).toFixed(2)),
    co2Grams: parseFloat(gramy.toFixed(3)),
    rating: znamka,
    ratingNote: popisHodnoceni(znamka),
    uplne,
    zmerenychPozadavku: zmerenych,
    nezmerenychPozadavku: nezmerenych,
    duvod: uplne
      ? null
      : `U ${nezmerenych} požadavků se velikost zjistit nepodařilo, `
        + 'uvedený objem i odhad emisí jsou proto dolní mez. Známka se '
        + 'z neúplného měření neuvádí.',
    scope: POPIS_MODELU,
  };
}
