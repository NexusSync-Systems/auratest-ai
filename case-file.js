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
import { verifyChain, headHash } from './audit-ledger.js';

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
  'Řetězení záznamů dokazuje, že s historií nikdo dodatečně nehýbal. ' +
    'Nedokazuje nemožnost podvrhu: kdo má právo zapisovat, může přepsat celý ' +
    'řetěz a otisky přepočítat. Průkaznost dodává až ukotvení otisku mimo ' +
    'systém.',
  'Časová razítka pocházejí z hodin serveru, ne od autority časových razítek.',
  'Spis není právní posouzení shody. Je to doklad o provedených měřeních.',
];

/**
 * Verdikt jednoho běhu.
 *
 * Běh, který skončil chybou, NENÍ nález na testované aplikaci — je to
 * neproběhlé měření. Splést to znamená připsat zákazníkovi vadu, kterou
 * nikdo neprokázal.
 */
function verdictOf(session) {
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

/** Bezpečné porovnání dat; neplatné vstupy nesmí tiše vyřadit běh ze spisu. */
function inPeriod(timestamp, from, to) {
  const t = Date.parse(timestamp);
  if (Number.isNaN(t)) return false;
  if (from && t < Date.parse(from)) return false;
  if (to && t > Date.parse(to)) return false;
  return true;
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
 */
export function buildCaseFile({ sessions, records, from, to, subject, chain, head }) {
  const byId = new Map((records || []).map((r) => [r.sessionId, r]));

  const runs = (sessions || [])
    .filter((s) => inPeriod(s.timestamp, from, to))
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp))
    .map((session) => {
      const record = byId.get(session.id);
      const verdict = verdictOf(session);
      return {
        sessionId: session.id,
        target: session.url,
        goal: session.goal,
        performedAt: session.timestamp,
        verdict,
        findings: session.bugs || [],
        // Varování se drží odděleně od nálezů schválně: jsou to pozorování,
        // ne porušení. Sloučit je by nafouklo počet vad.
        observations: session.warnings || [],
        evidence: record
          ? {
              recorded: true,
              recordHash: record.hash,
              resultDigest: record.resultDigest,
              recordedAt: record.recordedAt,
              toolVersion: record.tool?.version,
              rulesetDigest: record.ruleset?.digest,
            }
          : {
              recorded: false,
              // Bez záznamu je běh ve spisu pořád uveden — zamlčet ho by
              // znamenalo upravovat historii. Jen se u něj řekne, že
              // neporušenost doložit nelze.
              note:
                'K tomuto běhu chybí položka v záznamu auditů. Výsledek platí, ' +
                'ale jeho neporušenost tímto spisem doložit nelze.',
            },
      };
    });

  const chainStatus = chain || verifyChain();

  // Do spisu jde znění pravidel, ne odkaz na ně. Za rok už soubor
  // s registrem nemusí být po ruce a odkaz „nis2.headers.csp.v1" by pak
  // nikomu nic neřekl.
  const ruleSnapshot = RULES.map(({ id, version, title, method, limits }) => ({
    ref: `${id}.v${version}`,
    title,
    method,
    limits,
  }));

  const counts = runs.reduce(
    (acc, r) => {
      acc[r.verdict.value] = (acc[r.verdict.value] || 0) + 1;
      return acc;
    },
    { findings: 0, 'no-findings': 0, inconclusive: 0 }
  );

  return {
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
    },
    runs,
    ledger: {
      headHash: head || headHash(),
      chainOk: chainStatus.ok,
      recordsTotal: chainStatus.count,
      problems: chainStatus.problems,
    },
    ruleset: { ...rulesetInfo(), rules: ruleSnapshot },
    limits: CASE_FILE_LIMITS,
  };
}

const escapeHtml = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );

const czDate = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('cs-CZ');
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
          <span class="mono">${escapeHtml(run.sessionId)}</span>
        </p>
        <p class="verdict">${escapeHtml(run.verdict.label)}</p>
        <p class="rationale">${escapeHtml(run.verdict.rationale)}</p>
        ${
          run.findings.length
            ? `<ul>${run.findings.map((f) => `<li>${escapeHtml(f)}</li>`).join('')}</ul>`
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
                 <tr><th>Otisk záznamu</th><td class="mono">${escapeHtml(run.evidence.recordHash)}</td></tr>
                 <tr><th>Verze nástroje</th><td>${escapeHtml(run.evidence.toolVersion)}</td></tr>`
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
        ? 'Neporušený — žádný záznam nebyl dodatečně změněn ani odstraněn.'
        : `<span class="warn">PORUŠENÝ — ${caseFile.ledger.problems.length} nálezů.</span>`
    }</td></tr>
    <tr><th>Položek celkem</th><td>${caseFile.ledger.recordsTotal}</td></tr>
    <tr><th>Otisk hlavy</th><td class="mono">${escapeHtml(caseFile.ledger.headHash)}</td></tr>
    <tr><th>Otisk sady pravidel</th><td class="mono">${escapeHtml(caseFile.ruleset.digest)}</td></tr>
  </table>

  <h2>Jednotlivé běhy</h2>
  ${runsHtml || '<p>V daném období neproběhl žádný audit.</p>'}

  <h2>Co tímto spisem doloženo NENÍ</h2>
  <div class="limits">
    <ul>${caseFile.limits.map((l) => `<li>${escapeHtml(l)}</li>`).join('')}</ul>
  </div>

  <h2>Znění použitých pravidel</h2>
  <p class="sub">Verze platné v době měření. Uvedeno včetně toho, co z každé kontroly neplyne.</p>
  <table class="rules">
    ${caseFile.ruleset.rules
      .map(
        (r) => `<tr>
          <td class="mono">${escapeHtml(r.ref)}</td>
          <td><strong>${escapeHtml(r.title)}</strong><br>
              ${escapeHtml(r.method)}<br>
              <em>Neplyne z toho:</em> ${escapeHtml(r.limits)}</td>
        </tr>`
      )
      .join('')}
  </table>

  <footer>
    AuraGuard — doklad o provedených měřeních, nikoli právní posouzení shody.
    Strojově čitelnou podobu tohoto spisu lze získat ve formátu JSON.
  </footer>
</body>
</html>`;
}
