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

/** Krátký textový štítek — informace nesmí být nesena jen barvou. */
export function complianceLabel(isCompliant) {
  switch (complianceState(isCompliant)) {
    case COMPLIANCE.PASS: return 'Splněno';
    case COMPLIANCE.FAIL: return 'Nesplněno';
    default: return 'Neprůkazné';
  }
}
