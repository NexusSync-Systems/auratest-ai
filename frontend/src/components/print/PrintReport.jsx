import ReactMarkdown from 'react-markdown';
import { IMPACT_TRANSLATIONS, RULE_TRANSLATIONS, TEST_TYPES } from '../../constants/testTypes.js';
import { complianceBadgeClass, complianceLabel, obligationLabel, pqcLabel } from '../../lib/compliance.js';

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
/**
 * Stav jedné bezpečnostní hlavičky slovy.
 *
 * `agent.js` vrací u `hsts` a `csp` TROJSTAV — `true` / `false` / `null` —
 * a u `null` výslovně zdůvodňuje proč: na nešifrovaném spojení prohlížeč
 * HSTS ignoruje, takže její absence není volbou provozovatele a nálezem
 * být nemůže. Tiskový report to zplošťoval ternárním operátorem
 * `hsts ? 'Aktivní' : 'Chybí'`; `null` je falsy, takže v dokumentu pro
 * úřad stálo „Chybí" o hlavičce, kterou nikdo neměřil.
 *
 * `false` navíc znamená dvě různé věci: hlavička chybí, nebo je přítomná
 * a nechrání (`Referrer-Policy: unsafe-url`, CSP s `unsafe-inline`).
 * Agent to rozlišuje v `weakHeaders`; report to má tisknout taky, protože
 * provozovatel podle toho ví, jestli hlavičku doplnit, nebo opravit.
 */
function headerStateLabel(ok, label, nis2) {
  if (ok === true) return 'Aktivní';
  if (ok === null || ok === undefined) return 'Nelze posoudit';
  if (nis2?.weakHeaders?.includes(label)) return 'Přítomná, ale nechrání';
  if (nis2?.missingHeaders?.includes(label)) return 'Chybí';
  // Starší uložený běh nová pole nemá. „Chybí" by pak bylo tvrzení
  // o webu, který hlavičku klidně má — jen ji má neúčinnou. Neutrální
  // znění říká jen to, co `false` skutečně znamená.
  return 'Nesplněno';
}

/**
 * Eko třída na barvu odznaku.
 *
 * Dřív se hledal podřetězec `'A'` a `'C'` v celém řetězci hodnocení.
 * Fungovalo to jen náhodou — stačilo přidat další stupeň, jehož text
 * obsahuje písmeno A (třeba „B (Nadprůměr)" s poznámkou), a odznak by
 * zezelenal. Rozhoduje první znak, ostatní je popis.
 */
const EKO_ODZNAK = { A: 'success', B: 'success', C: 'warning', D: 'warning', E: 'error', F: 'error' };

/**
 * Průzkumný běh agenta je jediná část dokumentu, kde „nic jsme nenašli"
 * NENÍ tvrzení o souladu. Agent klikal, kam ho napadlo; z toho, že
 * nenarazil na chybu, neplyne, že aplikace žádnou nemá. Odznak proto
 * nepoužívá `complianceLabel` — ten by tiskl „Splněno".
 */
/**
 * Předpisový sken NENÍ běh agenta.
 *
 * Server ukládá obojí do stejné kolekce a `buildScanSession` zakládá
 * předpisovou kontrolu s `bugs: []` a `status: 'completed'` schválně —
 * spis ta pole čte u každého běhu. Kliknutím na takový záznam v historii
 * se dostane do `activeSession` a bez tohohle rozlišení by PDF
 * z předpisové kontroly tvrdilo, že proběhl průzkumný běh agenta a nic
 * nenašel. Žádný agent přitom neběžel.
 *
 * Rozlišení je stejné jako v `case-file.js`: co není `compliance-scan`,
 * je agentní běh (starší záznamy `kind` nemají vůbec).
 */
function jeAgentniBeh(session) {
  return Boolean(session) && session.kind !== 'compliance-scan';
}

