/**
 * Čtení Content Credentials (C2PA) z hlavičky obrázku.
 *
 * PROČ NE ÚPLNÝ PARSER
 * Plné čtení C2PA znamená rozebrat JUMBF kontejner, dekódovat CBOR a ověřit
 * podpis COSE. To je knihovna sama pro sebe a její výsledek by stejně
 * nepřinesl víc, než co potřebujeme: JESTLI je obsah označený jako
 * vytvořený AI.
 *
 * Manifest obsahuje typ zdroje jako identifikátor ze slovníku IPTC, uložený
 * jako obyčejný řetězec. Ten se dá najít i bez dekódování — a co se najde,
 * je skutečně v manifestu, ne odhad.
 *
 * CO Z TOHO NEPLYNE
 * Nálezem se NEOVĚŘUJE podpis. Manifest tvrdí, co tvrdí; jeho pravost
 * a neporušenost by vyžadovala kryptografické ověření proti důvěryhodnému
 * kořeni. Report to musí říct, jinak by z „obrázek se hlásí jako pořízený
 * fotoaparátem" udělal „obrázek pořízený fotoaparátem".
 *
 * A hlavně: absence manifestu neznamená, že obsah JE syntetický. Většina
 * fotografií na světě žádné pověření nemá.
 */

/** Typ zdroje podle slovníku IPTC (cv.iptc.org/newscodes/digitalsourcetype). */
export const SOURCE_TYPE = {
  /** Vytvořeno generativním modelem. */
  AI_GENERATED: 'ai-generated',
  /** Kombinace skutečného záznamu a generovaného obsahu. */
  AI_COMPOSITE: 'ai-composite',
  /** Vytvořeno algoritmem, ale ne trénovaným modelem (např. render). */
  ALGORITHMIC: 'algorithmic',
  /** Pořízeno zařízením. */
  CAPTURE: 'capture',
  /**
   * Typ zdroje je ve slovníku, ale o generativní AI nerozhoduje.
   * IPTC u něj výslovně říká „may or may not be generative AI".
   */
  AMBIGUOUS: 'ambiguous',
  /** Typ zdroje je přečtený a generativní AI to není. */
  NOT_AI: 'not-ai',
  /** Manifest je, ale typ zdroje se v načtené části nenašel. */
  UNKNOWN: 'unknown',
  /** Manifest není. */
  NONE: 'none',
};

/**
 * Identifikátory IPTC, jak se v manifestu vyskytují.
 *
 * ODKUD TA TABULKA JE
 * Ze slovníku samotného: http://cv.iptc.org/newscodes/digitalsourcetype/,
 * staženo 18. 9. 2026. Původní verze měla PĚT hodnot, které jsem napsal
 * z hlavy, a slovník jich má dvacet. To není kosmetická mezera:
 *
 *   `compositeSynthetic` — „Composite including generative AI elements /
 *   Mix or composite of several elements, at least one of which is
 *   Generative AI"
 *
 * je podle IPTC označení generativní AI, a v našem seznamu chyběl. Obrázek
 * s tímhle pověřením skončil jako „typ zdroje se nepodařilo přečíst",
 * takže se NEZAPOČÍTAL mezi označený syntetický obsah — přesně ten údaj,
 * na kterém stojí posouzení čl. 50 odst. 2. Označení existovalo a my
 * jsme napsali, že nevíme.
 *
 * POŘADÍ JE PODSTATNÉ.
 * Hledá se podřetězec, takže obecnější hodnota nesmí stát před užší:
 * `composite` je podřetězcem `compositeSynthetic` i `compositeCapture`.
 * Proto se dlouhé zkoušejí první a `composite` je až úplně poslední.
 */
