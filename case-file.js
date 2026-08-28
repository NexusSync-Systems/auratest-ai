/**
 * Spis za období — to, co zákazník při kontrole reálně odevzdává (D4).
 *
 * PROČ TO NENÍ JEN VÝPIS BĚHŮ
 * Kontrolor se ptá: co jste měřili, kdy, jakým pravidlem, s jakým výsledkem,
 * a proč u některých položek nic netvrdíte. Poslední otázka je ta, na které
 * běžné skenery selhávají — buď neprůkazné výsledky zamlčí, nebo je vydají
 * za splněné. Ve spisu proto mají vlastní oddíl, ne poznámku pod čarou.
 *
 * CO SPIS OBSAHUJE
 *   • období a kdo ho vygeneroval
 *   • každý běh: cíl, čas, verdikt, otisk výsledku, otisk záznamu
 *   • ZNĚNÍ PRAVIDEL platné v době měření, ne dnešní — proto se ukládá
 *     verze u každého pravidla a otisk celé sady
 *   • stav ověření řetězu záznamů
 *   • výslovný oddíl „co tímto spisem doloženo NENÍ"
 *
 * Sestavení je oddělené od vykreslení, aby šlo testovat bez prohlížeče
 * a aby JSON i PDF nesly prokazatelně tentýž obsah.
 */

import { RULES, rulesetInfo } from './rule-registry.js';
import { verifyChain, headHash, digestOf, auditResultOf } from './audit-ledger.js';

/**
 * Odpovídá uložený otisk tomu, co je dnes v databázi?
 *
 * @returns {boolean|null} null = nelze ověřit (starý záznam bez otisku)
 */
function verifyResultDigest(session, record) {
  if (!record?.resultDigest) return null;
  try {
    return digestOf(auditResultOf(session)) === record.resultDigest;
  } catch {
    return null;
  }
}

/** Verze formátu spisu. Až se změní, staré spisy musí zůstat čitelné. */
export const CASE_FILE_SCHEMA = 1;

/**
 * Meze, které platí pro spis jako celek.
 *
 * Nejsou to výhrady z opatrnosti — jsou to fakta o metodě. Kdyby ve spisu
 * chyběly, četl by ho kontrolor jako silnější důkaz, než jaký je, a to je
 * pro zákazníka nebezpečnější než přísnější nález.
 */
export const CASE_FILE_LIMITS = [
  'Spis dokládá výsledky externího skenu. Externí sken nevidí do serverové ' +
    'části aplikace, do zdrojového kódu ani do organizačních opatření, která ' +
    'předpisy vyžadují stejně jako technická.',
  'Neprůkazný výsledek znamená, že kontrola neproběhla dost spolehlivě na ' +
    'závěr. Není to ani splnění, ani porušení — a nelze ho tak vykládat ' +
    'v žádném směru.',
  'Řetězení záznamů dokazuje, že s historií nikdo dodatečně nehýbal ' +
    'doprostřed. Samo o sobě nedokazuje nemožnost podvrhu: kdo má právo ' +
    'zapisovat, může přepsat celý řetěz a otisky přepočítat, a odstranění ' +
    'nejnovějších položek po sobě nezanechá stopu. Obojí vylučuje až ' +
    'ukotvení otisku mimo systém — viz oddíl Neporušenost záznamu. ' +
    'Záznamy pořízené po posledním ukotvení kryté nejsou.',
  'Časová razítka pocházejí z hodin serveru, ne od autority časových razítek.',
  'Spis není právní posouzení shody. Je to doklad o provedených měřeních.',
  'Nálezy z autonomního průzkumu aplikace pocházejí z posouzení jazykovým ' +
    'modelem, ne z pravidla registru. Nejsou reprodukovatelné stejným způsobem ' +
    'jako předpisové kontroly a je namístě je ověřit ručně, než se z nich ' +
    'vyvodí závěr.',
  'Chyby měření (timeout, pád prohlížeče) se ve spisu drží odděleně od ' +
    'nálezů. Běh, jehož měření se nedokončilo, je vždy neprůkazný — nikdy ' +
    'z něj neplyne nález ani jeho absence.',
];

