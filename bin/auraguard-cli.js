#!/usr/bin/env node

import { auditNIS2AndPQC, auditCRA_SBOM, auditAccessibility, auditAIAct, auditStrictCookies, auditCRAVulnerabilities, runAutonomousTest } from '../agent.js';
import { sendSlackNotification } from '../slack-notifier.js';
import dotenv from 'dotenv';
dotenv.config();

// Exit kódy: 0 = prošlo, 1 = compliance selhalo, 2 = chyba použití,
// 3 = interní chyba. Dřív splývalo všechno do 0/1, takže CI nerozlišilo
// „web nesplňuje směrnice" od „nástroj se nespustil".
const EXIT_OK = 0;
const EXIT_COMPLIANCE_FAILED = 1;
const EXIT_USAGE = 2;
const EXIT_INTERNAL = 3;

const VALID_AUDITS = ['nis2', 'cra', 'cve', 'eaa', 'ai', 'gdpr', 'ai-agent', 'all'];
const USAGE = 'Použití: auraguard --url <https://vase-aplikace.cz> --audit <' + VALID_AUDITS.join('|') + '>';

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(USAGE);
  process.exit(EXIT_OK);
}

const urlIndex = args.indexOf('--url');
const auditIndex = args.indexOf('--audit');

if (urlIndex === -1 || urlIndex + 1 >= args.length) {
  console.error('Chyba: Musíte zadat cílové URL pomocí parametru --url');
  console.error(USAGE);
  process.exit(EXIT_USAGE);
}

const url = args[urlIndex + 1];

// Bez validace se z `--url --audit nis2` stalo URL "--audit". Hlavně ale
// hodnota jde přímo do Playwright page.goto(), takže `file:///etc/passwd`
// nebo `http://169.254.169.254/` z CI runneru znamená čtení souborů / SSRF.
let parsedUrl;
try {
  parsedUrl = new URL(url);
} catch {
  console.error(`Chyba: "${url}" není platná URL.`);
  console.error(USAGE);
  process.exit(EXIT_USAGE);
}
if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
  console.error(`Chyba: povoleno je pouze schéma http nebo https (zadáno: ${parsedUrl.protocol}).`);
  process.exit(EXIT_USAGE);
}

const auditType = (auditIndex !== -1 && auditIndex + 1 < args.length) ? args[auditIndex + 1] : 'all';

// Bez tohohle skončil překlep (`--audit nis`) tak, že neproběhl ŽÁDNÝ audit,
// hasErrors zůstalo false a CLI vypsalo „prošla všemi EU audity" s exit 0.
// V CI to tiše propustilo nasazení.
if (!VALID_AUDITS.includes(auditType)) {
  console.error(`Chyba: neznámý typ auditu "${auditType}".`);
  console.error(USAGE);
  process.exit(EXIT_USAGE);
}

console.log(`\n🛡️  AuraGuard CI/CD Zabezpečení 🛡️`);
console.log(`Cílové URL: ${url}`);
console.log(`Spouštím audit: ${auditType.toUpperCase()}\n`);

/**
 * Skenery vracejí tříhodnotový výsledek: true / false / null (neprůkazné).
 *
 * CLI dřív používalo `if (!report.isCompliant)`, jenže `!null` je `true` —
 * neprůkazný výsledek tak spadl do větve SELHÁNÍ a zablokoval nasazení
 * s hláškou o porušení a prázdným seznamem nálezů. Blokovat pipeline kvůli
 * tomu, že skener nic nezjistil, je horší než nic nehlásit.
 */
function classify(isCompliant) {
  if (isCompliant === true) return 'pass';
  if (isCompliant === false) return 'fail';
  return 'inconclusive';
}

