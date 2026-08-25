/**
 * Kvalita upozornění na AI, ne jen jeho existence (AI Act, čl. 50 odst. 1).
 *
 * PROČ TO NESTAČÍ HLEDAT V TEXTU
 * Dosud stačilo, aby se kdekoli na stránce vyskytlo slovo „AI". Projde tím
 * zmínka v patičce, v blogovém titulku i v marketingové větě — a z toho
 * plynul verdikt SPLNĚNO. Čl. 50 odst. 1 přitom chce, aby byl uživatel
 * informován „nejpozději při první interakci". Upozornění, které nikdo
 * neuvidí, tuhle podmínku nesplňuje, i když v HTML je.
 *
 * CO SE MĚŘÍ
 * U každého nalezeného výskytu se z prohlížeče čte, kde a jak je vykreslený:
 * viditelnost, poloha vůči prvnímu zobrazení, umístění v patičce
 * a vzdálenost od konverzačního prvku. Klasifikace je pak čistá funkce nad
 * těmi údaji — testuje se bez prohlížeče.
 *
 * ČEHO SE MODUL DRŽÍ DÁL OD
 * Neposuzuje, jestli je formulace upozornění dostatečná. „Tento chat používá
 * AI" a „Používáme moderní technologie" jsou obojí text obsahující zmínku;
 * rozlišit je automaticky nelze bez porozumění obsahu. Proto se hodnotí
 * UMÍSTĚNÍ, a formulace zůstává na ručním posouzení.
 */

/** Jak dobře je upozornění umístěné. */
export const PLACEMENT = {
  /** Vidět bez posouvání, u konverzačního prvku nebo v hlavním obsahu. */
  PROMINENT: 'prominent',
  /** Je vykreslené, ale až po posunutí stránky. */
  BELOW_FOLD: 'below-fold',
  /** Jen v patičce nebo v odkazu na podmínky. */
  FOOTER_ONLY: 'footer-only',
  /** V DOM je, ale nevykresluje se (display:none, aria-hidden, nulová velikost). */
  HIDDEN: 'hidden',
  /** Nenalezeno. */
  NONE: 'none',
  /**
   * Nezměřeno.
   *
   * Čtení DOM selhalo, nebo se výsledky rozcházejí (text na stránce je,
   * ale nepodařilo se najít prvek, který ho nese). Vydávat to za „nenalezeno"
   * by znamenalo hlásit prokázané porušení tam, kde měření neproběhlo —
   * přesně to, čemu se celý nástroj vyhýbá.
   */
  UNMEASURED: 'unmeasured',
};

/**
 * Vybere nejlepší z nalezených výskytů.
 *
 * Posuzuje se ten nejlepší, ne první: stránka může mít zmínku v patičce
 * i přímo u chatu, a rozhodující je ta, kterou uživatel uvidí dřív.
 * Hodnotit nejhorší by vyrábělo nálezy tam, kde je vše v pořádku.
 */
const RANK = {
  [PLACEMENT.PROMINENT]: 4,
  [PLACEMENT.BELOW_FOLD]: 3,
  [PLACEMENT.FOOTER_ONLY]: 2,
  [PLACEMENT.HIDDEN]: 1,
  [PLACEMENT.NONE]: 0,
  [PLACEMENT.UNMEASURED]: 0,
};

/**
 * Klasifikuje jeden výskyt.
 *
 * @param {object} o
 * @param {boolean} o.rendered   vykresluje se vůbec?
 * @param {boolean} o.inViewport vidět bez posouvání?
 * @param {boolean} o.inFooter   uvnitř <footer> nebo odkazu na podmínky?
 * @param {boolean} o.nearConversation  u konverzačního prvku?
 */
export function classifyOccurrence(o) {
  if (!o?.rendered) return PLACEMENT.HIDDEN;
  // U konverzačního prvku je upozornění na místě i tehdy, když je chat
  // sám níž na stránce — uživatel ho uvidí ve chvíli, kdy začne psát.
  if (o.nearConversation) return PLACEMENT.PROMINENT;
  if (o.inFooter) return PLACEMENT.FOOTER_ONLY;
  if (o.inViewport) return PLACEMENT.PROMINENT;
  return PLACEMENT.BELOW_FOLD;
}

/**
 * Posoudí všechny výskyty dohromady.
 *
 * @param {Array} occurrences
 * @returns {{placement: string, rationale: string, occurrences: number}}
 */