/**
 * Verdikt předpisové kontroly.
 *
 * Vychází z tříhodnotových výsledků jednotlivých kontrol:
 *   • jediné prokázané porušení → nález
 *   • jediná neposouzená kontrola → neprůkazné, i když ostatní prošly
 *   • vše posouzeno a bez porušení → bez nálezu (NE „v souladu")
 *
 * Druhá odrážka je ta podstatná. Bez ní by sken, u kterého polovina
 * kontrol neproběhla, vyšel jako v pořádku.
 */
function complianceVerdict(session) {
  const checks = Array.isArray(session.checks) ? session.checks : [];
  if (session.status !== 'completed' || checks.length === 0) {
    return {
      value: 'inconclusive',
      label: 'Neprůkazné',
      rationale:
        'Sken neproběhl nebo nevrátil žádný dílčí výsledek. Z toho neplyne ' +
        'nález ani jeho absence.',
    };
  }

  const failed = checks.filter((c) => c.ok === false);
  const unresolved = checks.filter((c) => c.ok !== true && c.ok !== false);

  if (failed.length > 0) {
    return {
      value: 'findings',
      label: `Nálezy: ${failed.length}`,
      rationale:
        `Z ${checks.length} kontrol ${failed.length} prokazatelně nesplněno` +
        (unresolved.length ? `, ${unresolved.length} se nepodařilo posoudit` : '') +
        '. Jednotlivé kontroly jsou uvedené níž.',
    };
  }

  if (unresolved.length > 0) {
    return {
      value: 'inconclusive',
      label: 'Neprůkazné',
      rationale:
        `Z ${checks.length} kontrol se ${unresolved.length} nepodařilo posoudit. ` +
        'Ostatní neskončily nálezem, ale dokud zbývá neposouzená kontrola, ' +
        'nelze o výsledku tvrdit ani splnění, ani porušení.',
    };
  }

  return {
    value: 'no-findings',
    label: 'Bez nálezu',
    rationale:
      `Všech ${checks.length} kontrol proběhlo a žádná neskončila nálezem. ` +
      'Absence nálezu není důkazem shody — viz meze spisu.',
  };
}

/**
 * Verdikt jednoho běhu.
 *
 * Běh, který skončil chybou, NENÍ nález na testované aplikaci — je to
 * neproběhlé měření. Splést to znamená připsat zákazníkovi vadu, kterou
 * nikdo neprokázal.
 */
function verdictOf(session) {
  // Předpisová kontrola se čte jinak než agentní běh.
  //
  // Agentní běh hlásí nálezy jako seznam; verdikt jde odvodit z jeho délky.
  // Compliance sken má tříhodnotové výsledky jednotlivých kontrol a odvozovat
  // je z `bugs` by je zploštilo na dva stavy — přesně to slučování
  // „neprůkazné = v pořádku", kterému se celý nástroj vyhýbá.
  if (session.kind === 'compliance-scan') return complianceVerdict(session);

  if (session.status !== 'completed') {
    return {
      value: 'inconclusive',
      label: 'Neprůkazné',
      rationale:
        session.status === 'failed'
          ? `Běh neskončil úspěšně (${session.summary || 'bez bližšího údaje'}). ` +
            'Z nedokončeného měření neplyne nález ani jeho absence.'
          : `Běh je ve stavu „${session.status}" — výsledek zatím není k dispozici.`,
    };
  }

  // Souhrn od skeneru bývá stručný („Nález.") a jako odůvodnění nestačí.
  // Verdikt proto vždycky nese vlastní větu a souhrn se k ní jen připojí.
  const detail = session.summary ? ` Souhrn skeneru: ${session.summary}` : '';

  // Pojistka pro starší záznamy: běh, který má zapsanou chybu měření, není
  // průkazný, ať už je jeho `status` jakýkoli. Dřív se chyby měření zapisovaly
  // do `bugs` a takový běh se ve spisu tvářil jako doložený nález.
  if (session.runErrors?.length) {
    return {
      value: 'inconclusive',
      label: 'Neprůkazné',
      rationale:
        `Měření se nedokončilo (${session.runErrors[0]}). Z nedokončeného ` +
        'měření neplyne nález ani jeho absence.',
    };
  }

  const bugs = session.bugs?.length ?? 0;
  if (bugs > 0) {
    return {
      value: 'findings',
      label: `Nálezy: ${bugs}`,
      rationale:
        `Měření proběhlo a zaznamenalo ${bugs} ${bugs === 1 ? 'nález' : 'nálezů'}; ` +
        `jednotlivé položky jsou uvedené níž.${detail}`,
    };
  }

  return {
    value: 'no-findings',
    label: 'Bez nálezu',
    rationale:
      'Kontroly proběhly a nezaznamenaly nález. Absence nálezu není důkazem ' +
      `shody — viz meze spisu.${detail}`,
  };
}

