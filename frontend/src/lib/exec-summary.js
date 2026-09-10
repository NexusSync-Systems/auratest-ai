/**
 * Manažerské shrnutí auditu.
 *
 * PROČ TO NEPÍŠE JAZYKOVÝ MODEL
 * Shrnutí je první — a u většiny čtenářů jediná — strana dokumentu,
 * který jde úřadu. Model by ho napsal čitelněji, ale nemá jak zaručit,
 * že nedoplní tvrzení, které měření nedokládá. Celý projekt stojí na
 * tom, že nástroj netvrdí víc, než změřil; u shrnutí to platí dvakrát,
 * protože právě ono se cituje dál.
 *
 * Shrnutí se proto skládá MECHANICKY z verdiktů, které už někdo změřil.
 * Nepřidává, nedopočítává, nepředpokládá.
 *
 * TŘI KOŠE, NE DVA
 * Splněno / Nesplněno / Neprůkazné. Neprůkazné je vlastní kategorie,
 * ne „skoro splněno" ani „skoro nesplněno" — a v souhrnu musí být
 * vidět, jinak by manažer četl „2 ze 3 v pořádku" tam, kde se třetí
 * věc jen nepodařilo změřit.
 */

import { complianceState, COMPLIANCE } from './compliance.js';

/**
 * Popis jedné oblasti: jak se jmenuje, odkud se bere verdikt a co
 * z výsledku vytáhnout jako důvod.
 *
 * Pořadí je pořadí v dokumentu.
 */
