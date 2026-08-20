#!/usr/bin/env node
/**
 * Smoke test proti živému webu.
 *
 * Celá automatická sada (jest + vitest) běží proti mockům — Playwright,
 * Firestore ani LLM se v ní reálně nespustí. Tenhle skript ověřuje přesně
 * ty opravy, které jednotkově potvrdit nejdou, a to proti skutečnému webu.
 *
 * DŮLEŽITÉ ROZLIŠENÍ, které si výstup drží ve dvou oddílech:
 *
 *   • ✅/❌ = kontrola NÁSTROJE. Rozhoduje o exit kódu.
 *   • ⚠️/·  = nález na TESTOVANÉM WEBU. O exit kódu nerozhoduje.
 *
 * Zelená fajfka tedy nikdy neznamená "web je v pořádku", ale "skener
 * odvedl svou práci". Splynutí těchhle dvou věcí je přesně chyba, kterou
 * měl tenhle projekt ve svých reportech (prázdný SBOM = "PASS").
 *
 * Používá `mode: 'monkey'`, takže NEPOTŘEBUJE běžící LLM.
 *
 * Použití:
 *   node scripts/smoke-test.mjs [url]
 *   node scripts/smoke-test.mjs https://nexus-sync-8d50b.web.app/logout
 *
 * Exit 0 = nástroj funguje, 1 = nástroj má chybu.
 */
import fs from 'fs';
import path from 'path';
import {
  runAutonomousTest,
  auditNIS2AndPQC,
  auditAIAct,
  auditCRAVulnerabilities,
  auditGreenAndResidency,
  auditAccessibility,
  auditStrictCookies,
  checkPage,
} from '../agent.js';
import { SCREENSHOTS_DIR, VIDEOS_DIR } from '../paths.js';

const TARGET = process.argv[2] || 'https://nexus-sync-8d50b.web.app/logout';

// Kontroly NÁSTROJE: prošlo/neprošlo rozhoduje o exit kódu.
const results = [];
// Nálezy na TESTOVANÉM WEBU: nejsou chybou nástroje, ale nesmí se schovat
// za zelenou fajfku. Tohle je přesně ta záměna, kterou skenery dělaly —
// "PASS" znamenalo "kontrola proběhla", ne "web je v pořádku".
const findings = [];

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  ✅' : '  ❌'} ${name}${detail ? ` — ${detail}` : ''}`);
}
function finding(severity, area, message) {
  findings.push({ severity, area, message });
  const mark = severity === 'fail' ? '  ⚠️ ' : '  ·  ';
  console.log(`${mark}${area}: ${message}`);
}
function info(msg) {
  console.log(`     ${msg}`);
}

console.log(`\n🔍 Smoke test proti ${TARGET}`);
console.log('   ✅/❌ = kontrola nástroje   ⚠️/· = nález na testovaném webu\n');

// ─────────────────────────────────────────────────────────────────────────────
// 1. Agent: video, screenshoty, navigační politika
// ─────────────────────────────────────────────────────────────────────────────
console.log('1) Autonomní agent (monkey mode, 3 kroky)');
const sessionId = `session_smoke_${Date.now()}`;
let run;
try {
  run = await runAutonomousTest(
    TARGET,
    'Smoke test',
    { mode: 'monkey', headless: true, maxSteps: 3 },
    () => {},
    sessionId
  );
  check('runAutonomousTest doběhl', true, `${run.steps.length} kroků`);
} catch (err) {
  check('runAutonomousTest doběhl', false, err.message);
  run = null;
}