function behAgenta(session, isRunning) {
  if (isRunning || !session || session.status !== 'completed') {
    return {
      trida: 'warning',
      nadpis: isRunning ? 'Běh nebyl dokončen' : 'Běh neskončil úspěšně',
      poznamka: isRunning
        ? 'Dokument zachycuje stav v okamžiku tisku. Kroky pod ním nejsou '
          + 'úplným záznamem běhu a závěr z nich vyvozovat nelze.'
        : 'Běh se nedokončil, takže nemá výsledek. Z toho neplyne, že je '
          + 'aplikace bez závad, ani že závady má.',
    };
  }
  // Chybějící pole není prázdný seznam.
  //
  // `bugs: []` je ZMĚŘENÁ nepřítomnost nálezu. `bugs: undefined` znamená,
  // že seznam nálezů běh vůbec nenese — starší uložený záznam, jiná
  // cesta zápisu. `?.length ?? 0` z toho dělalo nulu, a tedy zelený
  // odznak „nic jsme nenašli" nad během, který se na nálezy nedíval.
  if (!Array.isArray(session.bugs)) {
    return {
      trida: 'warning',
      nadpis: 'Dokončeno — seznam nálezů běh neobsahuje',
      poznamka: 'Záznam běhu nenese seznam nálezů. Nelze z něj vyvodit ani '
        + 'to, že se něco našlo, ani to, že se nenašlo nic.',
    };
  }
  const nalezy = session.bugs.length;
  if (nalezy > 0) {
    return {
      trida: 'error',
      nadpis: `Dokončeno — nalezeno ${nalezy} ${nalezy === 1 ? 'problém' : (nalezy < 5 ? 'problémy' : 'problémů')}`,
      poznamka: 'Nálezy jsou vypsané níž tak, jak je agent zaznamenal.',
    };
  }
  return {
    trida: 'success',
    nadpis: 'Dokončeno — agent na žádný problém nenarazil',
    poznamka: 'Průzkumný běh není úplný test. Agent prošel jen cesty, na '
      + 'které během běhu narazil; z absence nálezu neplyne, že je '
      + 'aplikace bez závad.',
  };
}