const OBLASTI = [
  {
    klic: 'a11yResult',
    nazev: 'Přístupnost (EAA)',
    // `nosny` brání tomu, aby se do shrnutí dostal řádek bez odpovídající
    // sekce v dokumentu — věta „podrobnosti jsou v sekcích níž" by pak
    // byla nepravdivá.
    nosny: (r) => Array.isArray(r.violations) || Array.isArray(r.incomplete),
    verdikt: (r) => {
      if (r.navigationError) return null;
      if ((r.violations?.length ?? 0) > 0) return false;
      if ((r.incomplete?.length ?? 0) > 0) return null;
      return true;
    },
    duvod: (r) => {
      if (r.navigationError) return 'stránku se nepodařilo posoudit';
      const p = r.violations?.length ?? 0;
      const i = r.incomplete?.length ?? 0;
      if (p > 0) return `${p} ${vet(p, 'porušení', 'porušení', 'porušení')}`;
      if (i > 0) return `${i} ${vet(i, 'položka', 'položky', 'položek')} k ručnímu posouzení`;
      return 'bez nálezu automatickým testem';
    },
  },
  {
    klic: 'nis2Result',
    nazev: 'Bezpečnostní hlavičky a TLS (NIS2)',
    nosny: (r) => Boolean(r.nis2),
    verdikt: (r) => r.nis2?.isCompliant,
    // Verdikt se po výpočtu z hlaviček PŘEPISUJE podle TLS: zastaralé
    // verze nebo nálezy v TLS ho stáhnou na `false`, neověřitelná TLS
    // vrstva na `null`. Důvod, který četl jen hlavičky, pak v tabulce
    // stál vedle verdiktu, kterému odporoval: „Vyžaduje nápravu |
    // všechny posuzované hlavičky chrání".
    duvod: (r) => {
      const casti = [];
      const m = r.nis2?.missingHeaders?.length ?? 0;
      const w = r.nis2?.weakHeaders?.length ?? 0;
      const n = r.nis2?.inconclusiveHeaders?.length ?? 0;
      const t = r.nis2?.tlsFindings?.length ?? 0;
      if (m > 0) casti.push(`${m} ${vet(m, 'hlavička chybí', 'hlavičky chybí', 'hlaviček chybí')}`);
      if (w > 0) casti.push(`${w} ${vet(w, 'hlavička nechrání', 'hlavičky nechrání', 'hlaviček nechrání')}`);
      if (n > 0) casti.push(`${n} ${vet(n, 'hlavičku', 'hlavičky', 'hlaviček')} nelze posoudit`);
      if (t > 0) casti.push(`${t} ${vet(t, 'nález', 'nálezy', 'nálezů')} v TLS`);
      if (casti.length > 0) return casti.join(', ');
      // Verdikt může být `null` i bez jediného seznamu — když se
      // nepodařilo ověřit TLS vrstvu.
      if (r.nis2?.isCompliant === null) return 'TLS vrstvu se nepodařilo ověřit';
      return 'všechny posuzované hlavičky chrání, TLS bez nálezu';
    },
  },
  {
    klic: 'cookieResult',
    nazev: 'Trackery před souhlasem (GDPR)',
    nosny: (r) => Boolean(r.gdpr),
    verdikt: (r) => r.gdpr?.isCompliant,
    duvod: (r) => {
      // Nenačtená stránka nemá podezřelé položky — bez tohohle řádku
      // z toho vzniklo „bez nálezu ze sledovaného seznamu", tedy
      // uklidňující věta o webu, na který se nikdo nedostal.
      if (r.navigationError) return 'stránku se nepodařilo načíst';
      const n = r.gdpr?.suspiciousItems?.length ?? 0;
      return n > 0
        ? `${n} ${vet(n, 'položka', 'položky', 'položek')} před souhlasem`
        : 'bez nálezu ze sledovaného seznamu';
    },
  },
  {
    klic: 'greenResult',
    nazev: 'Umístění dat (GDPR)',
    nosny: (r) => Boolean(r.residency),
    verdikt: (r) => r.residency?.isEUCompliant,
    duvod: (r) => {
      // U neprůkazného verdiktu musí jít důvod neprůkaznosti PRVNÍ.
      // `residency.warning` začíná kladnou větou („Všech 5 posouzených
      // serverů je v EU/EHP…") a výhrada je až za ní — ve shrnutí je
      // pořadí vět tvrzením samo o sobě.
      if (r.residency?.isEUCompliant === null) {
        if (r.residency?.originMeasured === false) {
          return 'doménu webu se nepodařilo umístit';
        }
        if ((r.residency?.measuredDomains ?? 0) === 0) {
          return 'žádnou doménu se nepodařilo umístit';
        }
        return `neprůkazné — ${r.residency?.warning || 'bez bližšího určení'}`;
      }
      return r.residency?.warning || 'bez bližšího určení';
    },
  },
  {
    klic: 'craVulnResult',
    nazev: 'Známé zranitelnosti (CRA)',
    nosny: (r) => Boolean(r.cra),
    verdikt: (r) => r.cra?.isCompliant,
    duvod: (r) => {
      const v = r.cra?.vulnerabilities?.length ?? 0;
      const s = r.cra?.skipped?.length ?? 0;
      if (v > 0) return `${v} ${vet(v, 'zranitelnost', 'zranitelnosti', 'zranitelností')}`;
      if (s > 0) return `${s} ${vet(s, 'komponenta', 'komponenty', 'komponent')} se nepodařilo ověřit`;
      // Dvě větve skeneru vracejí `null` se SOUČASNĚ prázdnými
      // `vulnerabilities` i `skipped`: prázdný SBOM a slepá místa
      // skenu. Věta „bez známých CVE u ověřených komponent" tam
      // znamenala, že se neověřila ani jedna komponenta. Skener má pro
      // ty případy vlastní `rating` — použije se on.
      if (r.cra?.isCompliant !== true) {
        return zkrat(r.cra?.rating) || 'sken nebyl úplný';
      }
      return 'bez známých CVE u ověřených komponent';
    },
  },
  {
    klic: 'aiActResult',
    nazev: 'Transparentnost AI (AI Act, čl. 50)',
    nosny: (r) => Boolean(r.aiAct),
    verdikt: (r) => r.aiAct?.isCompliant,
    duvod: (r) => {
      if (r.navigationError) return 'stránku se nepodařilo načíst';
      return zkrat(r.aiAct?.rating) || 'bez bližšího určení';
    },
  },
  {
    klic: 'chaosResult',
    nazev: 'Odolnost při výpadcích (doporučení)',
    nosny: (r) => Boolean(r.chaos),
    verdikt: (r) => r.chaos?.isResilient,
    duvod: (r) => zkrat(r.chaos?.rating) || 'bez bližšího určení',
    // Chaos test není verdikt o splnění předpisu — DORA dopadá jen na
    // finanční subjekty. „Vyžaduje nápravu" by u běžného e-shopu
    // znamenalo tvrzení o povinnosti, která na něj nedopadá. Proto
    // vlastní popisky a vyloučení ze závěru.
    popisky: { pass: 'Odolné', fail: 'Neošetřené výpadky', inconclusive: 'Neprůkazné' },
    mimoPredpis: true,
  },
];

/** Zkrátí dlouhý `rating` skeneru na první větu. */
function zkrat(text) {
  const t = String(text ?? '').trim();
  if (t === '') return null;
  const tecka = t.indexOf('. ');
  const veta = tecka > 0 ? t.slice(0, tecka + 1) : t;
  return veta.length > 160 ? `${veta.slice(0, 157)}…` : veta;
}

/** Česká trojice tvarů podle počtu. */
function vet(n, jeden, dva, pet) {
  if (n === 1) return jeden;
  if (n >= 2 && n <= 4) return dva;
  return pet;
}

