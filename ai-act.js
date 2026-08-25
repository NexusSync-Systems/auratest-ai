/**
 * AI Act, článek 50 — transparentnost.
 *
 * Článek 50 obsahuje ČTYŘI samostatné povinnosti, ne jednu. Skener je dřív
 * slučoval do jednoho výsledku, takže report tvrdil víc, než uměl doložit.
 * Tenhle modul je drží oddělené a u každé říká, jestli ji vůbec umíme
 * zvenčí posoudit.
 *
 * Povinnosti (zjednodušeně, plné znění viz zdroj):
 *   1) AI systém interagující s člověkem musí uživatele informovat,
 *      že komunikuje s AI  → testovatelné dobře
 *   2) Syntetický obsah musí být označený strojově čitelně a detekovatelně
 *      → testovatelné částečně (C2PA / Content Credentials)
 *   3) Rozpoznávání emocí a biometrická kategorizace — informovat dotčené
 *      → zvenčí prakticky netestovatelné (povinnost provozovatele)
 *   4) Deepfakes a AI-generovaný obsah — zveřejnit, že jde o umělý obsah
 *      → zvenčí prakticky netestovatelné (povinnost provozovatele)
 *
 * Účinnost: 2. 8. 2026. Digital Omnibus (nařízení EU 2026/1744) odložil
 * povinnosti pro vysoce rizikové systémy, ale článek 50 odložen NEBYL.
 *
 * Zdroj: https://artificialintelligenceact.eu/article/50/
 *
 * Logika je záměrně v samostatném modulu bez Playwrightu, aby šla testovat
 * jednotkově — v projektu je většina chyb historicky vznikala právě v místech,
 * která se dala ověřit jen spuštěním prohlížeče.
 */

/** Stavy jednotlivé povinnosti. */
import { placementToStatus } from './disclosure-placement.js';

export const OBLIGATION_STATUS = {
  PASS: 'pass',
  FAIL: 'fail',
  INCONCLUSIVE: 'inconclusive',
  NOT_APPLICABLE: 'not_applicable',
};

/** Volání AI API viditelná z prohlížeče. Seznam je nutně neúplný. */
export const AI_API_HOST_PATTERNS = [
  'api.openai.com', 'anthropic.com', 'generativelanguage.googleapis',
  'huggingface.co', 'openai.azure.com', 'api.cohere', 'api.mistral.ai',
  'api.replicate.com', 'bedrock-runtime', 'aiplatform.googleapis',
  'api.perplexity.ai', 'api.together.xyz', 'api.groq.com',
  'api.deepseek.com', 'api.x.ai', 'api.anthropic.com',
];

/**
 * Hostitelé chatovacích widgetů. Většina z nich AI nemusí používat —
 * detekce widgetu proto sama o sobě NEznamená AI systém, jen zvedá
 * podezření a mění výsledek z „nic jsme nenašli" na „něco tu je,
 * posuďte ručně".
 */
export const CHAT_WIDGET_HOSTS = [
  'intercom.io', 'intercomcdn.com',
  'drift.com', 'driftt.com',
  'tidio.co', 'tidiochat.com',
  'crisp.chat',
  'zendesk.com', 'zdassets.com',
  'livechatinc.com',
  'hs-scripts.com', 'hubspot.com/conversations',
  'freshchat.com', 'freshworks.com',
  'tawk.to',
  'smartsupp.com',
  'chatra.io',
  'landbot.io',
  'voiceflow.com',
  'botpress.cloud',
  'chatbase.co',
  'crisp.im',
];

/**
 * Upozornění na AI. Slovní hranice jsou nutné — dřívější `includes('ai')`
 * matchovalo „email", „detail", „main", takže prošla každá stránka.
 * `\b` v JS nefunguje spolehlivě u znaků s diakritikou, proto jsou české
 * výrazy psané tak, aby na hranici nezáležely.
 */
export const AI_DISCLAIMER_PATTERN = new RegExp(
  [
    '\\bAI\\b',
    '\\bA\\.I\\.',
    'umělou?\\s+inteligenc',
    'umělá\\s+inteligence',
    'generativní',
    'vygenerováno\\s+(AI|umělou)',
    'generated\\s+by\\s+AI',
    'AI[- ]asistent',
    'AI[- ]assistant',
    'chatbot',
    'virtuální\\s+asistent',
    'automatický\\s+asistent',
  ].join('|'),
  'i'
);