export const SOURCE_MARKERS = [
  // Generativní AI — o tyhle jde v čl. 50 odst. 2.
  ['compositeWithTrainedAlgorithmicMedia', SOURCE_TYPE.AI_COMPOSITE],
  ['compositeSynthetic', SOURCE_TYPE.AI_COMPOSITE],
  ['trainedAlgorithmicMedia', SOURCE_TYPE.AI_GENERATED],

  // Algoritmus bez trénování — render, matematická formule.
  ['algorithmicallyEnhanced', SOURCE_TYPE.NOT_AI],
  ['algorithmicMedia', SOURCE_TYPE.ALGORITHMIC],

  // Záznam skutečnosti.
  ['computationalCapture', SOURCE_TYPE.CAPTURE],
  ['compositeCapture', SOURCE_TYPE.CAPTURE],
  ['digitalCapture', SOURCE_TYPE.CAPTURE],
  ['negativeFilm', SOURCE_TYPE.CAPTURE],
  ['positiveFilm', SOURCE_TYPE.CAPTURE],

  // Přečtené, ale generativní AI to není.
  ['digitalCreation', SOURCE_TYPE.NOT_AI],
  ['minorHumanEdits', SOURCE_TYPE.NOT_AI],   // vyřazeno 2024, může být ve starších souborech
  ['humanEdits', SOURCE_TYPE.NOT_AI],
  ['dataDrivenMedia', SOURCE_TYPE.NOT_AI],
  ['screenCapture', SOURCE_TYPE.NOT_AI],

  // Slovník sám říká, že o AI nerozhodují. Vydávat je za „není to AI"
  // by bylo tvrzení, které IPTC výslovně nedává.
  //   virtualRecording: „based on Generative AI and/or captured elements"
  //   composite:        „any of which may or may not be generative AI"
  ['virtualRecording', SOURCE_TYPE.AMBIGUOUS],
  ['composite', SOURCE_TYPE.AMBIGUOUS],
];

/**
 * Identifikátory, které kód posuzuje — jen ty, nic navíc.
 *
 * Exportuje se, aby šlo OBOUSMĚRNĚ porovnat s fixturou slovníku IPTC.
 * Test to dřív dělal jen jedním směrem (fixtura → kód) a druhý směr
 * hlídal `expect(vFixture.size).toBe(17)`, tedy magické číslo. Kontrolní
 * vlna ověřila, že přidání `digitalArt` (hodnota, kterou IPTC VYŘADILO
 * a fixtura ji má v `neposuzujeme`) do tabulky projde bez jediného
 * červeného testu — do reportu by se tak dala propašovat kategorizace
 * „není to AI" u identifikátoru, který se posuzovat nemá.
 */
export const POSUZOVANE_ID = Object.freeze(SOURCE_MARKERS.map(([id]) => id));

/**
 * Obal, ve kterém manifest leží (JUMBF).
 *
 * `jumb` je superbox a `jumd` jeho popisný box — vyskytují se VŽDY spolu
 * v každém kontejneru JUMBF, i takovém, který s C2PA nesouvisí. Jsou to
 * dva zápisy jednoho signálu, ne dva nezávislé důkazy.
 */
const CONTAINER_MARKERS = ['jumb', 'jumd'];

/**
 * Značky, které ukazují přímo na C2PA.
 *
 * Vyžaduje se obal A ZÁROVEŇ aspoň jedna z těchto — jinak by za manifest
 * prošel jakýkoli kontejner JUMBF, i cizí.
 */
const C2PA_MARKERS = ['c2pa', 'c2ma', 'contentauth'];

/**
 * Prozkoumá načtené bajty obrázku.
 *
 * @param {Uint8Array|Buffer|string} bytes  začátek souboru
 * @returns {{hasManifest: boolean, sourceType: string, markers: string[]}}
 */
export function inspectImageBytes(bytes) {
  if (!bytes || bytes.length === 0) {
    return { hasManifest: false, sourceType: SOURCE_TYPE.NONE, markers: [] };
  }

  const text =
    typeof bytes === 'string'
      ? bytes
      : new TextDecoder('latin1').decode(
          bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
        );

  const container = CONTAINER_MARKERS.filter((m) => text.includes(m));
  const specific = C2PA_MARKERS.filter((m) => text.includes(m));
  const markers = [...container, ...specific];

  // Vyžaduje se ÚPLNÝ obal (`jumb` i `jumd`, které se v reálném souboru
  // vyskytují vždy spolu) a k tomu značka C2PA.
  //
  // Volnější podmínka propouštěla souvislý text: článek o formátu obsahuje
  // slova „jumb" i „c2pa", a prošel by jako obrázek s manifestem.
  const hasManifest =
    container.length === CONTAINER_MARKERS.length && specific.length > 0;

  if (!hasManifest) {
    return { hasManifest: false, sourceType: SOURCE_TYPE.NONE, markers };
  }

  for (const [needle, type] of SOURCE_MARKERS) {
    if (text.includes(needle)) {
      return { hasManifest: true, sourceType: type, markers };
    }
  }

  return { hasManifest: true, sourceType: SOURCE_TYPE.UNKNOWN, markers };
}

/**
 * Souhrn přes vzorek obrázků.
 *
 * @param {Array<{url: string, hasManifest: boolean, sourceType: string}>} results
 * @param {number} totalImages  kolik obrázků stránka má celkem
 */