/**
 * Sestaví shrnutí z výsledků, které v běhu skutečně vznikly.
 *
 * Oblasti, které se nespouštěly, se NEPOČÍTAJÍ ani nezmiňují. Napsat
 * „0 porušení" o kontrole, která neproběhla, by bylo tvrzení bez opory
 * — a ve shrnutí to nejnebezpečnější tvrzení vůbec.
 *
 * @param {Record<string, any>} vysledky výsledky auditů podle klíčů výš
 * @returns {{
 *   polozky: Array<{nazev:string, stav:string, duvod:string}>,
 *   splneno:number, nesplneno:number, neprukazne:number, celkem:number,
 *   zaver: string,
 * }|null} `null`, když se nespustil žádný sken
 */
export function execSummary(vysledky = {}) {
  const polozky = [];

  for (const oblast of OBLASTI) {
    const r = vysledky[oblast.klic];
    if (!r) continue;

    // Nosný podobjekt musí být přítomný. Bez něj by ve shrnutí vznikl
    // řádek, ke kterému se v dokumentu nevykreslí žádná sekce — a věta
    // „podrobnosti jsou v sekcích níž" by byla nepravdivá.
    let stav;
    let duvod;
    if (oblast.nosny && !oblast.nosny(r)) {
      stav = COMPLIANCE.INCONCLUSIVE;
      duvod = 'výsledek se nepodařilo přečíst';
    } else {
      try {
        stav = complianceState(oblast.verdikt(r));
        duvod = oblast.duvod(r);
      } catch {
        // Vadný tvar výsledku nesmí shodit celý dokument ani zmizet.
        stav = COMPLIANCE.INCONCLUSIVE;
        duvod = 'výsledek se nepodařilo přečíst';
      }
    }

    polozky.push({
      nazev: oblast.nazev,
      stav,
      duvod,
      // Oblasti, které nejsou verdiktem o splnění předpisu (chaos test),
      // mají vlastní popisky a do závěru se nezapočítávají.
      popisek: oblast.popisky?.[stav] || stavLabel(stav),
      mimoPredpis: Boolean(oblast.mimoPredpis),
    });
  }

  if (polozky.length === 0) return null;

  const predpisove = polozky.filter((p) => !p.mimoPredpis);
  const spocitej = (s) => predpisove.filter((p) => p.stav === s).length;
  const splneno = spocitej(COMPLIANCE.PASS);
  const nesplneno = spocitej(COMPLIANCE.FAIL);
  const neprukazne = spocitej(COMPLIANCE.INCONCLUSIVE);

  return {
    polozky,
    splneno,
    nesplneno,
    neprukazne,
    celkem: predpisove.length,
    zaver: predpisove.length === 0
      ? 'Neproběhla žádná předpisová kontrola. Dokument o souladu nevypovídá.'
      : zaver(splneno, nesplneno, neprukazne, predpisove.length),
  };
}

/**
 * Jedna věta závěru.
 *
 * Kladný závěr smí vzniknout JEN tehdy, když je všechno změřené a
 * v pořádku. Jediná neprůkazná oblast ho blokuje — ne proto, že by
 * znamenala závadu, ale protože o ní nikdo nic neví.
 */
function zaver(splneno, nesplneno, neprukazne, celkem) {
  const rozsah = `Posouzeno ${celkem} ${vet(celkem, 'oblast', 'oblasti', 'oblastí')}.`;

  if (nesplneno > 0 && neprukazne > 0) {
    return `${rozsah} ${nesplneno} ${vet(nesplneno, 'oblast vyžaduje', 'oblasti vyžadují', 'oblastí vyžaduje')} `
      + `nápravu, u ${neprukazne} se výsledek nepodařilo určit. Dokument nedokládá soulad.`;
  }
  if (nesplneno > 0) {
    return `${rozsah} ${nesplneno} ${vet(nesplneno, 'oblast vyžaduje', 'oblasti vyžadují', 'oblastí vyžaduje')} `
      + 'nápravu. Zbytek posuzovaných oblastí je bez nálezu.';
  }
  if (neprukazne > 0) {
    return `${rozsah} Žádné porušení nebylo prokázáno, ale u ${neprukazne} `
      + `${vet(neprukazne, 'oblasti se výsledek', 'oblastí se výsledek', 'oblastí se výsledek')} `
      + 'nepodařilo určit. Na doklad souladu to nestačí.';
  }
  return `${rozsah} Ve všech posuzovaných oblastech bez nálezu. `
    + 'Rozsah je dán tím, co nástroj měří — není to potvrzení souladu '
    + 'nad rámec provedených kontrol.';
}

/** Krátký popisek stavu pro tabulku shrnutí. */
export function stavLabel(stav) {
  switch (stav) {
    case COMPLIANCE.PASS: return 'Bez nálezu';
    case COMPLIANCE.FAIL: return 'Vyžaduje nápravu';
    default: return 'Neprůkazné';
  }
}

/** Třída odznaku pro daný stav. */
export function stavTrida(stav) {
  switch (stav) {
    case COMPLIANCE.PASS: return 'success';
    case COMPLIANCE.FAIL: return 'error';
    default: return 'warning';
  }
}
