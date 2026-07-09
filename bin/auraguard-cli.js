#!/usr/bin/env node

import { auditNIS2AndPQC, auditCRA_SBOM, auditAccessibility, auditAIAct, auditStrictCookies, auditCRAVulnerabilities } from '../agent.js';

const args = process.argv.slice(2);
const urlIndex = args.indexOf('--url');
const auditIndex = args.indexOf('--audit');

if (urlIndex === -1 || urlIndex + 1 >= args.length) {
  console.error('Chyba: Musíte zadat cílové URL pomocí parametru --url');
  console.error('Použití: auraguard --url <https://vase-aplikace.cz> --audit <nis2|cra|cve|eaa|ai|gdpr|all>');
  process.exit(1);
}

const url = args[urlIndex + 1];
const auditType = (auditIndex !== -1 && auditIndex + 1 < args.length) ? args[auditIndex + 1] : 'all';

console.log(`\n🛡️  AuraGuard CI/CD Zabezpečení 🛡️`);
console.log(`Cílové URL: ${url}`);
console.log(`Spouštím audit: ${auditType.toUpperCase()}\n`);

async function runCLI() {
  let hasErrors = false;

  try {
    if (['nis2', 'all'].includes(auditType)) {
      console.log('Spouštím: NIS2 & PQC Audit...');
      const nis2Report = await auditNIS2AndPQC(url);
      
      if (!nis2Report.nis2.isCompliant) {
        console.error('❌ SELHÁNÍ: Aplikace nesplňuje požadavky směrnice NIS2!');
        const missing = nis2Report.nis2.missingHeaders || [];
        missing.forEach(h => console.error(`   - Chybí hlavička: ${h}`));
        hasErrors = true;
      } else {
        console.log('✅ PASS: NIS2 Compliance');
      }
      console.log(`   PQC Status: ${nis2Report.pqc.protocol}\n`);
    }

    if (['cra', 'all'].includes(auditType)) {
      console.log('Spouštím: CRA SBOM Skener...');
      const craReport = await auditCRA_SBOM(url);
      
      if (craReport.sbom.length > 0) {
        console.log('✅ PASS: SBOM úspěšně vygenerován.');
        craReport.sbom.forEach(lib => console.log(`   - Detekováno: ${lib.name} (${lib.version})`));
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
      } else {
        console.log('✅ PASS: EAA Compliance (Základní A11y)\n');
      }
    }

    if (['ai', 'all'].includes(auditType)) {
      console.log('Spouštím: EU AI Act Scanner...');
      const aiReport = await auditAIAct(url);
      
      if (!aiReport.aiAct.isCompliant) {
        console.error('❌ SELHÁNÍ: AI Act Violation! Detekováno LLM API bez transparentního upozornění.');
        aiReport.aiAct.apisDetected.forEach(api => console.error(`   - Voláno API: ${api}`));
        hasErrors = true;
      } else {
        console.log('✅ PASS: AI Act Compliance\n');
      }
    }

    if (['gdpr', 'all'].includes(auditType)) {
      console.log('Spouštím: Striktní GDPR Cookie Auditor...');
      const cookieReport = await auditStrictCookies(url);
      
      if (!cookieReport.gdpr.isCompliant) {
        console.error('❌ SELHÁNÍ: GDPR ePrivacy Violation! Detekovány trackery před udělením souhlasu.');
        cookieReport.gdpr.suspiciousItems.forEach(item => console.error(`   - Tracker: ${item}`));
        hasErrors = true;
      } else {
        console.log('✅ PASS: GDPR Cookie Compliance (No implicit trackers)\n');
      }
    }

    if (['cve', 'all'].includes(auditType)) {
      console.log('Spouštím: CRA Vulnerability Scanner (OSV.dev)...');
      const vulnReport = await auditCRAVulnerabilities(url);
      
      if (!vulnReport.cra.isCompliant) {
        console.error(`❌ SELHÁNÍ: CRA Violation! Nalezeno ${vulnReport.cra.vulnerabilities.length} zranitelností (CVE).`);
        vulnReport.cra.vulnerabilities.forEach(v => console.error(`   - ${v.cve} (${v.severity}): ${v.library} ${v.version}`));
        hasErrors = true;
      } else {
        console.log('✅ PASS: Cyber Resilience Act (0 CVE found)\n');
      }
    }

  } catch (err) {
    console.error(`❌ Kritická chyba při provádění auditu: ${err.message}`);
    process.exit(1);
  }

  if (hasErrors) {
    console.error(`\n🚨 ZÁVĚR: CI/CD Pipeline byla zastavena, protože aplikace nesplňuje Evropské směrnice. Opravte výše uvedené chyby před nasazením.`);
    process.exit(1);
  } else {
    console.log(`\n🎉 ZÁVĚR: Aplikace prošla všemi EU audity. Nasazení povoleno!`);
    process.exit(0);
  }
}

runCLI();
