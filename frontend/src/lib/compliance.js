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
