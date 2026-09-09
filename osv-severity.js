/**
 * Čtení závažnosti zranitelnosti z odpovědi OSV.
 *
 * PROBLÉM, KTERÝ TO ŘEŠÍ
 * Závažnost se brala z `database_specific.severity` a při jeho absenci se
 * doplnila konstantou `'HIGH'`. To pole plní prakticky jen GHSA; u záznamů
 * z jiných zdrojů chybí, takže KAŽDÁ taková zranitelnost dostala vysokou
 * závažnost. Vytisklo se to v dokumentu pro úřad jako `CVE-… (HIGH)`,
 * tedy jako údaj, který nikdo neměřil.
 *
 * Pro zákazníka to znamená dvojí škodu: nadhodnocené závažnosti ho vedou
 * opravovat ve špatném pořadí, a kdyby si to někdo ověřil, ztratí důvěru
 * i k těm údajům, které jsou správné.
 *
 * CO SE ČTE MÍSTO TOHO
 * OSV má standardní pole `severity[]` s vektory CVSS. Z vektoru se dá
 * spočítat základní skóre, ale spočítat CVSS pořádně znamená implementovat
 * celý standard — místo toho se čte `baseScore`, když ho záznam nese, a
 * jinak se sáhne po `database_specific`, kde je závažnost slovem.
 *
 * Když není ani jedno, vrací se `null`. Neznámá závažnost je legitimní
 * výsledek; vymyšlená není.
 */

/** Prahové hodnoty CVSS v3 podle specifikace FIRST. */
function scoreToLabel(score) {
  if (typeof score !== 'number' || Number.isNaN(score)) return null;
  if (score >= 9.0) return 'CRITICAL';
  if (score >= 7.0) return 'HIGH';
  if (score >= 4.0) return 'MEDIUM';
  if (score > 0) return 'LOW';
  return 'NONE';
}

/**
 * Vytáhne základní skóre z vektoru CVSS.
 *
 * Vektor sám o sobě skóre neobsahuje — musel by se spočítat. OSV ale
 * u části záznamů uvádí `score` jako číslo v textové podobě, takže se
 * zkusí přečíst; jinak se vrací `null` a rozhodne slovní hodnota.
 */
function scoreFromSeverityEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const raw = entry.score;
  if (typeof raw === 'number') return raw;
  if (typeof raw === 'string') {
    // Číselná podoba `"7.5"`. Vektor `"CVSS:3.1/AV:N/..."` číslo nenese.
    const cislo = Number.parseFloat(raw);
    if (!Number.isNaN(cislo) && !raw.startsWith('CVSS')) return cislo;
  }
  return null;
}

const ZNAME_STUPNE = new Set(['CRITICAL', 'HIGH', 'MEDIUM', 'MODERATE', 'LOW', 'NONE']);

/**
 * Závažnost zranitelnosti, nebo `null` když ji záznam neuvádí.
 *
 * @param {object} vuln jedna položka z `data.vulns`
 * @returns {{label: string|null, source: string|null}}
 */
export function severityOf(vuln) {
  if (!vuln || typeof vuln !== 'object') return { label: null, source: null };

  // 1) Standardní pole se skóre — nejpřesnější, pokud ho záznam nese.
  for (const entry of Array.isArray(vuln.severity) ? vuln.severity : []) {
    const label = scoreToLabel(scoreFromSeverityEntry(entry));
    if (label) return { label, source: `CVSS (${entry.type || 'neurčeno'})` };
  }

  // 2) Slovní hodnota, kterou plní hlavně GHSA.
  const slovni = vuln.database_specific?.severity;
  if (typeof slovni === 'string' && ZNAME_STUPNE.has(slovni.toUpperCase())) {
    // GHSA používá MODERATE tam, kde CVSS říká MEDIUM.
    const norm = slovni.toUpperCase() === 'MODERATE' ? 'MEDIUM' : slovni.toUpperCase();
    return { label: norm, source: 'databáze zdroje' };
  }

  // 3) Nic. Dřív tu byla konstanta 'HIGH'.
  return { label: null, source: null };
}

/** Text pro report. Neznámou závažnost pojmenuje, nezamlčí. */
export function severityLabel(label) {
  return label || 'závažnost neuvedena';
}