/**
 * Konec období včetně celého dne.
 *
 * `to='2026-06-15'` se parsuje jako půlnoc, takže běh z 15. 6. v 10:00 by
 * z období vypadl — přestože dokumentace i uživatelské rozhraní slibují
 * „včetně". Frontend si to obcházel vlastním přičtením času; opravou tady
 * platí totéž pro každého konzumenta včetně přímého volání API.
 */
function periodEnd(to) {
  if (!to) return null;
  const t = Date.parse(to);
  if (Number.isNaN(t)) return null;
  // Datum bez časové složky → posunout na konec dne.
  return /^\d{4}-\d{2}-\d{2}$/.test(String(to).trim()) ? t + 86399999 : t;
}

/**
 * Bezpečné porovnání dat.
 *
 * Vrací 'in' | 'out' | 'unreadable'. Tři stavy, ne dva: běh s nečitelným
 * časem NENÍ mimo období — jen nevíme, kam patří. Vracet u něj `false` ho
 * ze spisu tiše odstranilo a rozdíl mezi „nic neproběhlo" a „něco nám
 * vypadlo" nikdo nepoznal.
 */
function periodMembership(timestamp, from, to) {
  const t = Date.parse(timestamp);
  if (Number.isNaN(t)) return 'unreadable';
  if (from && t < Date.parse(from)) return 'out';
  const end = periodEnd(to);
  if (end != null && t > end) return 'out';
  return 'in';
}

/**
 * Sestaví spis.
 *
 * @param {object} input
 * @param {Array} input.sessions   běhy z databáze (plné, ne jen souhrn)
 * @param {Array} input.records    položky záznamu auditů
 * @param {string} [input.from]    ISO datum, včetně
 * @param {string} [input.to]      ISO datum, včetně
 * @param {string} [input.subject] pro koho je spis vystaven
 * @param {object} [input.chain]   výsledek verifyChain(); pro testy
 * @param {string} [input.head]    otisk hlavy; pro testy
 * @param {object} [input.anchor]  shrnutí ukotvení z anchorSummary()
 */