export function summarizeC2pa(results, totalImages) {
  const list = Array.isArray(results) ? results : [];
  const counts = {
    sampled: list.length,
    withManifest: list.filter((r) => r.hasManifest).length,
    declaredAi: list.filter(
      (r) => r.sourceType === SOURCE_TYPE.AI_GENERATED || r.sourceType === SOURCE_TYPE.AI_COMPOSITE
    ).length,
    declaredCapture: list.filter((r) => r.sourceType === SOURCE_TYPE.CAPTURE).length,
    // Typ zdroje je přečtený a generativní AI to není.
    declaredNotAi: list.filter((r) => r.sourceType === SOURCE_TYPE.NOT_AI).length,
    // Bez téhle kolonky nepadl `ALGORITHMIC` do ŽÁDNÉ: obrázek se objevil
    // ve `withManifest`, ale v žádném rozpadu, takže si čtenář reportu
    // součet neuzavřel. Algoritmus bez trénování (render, matematická
    // formule) není generativní AI, ale je to vlastní kategorie slovníku.
    declaredAlgorithmic: list.filter((r) => r.sourceType === SOURCE_TYPE.ALGORITHMIC).length,
    // Typ zdroje je přečtený, ale o AI nerozhoduje — IPTC u něj sám říká
    // „may or may not be generative AI". Do „nehlásí se jako AI" tyhle
    // položky NEPATŘÍ.
    declaredAmbiguous: list.filter((r) => r.sourceType === SOURCE_TYPE.AMBIGUOUS).length,
    // Manifest je, ale typ zdroje se nepodařilo přečíst. Počítat ho mezi
    // „nehlásí se jako AI" by znamenalo tvrdit něco, co se nezměřilo:
    // seznam identifikátorů IPTC je delší, než co pokrýváme, a typ může
    // ležet za hranicí načtených 64 kB.
    unknownSource: list.filter((r) => r.sourceType === SOURCE_TYPE.UNKNOWN).length,
  };

  let rationale;
  if (counts.sampled === 0) {
    rationale = 'Nepodařilo se načíst žádný obrázek k prozkoumání.';
  } else if (counts.withManifest === 0) {
    rationale =
      `Žádný z ${counts.sampled} zkoumaných obrázků nenese Content Credentials. ` +
      'Z toho ale neplyne porušení: většina fotografií žádné pověření nemá ' +
      'a bez znalosti toho, co systém generuje, nelze určit, který obsah je ' +
      'syntetický.';
  } else if (counts.declaredAi > 0) {
    rationale =
      `${counts.declaredAi} z ${counts.sampled} zkoumaných obrázků se v manifestu ` +
      'hlásí jako vytvořené generativním modelem — označení tedy existuje. ' +
      'Podpis manifestu se neověřuje, takže jde o tvrzení obsažené v souboru, ' +
      'ne o prokázaný původ.';
  } else if (counts.unknownSource + counts.declaredAmbiguous === counts.withManifest) {
    // Všechny nalezené manifesty mají nepřečtený typ zdroje — o povaze
    // obsahu tedy nevíme nic.
    rationale =
      `${counts.withManifest} z ${counts.sampled} zkoumaných obrázků nese Content ` +
      'Credentials, ale typ zdroje se buď v načtené části souboru nepodařilo ' +
      'přečíst, nebo o generativní AI nerozhoduje (slovník IPTC u části hodnot ' +
      'sám uvádí, že obsah AI zahrnovat může i nemusí). Zda jde o syntetický ' +
      'obsah, z toho neplyne ani tak, ani onak. Podpis se navíc neověřuje.';
  } else {
    const unknownNote = counts.unknownSource > 0
      ? ` U ${counts.unknownSource} se typ zdroje přečíst nepodařilo.`
      : '';
    // Nerozhodné hodnoty se přiznávají zvlášť. Zamlčet je by z věty
    // „žádný se nehlásí jako vytvořený AI" udělalo tvrzení o obrázcích,
    // u kterých to slovník nechává otevřené.
    const ambiguousNote = counts.declaredAmbiguous > 0
      ? ` U ${counts.declaredAmbiguous} typ zdroje o generativní AI nerozhoduje.`
      : '';
    rationale =
      `${counts.withManifest} z ${counts.sampled} zkoumaných obrázků nese Content ` +
      'Credentials, žádný z přečtených se nehlásí jako vytvořený AI.' +
      `${unknownNote}${ambiguousNote} Podpis se neověřuje.`;
  }

  return {
    ...counts,
    totalImages: totalImages ?? null,
    // Zbytek stránky zůstává neprozkoumaný a report to musí přiznat —
    // vzorek osmi obrázků neříká nic o zbylých dvou stech.
    unsampled: totalImages != null ? Math.max(0, totalImages - counts.sampled) : null,
    rationale,
  };
}