export function assessDisclosurePlacement(occurrences, context = {}) {
  // `null` znamená, že měření neproběhlo — na rozdíl od prázdného pole,
  // které znamená „hledali jsme a nic nenašli".
  if (occurrences == null) {
    return {
      placement: PLACEMENT.UNMEASURED,
      occurrences: null,
      rationale:
        'Umístění upozornění se nepodařilo změřit (čtení stránky selhalo). ' +
        'Z toho neplyne, že upozornění chybí.',
    };
  }

  const list = Array.isArray(occurrences) ? occurrences : [];

  if (list.length === 0) {
    // Dva případy, kdy „nenašli jsme" NENÍ totéž co „není tam":
    //
    // 1. Text na stránce je (`hasDisclaimer`), ale rozpadá se přes víc
    //    prvků — `<p>Používáme umělou <em>inteligenci</em></p>`. Vzor se
    //    pak nechytne na žádném jednotlivém uzlu.
    // 2. Chat běží v iframu nebo shadow DOM, kam čtení nedohlédne. Tam bývá
    //    upozornění umístěné právě u toho widgetu.
    if (context.textMatched) {
      return {
        placement: PLACEMENT.UNMEASURED,
        occurrences: 0,
        rationale:
          'Text na stránce zmínku o AI obsahuje, ale nepodařilo se určit, ' +
          'který prvek ji nese — nejspíš je rozdělená mezi víc značek. ' +
          'Umístění proto nelze posoudit.',
      };
    }
    if (context.hasEmbeddedWidget) {
      return {
        placement: PLACEMENT.UNMEASURED,
        occurrences: 0,
        rationale:
          'Na stránce je vložený konverzační widget (iframe nebo samostatný ' +
          'komponent), do kterého sken nevidí. Upozornění bývá umístěné právě ' +
          'v něm, takže z jeho nenalezení na hlavní stránce nic neplyne.',
      };
    }
    return {
      placement: PLACEMENT.NONE,
      occurrences: 0,
      rationale: 'Na stránce se nenašla žádná zmínka o použití AI.',
    };
  }

  const classified = list.map(classifyOccurrence);
  const best = classified.reduce(
    (acc, p) => (RANK[p] > RANK[acc] ? p : acc),
    PLACEMENT.HIDDEN
  );

  const RATIONALES = {
    [PLACEMENT.PROMINENT]:
      'Upozornění je vykreslené a uživatel ho uvidí bez posouvání nebo přímo ' +
      'u konverzačního prvku.',
    [PLACEMENT.BELOW_FOLD]:
      'Upozornění je na stránce, ale až pod prvním zobrazením — uživatel ho ' +
      'uvidí jen když stránku posune.',
    [PLACEMENT.FOOTER_ONLY]:
      'Zmínka o AI je pouze v patičce nebo v odkazu na podmínky. Čl. 50 odst. 1 ' +
      'chce informování nejpozději při první interakci; jestli patička tuhle ' +
      'podmínku splňuje, externí sken rozhodnout nedokáže.',
    [PLACEMENT.HIDDEN]:
      'Zmínka o AI je v HTML, ale nevykresluje se (skrytý prvek, nulová ' +
      'velikost, oříznutí nebo poloha mimo plátno). Uživatele informovat nemůže.',
  };

  return {
    placement: best,
    occurrences: list.length,
    rationale: RATIONALES[best],
  };
}

/**
 * Přeloží umístění na stav povinnosti, KDYŽ je použití AI prokázané.
 *
 * Rozhodnutí, které tenhle modul dělá a je jádrem úkolu A4:
 *
 *   prominent    → splněno
 *   below-fold   → neprůkazné; „pod ohybem" není totéž co „neinformoval",
 *                  ale ani totéž co informoval nejpozději při interakci
 *   footer-only  → neprůkazné s vysvětlením; posouzení dostatečnosti je
 *                  právní otázka, ne měření
 *   hidden       → PORUŠENO; upozornění, které se nevykresluje, nemůže
 *                  informovat nikoho — tohle je jediný případ, kdy si sken
 *                  může být jistý
 *   none         → porušeno
 */
export function placementToStatus(placement) {
  switch (placement) {
    case PLACEMENT.PROMINENT:
      return 'pass';
    case PLACEMENT.HIDDEN:
    case PLACEMENT.NONE:
      return 'fail';
    // UNMEASURED, BELOW_FOLD, FOOTER_ONLY i cokoli neznámého → neprůkazné.
    default:
      return 'inconclusive';
  }
}
