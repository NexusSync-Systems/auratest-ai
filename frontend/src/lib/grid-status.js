/**
 * Popisek widgetu „stav sítě" v hlavičce.
 *
 * PROČ VLASTNÍ MODUL A PROČ TAKHLE OPATRNĚ
 *
 * Backend (`getGridEnergyStatus` v `agent.js`) je vzorně poctivý: vrací
 * `simulated: true`, `source: 'simulace podle denní doby (žádné reálné
 * měření)'` a `disclaimer` s odkazem na ENTSO-E. Hodnota je natvrdo 65
 * nebo 20 podle hodiny.
 *
 * UI z toho nepoužívalo NIC a tisklo:
 *
 *     EU Grid: 65 % Zelené (Eco ON)
 *
 * zeleně, s ikonou blesku. To je v nástroji, který stojí na tom, že
 * netvrdí nic, co nezměřil, jediné místo se smyšleným číslem podaným
 * jako údaj. V kódu backendu je navíc komentář, že tohle se už jednou
 * opravovalo — dřív se počítalo přes `Math.random()`. Oprava skončila
 * u datového modelu a do UI nedošla.
 *
 * ŘEŠENÍ: popisek se odvozuje z `simulated`. Dokud je simulace, je to
 * v textu i v barvě vidět; až se napojí ENTSO-E a `simulated` bude
 * `false`, widget se sám přepne do normální podoby. Žádné další zásahy.
 */

/** Neutrální barva pro simulaci — zelená/oranžová znamená měření. */
const NEUTRALNI = '#94a3b8';
const NIZKOUHLIKOVA = '#10b981';
const VYSOKOUHLIKOVA = '#f59e0b';

/**
 * @param {object|null} stav odpověď z `/api/auraguard/grid-status`
 * @returns {{text: string, title: string, barva: string, simulace: boolean}|null}
 *   `null` = není co zobrazit
 */
export function popisStavuSite(stav) {
  if (!stav || typeof stav !== 'object') return null;

  const procenta = Number(stav.renewablePercentage);
  if (!Number.isFinite(procenta)) return null;

  const nizkouhlikova = stav.status === 'LOW_CARBON';
  // Chybějící `simulated` se bere jako SIMULACE, ne jako měření.
  // Fail-closed: starší odpověď bez toho pole nesmí projít jako údaj.
  const simulace = stav.simulated !== false;

  if (simulace) {
    return {
      simulace: true,
      barva: NEUTRALNI,
      // Slovo „odhad" a „denní doba" jsou v popisku, ne schované
      // v tooltipu — ten si nikdo nenajede.
      text: `Síť EU: odhad ${procenta} % OZE (simulace podle denní doby)`,
      title: stav.disclaimer
        || 'Simulovaná hodnota, ne měření. Pro auditní účely použijte data '
           + 'od provozovatele přenosové soustavy (ENTSO-E).',
    };
  }

  return {
    simulace: false,
    barva: nizkouhlikova ? NIZKOUHLIKOVA : VYSOKOUHLIKOVA,
    text: `Síť EU: ${procenta} % OZE (${nizkouhlikova ? 'nízkouhlíková' : 'vysokouhlíková'})`,
    title: [stav.source, stav.recommendation].filter(Boolean).join(' — '),
  };
}