export function buildCaseFile({ sessions, records, from, to, subject, chain, head, anchor }) {
  const recordList = records || [];

  // Duplicitní sessionId se NEPŘEHLÍŽÍ.
  //
  // Dřív tu bylo `new Map(records.map(...))`, kde poslední vyhrál. Kdo má
  // právo zapisovat, mohl přidat druhý záznam téže session s jiným otiskem
  // a spis tiše ukázal jen ten novější — přepis historie, který ověření
  // řetězu odhalit nemůže, protože řetěz sám je v pořádku.
  const byId = new Map();
  const duplicated = new Set();
  for (const r of recordList) {
    if (byId.has(r.sessionId)) duplicated.add(r.sessionId);
    else byId.set(r.sessionId, r);
  }

  const all = sessions || [];
  const inPeriodSessions = [];
  const unreadable = [];
  for (const session of all) {
    const where = periodMembership(session.timestamp, from, to);
    if (where === 'in') inPeriodSessions.push(session);
    else if (where === 'unreadable') unreadable.push(session);
  }

  const chainStatus = chain || verifyChain(undefined, recordList);

  // Problémy řetězu napárované na konkrétní běh, aby výstraha stála u něj,
  // ne jen v souhrnu o dvě kapitoly výš.
  const problemBySession = new Set(
    (chainStatus.problems || []).map((p) => p.sessionId).filter(Boolean)
  );

  const runs = inPeriodSessions
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp))
    .map((session) => {
      const record = byId.get(session.id);
      const verdict = verdictOf(session);
      // Nálezy se u neprůkazného běhu NEVYPISUJÍ. Seznam pod verdiktem
      // „Neprůkazné" se čte jako zjištění, i když jím není.
      const findings = verdict.value === 'inconclusive' ? [] : session.bugs || [];
      return {
        sessionId: session.id,
        target: session.url,
        goal: session.goal,
        // Předpisová kontrola vs. autonomní průzkum. Kontrolor musí poznat,
        // co je měření podle pravidla a co posouzení jazykovým modelem.
        kind: session.kind === 'compliance-scan' ? 'compliance-scan' : 'agent-run',
        performedAt: session.timestamp,
        verdict,
        // Dílčí kontroly u předpisového skenu. Každá nese vlastní verdikt
        // i odůvodnění, takže ve spisu je vidět nejen kolik, ale co přesně.
        checks: Array.isArray(session.checks) ? session.checks : [],
        findings,
        // Varování se drží odděleně od nálezů schválně: jsou to pozorování,
        // ne porušení. Sloučit je by nafouklo počet vad.
        observations: session.warnings || [],
        // Chyby NAŠEHO měření. Patří do spisu, aby bylo vidět, proč je běh
        // neprůkazný — ale nikdy mezi nálezy o auditovaném webu.
        runErrors: session.runErrors || [],
        evidence: record
          ? {
              recorded: true,
              recordHash: record.hash,
              resultDigest: record.resultDigest,
              recordedAt: record.recordedAt,
              toolVersion: record.tool?.version,
              rulesetDigest: record.ruleset?.digest,
              // Otisk se PŘEPOČÍTÁ z uloženého výsledku a porovná.
              // Bez toho je „Otisk výsledku" jen 64znakové číslo pod seznamem
              // nálezů, které nikdo nedokáže zkontrolovat — a čtenář si přitom
              // vyvodí, že ty nálezy kryje.
              digestMatches: verifyResultDigest(session, record),
              chainProblem: problemBySession.has(session.id),
              duplicateRecords: duplicated.has(session.id),
            }
          : {
              recorded: false,
              // Bez záznamu je běh ve spisu pořád uveden — zamlčet ho by
              // znamenalo upravovat historii. Jen se u něj řekne, co z toho
              // plyne; a u běhu, který se nedokončil, se neříká „výsledek
              // platí", protože žádný výsledek není.
              note:
                verdict.value === 'inconclusive'
                  ? 'Měření se nedokončilo, v záznamu auditů proto není žádná položka.'
                  : 'K tomuto běhu chybí položka v záznamu auditů. Výsledek platí, ' +
                    'ale jeho neporušenost tímto spisem doložit nelze.',
            },
      };
    });

  // Do spisu jde znění pravidel, ne odkaz na ně. Za rok už soubor
  // s registrem nemusí být po ruce a odkaz „nis2.headers.csp.v1" by pak
  // nikomu nic neřekl.
  //
  // Vypisují se JEN pravidla, na která se běhy v období skutečně odvolávají.
  // Dřív se tiskl celý registr pod nadpisem „Znění použitých pravidel" —
  // včetně pravidla, jehož metoda zní „neexistuje automatická kontrola".
  // Kontrolor si z toho přečetl, že jsme kontrolovali věci, které jsme
  // nekontrolovali.
  const usedRefs = new Set();
  for (const session of inPeriodSessions) {
    const record = byId.get(session.id);
    // Přednost má záznam: ten je neměnný. Databázový záznam běhu se dá
    // změnit, takže slouží jen jako záloha pro běhy, u kterých se zápis
    // do řetězu nezdařil.
    const refs = record?.rules?.length ? record.rules : session.ruleRefs || [];
    for (const ref of refs) usedRefs.add(ref);
  }
  const ruleSnapshot = RULES.filter((r) => usedRefs.has(`${r.id}.v${r.version}`)).map(
    ({ id, version, title, method, limits, changelog }) => ({
      ref: `${id}.v${version}`,
      title,
      method,
      limits,
      // Changelog patří do spisu: bez něj nejde po roce doložit, proč se týž
      // web posuzuje jinak než dřív.
      changelog: changelog || null,
    })
  );

  const counts = runs.reduce(
    (acc, r) => {
      acc[r.verdict.value] = (acc[r.verdict.value] || 0) + 1;
      return acc;
    },
    { findings: 0, 'no-findings': 0, inconclusive: 0 }
  );

  // Otisk sady pravidel, na který se běhy odvolávaly, proti dnešnímu.
  // Když se liší, znamená to, že se od měření pravidla změnila — a spis to
  // musí říct, protože jinak vydává dnešní znění za znění platné tehdy.
  const today = rulesetInfo();
  const recordedDigests = new Set(
    inPeriodSessions
      .map((session) => byId.get(session.id)?.ruleset?.digest)
      .filter(Boolean)
  );
  const rulesetChanged =
    recordedDigests.size > 0 && [...recordedDigests].some((d) => d !== today.digest);

  const caseFile = {
    schema: CASE_FILE_SCHEMA,
    generatedAt: new Date().toISOString(),
    subject: subject || null,
    period: { from: from || null, to: to || null },
    summary: {
      runs: runs.length,
      withFindings: counts.findings,
      withoutFindings: counts['no-findings'],
      inconclusive: counts.inconclusive,
      unrecorded: runs.filter((r) => !r.evidence.recorded).length,
      // Běhy s nečitelným časem: nepatří do období, ale ani nezmizí.
      // Rozdíl mezi „nic neproběhlo" a „něco nám vypadlo" musí být vidět.
      undatable: unreadable.length,
    },
    runs,
    undatableRuns: unreadable.map((s2) => ({
      sessionId: s2.id,
      target: s2.url,
      rawTimestamp: s2.timestamp ?? null,
    })),
    ledger: {
      headHash: head || headHash(),
      chainOk: chainStatus.ok,
      // Ukotvení mimo systém — jediné, co vylučuje useknutí konce řetězu.
      // Bez něj zůstává tvrzení o neporušenosti omezené na střed historie.
      anchor: anchor || {
        state: 'none',
        anchoredAt: null,
        headHash: null,
        rationale:
          'Ukotvení nebylo pro tento spis zjišťováno; odstranění nejnovějších ' +
          'položek proto vyloučit nelze.',
      },
      recordsTotal: chainStatus.count,
      // Problémy bez `sessionId`: index a popis stačí k doložení, identifikátory
      // cizích auditů do spisu nepatří.
      problems: (chainStatus.problems || []).map(({ index, problem }) => ({ index, problem })),
    },
    ruleset: {
      ...today,
      rules: ruleSnapshot,
      // Snapshot je znění K DATU VYGENEROVÁNÍ. Do záznamu se ukládá jen otisk
      // sady, ne její text, takže tvrdit „znění platné v době měření" nelze.
      snapshotOf: 'generated',
      changedSinceMeasurement: rulesetChanged,
      recordedDigests: [...recordedDigests],
    },
    limits: CASE_FILE_LIMITS,
  };

  // Otisk spisu samotného. Bez něj nemá držitel PDF jak ověřit, že odpovídá
  // strojově čitelné podobě, a naopak. Počítá se nad spisem BEZ tohoto pole —
  // ověření viz `verifyCaseFileDigest`.
  caseFile.selfDigest = digestOf(caseFile);
  return caseFile;
}

