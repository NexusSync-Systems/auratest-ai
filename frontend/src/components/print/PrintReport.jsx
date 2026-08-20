import ReactMarkdown from 'react-markdown';
import { IMPACT_TRANSLATIONS, RULE_TRANSLATIONS, TEST_TYPES } from '../../constants/testTypes.js';
import { complianceBadgeClass, complianceLabel } from '../../lib/compliance.js';

/**
 * Tiskový report (Executive Summary) pro export do PDF přes Print CSS.
 *
 * Dřív byl tenhle blok (~230 řádků JSX) vložený přímo v App.jsx a renderoval
 * se při KAŽDÉM překreslení, přestože je přes `.print-only { display: none }`
 * na obrazovce neviditelný. Při 99 stavových proměnných v App to znamenalo
 * plný re-render při každém stisku klávesy v jakémkoli inputu.
 *
 * Nově je to samostatná komponenta načítaná přes React.lazy — do hlavního
 * bundlu se nedostane vůbec.
 */
export default function PrintReport({
  user,
  agentUrl,
  liveLogs,
  a11yResult,
  nis2Result,
  greenResult,
  craResult,
  craVulnResult,
  cookieResult,
  aiActResult,
  monitorPageResult,
  monitorFormResult,
  securityAnalysisResult,
  selectedTestType,
  authEmail,
}) {
  return (
    <div className="print-only">
      <div className="print-header">
        <h1>AuraGuard</h1>
        <h2>Executive QA & Compliance Report</h2>
        <p>Vygenerováno: {new Date().toLocaleString('cs-CZ')}</p>
      </div>

      <div className="print-section">
        <h3>Shrnutí Testování</h3>
        <table className="print-table">
          <tbody>
            <tr>
              <th style={{ width: '30%' }}>Cílová URL:</th>
              <td>{agentUrl || 'Nenastaveno'}</td>
            </tr>
            <tr>
              <th>Typ Testu:</th>
              <td>{TEST_TYPES.find(t => t.id === selectedTestType)?.label || 'Neznámý test'}</td>
            </tr>
            <tr>
              <th>Tester (E-mail):</th>
              <td>{user?.email || authEmail || 'Anonymní spuštění'}</td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* EAA Audit */}
      {a11yResult && (
        <div className="print-section">
          <h3>Výsledky EAA (Přístupnost)</h3>
          <div className={`print-badge ${a11yResult.violations.length === 0 ? 'success' : 'error'}`}>
            Nalezeno porušení: {a11yResult.violations.length}
          </div>
          {a11yResult.violations.length > 0 && (
            <ul style={{ marginTop: '15px', paddingLeft: '20px' }}>
              {a11yResult.violations.map(v => (
                <li key={v.id} style={{ marginBottom: '10px' }}>
                  <strong>{RULE_TRANSLATIONS[v.id] || v.id}</strong> ({IMPACT_TRANSLATIONS[v.impact] || v.impact})
                  <p style={{ margin: '4px 0 0 0', fontSize: '14px', color: '#475569' }}>{v.description}</p>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Green Deal & GDPR */}
      {greenResult && (
        <div className="print-section">
          <h3>Green Deal & GDPR</h3>
          <div className={`print-badge ${greenResult.green.rating.includes('A') ? 'success' : greenResult.green.rating.includes('C') ? 'warning' : 'error'}`}>
            Eko Třída: {greenResult.green.rating}
          </div>
          <table className="print-table" style={{ marginBottom: '20px' }}>
            <tbody>
              <tr><th style={{ width: '30%' }}>Uhlíková stopa:</th><td>{greenResult.green.co2Grams} g CO2 / načtení</td></tr>
              <tr><th>Přenesená data:</th><td>{greenResult.green.totalMb} MB</td></tr>
            </tbody>
          </table>

          <div className={`print-badge ${complianceBadgeClass(greenResult.residency.isEUCompliant)}`}>
            {`GDPR Rezidence [${complianceLabel(greenResult.residency.isEUCompliant)}]: `}
            {greenResult.residency.warning}
          </div>
          <ul style={{ marginTop: '15px', paddingLeft: '20px' }}>
            {greenResult.residency.locations.map((loc, i) => (
              <li key={i} style={{ marginBottom: '4px' }}>
                <strong>{loc.domain}</strong> ({loc.country}) - {loc.isEU ? 'EU/EEA' : 'Mimo EU'}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* AI Act */}
      {aiActResult && (
        <div className="print-section">
          <h3>EU AI Act (Transparentnost)</h3>
          <div className={`print-badge ${complianceBadgeClass(aiActResult.aiAct.isCompliant)}`}>
            {`[${complianceLabel(aiActResult.aiAct.isCompliant)}] `}
            {aiActResult.aiAct.rating}
          </div>
          {aiActResult.aiAct.apisDetected.length > 0 && (
            <div style={{ marginTop: '15px' }}>
              <strong>Detekované AI služby:</strong>
              <ul style={{ marginTop: '10px', paddingLeft: '20px' }}>
                {aiActResult.aiAct.apisDetected.map((api, i) => <li key={i}>{api}</li>)}
              </ul>
            </div>
          )}
        </div>
      )}

      {/* NIS2 Result */}
      {nis2Result && (
        <div className="print-section">
          <h3>NIS2 & PQC (Kvantová Bezpečnost)</h3>
          <table className="print-table" style={{ marginBottom: '20px' }}>
            <tbody>
              <tr><th style={{ width: '30%' }}>HSTS:</th><td>{nis2Result.nis2.hsts ? 'Aktivní' : 'Chybí'}</td></tr>
              <tr><th>CSP:</th><td>{nis2Result.nis2.csp ? 'Aktivní' : 'Chybí'}</td></tr>
              <tr><th>PQC Protokol:</th><td>{nis2Result.pqc.protocol}</td></tr>
              <tr><th>PQC Autorita:</th><td>{nis2Result.pqc.issuer}</td></tr>
            </tbody>
          </table>
        </div>
      )}

      {/* CRA SBOM */}
      {craResult && (
        <div className="print-section">
          <h3>CRA SBOM (Softwarový Kusovník)</h3>
          <div className="print-badge success" style={{ borderLeftColor: '#3b82f6', color: '#1d4ed8', backgroundColor: '#eff6ff' }}>
            Detekováno technologií: {craResult.sbom.length}
          </div>
          <table className="print-table">
            <thead>
              <tr><th style={{ width: '40%' }}>Název</th><th>Typ</th><th>Verze</th></tr>
            </thead>
            <tbody>
              {craResult.sbom.map((lib, i) => (
                <tr key={i}>
                  <td><strong>{lib.name}</strong></td>
                  <td>{lib.type}</td>
                  <td>{lib.version}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* GDPR Cookie Result */}
      {cookieResult && (
        <div className="print-section">
          <h3>GDPR Cookie Auditor</h3>
          <div className={`print-badge ${cookieResult.gdpr.isCompliant ? 'success' : 'error'}`}>
            {cookieResult.gdpr.rating}
          </div>
          {cookieResult.gdpr.suspiciousItems.length > 0 && (
            <div style={{ marginTop: '15px' }}>
              <strong style={{ color: '#ef4444' }}>Nalezeny trackery před souhlasem:</strong>
              <ul style={{ paddingLeft: '20px', marginTop: '8px' }}>
                {cookieResult.gdpr.suspiciousItems.map((item, i) => <li key={i} style={{ fontFamily: 'monospace', fontSize: '14px', color: '#475569' }}>{item}</li>)}
              </ul>
            </div>
          )}
        </div>
      )}

      {/* CRA Vuln Result */}
      {craVulnResult && (
        <div className="print-section">
          <h3>CRA Zranitelnosti (CVE OSV Scan)</h3>
          <div className={`print-badge ${complianceBadgeClass(craVulnResult.cra.isCompliant)}`}>
            {`[${complianceLabel(craVulnResult.cra.isCompliant)}] `}
            {craVulnResult.cra.rating}
          </div>
          {craVulnResult.cra.vulnerabilities.length > 0 && (
            <div style={{ marginTop: '15px' }}>
              {craVulnResult.cra.vulnerabilities.map((v, i) => (
                <div key={i} style={{ padding: '15px', background: '#fff', border: '1px solid #e2e8f0', borderLeft: '4px solid #ef4444', marginBottom: '8px' }}>
                  <div style={{ fontWeight: 'bold', color: '#ef4444' }}>{v.cve} ({v.severity})</div>
                  <div style={{ fontSize: '14px', color: '#475569' }}>Zasažená knihovna: {v.library} {v.version}</div>
                  <div style={{ fontSize: '12px', color: '#64748b', marginTop: '4px' }}>{v.details}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* HTTP Page Monitor */}
      {monitorPageResult && (
        <div className="print-section">
          <h3>Test Dostupnosti (HTTP)</h3>
          <div className={`print-badge ${monitorPageResult.ok ? 'success' : 'error'}`}>
            {monitorPageResult.ok ? 'Uptime OK' : 'Výpadek Zaznamenán'}
          </div>
          <table className="print-table">
            <tbody>
              <tr><th style={{ width: '30%' }}>URL:</th><td>{monitorPageResult.url}</td></tr>
              <tr><th>Doba odezvy:</th><td>{monitorPageResult.durationMs} ms</td></tr>
              <tr><th>HTTP Status:</th><td>{monitorPageResult.status}</td></tr>
              {!monitorPageResult.ok && <tr><th style={{color: '#ef4444'}}>Chyba:</th><td style={{color: '#ef4444'}}>{monitorPageResult.error}</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {/* HTTP Form Monitor */}
      {monitorFormResult && (
        <div className="print-section">
          <h3>Test Formuláře (HTTP)</h3>
          <div className={`print-badge ${monitorFormResult.ok ? 'success' : 'error'}`}>
            {monitorFormResult.ok ? 'Formulář prošel' : 'Formulář zamítnut'}
          </div>
          <table className="print-table">
            <tbody>
              <tr><th style={{ width: '30%' }}>Odesláno na:</th><td>{monitorFormResult.url}</td></tr>
              <tr><th>Doba odezvy:</th><td>{monitorFormResult.durationMs} ms</td></tr>
              <tr><th>HTTP Status:</th><td>{monitorFormResult.status}</td></tr>
              {!monitorFormResult.ok && <tr><th style={{color: '#ef4444'}}>Chyba:</th><td style={{color: '#ef4444'}}>{monitorFormResult.error}</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {/* Security Analysis Result */}
      {securityAnalysisResult && (
        <div className="print-section">
          <h3>Komplexní AI Bezpečnostní Analýza</h3>
          <div className="markdown-body" style={{ color: '#334155', fontSize: '14px', lineHeight: 1.6 }}>
            <ReactMarkdown>{securityAnalysisResult}</ReactMarkdown>
          </div>
        </div>
      )}

      {/* Logy (Agent) */}
      {liveLogs.length > 0 && (
        <div className="print-section">
          <h3>Provedené Akce Agenta</h3>
          <div style={{ fontFamily: 'monospace', fontSize: '12px', background: '#f8fafc', padding: '15px', borderRadius: '8px', border: '1px solid #e2e8f0' }}>
            {liveLogs.map((log, i) => (
              <div key={i} style={{ marginBottom: '6px', borderBottom: i < liveLogs.length - 1 ? '1px dashed #cbd5e1' : 'none', paddingBottom: '6px' }}>
                <span style={{ color: '#64748b' }}>[Krok {log.step}] [{log.action}]</span> {log.reasoning}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
