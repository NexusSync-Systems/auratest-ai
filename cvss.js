/**
 * Základní skóre CVSS 3.x z vektoru.
 *
 * PROČ TENHLE SOUBOR VZNIKL
 * `osv-severity.js` měl větev, která číslo hledala v `severity[].score`:
 *
 *     if (typeof raw === 'number') return raw;
 *
 * Kontrolní vlna ověřila proti živému api.osv.dev, že u typu `CVSS_V3`
 * je `score` VŽDY vektorový řetězec:
 *
 *   GHSA-35jh-r3h4-6jhm → "CVSS:3.1/AV:N/AC:L/PR:H/UI:N/S:U/C:H/I:H/A:H"
 *   GHSA-gxr4-xjj5-5px2 → "CVSS:3.1/AV:N/AC:H/PR:N/UI:R/S:C/C:H/I:L/A:N"
 *
 * Číselná větev tedy v produkci NIKDY neproběhla a závažnost se čte
 * výhradně z `database_specific.severity`, což plní prakticky jen GHSA.
 * Zranitelnost z jiného zdroje OSV dostala „závažnost neuvedena", i když
 * záznam CVSS vektor nesl. Test přitom vracel `score: 9.8` jako číslo —
 * tedy moji představu o API — a v reportu pro recenzenta to vypadalo,
 * že CVSS čteme.
 *
 * Vektor skóre neobsahuje, musí se spočítat. Formule je ze specifikace
 * CVSS v3.1, oddíl 7.1 a tabulka 16:
 *   https://www.first.org/cvss/v3.1/specification-document
 *
 * NEIMPLEMENTUJI NIC Z PAMĚTI. Každá konstanta je z tabulky 16, funkce
 * `zaokruhliNahoru` je doslovný přepis pseudokódu z Přílohy A, a test
 * ověřuje výsledek proti SEDMI párům vektor→skóre z NVD, tedy proti
 * číslům, která publikoval někdo jiný. Kdyby se rozešly, chyba je moje.
 *
 * CO TO NEUMÍ
 * Jen ZÁKLADNÍ skóre. Temporal a Environmental metriky se ignorují —
 * OSV je nedodává a report o nich nic netvrdí. Vektory CVSS 2.0
 * (bez prefixu `CVSS:`) se odmítají: mají jinou stupnici i jiné metriky
 * a tiše je přepočítat na trojkovou škálu by bylo tvrzení bez opory.
 */

/** Tabulka 16 ze specifikace. Nic z toho se neodhaduje. */
const AV = { N: 0.85, A: 0.62, L: 0.55, P: 0.2 };
const AC = { L: 0.77, H: 0.44 };
/** Privileges Required má jinou hodnotu, když je Scope změněný. */
const PR_NEZMENENY = { N: 0.85, L: 0.62, H: 0.27 };
const PR_ZMENENY = { N: 0.85, L: 0.68, H: 0.5 };
const UI = { N: 0.85, R: 0.62 };
const CIA = { H: 0.56, L: 0.22, N: 0 };

/**
 * Doslovný přepis pseudokódu z Přílohy A specifikace.
 *
 * Naivní `Math.ceil(x * 10) / 10` dává jiné výsledky, protože
 * `0.1 + 0.2` je v plovoucí aritmetice `0.30000000000000004` a zaokrouhlí
 * se na 0.4. Specifikace na to má vlastní oddíl a doporučený postup:
 * vynásobit 100000, zaokrouhlit na celé číslo a dál počítat celočíselně.
 */
export function zaokruhliNahoru(vstup) {
  const cele = Math.round(vstup * 100000);
  if (cele % 10000 === 0) return cele / 100000.0;
  return (Math.floor(cele / 10000) + 1) / 10.0;
}

/**
 * Rozebere vektor na metriky. `null`, když to není CVSS 3.x vektor.
 */
export function rozeberVektor(vektor) {
  const text = String(vektor || '').trim();
  // CVSS 2.0 vektory prefix nemají. Odmítnout je je správné: jiná
  // stupnice, jiné metriky, a přepočet na trojkovou škálu neexistuje.
  if (!/^CVSS:3\.[01]\//.test(text)) return null;

  const metriky = {};
  for (const cast of text.split('/').slice(1)) {
    const [klic, hodnota] = cast.split(':');
    if (klic && hodnota) metriky[klic] = hodnota;
  }

  // Osm základních metrik musí být všechny. Chybí-li jedna, skóre
  // spočítat NELZE — a dopočítat si ji výchozí hodnotou by znamenalo
  // vyrobit číslo, které ve vektoru není.
  for (const povinna of ['AV', 'AC', 'PR', 'UI', 'S', 'C', 'I', 'A']) {
    if (!metriky[povinna]) return null;
  }
  return metriky;
}

/**
 * Základní skóre z vektoru CVSS 3.x, nebo `null`.
 *
 * Oddíl 7.1 specifikace:
 *   ISS = 1 - [(1-C) × (1-I) × (1-A)]
 *   Impact = 6.42 × ISS                                        (S:U)
 *          = 7.52 × (ISS - 0.029) - 3.25 × (ISS - 0.02)^15     (S:C)
 *   Exploitability = 8.22 × AV × AC × PR × UI
 *   BaseScore = 0                                              (Impact ≤ 0)
 *             = Roundup(min(Impact + Exploitability, 10))       (S:U)
 *             = Roundup(min(1.08 × (Impact + Exploitability), 10))  (S:C)
 */
export function zakladniSkore(vektor) {
  const m = rozeberVektor(vektor);
  if (!m) return null;

  const zmenenyScope = m.S === 'C';
  const av = AV[m.AV];
  const ac = AC[m.AC];
  const pr = (zmenenyScope ? PR_ZMENENY : PR_NEZMENENY)[m.PR];
  const ui = UI[m.UI];
  const c = CIA[m.C];
  const i = CIA[m.I];
  const a = CIA[m.A];
  // Neznámá hodnota metriky (překlep, budoucí rozšíření) — nedopočítáváme.
  if ([av, ac, pr, ui, c, i, a].some((v) => v === undefined)) return null;

  const iss = 1 - (1 - c) * (1 - i) * (1 - a);
  const dopad = zmenenyScope
    ? 7.52 * (iss - 0.029) - 3.25 * (iss - 0.02) ** 15
    : 6.42 * iss;
  if (dopad <= 0) return 0;

  const zneuzitelnost = 8.22 * av * ac * pr * ui;
  const soucet = zmenenyScope
    ? 1.08 * (dopad + zneuzitelnost)
    : dopad + zneuzitelnost;
  return zaokruhliNahoru(Math.min(soucet, 10));
}