/**
 * Ověří otisk spisu.
 *
 * Předpis musí být zapsaný, ne odvozený: kdo dostane JSON a PDF, potřebuje
 * vědět, co přesně se hashovalo. Jinak je otisk v patičce jen dekorace.
 *
 * @param {object} caseFile spis včetně pole `selfDigest`
 */
export function verifyCaseFileDigest(caseFile) {
  if (!caseFile?.selfDigest) return null;
  const { selfDigest, ...body } = caseFile;
  try {
    return digestOf(body) === selfDigest;
  } catch {
    return null;
  }
}

const escapeHtml = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );

const czDate = (iso) => {
  const d = new Date(iso);
  // Zóna se uvádí výslovně. Bez ní se čas tiskne v neurčené zóně serveru
  // a na jiném stroji vyjde jinak — u důkazu musí být čas jednoznačný.
  return Number.isNaN(d.getTime())
    ? '—'
    : `${d.toLocaleString('cs-CZ', { timeZone: 'UTC' })} UTC`;
};

/**
 * Nález na čitelný text.
 *
 * Skenery pracují se strukturami (`{severity, message}`), agent posílá
 * řetězce. `String(objekt)` z toho udělal `[object Object]` — ve spisu
 * odevzdávaném úřadu ztráta obsahu bez varování.
 */
/**
 * Tři stavy dílčí kontroly. Neprůkazné má vlastní značku, ne přeškrtnutí —
 * čtenář musí na první pohled poznat, že se to neměřilo.
 */
const checkLabel = (ok) => (ok === true ? 'SPLNĚNO' : ok === false ? 'NESPLNĚNO' : 'NEPRŮKAZNÉ');
const checkClass = (ok) => (ok === true ? 'pass' : ok === false ? 'fail' : 'unknown');