async function runCLI() {
  let hasErrors = false;
  const inconclusive = [];
  let failedAudits = [];

  try {
    if (['nis2', 'all'].includes(auditType)) {
      console.log('Spouštím: NIS2 & PQC Audit...');
      const nis2Report = await auditNIS2AndPQC(url);
      
      const missing = nis2Report.nis2.missingHeaders || [];
      // Chybějící a slabé hlavičky se hlásí zvlášť. „Chybí CSP" u webu,
      // který CSP má, je nepravda — i když je verdikt stejný. Provozovatel
      // navíc podle toho pozná, jestli hlavičku doplnit, nebo opravit.
      const weak = nis2Report.nis2.weakHeaders || [];

      if (classify(nis2Report.nis2.isCompliant) === 'fail') {
        if (missing.length > 0) {
          console.error(`❌ SELHÁNÍ: Chybí ${missing.length} bezpečnostních hlaviček.`);
          missing.forEach(h => console.error(`   - Chybí hlavička: ${h}`));
          failedAudits.push(`*Bezpečnostní hlavičky*: chybí ${missing.join(', ')}`);
        }
        if (weak.length > 0) {
          console.error(`❌ SELHÁNÍ: ${weak.length} hlaviček je nastavených, ale neposkytuje ochranu.`);
          weak.forEach(h => console.error(`   - Nedostatečná hlavička: ${h}`));
          failedAudits.push(`*Bezpečnostní hlavičky*: nedostatečné ${weak.join(', ')}`);
        }
        hasErrors = true;
      } else {
        console.log('✅ PASS: Bezpečnostní hlavičky nastavené');
      }
      // Post-kvantová odolnost se skutečně měří — sonda nabídne serveru
      // pouze hybridní skupinu a čeká, jestli handshake projde.
      const pqcState = classify(nis2Report.pqc.isQuantumSafe);
      const PQC_MARK = { pass: '✅ PASS', fail: '⚠️  DOPORUČENÍ', inconclusive: '➖ NEPRŮKAZNÉ' };
      console.log(`${PQC_MARK[pqcState]}: post-kvantová výměna klíčů (${nis2Report.pqc.pqcGroup})`);
      console.log(`   ${nis2Report.pqc.recommendation}`);

      // Rozbor obsahu CSP.
      //
      // Samostatně od chybějících hlaviček: „politika je slabá" a „politika
      // chybí" jsou dvě různá zjištění a smíchat je znamená vypsat
      // „Chybí hlavička: chybí base-uri".
      const csp = nis2Report.nis2.cspDetail;
      if (csp?.present) {
        const bySeverity = { high: [], medium: [], low: [] };
        for (const f of csp.findings) bySeverity[f.severity]?.push(f.message);

        for (const message of bySeverity.high) {
          console.error(`❌ SELHÁNÍ: CSP — ${message}`);
          hasErrors = true;
          failedAudits.push(`*CSP*: ${message}`);
        }
        for (const message of bySeverity.medium) console.log(`   ⚠️  CSP — ${message}`);
        for (const message of bySeverity.low) console.log(`   ➖ CSP — ${message}`);

        if (csp.ok && bySeverity.medium.length === 0) {
          console.log('✅ PASS: obsah CSP bez nálezu');
        }
      }

      // Nálezy v TLS vrstvě jsou samostatná, prokázaná závada — proto mají
      // vlastní pole a nemíchají se mezi chybějící hlavičky.
      for (const finding of nis2Report.nis2.tlsFindings || []) {
        console.error(`❌ SELHÁNÍ: ${finding}`);
        hasErrors = true;
        failedAudits.push(`*TLS*: ${finding}`);
      }
      for (const note of nis2Report.pqc.tlsNotes || []) console.log(`   ➖ ${note}`);

      // Poctivé vymezení: kontrola hlaviček není posouzení shody s NIS2.
      console.log(`   Rozsah: ${nis2Report.nis2.scope}`);
      console.log(`   TLS: ${nis2Report.pqc.protocol}\n`);
    }

    if (['cra', 'all'].includes(auditType)) {
      console.log('Spouštím: CRA SBOM Skener...');
      const craReport = await auditCRA_SBOM(url);
      
      if (craReport.sbom.length > 0) {
        console.log('✅ PASS: SBOM úspěšně vygenerován.');
        // `version` je u nálezů z fingerprintingu často null — knihovnu jsme
        // našli, ale verzi ne. `(null)` ve výpisu vypadalo jako chyba nástroje.
        craReport.sbom.forEach((lib) => {
          const version = lib.version ? `v${lib.version}` : 'verze neznámá';
          const sources = (lib.sources || []).join(', ');
          console.log(`   - Detekováno: ${lib.name} (${version})${sources ? ` [${sources}]` : ''}`);
        });
      } else {
        console.log('⚠️ UPOZORNĚNÍ: Nebyly detekovány žádné klientské knihovny.\n');
      }
      console.log();
    }

    if (['eaa', 'all'].includes(auditType)) {
      console.log('Spouštím: EAA Audit Přístupnosti...');
      const eaaReport = await auditAccessibility(url);
      
      if (eaaReport.violations.length > 0) {
        console.error(`❌ SELHÁNÍ: Nalezeno ${eaaReport.violations.length} porušení přístupnosti (Evropský akt o přístupnosti)!`);
        hasErrors = true;
        failedAudits.push(`*EAA Přístupnost*: ${eaaReport.violations.length} porušení`);
      } else {
        console.log('✅ PASS: EAA Compliance (Základní A11y)\n');
      }
    }

    if (['ai', 'all'].includes(auditType)) {
      console.log('Spouštím: EU AI Act Scanner...');
      const aiReport = await auditAIAct(url);
      
      const aiVerdict = classify(aiReport.aiAct.isCompliant);
      if (aiVerdict === 'fail') {
        console.error('❌ SELHÁNÍ: AI Act čl. 50 — detekováno volání AI API bez upozornění uživatele.');
        aiReport.aiAct.apisDetected.forEach(api => console.error(`   - Voláno API: ${api}`));
        hasErrors = true;
        failedAudits.push(`*AI Act*: Chybí upozornění na AI (${aiReport.aiAct.apisDetected.join(', ')})`);
      } else if (aiVerdict === 'inconclusive') {
        console.warn('⚠️  NEPRŮKAZNÉ: AI Act čl. 50 nelze externím skenem posoudit.');
        (aiReport.aiAct.obligations || []).forEach((ob) => {
          if (ob.status === 'inconclusive') console.warn(`   - ${ob.id}: ${ob.rationale}`);
        });
        inconclusive.push('AI Act čl. 50');
      } else {
        console.log('✅ PASS: AI Act čl. 50\n');
      }
    }

    if (['gdpr', 'all'].includes(auditType)) {
      console.log('Spouštím: Striktní GDPR Cookie Auditor...');
      const cookieReport = await auditStrictCookies(url);
      
      if (!cookieReport.gdpr.isCompliant) {
        console.error('❌ SELHÁNÍ: GDPR ePrivacy Violation! Detekovány trackery před udělením souhlasu.');
        cookieReport.gdpr.suspiciousItems.forEach(item => console.error(`   - Tracker: ${item}`));
        hasErrors = true;
        failedAudits.push(`*GDPR Cookies*: Nalezeny nelegální trackery (${cookieReport.gdpr.suspiciousItems.join(', ')})`);
      } else {
        console.log('✅ PASS: GDPR Cookie Compliance (No implicit trackers)\n');
      }

      // Příznaky cookies jsou aplikační bezpečnost, ne ePrivacy — proto
      // samostatný oddíl. Web bez trackerů, ale s relační cookie čitelnou
      // ze skriptu, by jinak prošel jako bezvadný.
      const flags = cookieReport.cookieFlags;
      if (flags) {
        if (flags.ok === null) {
          console.log(`➖ NEPRŮKAZNÉ: příznaky cookies — ${flags.rationale}`);
        } else {
          const severe = flags.findings.filter((f) => f.severity === 'high');
          for (const f of severe) {
            console.error(`❌ SELHÁNÍ: cookie ${f.cookie} — ${f.message}`);
            hasErrors = true;
            failedAudits.push(`*Cookie ${f.cookie}*: ${f.message}`);
          }
          for (const f of flags.findings.filter((x) => x.severity !== 'high')) {
            console.log(`   ${f.severity === 'medium' ? '⚠️ ' : '➖'} cookie ${f.cookie} — ${f.message}`);
          }
          if (severe.length === 0) console.log(`✅ PASS: ${flags.rationale}`);
        }
      }
    }

    if (['cve', 'all'].includes(auditType)) {
      console.log('Spouštím: CRA Vulnerability Scanner (OSV.dev)...');
      const vulnReport = await auditCRAVulnerabilities(url);
      
      const craVerdict = classify(vulnReport.cra.isCompliant);
      if (craVerdict === 'fail') {
        console.error(`❌ SELHÁNÍ: Nalezeno ${vulnReport.cra.vulnerabilities.length} zranitelností (CVE).`);
        vulnReport.cra.vulnerabilities.forEach(v => console.error(`   - ${v.cve} (${v.severity}): ${v.library} ${v.version}`));
        hasErrors = true;
        const cves = vulnReport.cra.vulnerabilities.map(v => v.cve).join(', ');
        failedAudits.push(`*CRA Zranitelnosti*: Nalezeno CVE (${cves})`);
      } else if (craVerdict === 'inconclusive') {
        // Bundlovaná aplikace nevystavuje knihovny do window, takže SBOM
        // zůstane prázdný. „0 CVE" by tu znamenalo „nic jsem neviděl".
        console.warn(`⚠️  NEPRŮKAZNÉ: ${vulnReport.cra.rating}`);
        inconclusive.push('CRA zranitelnosti');
      } else {
        console.log(`✅ PASS: ${vulnReport.cra.rating}\n`);
      }
    }

    if (['ai-agent', 'all'].includes(auditType)) {
      console.log('Spouštím: Autonomní AI Agent Test (Playwright + LLM)...');
      // Použijeme jednoduchý headless smoke test s 5 kroky
      const llmConfig = { provider: 'ollama', model: 'llama3', host: 'http://localhost:11434', headless: true, maxSteps: 5, mode: 'smoke_test' };
      const aiAgentReport = await runAutonomousTest(url, 'Najdi všechny logické nebo javascriptové chyby na webu.', llmConfig, () => {});
      
      const agentBugs = aiAgentReport.bugs || [];
      if (agentBugs.length > 0) {
        console.error(`❌ SELHÁNÍ: AI Agent objevil na webu ${agentBugs.length} chyb!`);
        agentBugs.forEach(bug => console.error(`   - ${bug}`));
        hasErrors = true;
        failedAudits.push(`*AI Agent*: Byly nalezeny funkční chyby (${agentBugs.length} chyb)`);
      } else if (aiAgentReport.success === false) {
        // Test neproběhl (LLM nedostupné, timeout). Dřív to spadlo do větve
        // „PASS: žádné viditelné chyby", tedy falešně negativní výsledek.
        console.error('❌ SELHÁNÍ: AI Agent Test neproběhl korektně.');
        hasErrors = true;
        failedAudits.push('*AI Agent*: Test se nepodařilo dokončit');
      } else {
        console.log('✅ PASS: AI Agent Test (Žádné viditelné chyby na webu)\n');
      }
    }

  } catch (err) {
    console.error(`❌ Kritická chyba při provádění auditu: ${err.message}`);
    if (err.stack) console.error(err.stack);
    process.exit(EXIT_INTERNAL);
  }

  if (inconclusive.length > 0) {
    console.warn(`\n⚠️  ${inconclusive.length} kontrol skončilo jako NEPRŮKAZNÉ: ${inconclusive.join(', ')}.`);
    console.warn('   Nezpůsobují selhání pipeline, ale shodu z nich vyvodit nelze — posuďte ručně.');
  }

  if (hasErrors) {
    console.error(`\n🚨 ZÁVĚR: CI/CD Pipeline byla zastavena, protože aplikace nesplňuje Evropské směrnice. Opravte výše uvedené chyby před nasazením.`);
    
    // Slack Notification
    if (process.env.SLACK_COMPLIANCE_BOT_TOKEN || process.env.SLACK_BOT_TOKEN) {
      const channel = process.env.SLACK_CHANNEL || '#general';
      console.log(`Odesílám upozornění do Slacku (kanál: ${channel})...`);
      const blocks = [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*Detaily selhání (CI/CD):*\n${failedAudits.map(f => `• ${f}`).join('\n')}`
          }
        },
        {
          type: 'context',
          elements: [{ type: 'mrkdwn', text: `URL: ${url} | Spuštěno AuraGuard CLI` }]
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: {
                type: 'plain_text',
                text: 'Spustit znovu',
                emoji: true
              },
              style: 'primary',
              value: url,
              action_id: 'run_audit_again'
            },
            {
              type: 'button',
              text: {
                type: 'plain_text',
                text: 'Ignorovat upozornění',
                emoji: true
              },
              style: 'danger',
              value: 'ignore',
              action_id: 'ignore_alert'
            }
          ]
        }
      ];
      await sendSlackNotification(
        channel,
        'AuraGuard: Nasazení zablokováno (Porušení compliance)',
        `Cílová adresa *${url}* neprošla povinnými audity.`,
        true,
        blocks,
        'compliance'
      );
    }

    process.exit(EXIT_COMPLIANCE_FAILED);
  } else {
    console.log(inconclusive.length > 0
      ? `\n✅ ZÁVĚR: Žádné prokazatelné porušení. Pozor: ${inconclusive.length} kontrol bylo neprůkazných — nejde o potvrzení shody.`
      : `\n🎉 ZÁVĚR: Žádné prokazatelné porušení v ověřovaných kontrolách. Nasazení povoleno.`);
    process.exit(EXIT_OK);
  }
}

// Bez .catch() by výjimka mimo try (např. ze sendSlackNotification) přeskočila
// process.exit() a spolehla se na výchozí chování Node.
runCLI().catch((err) => {
  console.error('❌ Neošetřená chyba CLI:', err);
  process.exit(EXIT_INTERNAL);
});