if (run) {
  // Video se dřív ukládalo pod náhodným hashem, takže server u něj nikdy
  // nenašel session a vracel 404.
  if (run.videoUrl) {
    const videoName = path.basename(run.videoUrl);
    const videoPath = path.join(VIDEOS_DIR, videoName);
    const exists = fs.existsSync(videoPath);
    const size = exists ? fs.statSync(videoPath).size : 0;

    check('video má název odvozený od sessionId', videoName.startsWith(sessionId), videoName);
    check('video existuje na disku', exists, videoPath);
    // Kdyby se context nezavřel před čtením, soubor by byl useknutý/nulový.
    check('video není prázdné', size > 1000, `${size} B`);
  } else {
    check('videoUrl je vyplněné', false, 'agent video nevrátil');
  }

  // Screenshoty musí sedět na regex a extrakci sessionId na serveru.
  const shots = fs.existsSync(SCREENSHOTS_DIR)
    ? fs.readdirSync(SCREENSHOTS_DIR).filter((f) => f.startsWith(sessionId))
    : [];
  check('vznikly screenshoty', shots.length > 0, `${shots.length} souborů`);
  check(
    'názvy screenshotů odpovídají očekávanému tvaru',
    shots.every((f) => /^[A-Za-z0-9_-]+_step_\d+\.png$/.test(f)),
    shots[0] || ''
  );

  // Navigační guard porovnával přesný origin, takže po http->https nebo
  // apex->www hlásil každou navigaci jako chybu aplikace.
  const navBugs = (run.bugs || []).filter((b) => /Navigace mimo|zablokována/i.test(b));
  check('žádné falešné bugy z navigační politiky', navBugs.length === 0, navBugs[0] || '');

  // Výkonnostní varování nesmí ovlivnit success.
  check(
    'warnings jsou oddělené od bugs',
    Array.isArray(run.warnings),
    `${(run.warnings || []).length} varování, ${(run.bugs || []).length} chyb`
  );
  if ((run.warnings || []).length > 0) {
    info(`ukázka varování: ${run.warnings[0].slice(0, 80)}`);
  }

  // Vnitřek SVG (<path>, <g>, <circle>) dědí `cursor: pointer` od tlačítka,
  // ve kterém leží. Dřív se registroval jako klikatelný prvek, agent na něj
  // klikl, Playwright hlásil "element is not stable" a vznikl FALEŠNÝ BUG
  // na funkčním webu.
  const svgClickBugs = (run.bugs || []).filter((b) => /Timeout .*exceeded/i.test(b));
  check(
    'žádné timeouty z klikání na nevhodné prvky',
    svgClickBugs.length === 0,
    svgClickBugs[0]?.slice(0, 90) || ''
  );

  // Na funkčním webu by monkey běh neměl vyrobit žádnou chybu.
  if ((run.bugs || []).length > 0) {
    info(`POZOR, nahlášené chyby (ověřte, že jsou skutečné):`);
    run.bugs.forEach((b) => info(`  • ${b.slice(0, 110)}`));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. NIS2 — dřív hlásil "Zastaralý protokol" i u TLS 1.3
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n2) NIS2 / PQC');
try {
  const nis2 = await auditNIS2AndPQC(TARGET);
  check('TLS bylo rozpoznáno', nis2.pqc.secure === true, `protokol: ${nis2.pqc.protocol}`);
  check(
    'protocol není undefined',
    typeof nis2.pqc.protocol === 'string' && nis2.pqc.protocol !== 'None',
    nis2.pqc.protocol
  );
  check(
    'HTTPS web nedostal hlášku o zastaralém protokolu',
    !/Zastaralý protokol/i.test(nis2.pqc.recommendation),
    nis2.pqc.recommendation.slice(0, 70)
  );
  check(
    'subjectName není [object Promise]',
    !String(nis2.pqc.subjectName).includes('Promise'),
    String(nis2.pqc.subjectName).slice(0, 40)
  );
  // Hlavičky se dřív po přesměrování vůbec nenačetly. Že se načetly, je
  // kontrola nástroje; JESTLI jsou nastavené, je nález o webu.
  check('bezpečnostní hlavičky se podařilo načíst', typeof nis2.nis2.hsts === 'boolean');

  const headerLabels = {
    hsts: 'Strict-Transport-Security',
    csp: 'Content-Security-Policy',
    xContentTypeOptions: 'X-Content-Type-Options',
    xFrameOptions: 'X-Frame-Options / frame-ancestors',
    referrerPolicy: 'Referrer-Policy',
    permissionsPolicy: 'Permissions-Policy',
  };
  for (const [key, label] of Object.entries(headerLabels)) {
    if (nis2.nis2[key] === false) finding('fail', 'NIS2', `chybí nebo je nedostatečná hlavička ${label}`);
  }
  info(`finální URL: ${nis2.finalUrl}`);
} catch (err) {
  check('auditNIS2AndPQC doběhl', false, err.message);
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. AI Act — dřív `includes('ai')` matchovalo "email"/"detail"
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n3) AI Act');
try {
  const ai = await auditAIAct(TARGET);
  check('status je jedna ze tří hodnot', ['pass', 'fail', 'inconclusive'].includes(ai.aiAct.status), ai.aiAct.status);

  // Článek 50 má čtyři samostatné povinnosti. Dřív se slučovaly do jednoho
  // výsledku, takže report tvrdil víc, než uměl doložit.
  const obligations = ai.aiAct.obligations || [];
  check('vrací všechny čtyři povinnosti čl. 50', obligations.length === 4,
    obligations.map((o) => o.id).join(', '));
  check('každá povinnost má stav i odůvodnění',
    obligations.every((o) => o.status && o.rationale),
    `${obligations.filter((o) => o.rationale).length}/${obligations.length}`);
  check('povinnosti 3 a 4 jsou označené jako mimo dosah skeneru',
    obligations.filter((o) => o.outOfScope).length === 2);
  check('souhrn nikdy netvrdí splněno, když je něco neprůkazné',
    !(ai.aiAct.isCompliant === true && ai.aiAct.counts?.inconclusive > 0),
    `isCompliant=${ai.aiAct.isCompliant}, neprůkazných=${ai.aiAct.counts?.inconclusive}`);

  for (const ob of obligations) {
    const mark = { pass: 'splněno', fail: 'NESPLNĚNO', inconclusive: 'neprůkazné', not_applicable: 'netýká se' }[ob.status];
    info(`${ob.id}: ${mark} — ${ob.title}`);
    if (ob.status === 'fail') finding('fail', 'AI Act', `${ob.id}: ${ob.rationale}`);
  }
  check(
    'bez detekovaného AI API je výsledek neprůkazný, ne PASS',
    ai.aiAct.apisDetected.length > 0 || ai.aiAct.isCompliant === null,
    `apisDetected=${ai.aiAct.apisDetected.length}, isCompliant=${ai.aiAct.isCompliant}`
  );
  info(ai.aiAct.rating.slice(0, 90));
  if (ai.aiAct.isCompliant === null) {
    finding('review', 'AI Act', `${ai.aiAct.counts?.inconclusive ?? '?'} ze 4 povinností čl. 50 nelze externím skenem posoudit`);
  }
} catch (err) {
  check('auditAIAct doběhl', false, err.message);
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. CRA — prázdný SBOM se dřív hlásil jako PASS
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n4) CRA / SBOM');
try {
  const cra = await auditCRAVulnerabilities(TARGET);
  const libs = cra.cra.libraries.length;
  check(
    'prázdný SBOM není hlášen jako splněno',
    libs > 0 || cra.cra.isCompliant === null,
    `knihoven=${libs}, isCompliant=${cra.cra.isCompliant}`
  );
  info(cra.cra.rating.slice(0, 90));
  if (cra.cra.vulnerabilities.length > 0) {
    finding('fail', 'CRA', `${cra.cra.vulnerabilities.length} známých zranitelností v knihovnách`);
    cra.cra.vulnerabilities.slice(0, 5).forEach((v) => info(`  • ${v.library}@${v.version}: ${v.cve}`));
  }
  if (cra.cra.isCompliant === null) {
    finding('review', 'CRA', 'SBOM se nepodařilo sestavit — soulad nelze potvrdit ani vyvrátit');
  }
  if (cra.cra.skipped?.length) info(`neověřeno: ${cra.cra.skipped.length} knihoven`);
} catch (err) {
  check('auditCRAVulnerabilities doběhl', false, err.message);
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Green / rezidence — UI četlo pole, která agent nevracel
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n5) Green Deal / GDPR rezidence');
try {
  const green = await auditGreenAndResidency(TARGET);
  check(
    'residency.isEUCompliant existuje',
    green.residency.isEUCompliant !== undefined,
    String(green.residency.isEUCompliant)
  );
  check(
    'residency.warning není prázdné',
    typeof green.residency.warning === 'string' && green.residency.warning.length > 0,
    (green.residency.warning || '').slice(0, 70)
  );

  // Anycast CDN (Firebase, Cloudflare, Fastly…) se geolokuje na nejbližší PoP,
  // ne na místo uložení dat. Hlásit z toho porušení GDPR je falešný poplach.
  const cdn = green.residency.cdnDomains || [];
  const allOnCdn = cdn.length > 0 && cdn.length === green.residency.locations.length;
  check(
    'web na CDN nedostane červený GDPR verdikt',
    !allOnCdn || green.residency.isEUCompliant === null,
    `${cdn.length}/${green.residency.locations.length} domén na CDN, isEUCompliant=${green.residency.isEUCompliant}`
  );
  info(`${green.green.totalMb} MB, ${green.green.co2Grams} g CO2, hodnocení ${green.green.rating}`);
  if (green.residency.isEUCompliant === false) {
    finding('fail', 'GDPR rezidence', `${green.residency.nonEULocations.length} serverů mimo EU/EHP`);
  } else if (green.residency.isEUCompliant === null) {
    finding('review', 'GDPR rezidence', 'rezidenci dat nelze z IP určit (CDN) — ověřte ve smlouvě');
  }
} catch (err) {
  check('auditGreenAndResidency doběhl', false, err.message);
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. Přístupnost a cookies — jen tvar odpovědi
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n6) Přístupnost a cookies');
try {
  const a11y = await auditAccessibility(TARGET);

  // Kontrola nástroje: `incomplete` se dřív zahazovalo (false negatives).
  check('axe vrací i položky k ručnímu posouzení', Array.isArray(a11y.incomplete));

  // Nálezy o webu — tyhle NESMÍ dostat zelenou fajfku.
  if (a11y.violations.length > 0) {
    finding('fail', 'EAA', `${a11y.violations.length} porušení WCAG 2.1 AA`);
    a11y.violations.slice(0, 5).forEach((v) => info(`  • [${v.impact}] ${v.id}: ${v.help}`));
  }
  if (a11y.incomplete.length > 0) {
    finding('review', 'EAA', `${a11y.incomplete.length} položek vyžaduje ruční posouzení`);
    a11y.incomplete.slice(0, 3).forEach((v) => info(`  • ${v.id}: ${v.help}`));
  }
  info(`automaticky prošlo: ${a11y.passedCount} pravidel`);
} catch (err) {
  check('auditAccessibility doběhl', false, err.message);
}

try {
  const cookies = await auditStrictCookies(TARGET);
  check('cookie audit doběhl', typeof cookies.gdpr.isCompliant === 'boolean');

  if (cookies.gdpr.suspiciousItems.length > 0) {
    finding('fail', 'GDPR', `${cookies.gdpr.suspiciousItems.length} trackerů před udělením souhlasu`);
    cookies.gdpr.suspiciousItems.slice(0, 5).forEach((i) => info(`  • ${i}`));
  } else {
    info('bez nálezu (seznam trackerů není vyčerpávající — neznamená to prokázaný soulad)');
  }
} catch (err) {
  check('auditStrictCookies doběhl', false, err.message);
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. HTTP monitor — durationMs (Slack posílal responseTime = undefined)
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n7) HTTP monitor');
try {
  const page = await checkPage({ url: TARGET, name: 'smoke' });
  check('checkPage vrací durationMs', typeof page.durationMs === 'number', `${page.durationMs} ms`);
  check('stránka odpovídá', page.ok === true, `HTTP ${page.status}`);
} catch (err) {
  check('checkPage doběhl', false, err.message);
}

// ─────────────────────────────────────────────────────────────────────────────
// Shrnutí. Záměrně ve DVOU oddílech: exit kód vypovídá o NÁSTROJI, ne
// o souladu testovaného webu. Míchat obojí by znamenalo zobrazit zelenou
// tam, kde skener našel porušení — přesně ta záměna, kterou tenhle projekt
// dělal ve svých reportech.
const failed = results.filter((r) => !r.ok);
const problems = findings.filter((f) => f.severity === 'fail');
const reviews = findings.filter((f) => f.severity === 'review');

console.log(`\n${'─'.repeat(64)}`);
console.log('NÁSTROJ');
console.log(`  Prošlo ${results.length - failed.length}/${results.length} kontrol.`);
if (failed.length > 0) {
  failed.forEach((f) => console.log(`  ❌ ${f.name}${f.detail ? ` — ${f.detail}` : ''}`));
}

console.log(`\nTESTOVANÝ WEB (${TARGET})`);
if (problems.length === 0 && reviews.length === 0) {
  console.log('  Bez nálezů. Pozor: neznamená to prokázaný soulad — skenery mají');
  console.log('  omezený dosah a část kontrol je nutné provést ručně.');
} else {
  if (problems.length > 0) {
    console.log(`  ⚠️  ${problems.length} porušení:`);
    problems.forEach((f) => console.log(`      • ${f.area}: ${f.message}`));
  }
  if (reviews.length > 0) {
    console.log(`  ·   ${reviews.length} k ručnímu posouzení:`);
    reviews.forEach((f) => console.log(`      • ${f.area}: ${f.message}`));
  }
}

console.log(`\n${'─'.repeat(64)}`);
if (failed.length > 0) {
  console.error('VÝSLEDEK: nástroj má chybu — opravte ji před nasazením.\n');
  process.exit(1);
}
console.log('VÝSLEDEK: nástroj funguje správně.');
console.log('Nálezy o webu výš jsou jeho vlastnost, ne chyba nástroje.\n');
