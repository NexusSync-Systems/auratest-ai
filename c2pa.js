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
  /** Manifest je, ale typ zdroje se v načtené části nenašel. */
  UNKNOWN: 'unknown',
  /** Manifest není. */
  NONE: 'none',
};

/**
 * Identifikátory IPTC, jak se v manifestu vyskytují.
 *
 * Pořadí rozhoduje: `compositeWithTrainedAlgorithmicMedia` obsahuje jako
 * podřetězec `trainedAlgorithmicMedia`, takže se musí zkoušet dřív.
 */
const SOURCE_MARKERS = [
  ['compositeWithTrainedAlgorithmicMedia', SOURCE_TYPE.AI_COMPOSITE],
  ['trainedAlgorithmicMedia', SOURCE_TYPE.AI_GENERATED],
  ['algorithmicMedia', SOURCE_TYPE.ALGORITHMIC],
  ['digitalCapture', SOURCE_TYPE.CAPTURE],
  ['computationalCapture', SOURCE_TYPE.CAPTURE],
];

/**
 * Značky kontejneru JUMBF, ve kterém je manifest uložený.
 *
 * Vyžadují se DVĚ nezávislé, ne jedna. Čtyřznakový řetězec jako `c2pa`
 * se v obrazových datech může vyskytnout náhodou; shoda dvou různých značek
 * je nepravděpodobná natolik, že falešný nález prakticky vylučuje.
 */
const CONTAINER_MARKERS = ['jumb', 'c2pa', 'c2ma', 'contentauth', 'jumd'];

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

  const markers = CONTAINER_MARKERS.filter((m) => text.includes(m));
  const hasManifest = markers.length >= 2;

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
  } else {
    rationale =
      `${counts.withManifest} z ${counts.sampled} zkoumaných obrázků nese Content ` +
      'Credentials, ale žádný se nehlásí jako vytvořený AI. Podpis se neověřuje.';
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