const findingText = (f) => {
  if (f == null) return '—';
  if (typeof f === 'string') return f;
  if (typeof f === 'object') {
    const base = f.message || f.title || f.text;
    if (base) return f.severity ? `[${f.severity}] ${base}` : String(base);
    try {
      return JSON.stringify(f);
    } catch {
      return String(f);
    }
  }
  return String(f);
};

/**
 * HTML podoba spisu — předloha pro tisk do PDF.
 *
 * Záměrně bez externích zdrojů: spis se archivuje a musí se dát otevřít
 * i za pět let na stroji bez internetu.
 */
export function renderCaseFileHtml(caseFile) {
  const period = caseFile.period.from || caseFile.period.to
    ? `${caseFile.period.from ? czDate(caseFile.period.from) : 'od počátku'} – ${
        caseFile.period.to ? czDate(caseFile.period.to) : 'dosud'
      }`
    : 'celá historie';

  const runsHtml = caseFile.runs
    .map(
      (run) => `
      <article class="run ${run.verdict.value}">
        <h3>${escapeHtml(run.target)}</h3>
        <p class="meta">
          ${czDate(run.performedAt)} · ${escapeHtml(run.goal || '')}<br>
          <span class="kind">${
            run.kind === 'compliance-scan'
              ? 'Předpisová kontrola podle pravidel registru'
              : 'Autonomní průzkum aplikace (posouzení jazykovým modelem)'
          }</span><br>
          <span class="mono">${escapeHtml(run.sessionId)}</span>
        </p>
        <p class="verdict">${escapeHtml(run.verdict.label)}</p>
        <p class="rationale">${escapeHtml(run.verdict.rationale)}</p>
        ${
          run.checks.length
            ? `<table class="checks">${run.checks
                .map(
                  (c) => `<tr>
                    <td class="check-mark ${checkClass(c.ok)}">${checkLabel(c.ok)}</td>
                    <td><strong>${escapeHtml(c.label || c.key)}</strong><br>
                        <span class="dim">${escapeHtml(c.rationale || '')}</span></td>
                  </tr>`
                )
                .join('')}</table>`
            : ''
        }
        ${
          run.findings.length
            ? `<ul>${run.findings.map((f) => `<li>${escapeHtml(findingText(f))}</li>`).join('')}</ul>`
            : ''
        }
        ${
          run.runErrors?.length
            ? `<p class="label">Chyby měření (netýkají se auditovaného webu)</p>
               <ul class="dim">${run.runErrors
                 .map((e) => `<li>${escapeHtml(findingText(e))}</li>`)
                 .join('')}</ul>`
            : ''
        }
        ${
          run.observations.length
            ? `<p class="label">Pozorování (nejde o porušení)</p>
               <ul class="dim">${run.observations
                 .map((o) => `<li>${escapeHtml(o)}</li>`)
                 .join('')}</ul>`
            : ''
        }
        <table class="evidence">
          ${
            run.evidence.recorded
              ? `<tr><th>Otisk výsledku</th><td class="mono">${escapeHtml(run.evidence.resultDigest)}</td></tr>
                 <tr><th>Otisk souhlasí</th><td>${
                   run.evidence.digestMatches === true
                     ? 'Ano — uložený výsledek odpovídá zapsanému otisku.'
                     : run.evidence.digestMatches === false
                       ? '<span class="warn">NE — uložený výsledek se od zapsaného otisku liší.</span>'
                       : 'Nelze ověřit (záznam bez otisku výsledku).'
                 }</td></tr>
                 <tr><th>Otisk záznamu</th><td class="mono">${escapeHtml(run.evidence.recordHash)}</td></tr>
                 <tr><th>Verze nástroje</th><td>${escapeHtml(run.evidence.toolVersion)}</td></tr>${
                   run.evidence.chainProblem
                     ? '<tr><th>Výstraha</th><td class="warn">Ověření řetězu u tohoto záznamu nalezlo problém — viz oddíl Neporušenost záznamu.</td></tr>'
                     : ''
                 }${
                   run.evidence.duplicateRecords
                     ? '<tr><th>Výstraha</th><td class="warn">K tomuto běhu existuje víc než jeden záznam. Ve spisu je uveden ten první.</td></tr>'
                     : ''
                 }`
              : `<tr><th>Záznam</th><td class="warn">${escapeHtml(run.evidence.note)}</td></tr>`
          }
        </table>
      </article>`
    )
    .join('');

  return `<!doctype html>
<html lang="cs">
<head>
<meta charset="utf-8">
<title>Spis auditů — AuraGuard</title>
<style>
  @page { size: A4; margin: 18mm 16mm; }
  body { font: 10.5pt/1.5 -apple-system, "Segoe UI", Roboto, sans-serif; color: #111; }
  h1 { font-size: 18pt; margin: 0 0 4pt; }
  h2 { font-size: 13pt; margin: 18pt 0 6pt; border-bottom: 1px solid #ddd; padding-bottom: 3pt; }
  h3 { font-size: 11pt; margin: 0 0 2pt; }
  .sub { color: #555; margin: 0 0 12pt; }
  .mono { font-family: ui-monospace, "SFMono-Regular", Menlo, monospace; font-size: 8pt; word-break: break-all; }
  .meta { color: #555; font-size: 9pt; margin: 0 0 6pt; }
  .summary { display: grid; grid-template-columns: repeat(2, 1fr); gap: 2pt 16pt; margin: 0; }
  .summary dt { color: #555; }
  .summary dd { margin: 0; font-weight: 600; }
  .run { border-left: 3px solid #ccc; padding: 6pt 0 6pt 10pt; margin: 0 0 12pt; break-inside: avoid; }
  .run.findings { border-color: #c0392b; }
  .run.no-findings { border-color: #27ae60; }
  .run.inconclusive { border-color: #d68910; }
  .verdict { font-weight: 600; margin: 0 0 2pt; }
  .rationale { margin: 0 0 6pt; color: #333; }
  .label { font-size: 9pt; color: #555; margin: 8pt 0 2pt; }
  ul { margin: 0 0 6pt; padding-left: 16pt; }
  .dim { color: #555; }
  .evidence { border-collapse: collapse; margin-top: 6pt; width: 100%; }
  .evidence th { text-align: left; font-weight: 400; color: #555; width: 34mm; vertical-align: top; padding: 1pt 6pt 1pt 0; font-size: 9pt; }
  .evidence td { padding: 1pt 0; font-size: 9pt; }
  .warn { color: #b9770e; }
  .limits { background: #fdf6e3; border: 1px solid #e6d9a8; padding: 8pt 10pt; break-inside: avoid; }
  .limits li { margin-bottom: 4pt; }
  .kind { color: #666; font-size: 8.5pt; }
  .checks { border-collapse: collapse; width: 100%; margin: 6pt 0; }
  .checks td { padding: 2pt 6pt 2pt 0; vertical-align: top; font-size: 9pt; border-top: 1px solid #eee; }
  .check-mark { width: 24mm; font-weight: 600; font-size: 8.5pt; white-space: nowrap; }
  .check-mark.pass { color: #1e8449; }
  .check-mark.fail { color: #c0392b; }
  .check-mark.unknown { color: #b9770e; }
  .rules th { text-align: left; }
  .rules td { padding: 3pt 6pt 3pt 0; vertical-align: top; font-size: 9pt; border-top: 1px solid #eee; }
  footer { margin-top: 16pt; color: #777; font-size: 8.5pt; }
</style>
</head>
<body>
  <h1>Spis auditů</h1>
  <p class="sub">
    Období: ${escapeHtml(period)}<br>
    ${caseFile.subject ? `Vystaveno pro: ${escapeHtml(caseFile.subject)}<br>` : ''}
    Vygenerováno: ${czDate(caseFile.generatedAt)}
  </p>

  <h2>Souhrn</h2>
  <dl class="summary">
    <dt>Provedených běhů</dt><dd>${caseFile.summary.runs}</dd>
    <dt>S nálezem</dt><dd>${caseFile.summary.withFindings}</dd>
    <dt>Bez nálezu</dt><dd>${caseFile.summary.withoutFindings}</dd>
    <dt>Neprůkazných</dt><dd>${caseFile.summary.inconclusive}</dd>
  </dl>

  <h2>Neporušenost záznamu</h2>
  <table class="evidence">
    <tr><th>Stav řetězu</th><td>${
      caseFile.ledger.chainOk
        ? 'Neporušený — žádný záznam nebyl dodatečně změněn ani odstraněn ' +
          '<em>z prostřed řetězu</em>.'
        : `<span class="warn">PORUŠENÝ — ${caseFile.ledger.problems.length} nálezů.</span>`
    }</td></tr>
    <tr><th>Ukotvení</th><td class="${
      caseFile.ledger.anchor?.state === 'broken' ||
      caseFile.ledger.anchor?.state === 'empty'
        ? 'warn'
        : ''
    }">${
      caseFile.ledger.anchor?.state === 'anchored'
        ? `Ukotveno ${czDate(caseFile.ledger.anchor.anchoredAt)}` +
          (caseFile.ledger.anchor.coversRecords
            ? ` — kryje ${caseFile.ledger.anchor.coversRecords} záznamů.`
            : '.')
        : caseFile.ledger.anchor?.state === 'broken'
          ? 'POZOR — dříve ukotvený otisk se v řetězu nenachází.'
          : caseFile.ledger.anchor?.state === 'empty'
            ? 'Ukotveno nad prázdným záznamem — nekryje žádný běh.'
            : 'Neukotveno.'
    }<br><span class="dim">${escapeHtml(caseFile.ledger.anchor?.rationale || '')}</span></td></tr>
    <tr><th>Položek v tomto spisu</th><td>${caseFile.ledger.recordsTotal}</td></tr>
    <tr><th>Otisk hlavy</th><td class="mono">${escapeHtml(caseFile.ledger.headHash)}</td></tr>
    <tr><th>Otisk sady pravidel</th><td class="mono">${escapeHtml(caseFile.ruleset.digest)}</td></tr>
    ${
      caseFile.summary.unrecorded
        ? `<tr><th>Bez záznamu</th><td class="warn">${caseFile.summary.unrecorded} běhů nemá položku v záznamu auditů.</td></tr>`
        : ''
    }
    ${
      caseFile.summary.undatable
        ? `<tr><th>Nezařaditelné</th><td class="warn">${caseFile.summary.undatable} běhů má nečitelný čas a nelze je zařadit do období — nejsou tedy níž uvedené.</td></tr>`
        : ''
    }
  </table>

  <h2>Jednotlivé běhy</h2>
  ${runsHtml || '<p>V daném období neproběhl žádný audit.</p>'}

  <h2>Co tímto spisem doloženo NENÍ</h2>
  <div class="limits">
    <ul>${caseFile.limits.map((l) => `<li>${escapeHtml(l)}</li>`).join('')}</ul>
  </div>

  <h2>Znění použitých pravidel</h2>
  ${
    caseFile.ruleset.rules.length
      ? `<p class="sub">Znění k datu vygenerování spisu (${czDate(caseFile.generatedAt)}).
          Do záznamu se ukládá jen otisk sady pravidel, ne její text, takže tvrdit,
          že jde o znění platné v době měření, by bylo nad rámec doloženého.
          ${
            caseFile.ruleset.changedSinceMeasurement
              ? '<strong class="warn">Otisk sady se od doby měření změnil — níž uvedené znění tedy NEODPOVÍDÁ tomu, podle kterého se měřilo.</strong>'
              : 'Otisk sady odpovídá tomu, který nesou záznamy z tohoto období.'
          }
          Uvedeno včetně toho, co z každé kontroly neplyne.</p>
        <table class="rules">
          ${caseFile.ruleset.rules
            .map(
              (r) => `<tr>
                <td class="mono">${escapeHtml(r.ref)}</td>
                <td><strong>${escapeHtml(r.title)}</strong><br>
                    ${escapeHtml(r.method)}<br>
                    <em>Neplyne z toho:</em> ${escapeHtml(r.limits)}${
                      r.changelog
                        ? `<br><em>Změny oproti starším verzím:</em> ${Object.entries(r.changelog)
                            .map(([v, text]) => `v${escapeHtml(v)}: ${escapeHtml(text)}`)
                            .join(' ')}`
                        : ''
                    }</td>
              </tr>`
            )
            .join('')}
        </table>`
      : `<p>Žádný z běhů v tomto období se neodvolává na pravidlo z registru.
          Uvedené běhy pocházejí z autonomního průzkumu aplikace, který
          nevyhodnocuje jednotlivé předpisové kontroly — výpis znění pravidel
          by proto tvrdil, že proběhly kontroly, které neproběhly.</p>`
  }

  <footer>
    AuraGuard — doklad o provedených měřeních, nikoli právní posouzení shody.
    Strojově čitelnou podobu tohoto spisu lze získat ve formátu JSON.<br>
    Otisk spisu (SHA-256): <span class="mono">${escapeHtml(caseFile.selfDigest)}</span> —
    tímtéž otiskem se ověří, že strojově čitelná podoba nese stejný obsah.
  </footer>
</body>
</html>`;
}