export default function PrintReport({
  chaosResult,
  user,
  agentUrl,
  liveLogs,
  activeSession = null,
  isRunning = false,
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

      {/* Výsledek běhu agenta.
          Do reportu se dosud předávaly POUZE `liveLogs` — tedy kroky.
          Nálezy (`bugs`), varování, závěr běhu i jeho stav zůstávaly na
          obrazovce a do PDF se nedostaly. Dokument nadepsaný „Compliance
          Report" tak o zjištěném problému mlčel a čtenář z něj vyvodil,
          že se nic nenašlo. */}
      {(jeAgentniBeh(activeSession) || isRunning) && (() => {
        const stav = behAgenta(activeSession, isRunning);
        return (
          <div className="print-section">
            <h3>Výsledek běhu agenta</h3>
            <div className={`print-badge ${stav.trida}`}>{stav.nadpis}</div>
            <p style={{ marginTop: '10px', fontSize: '14px', color: '#475569' }}>
              {stav.poznamka}
            </p>

            {activeSession?.summary && (
              <p style={{ marginTop: '10px', fontSize: '14px' }}>{activeSession.summary}</p>
            )}

            {activeSession?.performanceMetrics && (
              <table className="print-table" style={{ marginTop: '15px' }}>
                <tbody>
                  <tr>
                    <th style={{ width: '30%' }}>Načtení stránky:</th>
                    <td>
                      {activeSession.performanceMetrics.loadTimeMs
                        ? `${activeSession.performanceMetrics.loadTimeMs} ms`
                        : 'neměřeno'}
                    </td>
                  </tr>
                  <tr>
                    <th>Titulek stránky:</th>
                    <td>{activeSession.performanceMetrics.title || 'chybí'}</td>
                  </tr>
                </tbody>
              </table>
            )}

            {activeSession?.bugs?.length > 0 && (
              <>
                <p style={{ marginTop: '15px', marginBottom: '4px', fontWeight: 600 }}>
                  Detekované problémy ({activeSession.bugs.length})
                </p>
                <ul style={{ paddingLeft: '20px' }}>
                  {activeSession.bugs.map((b, i) => (
                    <li key={i} style={{ marginBottom: '6px', fontSize: '14px', color: '#475569' }}>
                      {b}
                    </li>
                  ))}
                </ul>
              </>
            )}

            {/* Chyby MĚŘENÍ, oddělené od nálezů.
                Agent je ukládá zvlášť právě proto, aby je nikdo nemohl
                číst jako zjištění o zákazníkově webu. V dokumentu ale
                být musí — jinak u nedokončeného běhu stojí „běh se
                nedokončil" bez jediného slova o tom proč. */}
            {activeSession?.runErrors?.length > 0 && (
              <>
                <p style={{ marginTop: '15px', marginBottom: '4px', fontWeight: 600 }}>
                  Chyby měření ({activeSession.runErrors.length})
                </p>
                <p style={{ margin: '0 0 8px 0', fontSize: '14px', color: '#475569' }}>
                  Tohle nejsou nálezy o testované aplikaci — je to seznam
                  toho, co se nepodařilo změřit.
                </p>
                <ul style={{ paddingLeft: '20px' }}>
                  {activeSession.runErrors.map((e, i) => (
                    <li key={i} style={{ marginBottom: '6px', fontSize: '14px', color: '#475569' }}>
                      {typeof e === 'string' ? e : (e?.message || JSON.stringify(e))}
                    </li>
                  ))}
                </ul>
              </>
            )}

            {activeSession?.warnings?.length > 0 && (
              <>
                <p style={{ marginTop: '15px', marginBottom: '4px', fontWeight: 600 }}>
                  Varování ({activeSession.warnings.length})
                </p>
                <ul style={{ paddingLeft: '20px' }}>
                  {activeSession.warnings.map((w, i) => (
                    <li key={i} style={{ marginBottom: '6px', fontSize: '14px', color: '#475569' }}>
                      {w}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        );
      })()}

      {/* EAA Audit */}
      {a11yResult && (
        <div className="print-section">
          <h3>Výsledky EAA (Přístupnost)</h3>
          {/* Trojstav, ne zelená/červená.
              Zbytek dokumentu tři stavy umí; tahle sekce jediná zůstala
              binární — a zrovna tady `null` reálně vzniká. Web s desítkami
              položek k ručnímu posouzení dostával do dokumentu pro úřad
              zelený odznak „Nalezeno porušení: 0" a nic víc. */}
          {(() => {
            const porusení = a11yResult.violations?.length ?? 0;
            const kRucnimu = a11yResult.incomplete?.length ?? 0;
            const stav = a11yResult.navigationError
              ? null
              : (porusení > 0 ? false : (kRucnimu > 0 ? null : true));
            return (
              <div className={`print-badge ${complianceBadgeClass(stav)}`}>
                {complianceLabel(stav)} — nalezeno porušení: {porusení}
                {kRucnimu > 0 ? `, k ručnímu posouzení: ${kRucnimu}` : ''}
              </div>
            );
          })()}

          {a11yResult.navigationError && (
            <p style={{ marginTop: '10px', fontSize: '14px', color: '#475569' }}>
              Stránku se nepodařilo posoudit: {a11yResult.navigationError} Z toho
              neplyne, že je bez závad.
            </p>
          )}

          {a11yResult.violations?.length > 0 && (
            <ul style={{ marginTop: '15px', paddingLeft: '20px' }}>
              {a11yResult.violations.map(v => (
                <li key={v.id} style={{ marginBottom: '10px' }}>
                  <strong>{RULE_TRANSLATIONS[v.id] || v.id}</strong> ({IMPACT_TRANSLATIONS[v.impact] || v.impact})
                  <p style={{ margin: '4px 0 0 0', fontSize: '14px', color: '#475569' }}>{v.description}</p>
                </li>
              ))}
            </ul>
          )}

          {/* Položky k ručnímu posouzení se dosud netiskly vůbec, přestože
              registr u téhož pravidla uvádí, že nejsou splněné ani
              porušené. Kontrolor tak neměl jak poznat, že je co dořešit. */}
          {a11yResult.incomplete?.length > 0 && (
            <>
              <p style={{ marginTop: '15px', marginBottom: '4px', fontWeight: 600 }}>
                K ručnímu posouzení ({a11yResult.incomplete.length})
              </p>
              <p style={{ margin: '0 0 8px 0', fontSize: '14px', color: '#475569' }}>
                Automatický test tyhle položky rozhodnout neumí. Nejsou splněné
                ani porušené — vyžadují posouzení člověkem.
              </p>
              <ul style={{ paddingLeft: '20px' }}>
                {a11yResult.incomplete.map(v => (
                  <li key={v.id} style={{ marginBottom: '6px' }}>
                    <strong>{RULE_TRANSLATIONS[v.id] || v.id}</strong>
                    <p style={{ margin: '4px 0 0 0', fontSize: '14px', color: '#475569' }}>{v.description}</p>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}

      {/* Green Deal & GDPR */}
      {greenResult && (
        <div className="print-section">
          <h3>Green Deal & GDPR</h3>
          <div className={`print-badge ${EKO_ODZNAK[String(greenResult.green.rating || '').trim().charAt(0).toUpperCase()] || 'warning'}`}>
            Eko Třída: {greenResult.green.rating || 'neurčena'}
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
          {/* `isEU: null` znamená „nešlo posoudit", ne „mimo EU".
              Ternární výraz z toho dělal tvrzení o přenosu do třetí země
              u domény za CDN i u adresy, kterou databáze neumístila —
              přesně to, co oprava rezidence odstranila o patro níž. */}
          <ul style={{ marginTop: '15px', paddingLeft: '20px' }}>
            {greenResult.residency.locations.map((loc, i) => (
              <li key={i} style={{ marginBottom: '4px' }}>
                <strong>{loc.domain}</strong>
                {loc.country ? ` (${loc.country})` : ''}
                {' — '}
                {loc.isEU === true
                  ? 'EU/EHP'
                  : loc.isEU === false
                    ? 'mimo EU/EHP'
                    : loc.onCdn
                      ? `za CDN (${loc.cdnProvider || 'neurčeno'}), umístění dat z IP určit nelze`
                      : 'umístění se nepodařilo určit'}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* DORA Chaos — v tiskovém reportu úplně chyběl, přestože README
          slibuje export "celé záložky Audit". */}
      {chaosResult && chaosResult.chaos && (
        <div className="print-section">
          <h3>DORA — Chaos Engineering</h3>
          <div className={`print-badge ${complianceBadgeClass(chaosResult.chaos.isResilient)}`}>
            {`[${complianceLabel(chaosResult.chaos.isResilient)}] `}
            {chaosResult.chaos.rating}
          </div>
          <table className="print-table" style={{ marginTop: '15px' }}>
            <tbody>
              <tr><td>Zahozené požadavky</td><td>{chaosResult.chaos.abortedRequests}</td></tr>
              <tr><td>Zpožděné požadavky</td><td>{chaosResult.chaos.delayedRequests}</td></tr>
              <tr><td>Chyb v konzoli</td><td>{chaosResult.chaos.consoleErrors}</td></tr>
              {/* Rozdíl proti baseline je to, co jde připsat injektáži. */}
              {chaosResult.chaos.baseline && (
                <>
                  <tr>
                    <td>Chyb v konzoli bez injektáže (baseline)</td>
                    <td>{chaosResult.chaos.baseline.consoleErrors}</td>
                  </tr>
                  <tr>
                    <td>Nových chyb způsobených injektáží</td>
                    <td>{chaosResult.chaos.newConsoleErrors}</td>
                  </tr>
                </>
              )}
              <tr><td>Stránka se zhroutila</td><td>{chaosResult.chaos.pageCrashed ? 'ano' : 'ne'}</td></tr>
              {/* Bez seedu není běh opakovatelný, a tedy ani doložitelný. */}
              {chaosResult.chaos.seed && (
                <tr><td>Seed běhu (pro zopakování)</td><td>{chaosResult.chaos.seed}</td></tr>
              )}
            </tbody>
          </table>
          <p style={{ fontSize: '0.85em', color: '#475569' }}>
            {chaosResult.chaos.scope}
          </p>
        </div>
      )}

      {/* AI Act */}
      {aiActResult && (
        <div className="print-section">
          <h3>EU AI Act — článek 50 (Transparentnost)</h3>
          <div className={`print-badge ${complianceBadgeClass(aiActResult.aiAct.isCompliant)}`}>
            {`[${complianceLabel(aiActResult.aiAct.isCompliant)}] `}
            {aiActResult.aiAct.rating}
          </div>

          {/* Čtyři povinnosti čl. 50 zvlášť — v auditním spisu musí být vidět
              i to, co skener posoudit nedokáže. */}
          {Array.isArray(aiActResult.aiAct.obligations) && (
            <table className="print-table" style={{ marginTop: '15px' }}>
              <tbody>
                {aiActResult.aiAct.obligations.map((ob) => (
                  <tr key={ob.id}>
                    <td style={{ whiteSpace: 'nowrap', fontWeight: 'bold' }}>{ob.id}</td>
                    <td>
                      {ob.title}
                      {ob.outOfScope ? ' (mimo dosah skeneru)' : ''}
                      <div style={{ fontSize: '0.85em', color: '#475569' }}>{ob.rationale}</div>
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}>{obligationLabel(ob.status)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

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

          {/* Jediná sekce, která dosud netiskla verdikt vůbec.
              Čtenář viděl dvě zploštělé hlavičky a parametry TLS — ne
              závěr, a ne to, co se posoudit nepodařilo.

              Verdikt se VÝSLOVNĚ vztahuje k hlavičkám, ne k NIS2 jako
              celku — sám agent to v `scope` říká a ten se tiskne pod
              tabulkou. Odznak „[Splněno]" pod nadpisem „NIS2" by jinak
              znamenal tvrzení o splnění směrnice na základě kontroly
              šesti HTTP hlaviček.

              Text se odvozuje z `isCompliant`, ne z `headersComplete`:
              to je u neprůkazného výsledku `true` (nic nechybí ani
              neselhalo, jen se to nedalo posoudit), takže by v dokumentu
              stálo „[Neprůkazné] hlavičky jsou kompletní" — a slovo
              v závorce větu nepřebije. */}
          <div className={`print-badge ${complianceBadgeClass(nis2Result.nis2.isCompliant)}`}>
            {`Bezpečnostní hlavičky [${complianceLabel(nis2Result.nis2.isCompliant)}]: `}
            {nis2Result.nis2.isCompliant === true
              ? 'všechny posuzované hlavičky jsou nastavené a chrání.'
              : (nis2Result.nis2.isCompliant === false
                ? 'rozbor jednotlivých hlaviček je níž.'
                : 'část hlaviček se posoudit nepodařilo, rozbor je níž.')}
          </div>

          <table className="print-table" style={{ marginTop: '15px', marginBottom: '20px' }}>
            <tbody>
              {/* Všech šest posuzovaných hlaviček, i když jsou v pořádku.
                  Dřív tu byly jen HSTS a CSP a zbylé čtyři se objevily
                  pouze jako nález — čtenář tedy nepoznal, jestli se
                  vůbec kontrolovaly. */}
              {[
                ['HSTS', 'hsts', 'Strict-Transport-Security'],
                ['CSP', 'csp', 'Content-Security-Policy'],
                ['X-Content-Type-Options', 'xContentTypeOptions', 'X-Content-Type-Options'],
                ['Ochrana proti rámování', 'xFrameOptions', 'X-Frame-Options / frame-ancestors'],
                ['Referrer-Policy', 'referrerPolicy', 'Referrer-Policy'],
                ['Permissions-Policy', 'permissionsPolicy', 'Permissions-Policy'],
              ].map(([popisek, klic, label]) => (
                <tr key={klic}>
                  <th style={{ width: '30%' }}>{popisek}:</th>
                  <td>{headerStateLabel(nis2Result.nis2[klic], label, nis2Result.nis2)}</td>
                </tr>
              ))}
              <tr><th>Vyjednaný protokol:</th><td>{nis2Result.pqc.protocol}</td></tr>
              <tr>
                <th>Post-kvantová výměna klíčů:</th>
                <td>
                  {pqcLabel(nis2Result.pqc.isQuantumSafe)}
                  {nis2Result.pqc.pqcGroup ? ` (${nis2Result.pqc.pqcGroup})` : ''}
                </td>
              </tr>
              {nis2Result.pqc.protocolsEnabled?.length > 0 && (
                <tr><th>Přijímané verze TLS:</th><td>{nis2Result.pqc.protocolsEnabled.join(', ')}</td></tr>
              )}
              <tr><th>Certifikační autorita:</th><td>{nis2Result.pqc.issuer}</td></tr>
            </tbody>
          </table>

          {/* Tři seznamy zvlášť. Agent je rozlišuje a zdůvodňuje proč:
              verdikt je u chybějící a slabé hlavičky stejný, ale TVRZENÍ
              ne — a nepravdivé tvrzení v compliance reportu je vada,
              i když vede ke správnému závěru. Neprůkazné pak není ani
              jedno z toho. */}
          {nis2Result.nis2.missingHeaders?.length > 0 && (
            <>
              <p style={{ marginTop: '15px', marginBottom: '4px', fontWeight: 600 }}>
                Chybějící hlavičky ({nis2Result.nis2.missingHeaders.length})
              </p>
              <ul style={{ paddingLeft: '20px' }}>
                {nis2Result.nis2.missingHeaders.map((h) => (
                  <li key={h} style={{ fontSize: '14px', color: '#475569' }}>{h}</li>
                ))}
              </ul>
            </>
          )}

          {nis2Result.nis2.weakHeaders?.length > 0 && (
            <>
              <p style={{ marginTop: '15px', marginBottom: '4px', fontWeight: 600 }}>
                Hlavičky, které jsou přítomné, ale nechrání ({nis2Result.nis2.weakHeaders.length})
              </p>
              <ul style={{ paddingLeft: '20px' }}>
                {nis2Result.nis2.weakHeaders.map((h) => (
                  <li key={h} style={{ fontSize: '14px', color: '#475569' }}>{h}</li>
                ))}
              </ul>
            </>
          )}

          {nis2Result.nis2.inconclusiveHeaders?.length > 0 && (
            <>
              <p style={{ marginTop: '15px', marginBottom: '4px', fontWeight: 600 }}>
                Hlavičky, které se posoudit nepodařilo ({nis2Result.nis2.inconclusiveHeaders.length})
              </p>
              <p style={{ margin: '0 0 8px 0', fontSize: '14px', color: '#475569' }}>
                Tyhle hlavičky nejsou splněné ani porušené. Typicky jde
                o web běžící po http://, kde je prohlížeč ignoruje — jejich
                absence tam není volbou provozovatele.
              </p>
              <ul style={{ paddingLeft: '20px' }}>
                {nis2Result.nis2.inconclusiveHeaders.map((h) => (
                  <li key={h} style={{ fontSize: '14px', color: '#475569' }}>{h}</li>
                ))}
              </ul>
            </>
          )}

          {/* Vymezení rozsahu. Agent v něm výslovně říká, že nejde
              o posouzení shody s NIS2 jako celkem — bez toho by nadpis
              sekce a odznak dohromady tvrdily víc, než sken umí. */}
          {nis2Result.nis2.scope && (
            <p style={{ marginTop: '15px', fontSize: '0.8rem', color: '#475569' }}>
              {nis2Result.nis2.scope}
            </p>
          )}
          {nis2Result.pqc.tlsIssues?.length > 0 && (
            <ul>
              {nis2Result.pqc.tlsIssues.map((issue) => <li key={issue}>{issue}</li>)}
            </ul>
          )}
          {nis2Result.pqc.tlsNotes?.length > 0 && (
            <ul>
              {nis2Result.pqc.tlsNotes.map((note) => <li key={note}>{note}</li>)}
            </ul>
          )}
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
              {/* Zdroj důkazu patří do reportu — bez něj se nedá posoudit,
                  jak spolehlivá která položka je. */}
              <tr><th style={{ width: '35%' }}>Název</th><th>Typ</th><th>Verze</th><th>Zdroj</th></tr>
            </thead>
            <tbody>
              {craResult.sbom.map((lib, i) => (
                <tr key={i}>
                  <td><strong>{lib.name}</strong></td>
                  <td>{lib.type}</td>
                  <td>{lib.version || 'neznámá'}</td>
                  <td>{(lib.sources || []).join(', ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {craResult.evidence && (
            <p style={{ fontSize: '0.8rem' }}>
              Prohledáno {craResult.evidence.scriptsScanned} skriptů
              {craResult.evidence.sourceMapPackages > 0
                && `, ze source map ${craResult.evidence.sourceMapPackages} balíčků`}
              {craResult.evidence.scriptsUnreadable > 0
                && `, ${craResult.evidence.scriptsUnreadable} skriptů se nepodařilo přečíst`}.
            </p>
          )}
          {craResult.scope && <p style={{ fontSize: '0.8rem' }}>{craResult.scope}</p>}
        </div>
      )}

      {/* GDPR Cookie Result */}
      {cookieResult && (
        <div className="print-section">
          <h3>GDPR Cookie Auditor</h3>
          {/* Taky trojstav: `null` je falsy, takže neprůkazný výsledek
              dostával červený odznak „nesplněno". Zbytek dokumentu
              `complianceBadgeClass` používá — tady se na to zapomnělo. */}
          <div className={`print-badge ${complianceBadgeClass(cookieResult.gdpr.isCompliant)}`}>
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
                  {/* Neznámá závažnost se pojmenuje, nedomýšlí.
                      Dřív se při chybějícím poli doplňovalo „HIGH", takže
                      dokument pro úřad uváděl údaj, který nikdo neměřil. */}
                  <div style={{ fontWeight: 'bold', color: v.severity ? '#ef4444' : '#94a3b8' }}>
                    {v.cve} ({v.severity || 'závažnost neuvedena'})
                  </div>
                  <div style={{ fontSize: '14px', color: '#475569' }}>Zasažená knihovna: {v.library} {v.version}</div>
                  <div style={{ fontSize: '12px', color: '#64748b', marginTop: '4px' }}>{v.details}</div>
                </div>
              ))}
            </div>
          )}

          {/* Komponenty, které se ověřit nepodařilo.
              Dosud se netiskly nikde — ani v PDF, ani na obrazovce —
              takže z dokumentu nešlo poznat, že se část soupisu vůbec
              neprověřila. Zůstal z toho jen počet ve větě verdiktu. */}
          {craVulnResult.cra.skipped?.length > 0 && (
            <>
              <p style={{ marginTop: '15px', marginBottom: '4px', fontWeight: 600 }}>
                Neověřené komponenty ({craVulnResult.cra.skipped.length})
              </p>
              <p style={{ margin: '0 0 8px 0', fontSize: '14px', color: '#475569' }}>
                U těchto komponent se dotaz na známé zranitelnosti nepodařilo
                provést. Neznamená to, že jsou v pořádku.
              </p>
              <ul style={{ paddingLeft: '20px' }}>
                {craVulnResult.cra.skipped.map((s, i) => (
                  <li key={i} style={{ marginBottom: '4px', fontSize: '14px' }}>
                    <strong>{s.library}</strong> — {s.reason}
                  </li>
                ))}
              </ul>
            </>
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
