/**
 * Které pravidlo registru vyhodnocuje který sken — a jak z výsledku číst
 * verdikt (D5).
 *
 * PROČ TO MUSÍ EXISTOVAT
 * Do neměnného záznamu se dosud zapisovaly jen agentní běhy. Předpisové
 * kontroly — tedy přesně to, co zákazník při kontrole odevzdává — běžely
 * jako bezstavové endpointy a nikde po nich nezůstala stopa. Spis pak nesl
 * doklad o průzkumu aplikace jazykovým modelem a o vlastních kontrolách
 * NIS2, CRA nebo čl. 50 neříkal nic.
 *
 * Zapsat je ale nestačí. Záznam má smysl jen tehdy, když se u něj dá doložit,
 * PODLE ČEHO se měřilo, a to znamená odkaz na konkrétní verzi pravidla.
 * Tenhle modul je ta vazba.
 *
 * ZÁSADA, KTERÉ SE MODUL DRŽÍ
 * Do seznamu patří pravidlo, které sken SKUTEČNĚ vyhodnocuje — ne pravidlo,
 * které s tématem souvisí. Vypsat ve spisu znění kontroly, která neproběhla,
 * je totéž jako tvrdit její výsledek.
 *
 * Verdikt se čte tříhodnotově. `false` znamená prokázané porušení, `null`
 * znamená, že se to nepodařilo posoudit — a to jsou dvě různé věci, které
 * spis nesmí slučovat.
 */

import { ruleRef, getRule } from './rule-registry.js';

/**
 * Pravidla vyhodnocovaná jednotlivými skeny.
 *
 * Uvedeno bez verze: tu doplní `ruleRef` z registru, takže po zvýšení verze
 * pravidla se záznam odkáže na tu novou automaticky a nemůže vzniknout
 * odkaz na verzi, která nikdy neexistovala.
 */
export const AUDIT_RULE_SCOPE = {
  'analyze-nis2': [
    'nis2.headers.hsts',
    'nis2.headers.csp',
    'nis2.headers.frame-options',
    'nis2.headers.content-type-options',
    'nis2.headers.referrer-policy',
    'nis2.headers.permissions-policy',
    'tls.pqc.x25519mlkem768',
    'tls.protocols.deprecated',
    'tls.certificate.validity',
  ],
  // Odst. 3 a 4 se do rozsahu NEDÁVAJÍ.
  //
  // `aiact.cl50.4.deepfake-disclosure` má v registru metodu „Neexistuje
  // automatická kontrola" a `evaluateOutOfScopeObligations` u obou vrací
  // neprůkazné bez jakéhokoli měření. Vypsat jejich znění ve spisu pod
  // nadpisem „Znění použitých pravidel" znamená tvrdit kontrolu, která
  // neproběhla — přesně vada, kterou minulá kontrolní vlna už jednou
  // odstranila a která se sem vrátila jinou cestou.
  //
  // Ve výsledku skenu jsou obě povinnosti dál uvedené jako neprůkazné
  // s vysvětlením; jen se na ně neodkazuje záznam.
  'ai-act-audit': ['aiact.cl50.1.chatbot-disclosure', 'aiact.cl50.2.synthetic-marking'],
  'analyze-cra': ['cra.sbom.bundle-fingerprint'],
  'cra-vuln-audit': ['cra.vulnerabilities.osv'],
  'analyze-accessibility': ['eaa.wcag21aa.axe'],
  // Cookie audit dělá dvě různé věci: trackery před souhlasem (ePrivacy)
  // a příznaky vlastních cookies (aplikační bezpečnost podle § 14).
  // Verdikty se drží odděleně, takže odděleně patří i pravidla.
  'cookie-audit': ['gdpr.cookies.pre-consent', 'appsec.cookies.flags'],
  'analyze-green-gdpr': ['gdpr.residency.geoip'],
  // Chaos test nezkouší předpisovou kontrolu — je to odolnostní experiment.
  // Prázdný seznam to říká pravdivě; přiřadit mu pravidlo „aby tam nějaké
  // bylo" by znamenalo tvrdit kontrolu, která neproběhla.
  'chaos-test': [],
};

/**
 * Plné odkazy na pravidla (`id.vN`) pro daný sken.
 *
 * @param {string} slug
 * @returns {string[]}
 */
export function rulesForAudit(slug) {
  return (AUDIT_RULE_SCOPE[slug] || []).map(ruleRef);
}

/** Lidský název skenu do spisu. */
export const AUDIT_TITLES = {
  'analyze-nis2': 'Bezpečnostní hlavičky a TLS (NIS2 § 14)',
  'ai-act-audit': 'Povinnosti podle čl. 50 AI Act',
  'analyze-cra': 'Soupis komponent (CRA, SBOM)',
  'cra-vuln-audit': 'Známé zranitelnosti komponent (CRA)',
  'analyze-accessibility': 'Přístupnost podle WCAG 2.1 AA (EAA)',
  'cookie-audit': 'Cookies — trackery před souhlasem a příznaky',
  'analyze-green-gdpr': 'Umístění serverů (GDPR, rezidence dat)',
  'chaos-test': 'Odolnostní test za nepříznivých podmínek',
};

