/**
 * Kdy smí běh skončit na návrh modelu.
 *
 * PROČ TO TU JE
 * Akce `finish` se propouštěla bez jakékoli podmínky. Kdo dokázal modelu
 * podstrčit text (a to dokáže každá auditovaná stránka — viz
 * `prompt-safety.js`), dostal běh se stavem `completed`, verdiktem
 * „Bez nálezu" a zápisem do neměnného záznamu. Ověřeno: odpověď
 * `{"action":"finish","detected_bugs":[]}` v prvním kroku → `isFinished`,
 * `status: 'completed'`, ve spisu „Bez nálezu".
 *
 * PRVNÍ POKUS O OPRAVU BYL ŠPATNÝ — a kontrolní vlna to našla.
 * Podmínka zněla „stránka sama hlásí dokončení, nebo nezůstal
 * nevyzkoušený prvek". Obojí bylo k ničemu:
 *
 *   1. „Stránka sama hlásí" se posuzovalo regexem nad URL a `<title>`.
 *      Obojí nastavuje auditovaný web. Ověřeno: titulek
 *      „Děkujeme, objednávka dokončena" propustil `finish` v prvním kroku
 *      i s dvaceti nevyzkoušenými tlačítky. Hradba se jen přesunula
 *      z `detected_bugs` na `<title>`.
 *   2. „Nezůstal nevyzkoušený prvek" se počítalo podle `data-qa-id`.
 *      Ta se ale přečíslují KAŽDÝ krok a `wasActionTargetUsed` se dívá
 *      jen tři kroky zpět. Počet tedy nikdy nedosáhl nuly a zároveň
 *      nevypovídal o tom, co se opravdu zkusilo.
 *
 * CO PLATÍ TEĎ
 * Žádný údaj pocházející ze stránky nemůže být sám dokladem dokončení,
 * protože auditovaný web je předmětem auditu a smí lhát. Ukončení proto
 * stojí na dvou věcech, které web nezfalšuje:
 *
 *   • NA STRÁNCE NENÍ CO OVLÁDAT — měření vrátilo prázdný seznam
 *     interaktivních prvků A extrakce přitom neselhala. Prázdno z pádu
 *     `page.evaluate()` je chyba měření, ne prázdná stránka (ověřeno: dřív
 *     se z ní stalo „vyčerpáno" a běh se vytiskl jako čistý výsledek).
 *   • STRÁNKA HLÁSÍ HOTOVO PO SKUTEČNÉ INTERAKCI — regex nad URL/titulkem
 *     platí jen tehdy, když agent předtím aspoň jednou klikl nebo vyplnil.
 *     Přivítací stránka s titulkem „dokončeno" tak neprojde. Zfalšovat to
 *     web stále dokáže, a proto se tenhle důvod ve spisu a v reportu
 *     VÝSLOVNĚ označuje za tvrzení stránky, ne za naše měření.
 *
 * CO TÍM ZTRÁCÍME — VĚDOMĚ
 * Běžný průzkumný běh nad reálnou aplikací teď skončí na limitu kroků.
 * To je pravdivý popis stavu: deset kroků aplikaci neprojde. Dřív takový
 * běh dostal zelené „agent na žádný problém nenarazil", což je tvrzení
 * o pokrytí, které nikdo nezměřil.
 */

export const UKONCENI = {
  /** Stránka sama hlásí dokončení (URL/titulek) po skutečné interakci. */
  POTVRZENO: 'potvrzeno-strankou',
  /** Na stránce není co ovládat a extrakce prvků proběhla. */
  VYCERPANO: 'vycerpano',
  /** Doběhl limit kroků. */
  LIMIT: 'limit-kroku',
  /** Měření se nedokončilo. */
  CHYBA: 'chyba-mereni',
};

export const POPIS_UKONCENI = {
  // Znění je součástí opravy: čtenář spisu musí poznat, že tohle tvrzení
  // pochází z auditované stránky, ne z našeho měření.
  [UKONCENI.POTVRZENO]: 'Běh ukončen proto, že stránka sama po provedené '
    + 'interakci hlásí dokončení (podle URL a titulku). Toto tvrzení pochází '
    + 'z auditovaného webu, nikoli z nezávislého měření.',
  [UKONCENI.VYCERPANO]: 'Běh ukončen, protože měření nenašlo na stránce žádný '
    + 'interaktivní prvek k ovládání.',
  [UKONCENI.LIMIT]: 'Běh ukončen limitem kroků; agent sám dokončení nedoložil.',
  [UKONCENI.CHYBA]: 'Běh se nedokončil kvůli chybě měření.',
};

/**
 * Důvody, u kterých se nesmí tvrdit, že běh prošel, co měl.
 *
 * `VYCERPANO` je tu taky, a schválně: „na stránce nebylo co ovládat"
 * znamená, že agent neprovedl nic. Kontrolní vlna ukázala, že takový běh
 * dostával plně zelený odznak „agent na žádný problém nenarazil" —
 * nejsilnější tvrzení nástroje nad během, který nic nezkusil. Aplikace
 * v iframu, frameset, PDF jako cíl nebo SPA, která v okamžiku čtení nemá
 * vyrenderované ovládací prvky, to spustí na nezávadném webu.
 *
 * Zbývá tedy `POTVRZENO`, a i to je jen tvrzení auditované stránky. Jinými
 * slovy: průzkumný agentní běh nikdy nedokládá soulad. Zelený odznak nad
 * ním byl od začátku tvrzení bez opory.
 */