/** Vrátí true, když hostname odpovídá některému vzoru. */
function matchesAny(value, patterns) {
  const haystack = String(value || '').toLowerCase();
  return patterns.some((p) => haystack.includes(p));
}

export function isAiApiUrl(url) {
  return matchesAny(url, AI_API_HOST_PATTERNS);
}

export function isChatWidgetUrl(url) {
  return matchesAny(url, CHAT_WIDGET_HOSTS);
}

// ─────────────────────────────────────────────────────────────────────────────
// Povinnost 1 — informování, že uživatel komunikuje s AI
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {object} signals
 * @param {string[]} signals.aiApiCalls   volání AI API zachycená v síti
 * @param {string[]} signals.chatWidgets  hostitelé chat widgetů v síti
 * @param {object}   signals.dom          výsledek detekce z DOM (viz collectDomSignals)
 * @param {boolean}  signals.hasDisclaimer nalezeno upozornění v textu stránky
 */
export function evaluateInteractionObligation(signals) {
  const aiApiCalls = signals.aiApiCalls || [];
  const chatWidgets = signals.chatWidgets || [];
  const dom = signals.dom || {};
  const hasDisclaimer = Boolean(signals.hasDisclaimer);

  const domHits = dom.chatIndicators || [];
  const hasStrongSignal = aiApiCalls.length > 0;
  const hasWeakSignal = chatWidgets.length > 0 || domHits.length > 0;

  // Kde je upozornění umístěné. Bez téhle informace (starší běh, chyba
  // čtení DOM) se zachovává původní chování podle pouhé přítomnosti textu.
  const disclosure = signals.disclosure || null;

  const evidence = {
    aiApiCalls,
    chatWidgets,
    domIndicators: domHits,
    hasDisclaimer,
    disclosurePlacement: disclosure?.placement ?? null,
    disclosureOccurrences: disclosure?.occurrences ?? null,
  };

  // Přímý důkaz volání AI API — o použití AI není pochyb.
  if (hasStrongSignal) {
    // Existence textu nestačí.
    //
    // Dřív z „na stránce je někde slovo AI" plynulo SPLNĚNO. Projde tím
    // zmínka v patičce i v marketingové větě. Čl. 50 odst. 1 chce
    // informování „nejpozději při první interakci", takže rozhoduje, jestli
    // ho uživatel uvidí — a to je měřitelné.
    if (disclosure) {
      const status = placementToStatus(disclosure.placement);
      return {
        id: 'art50.1',
        title: 'Informování uživatele, že komunikuje s AI',
        status: OBLIGATION_STATUS[status.toUpperCase()] || OBLIGATION_STATUS.INCONCLUSIVE,
        evidence,
        rationale:
          `Zachyceno ${aiApiCalls.length} volání AI API. ${disclosure.rationale}`,
      };
    }

    return {
      id: 'art50.1',
      title: 'Informování uživatele, že komunikuje s AI',
      status: hasDisclaimer ? OBLIGATION_STATUS.PASS : OBLIGATION_STATUS.FAIL,
      evidence,
      rationale: hasDisclaimer
        ? `Zachyceno ${aiApiCalls.length} volání AI API a na stránce je upozornění na AI.`
        : `Zachyceno ${aiApiCalls.length} volání AI API, ale upozornění na AI se na stránce nenašlo.`,
    };
  }

  // Nepřímý signál: chat widget nebo konverzační prvek v DOM. Nevíme, jestli
  // za ním stojí AI, nebo živý operátor — proto nikdy FAIL, jen neprůkazné.
  if (hasWeakSignal) {
    const what = [
      chatWidgets.length ? `chat widget (${chatWidgets.join(', ')})` : null,
      domHits.length ? `konverzační prvky v DOM (${domHits.slice(0, 3).join(', ')})` : null,
    ].filter(Boolean).join(' a ');

    return {
      id: 'art50.1',
      title: 'Informování uživatele, že komunikuje s AI',
      status: OBLIGATION_STATUS.INCONCLUSIVE,
      evidence,
      rationale: hasDisclaimer
        ? `Nalezen ${what} a zároveň upozornění na AI. Nelze ale potvrdit, že chat pohání AI — mohl by to být živý operátor. Posuďte ručně.`
        : `Nalezen ${what}, ale žádné upozornění na AI. Pokud chat pohání AI, je to pravděpodobné porušení čl. 50 odst. 1. Pokud za ním sedí člověk, povinnost se neuplatní. Posuďte ručně.`,
    };
  }

  // Žádný signál. Server-side AI bez konverzačního UI zvenčí nepoznáme.
  return {
    id: 'art50.1',
    title: 'Informování uživatele, že komunikuje s AI',
    status: OBLIGATION_STATUS.INCONCLUSIVE,
    evidence,
    rationale: 'Nezachyceno volání AI API ani konverzační prvek. Server-side integraci tímto testem vyloučit nelze.',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Povinnost 2 — strojově čitelné označení syntetického obsahu
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Čl. 50 odst. 2 vyžaduje, aby výstupy generativních systémů byly označené
 * ve strojově čitelném formátu. Technický standard se teprve ustaluje přes
 * Kodex správné praxe; nejrozšířenější kandidát je C2PA (Content Credentials).
 *
 * Zvenčí umíme zjistit jen to, JESTLI obrázky nesou C2PA manifest — ne to,
 * jestli byly generované AI. Proto je výsledek nanejvýš „neprůkazné".
 */
export function evaluateSyntheticMarkingObligation(signals) {
  const images = signals.dom?.images || { total: 0, withC2pa: 0, sampled: 0 };
  const generatesContent = (signals.aiApiCalls || []).length > 0;

  // Rozbor manifestů. Chybí u starších uložených běhů, proto volitelně.
  const c2pa = images.c2pa || null;

  const evidence = {
    imagesTotal: images.total,
    imagesSampled: images.sampled,
    imagesWithC2pa: images.withC2pa,
    imagesDeclaredAi: c2pa?.declaredAi ?? null,
    imagesDeclaredCapture: c2pa?.declaredCapture ?? null,
    imagesUnsampled: c2pa?.unsampled ?? null,
  };

  if (images.total === 0) {
    return {
      id: 'art50.2',
      title: 'Strojově čitelné označení syntetického obsahu',
      status: OBLIGATION_STATUS.NOT_APPLICABLE,
      evidence,
      rationale: 'Na stránce nejsou obrázky, u kterých by šlo označení ověřit.',
    };
  }

  if (images.withC2pa > 0) {
    // Nově se rozlišuje, CO manifest tvrdí.
    //
    // Verze 1 uměla jen „pověření tam je". Obrázek s pověřením, které se
    // hlásí jako pořízený fotoaparátem, a obrázek hlásící se jako výstup
    // generativního modelu jsou přitom pro čl. 50 odst. 2 dvě různé věci:
    // v druhém případě označení PROKAZATELNĚ existuje.
    const declaredAi = c2pa?.declaredAi ?? 0;

    const detail = declaredAi > 0
      ? `${declaredAi} z nich se hlásí jako vytvořené generativním modelem, ` +
        'takže označení u nich existuje. Podpis manifestu se neověřuje — jde ' +
        'o tvrzení obsažené v souboru, ne o prokázaný původ.'
      : 'Žádný z nich se ale nehlásí jako vytvořený AI.';

    const unsampled = c2pa?.unsampled
      ? ` Zbylých ${c2pa.unsampled} obrázků na stránce zůstalo neprozkoumaných.`
      : '';

    return {
      id: 'art50.2',
      title: 'Strojově čitelné označení syntetického obsahu',
      // Stále neprůkazné: i když je něco označené, o ZBYTKU syntetického
      // obsahu to nic neříká. Vydávat vzorek za celek by bylo přesně to
      // tvrzení nad rámec měření, kterému se nástroj vyhýbá.
      status: OBLIGATION_STATUS.INCONCLUSIVE,
      evidence,
      rationale:
        `${images.withC2pa} z ${images.sampled} zkoumaných obrázků nese C2PA ` +
        `manifest. ${detail}${unsampled} Zda jsou označené VŠECHNY syntetické ` +
        'výstupy, tímto testem zjistit nelze.',
    };
  }

  return {
    id: 'art50.2',
    title: 'Strojově čitelné označení syntetického obsahu',
    status: OBLIGATION_STATUS.INCONCLUSIVE,
    evidence,
    rationale: generatesContent
      ? `Aplikace volá AI API, ale žádný z ${images.sampled} zkoumaných obrázků nenese C2PA manifest. Pokud generuje obrazový obsah, je to podezření na porušení čl. 50 odst. 2 — ověřte, jaký obsah systém generuje.`
      : `Žádný z ${images.sampled} zkoumaných obrázků nenese C2PA manifest. Bez znalosti toho, co systém generuje, z toho ale nelze usuzovat na porušení.`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Povinnosti 3 a 4 — mimo dosah externího skeneru
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Čl. 50 odst. 3 (rozpoznávání emocí, biometrická kategorizace) a odst. 4
 * (deepfakes) jsou povinnosti PROVOZOVATELE a týkají se toho, co se děje
 * uvnitř systému. Externí sken webu je posoudit nedokáže.
 *
 * Vracíme je vědomě jako `inconclusive` s jasným odůvodněním, místo abychom
 * je zamlčeli — právě proto, aby report ukazoval i to, co nástroj neumí.
 */
export function evaluateOutOfScopeObligations(signals) {
  const biometricHints = signals.dom?.biometricHints || [];

  return [
    {
      id: 'art50.3',
      title: 'Informování o rozpoznávání emocí a biometrické kategorizaci',
      status: OBLIGATION_STATUS.INCONCLUSIVE,
      outOfScope: true,
      evidence: { hints: biometricHints },
      rationale: biometricHints.length
        ? `Na stránce jsou prvky, které mohou souviset s biometrií (${biometricHints.join(', ')}). Zda jde o rozpoznávání emocí nebo kategorizaci, externí sken neurčí — posuďte ručně.`
        : 'Povinnost provozovatele. Externí sken webu ji posoudit nedokáže — vyžaduje znalost toho, co systém uvnitř dělá.',
    },
    {
      id: 'art50.4',
      title: 'Zveřejnění, že obsah je umělý (deepfakes)',
      status: OBLIGATION_STATUS.INCONCLUSIVE,
      outOfScope: true,
      evidence: {},
      rationale: 'Povinnost provozovatele. Rozpoznat deepfake automaticky ze stránky nelze — vyžaduje znalost původu obsahu.',
    },
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// Souhrn
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Poskládá výsledek čtyř povinností a odvodí souhrn.
 *
 * Souhrnný `isCompliant` je `false` jen tehdy, když nějaká povinnost
 * PROKAZATELNĚ selhala. Jinak je `null` (neprůkazné) — nikdy `true`,
 * protože dvě ze čtyř povinností zvenčí ověřit nejde a tvrdit celkovou
 * shodu by bylo nepodložené.
 */
export function summarizeObligations(obligations) {
  const counts = {
    pass: 0,
    fail: 0,
    inconclusive: 0,
    not_applicable: 0,
  };
  for (const o of obligations) counts[o.status] += 1;

  const hasFailure = counts.fail > 0;
  const allResolved = counts.inconclusive === 0;

  let isCompliant;
  let rating;

  if (hasFailure) {
    isCompliant = false;
    const failed = obligations.filter((o) => o.status === OBLIGATION_STATUS.FAIL);
    rating = `NESPLNĚNO: ${failed.length} z ${obligations.length} povinností čl. 50 prokazatelně nesplněno (${failed.map((o) => o.id).join(', ')}).`;
  } else if (allResolved) {
    // Prakticky nedosažitelné, protože odst. 3 a 4 jsou vždy neprůkazné.
    isCompliant = true;
    rating = 'SPLNĚNO: všechny ověřitelné povinnosti čl. 50 splněny.';
  } else {
    isCompliant = null;
    rating = `NEPRŮKAZNÉ: ${counts.inconclusive} ze ${obligations.length} povinností čl. 50 nelze externím skenem posoudit. Splnění ani porušení nelze tvrdit.`;
  }

  return { counts, isCompliant, rating };
}