/**
 * Dílčí verdikty skenu.
 *
 * Každá položka je `{key, label, ok, rationale}`, kde `ok` je `true`,
 * `false` nebo `null`. Tříhodnotovost je celý smysl: sken, který se
 * nepodařilo provést, nesmí vyjít stejně jako sken, který nic nenašel.
 *
 * Čte se defenzivně — chybějící pole dává `null`, ne `false`. Odvodit
 * z nepřítomnosti dat porušení by znamenalo hlásit nález na základě
 * vlastní chyby.
 */
export function verdictsForAudit(slug, result) {
  if (!result || typeof result !== 'object') return [];

  switch (slug) {
    case 'analyze-nis2':
      return [
        {
          key: 'nis2.headers-tls',
          label: 'Bezpečnostní hlavičky a TLS',
          ok: tri(result.nis2?.isCompliant),
          rationale:
            result.nis2?.scope ||
            'Kontrola hlaviček a TLS vrstvy. Nejde o posouzení shody s NIS2 jako celkem.',
        },
        {
          key: 'tls.pqc',
          label: 'Hybridní post-kvantová výměna klíčů',
          // POZOROVÁNÍ, ne kontrola. Post-kvantovou výměnu dnes žádný
          // předpis nevyžaduje, takže „nepodporuje" není porušení.
          //
          // Dřív se změřené `false` balilo do `null`, což mělo dva zlé
          // následky: spis tvrdil „nepodařilo se posoudit" o měření, které
          // proběhlo, a NIS2 sken nemohl nikdy vyjít bez nálezu — bezvadný
          // web s TLS 1.3 dostal trvale „Neprůkazné".
          //
          // `advisory` říká, že se výsledek do celkového verdiktu nepočítá.
          advisory: true,
          ok: tri(result.tls?.pqc?.supported),
          rationale:
            (result.tls?.pqc?.rationale ||
              'Podporu se nepodařilo ověřit.') +
            ' Absence hybridní post-kvantové výměny klíčů dnes není porušením ' +
            'předpisu — jde o pozorování, ne o nález.',
        },
      ];

    case 'ai-act-audit':
      return (result.aiAct?.obligations || []).map((o) => ({
        key: o.id,
        label: o.title || o.id,
        ok: statusToTri(o.status),
        rationale: o.rationale || '',
      }));

    case 'analyze-cra': {
      const found = result.sbom?.length ?? 0;
      const ev = result.evidence || {};
      return [
        {
          key: 'cra.sbom',
          label: 'Soupis komponent',
          // Soupis komponent není kontrola, která by šla splnit či nesplnit —
          // je to zjištění stavu. Verdikt proto zůstává neprůkazný a report
          // uvádí, co se našlo i co se přečíst nepodařilo.
          ok: null,
          rationale:
            `Nalezeno ${found} komponent z ${ev.scriptsScanned ?? '?'} přečtených skriptů` +
            (ev.scriptsUnreadable ? ` (${ev.scriptsUnreadable} se přečíst nepodařilo)` : '') +
            (ev.truncated ? ', prohledávání bylo useknuto na horním limitu' : '') +
            '. Soupis z prohlížeče vidí jen to, co stránka načte — serverové ' +
            'závislosti v něm nejsou, takže úplnost SBOM z toho neplyne.',
        },
      ];
    }

    case 'cra-vuln-audit':
      return [
        {
          key: 'cra.vulnerabilities',
          label: 'Známé zranitelnosti komponent',
          ok: vulnVerdict(result),
          rationale: vulnRationale(result),
        },
      ];

    case 'analyze-accessibility':
      return [
        {
          key: 'eaa.wcag21aa',
          label: 'Přístupnost podle WCAG 2.1 AA',
          // Prázdný seznam porušení u nenačtené stránky NENÍ splnění.
          ok:
            result.navigationError || !Array.isArray(result.violations)
              ? null
              : result.violations.length === 0,
          rationale:
            `Automaticky zjištěno ${result.violations?.length ?? 0} porušení a ` +
            `${result.incomplete?.length ?? 0} položek k ručnímu posouzení. ` +
            'Automatický test pokrývá jen část kritérií WCAG — absence nálezu ' +
            'není důkazem přístupnosti.',
        },
      ];

    case 'cookie-audit':
      return [
        {
          key: 'gdpr.cookies.pre-consent',
          label: 'Trackery před udělením souhlasu',
          // Nenačtená stránka → neprůkazné, ať skener vrátí cokoli.
          // Druhá pojistka vedle té v agent.js: čtení výsledku se nesmí
          // spoléhat na to, že si měřič vždy vzpomene.
          ok: result.navigationError ? null : tri(result.gdpr?.isCompliant),
          rationale: result.gdpr?.rating || '',
        },
        {
          key: 'appsec.cookies.flags',
          label: 'Příznaky cookies (Secure, HttpOnly, SameSite)',
          ok: tri(result.cookieFlags?.ok),
          rationale: result.cookieFlags?.rationale || '',
        },
      ];

    case 'analyze-green-gdpr':
      return [
        {
          key: 'gdpr.residency',
          label: 'Umístění serverů v EU/EHP',
          ok: tri(result.residency?.isEUCompliant),
          rationale:
            result.residency?.warning ||
            'Umístění se odvozuje z geolokace IP, která u anycast CDN ukazuje ' +
              'na nejbližší uzel, ne na místo uložení dat.',
        },
      ];

    case 'chaos-test':
      return [
        {
          key: 'chaos.resilience',
          label: 'Chování za nepříznivých podmínek',
          // Odolnostní experiment, ne předpisová kontrola. Vydávat jeho
          // výsledek za splnění či porušení by bylo zavádějící.
          ok: null,
          rationale:
            'Experiment ověřuje chování aplikace při zhoršených podmínkách. ' +
            'Nejde o kontrolu podle předpisu, takže z něj splnění ani ' +
            'porušení neplyne.',
        },
      ];

    default:
      return [];
  }
}