export const UKONCENI_BEZ_POKRYTI = new Set([
  UKONCENI.LIMIT,
  UKONCENI.CHYBA,
  UKONCENI.VYCERPANO,
]);

/** Důvody opřené o tvrzení auditované stránky, ne o nezávislé měření. */
export const UKONCENI_DLE_STRANKY = new Set([UKONCENI.POTVRZENO]);

export function popisUkonceni(duvod) {
  return POPIS_UKONCENI[duvod] || 'Důvod ukončení běhu není zaznamenán.';
}

/**
 * Smí se `finish` od modelu přijmout?
 *
 * @param {object} vstup
 * @param {boolean} vstup.completionContext regex nad URL/titulkem — tvrzení STRÁNKY
 * @param {number} vstup.interakci kolik kroků bylo click/type
 * @param {number} vstup.prvkuNaStrance kolik interaktivních prvků měření našlo
 * @param {boolean} vstup.extrakceSelhala selhalo čtení prvků ze stránky?
 * @returns {{povoleno: boolean, duvod: string|null, popis: string}}
 */
export function vyhodnotFinish({
  completionContext,
  interakci,
  prvkuNaStrance,
  extrakceSelhala,
} = {}) {
  // Selhané měření nesmí nic dokládat — ani dokončení, ani prázdnotu.
  // Fail-closed na jakoukoli pravdivou hodnotu, ne jen na `true`.
  // Bezpečnostní větev se nesmí otvírat kvůli tvaru dat.
  if (extrakceSelhala) {
    return {
      povoleno: false,
      duvod: null,
      popis: 'Čtení prvků ze stránky selhalo, takže z něj nelze vyvodit ani to, '
        + 'že už není co zkoušet. Ukončení zamítnuto.',
    };
  }

  // `undefined` znamená „nevím" a nevím není nula.
  if (prvkuNaStrance === 0) {
    return {
      povoleno: true,
      duvod: UKONCENI.VYCERPANO,
      popis: POPIS_UKONCENI[UKONCENI.VYCERPANO],
    };
  }

  // Tvrzení stránky platí jen po skutečné interakci. Bez téhle podmínky
  // stačilo webu poslat `<title>Objednávka dokončena</title>` na úvodní
  // stránce a běh skončil v prvním kroku bez jediného kliknutí.
  if (completionContext === true && Number.isFinite(interakci) && interakci > 0) {
    return {
      povoleno: true,
      duvod: UKONCENI.POTVRZENO,
      popis: POPIS_UKONCENI[UKONCENI.POTVRZENO],
    };
  }

  return {
    povoleno: false,
    duvod: null,
    popis: completionContext === true
      ? 'Stránka hlásí dokončení, ale agent na ní ještě nic neprovedl; '
        + 'samotný titulek nebo URL ukončení nedokládá.'
      : 'Model navrhl ukončení, ale nic změřeného to nedokládá; pokračuji v testu.',
  };
}

/**
 * Souhrnné ukončení za víc stránek (crawler).
 *
 * Nejslabší důvod vyhrává. Crawler po jedné stránce useknuté limitem
 * nemůže tvrdit „prošli jsme, co bylo" o celém běhu — a bez tohohle
 * neukládal `ukonceni` vůbec, takže report dával zelený odznak a spis
 * „Bez nálezu" bez jediné výhrady o pokrytí.
 *
 * `null` v seznamu = stránka důvod nenese; nevím se řeší jako limit,
 * protože tvrdit doložené dokončení bez záznamu by znamenalo tvrdit víc,
 * než se změřilo.
 */
export function souhrnneUkonceni(duvody, jsouChybyMereni = false) {
  if (jsouChybyMereni) return UKONCENI.CHYBA;
  const seznam = Array.isArray(duvody) ? duvody : [];
  if (seznam.length === 0) return UKONCENI.LIMIT;
  if (seznam.some((d) => d === UKONCENI.CHYBA)) return UKONCENI.CHYBA;
  if (seznam.some((d) => d === UKONCENI.LIMIT || !d)) return UKONCENI.LIMIT;
  // Zbývá POTVRZENO a VYCERPANO. Tvrzení stránky je slabší než změřená
  // prázdnota, takže stačí jedno, aby platilo za celý běh.
  if (seznam.some((d) => d === UKONCENI.POTVRZENO)) return UKONCENI.POTVRZENO;
  // Jen samá `VYCERPANO` dá `VYCERPANO`. Neznámá hodnota propadne na limit,
  // ne na nejsilnější důvod — dřív `souhrnneUkonceni(['nesmysl'])` vracelo
  // `vycerpano`, tedy důvod, který žádná stránka neměla, a zároveň ten
  // jediný bez výhrady o pokrytí.
  if (seznam.every((d) => d === UKONCENI.VYCERPANO)) return UKONCENI.VYCERPANO;
  return UKONCENI.LIMIT;
}