/**
 * Celkový verdikt skenu z dílčích.
 *
 * Pravidlo je záměrně přísné v obou směrech:
 *   • jediné prokázané porušení shodí celek na `false`
 *   • jediný neprůkazný dílčí výsledek brání tvrdit `true`
 *
 * Druhá půlka je ta podstatná. Bez ní by sken, který polovinu kontrol
 * neprovedl, vyšel jako „v pořádku".
 */
export function overallVerdict(verdicts) {
  // Pozorování (`advisory`) se do verdiktu nepočítají. Jsou to zjištění,
  // která žádný předpis nevyžaduje — jejich `false` není porušení a jejich
  // `null` nesmí bránit tvrdit splnění.
  const list = (Array.isArray(verdicts) ? verdicts : []).filter((v) => !v?.advisory);
  if (list.length === 0) return null;
  if (list.some((v) => v.ok === false)) return false;
  if (list.some((v) => v.ok === null)) return null;
  return true;
}

/** Normalizace na tři stavy. Cokoli jiného než true/false je neprůkazné. */
function tri(value) {
  if (value === true) return true;
  if (value === false) return false;
  return null;
}

/** Stav povinnosti podle AI Actu na tři stavy. */
function statusToTri(status) {
  if (status === 'pass') return true;
  if (status === 'fail') return false;
  // `not_applicable` i `inconclusive` → neprůkazné. Nepoužitelnou povinnost
  // nelze vydávat za splněnou.
  return null;
}

/**
 * Verdikt zranitelností.
 *
 * Skener sám vrací `cra.isCompliant` jako tři stavy a `null` používá tam,
 * kde se SBOM nepodařilo sestavit. Přepočítávat to tady vlastní logikou by
 * znamenalo mít dva soudce téže věci, kteří se časem rozejdou — přesně to,
 * co se u CSP muselo rozplétat.
 *
 * Jediná úprava: nula nálezů se NEPOVYŠUJE na `true`. Znamená to „nic ze
 * zjištěných verzí nesedí na známou zranitelnost", ne „aplikace je bez
 * zranitelností"; u části knihoven se verzi zjistit nedaří a serverové
 * závislosti sken nevidí vůbec.
 */
function vulnVerdict(result) {
  // Skener sám vrací poctivý tři-stav a `true` dává jen tehdy, když byly
  // ověřeny všechny nalezené knihovny, všechny skripty se přečetly
  // a nenarazilo se na limit. Přepisovat to tady na `null` znamenalo mít
  // dva soudce téže věci — a zahodit výsledek, který skener poctivě změřil.
  return tri(result.cra?.isCompliant);
}

function vulnRationale(result) {
  const cra = result.cra;
  if (!cra) return 'Výsledek skenu se nepodařilo přečíst, verdikt je neprůkazný.';
  const count = cra.vulnerabilities?.length ?? 0;
  const skipped = cra.skipped?.length ?? 0;
  const skippedNote = skipped
    ? ` U ${skipped} komponent se verzi zjistit nepodařilo, takže do porovnání nevstoupily.`
    : '';

  if (count > 0) {
    return (
      `Nalezeno ${count} známých zranitelností u komponent zjištěných v prohlížeči.` +
      `${skippedNote} Skutečný počet může být vyšší.`
    );
  }
  return (
    'U zjištěných komponent se nenašla shoda se známou zranitelností. ' +
    'Z toho neplyne, že aplikace zranitelná není: sken vidí jen to, co ' +
    `stránka načte do prohlížeče.${skippedNote}`
  );
}

/**
 * Kontrola, že mapa neodkazuje na neexistující pravidlo.
 *
 * Volá se v testu, ne za běhu. Překlep v id by jinak vyrobil záznam
 * odkazující na pravidlo, které nikdy neexistovalo — a ten se z neměnného
 * souboru nedá vzít zpátky.
 */
export function unknownRuleIds() {
  const unknown = [];
  for (const [slug, ids] of Object.entries(AUDIT_RULE_SCOPE)) {
    for (const id of ids) {
      if (!getRule(id)) unknown.push(`${slug}: ${id}`);
    }
  }
  return unknown;
}
