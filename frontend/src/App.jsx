import React, { useState, useEffect, useRef } from 'react';
import { 
  Play, 
  Settings as SettingsIcon, 
  HelpCircle, 
  Terminal, 
  Globe, 
  CheckCircle, 
  AlertTriangle, 
  FileText, 
  Layers, 
  RefreshCw, 
  ArrowRight, 
  Database, 
  Code as CodeIcon, 
  Link as LinkIcon, 
  Image as ImageIcon,
  Check,
  AlertCircle
} from 'lucide-react';

export default function App() {
  const [activeTab, setActiveTab] = useState('agent'); // 'agent', 'compare', 'audit', 'settings'
  const [sessions, setSessions] = useState([]);
  const [selectedSessionId, setSelectedSessionId] = useState(null);
  const [activeSession, setActiveSession] = useState(null);
  
  // Settings State
  const [aiProvider, setAiProvider] = useState('ollama'); // 'ollama' or 'apfel'
  const [ollamaHost, setOllamaHost] = useState('http://localhost:11434');
  const [ollamaModel, setOllamaModel] = useState('llama3');
  const [headless, setHeadless] = useState(true);
  const [maxSteps, setMaxSteps] = useState(10);
  
  // Agent Run Form
  const [agentUrl, setAgentUrl] = useState('https://news.ycombinator.com');
  const [testLogin, setTestLogin] = useState('');
  const [testPassword, setTestPassword] = useState('');
  const [agentGoal, setAgentGoal] = useState('Najdi jakékoliv chyby, zkus kliknout na "new" a vyhledej vyhledávací pole');
  const [testMode, setTestMode] = useState('ai'); // 'ai' or 'monkey'
  const [isRunning, setIsRunning] = useState(false);
  const [liveLogs, setLiveLogs] = useState([]);
  const [liveProgress, setLiveProgress] = useState('');
  const [selectedStepIndex, setSelectedStepIndex] = useState(null);
  
  // Compare Form
  const [compareUrl1, setCompareUrl1] = useState('https://news.ycombinator.com');
  const [compareUrl2, setCompareUrl2] = useState('https://news.ycombinator.com/news');
  const [compareLoading, setCompareLoading] = useState(false);
  const [compareResult, setCompareResult] = useState(null);
  
  // Audit Form
  const [auditUrl, setAuditUrl] = useState('https://news.ycombinator.com');
  const [sourceType, setSourceType] = useState('file'); // 'file', 'api', 'postgres', 'mysql', 'sqlite', 'script'
  const [fileContent, setFileContent] = useState('{\n  "hn.title": "Hacker News",\n  "hn.new": "new",\n  "hn.past": "past"\n}');
  const [apiUrl, setApiUrl] = useState('http://localhost:3001/api/mock-translations');
  const [apiHeaders, setApiHeaders] = useState('{"Authorization": "Bearer sample-token"}');
  const [dbHost, setDbHost] = useState('localhost');
  const [dbPort, setDbPort] = useState('5432');
  const [dbUser, setDbUser] = useState('postgres');
  const [dbPassword, setDbPassword] = useState('');
  const [dbName, setDbName] = useState('my_translations_db');
  const [dbQuery, setDbQuery] = useState('SELECT key_name as key, translation_value as value FROM locales WHERE lang = \'cs\'');
  const [sqlitePath, setSqlitePath] = useState('./locales.sqlite');
  const [scriptName, setScriptName] = useState('get-translations');
  
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditResult, setAuditResult] = useState(null);
  const [auditError, setAuditError] = useState(null);
  
  // Active screenshot view tab
  const [inspectTab, setInspectTab] = useState('console'); // 'console', 'bugs'

  const wsRef = useRef(null);
  const logsEndRef = useRef(null);

  // Load past sessions
  const fetchSessions = async () => {
    try {
      const res = await fetch('/api/sessions');
      if (res.ok) {
        const data = await res.json();
        // ⚡ Bolt: Prevent unnecessary re-renders when data is identical
        setSessions(prev => {
          if (JSON.stringify(prev) === JSON.stringify(data)) {
            return prev; // Return exact same reference to skip render
          }
          return data;
        });
      }
    } catch (e) {
      console.error('Nepodařilo se stáhnout relace:', e);
    }
  };

  useEffect(() => {
    fetchSessions();
    const interval = setInterval(fetchSessions, 5000);
    return () => clearInterval(interval);
  }, []);

  // Fetch full details when selecting a session
  useEffect(() => {
    if (selectedSessionId) {
      fetch(`/api/sessions/${selectedSessionId}`)
        .then(res => res.json())
        .then(data => {
          setActiveSession(data);
          setLiveLogs(data.steps || []);
          setSelectedStepIndex(null);
          if (data.status !== 'running') {
            setIsRunning(false);
          }
        })
        .catch(console.error);
    }
  }, [selectedSessionId]);

  // Scroll to bottom of steps log list
  useEffect(() => {
    if (logsEndRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [liveLogs]);

  // Connect to WS for live logs during active runs
  const connectWebSocket = (sessionId) => {
    if (wsRef.current) wsRef.current.close();

    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const wsUrl = `${protocol}://${window.location.host}/ws?sessionId=${sessionId}`;
    
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type === 'progress') {
        setLiveProgress(msg.message);
      } else if (msg.type === 'step') {
        setLiveLogs((prev) => [...prev, msg.step]);
        setLiveProgress(`Krok ${msg.step.step} dokončen.`);
      } else if (msg.type === 'completed') {
        setIsRunning(false);
        setLiveProgress('Test byl úspěšně dokončen.');
        fetchSessions();
        setSelectedSessionId(sessionId); // trigger reload
      } else if (msg.type === 'failed') {
        setIsRunning(false);
        setLiveProgress(`Test selhal: ${msg.error}`);
        fetchSessions();
        setSelectedSessionId(sessionId); // trigger reload
      }
    };

    ws.onclose = () => {
      console.log('WS connection closed.');
    };
  };

  // 1. Run Test
  const handleRunTest = async (e) => {
    e.preventDefault();
    if (isRunning) return;

    setIsRunning(true);
    setLiveLogs([]);
    setSelectedStepIndex(null);
    setLiveProgress('Inicializace Playwright prohlížeče a agenta...');
    setActiveSession(null);

    try {
      const res = await fetch('/api/run-test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: agentUrl,
          goal: testMode === 'monkey' 
            ? 'Průzkumné testování bez zadání (Monkey Mode - bez AI)' 
            : (testMode === 'smoke_test' ? 'Automatický 3-fázový Smoke Test (AI řízené)' : (testMode === 'smart_monkey' ? 'Chytrý průzkumný test s AI (Smart Monkey)' : agentGoal)),
          model: ollamaModel,
          host: ollamaHost,
          headless,
          maxSteps,
          mode: testMode,
          provider: aiProvider,
          testLogin,
          testPassword
        })
      });

      if (!res.ok) {
        throw new Error(await res.text());
      }

      const data = await res.json();
      setSelectedSessionId(data.sessionId);
      connectWebSocket(data.sessionId);

    } catch (err) {
      setIsRunning(false);
      setLiveProgress(`Chyba spuštění: ${err.message}`);
    }
  };

  const handleExportJson = () => {
    if (!activeSession) return;
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(activeSession, null, 2));
    const downloadAnchorNode = document.createElement('a');
    downloadAnchorNode.setAttribute("href", dataStr);
    downloadAnchorNode.setAttribute("download", `auratest-export-${activeSession.id}.json`);
    document.body.appendChild(downloadAnchorNode);
    downloadAnchorNode.click();
    downloadAnchorNode.remove();
  };

  // 2. Run Compare (Prod vs Preview Diff)
  const handleCompare = async (e) => {
    e.preventDefault();
    if (compareLoading) return;
    setCompareLoading(true);
    setCompareResult(null);

    try {
      const res = await fetch('/api/compare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url1: compareUrl1,
          url2: compareUrl2
        })
      });

      if (!res.ok) throw new Error(await res.text());

      const data = await res.json();
      setCompareResult(data);
    } catch (err) {
      alert(`Porovnání selhalo: ${err.message}`);
    } finally {
      setCompareLoading(false);
    }
  };

  // 3. Run Translation Audit
  const handleAuditTranslations = async (e) => {
    e.preventDefault();
    if (auditLoading) return;
    setAuditLoading(true);
    setAuditResult(null);
    setAuditError(null);

    // Prepare translation source object
    const translationSource = { type: sourceType };
    if (sourceType === 'file') {
      translationSource.fileContent = fileContent;
    } else if (sourceType === 'api') {
      translationSource.apiUrl = apiUrl;
      translationSource.apiHeaders = apiHeaders;
    } else if (sourceType === 'postgres' || sourceType === 'mysql') {
      translationSource.dbHost = dbHost;
      translationSource.dbPort = dbPort;
      translationSource.dbUser = dbUser;
      translationSource.dbPassword = dbPassword;
      translationSource.dbName = dbName;
      translationSource.dbQuery = dbQuery;
    } else if (sourceType === 'sqlite') {
      translationSource.sqlitePath = sqlitePath;
      translationSource.dbQuery = dbQuery;
    } else if (sourceType === 'script') {
      translationSource.scriptName = scriptName;
    }

    try {
      const res = await fetch('/api/audit-translations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: auditUrl,
          translationSource,
          model: ollamaModel,
          host: ollamaHost,
          provider: aiProvider
        })
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Neznámá chyba serveru');
      }

      setAuditResult(data);
    } catch (err) {
      setAuditError(err.message);
    } finally {
      setAuditLoading(false);
    }
  };

  // Helper to extract clean domain name from URL
  const getDomain = (urlStr) => {
    try {
      return new URL(urlStr).hostname;
    } catch {
      return urlStr;
    }
  };

  const targetStepIndex = selectedStepIndex !== null ? selectedStepIndex : (liveLogs.length > 0 ? liveLogs.length - 1 : null);
  const activeStep = targetStepIndex !== null ? liveLogs[targetStepIndex] : null;
  const activeScreenshot = activeStep ? activeStep.screenshot : null;
  const activeLogs = activeStep && activeStep.logs ? activeStep.logs : [];
  const activeBugs = activeStep && activeStep.bugs ? activeStep.bugs : (activeSession?.bugs || []);

  return (
    <div className="app-container">
      {/* Sidebar navigation */}
      <aside className="sidebar">
        <div className="logo-section">
          <div className="logo-icon">
            <Layers size={18} color="white" />
          </div>
          <span className="logo-text">AuraTest AI</span>
        </div>

        <nav className="nav-menu">
          <button 
            className={`nav-item ${activeTab === 'agent' ? 'active' : ''}`}
            onClick={() => { setActiveTab('agent'); }}
          >
            <Play size={16} />
            <span>AI QA Agent</span>
          </button>
          <button 
            className={`nav-item ${activeTab === 'compare' ? 'active' : ''}`}
            onClick={() => { setActiveTab('compare'); }}
          >
            <RefreshCw size={16} />
            <span>Srovnávač Diff</span>
          </button>
          <button 
            className={`nav-item ${activeTab === 'audit' ? 'active' : ''}`}
            onClick={() => { setActiveTab('audit'); }}
          >
            <Globe size={16} />
            <span>Audit Překladů</span>
          </button>
          <button 
            className={`nav-item ${activeTab === 'settings' ? 'active' : ''}`}
            onClick={() => { setActiveTab('settings'); }}
          >
            <SettingsIcon size={16} />
            <span>Nastavení</span>
          </button>
        </nav>

        <div className="sidebar-divider" />
        <span className="sidebar-section-title">Historie testů</span>
        
        <div className="history-list">
          {sessions.length === 0 ? (
            <div style={{ color: 'var(--text-dark)', fontSize: '0.75rem', padding: '8px' }}>
              Žádné předchozí testy.
            </div>
          ) : (
            sessions.map((s) => (
              <div 
                key={s.id} 
                className={`history-item ${selectedSessionId === s.id ? 'active' : ''}`}
                onClick={() => { setSelectedSessionId(s.id); setActiveTab('agent'); }}
                style={selectedSessionId === s.id ? { borderColor: 'var(--accent)' } : {}}
              >
                <div className="history-item-header">
                  <span className="history-url">{getDomain(s.url)}</span>
                  {s.bugsCount > 0 && <span className="history-bugs">{s.bugsCount}x 🐛</span>}
                </div>
                <div className="history-goal">{s.goal}</div>
              </div>
            ))
          )}
        </div>
      </aside>

      {/* Main Workspace Workspace */}
      <main className="workspace">
        <header className="workspace-header">
          <div>
            <h2 style={{ fontSize: '1.25rem' }}>
              {activeTab === 'agent' && 'Autonomní AI QA Agent'}
              {activeTab === 'compare' && 'Porovnávání stránek (Prod vs Preview)'}
              {activeTab === 'audit' && 'Audit překladů a lokalizace'}
              {activeTab === 'settings' && 'Globální nastavení'}
            </h2>
            <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
              {activeTab === 'agent' && 'Agent provádí akce jako člověk a hledá chyby za běhu'}
              {activeTab === 'compare' && 'Porovnává textový a vizuální obsah mezi dvěma verzemi webu'}
              {activeTab === 'audit' && 'Kontrola překladů na webu proti databázi nebo nadefinovanému slovníku'}
              {activeTab === 'settings' && 'Konfigurace lokální Ollama instance a výchozí nastavení prohlížeče'}
            </p>
          </div>

          <div className="status-badge">
            <span className={`status-dot ${isRunning ? 'active' : 'idle'}`} />
            <span>{isRunning ? 'Agent běží...' : 'Připraven'}</span>
          </div>
        </header>

        {/* Tab panels */}
        <div className="tab-content">
          {/* Tab 1: QA Agent Runner */}
          {activeTab === 'agent' && (
            <div className="runner-layout">
              {/* Left Column: Form and Logs */}
              <div className="runner-left">
                {!isRunning && !activeSession && (
                  <form className="card" onSubmit={handleRunTest}>
                    <h3 className="card-title"><Play size={16} color="var(--accent)" /> Spustit nový test</h3>
                    
                    <div className="form-group-row">
                      <div className="form-group" style={{ flexGrow: 2 }}>
                        <label htmlFor="url">Cílová URL stránky</label>
                        <input 
                          type="text" 
                          id="url"
                          value={agentUrl}
                          onChange={(e) => setAgentUrl(e.target.value)}
                          placeholder="https://example.com"
                          required
                        />
                      </div>
                      
                      <div className="form-group">
                        <label htmlFor="testMode">Režim testování</label>
                        <select 
                          id="testMode" 
                          value={testMode}
                          onChange={(e) => setTestMode(e.target.value)}
                        >
                          <option value="ai">Cílený (AI Agent)</option>
                          <option value="crawler">Spider (Prohledat web s AI)</option>
                          <option value="smart_monkey">Chytrý průzkum s AI (Smart Monkey)</option>
                          <option value="smoke_test">Automatický Smoke Test</option>
                          <option value="monkey">Náhodný (Monkey Test bez AI)</option>
                        </select>
                      </div>
                    </div>

                    <div className="form-group-row" style={{ marginTop: '-8px' }}>
                      <div className="form-group">
                        <label htmlFor="testLogin">Testovací účet (E-mail / Login)</label>
                        <input 
                          type="text" 
                          id="testLogin"
                          value={testLogin}
                          onChange={(e) => setTestLogin(e.target.value)}
                          placeholder="Volitelné: admin@example.com"
                        />
                      </div>
                      <div className="form-group">
                        <label htmlFor="testPassword">Testovací heslo</label>
                        <input 
                          type="text" 
                          id="testPassword"
                          value={testPassword}
                          onChange={(e) => setTestPassword(e.target.value)}
                          placeholder="Volitelné: heslo123"
                        />
                      </div>
                    </div>

                    <div className="form-group">
                      <label htmlFor="goal">Cíl testování (Zadání pro AI)</label>
                      <textarea 
                        id="goal"
                        value={
                          testMode === 'monkey' 
                            ? 'Automatické průzkumné procházení (Monkey Mode) - AI není aktivní.' 
                            : (testMode === 'smoke_test' ? 'Automatický 3-fázový Smoke Test (Veřejná část -> Přihlášení -> Zabezpečená část). AI si aplikaci prozkoumá samo.' : (testMode === 'smart_monkey' ? 'Chytré autonomní testování (Smart Monkey) - AI prochází a hledá chyby.' : agentGoal))
                        }
                        onChange={(e) => setAgentGoal(e.target.value)}
                        placeholder="Např. Otestuj registrační formulář s neplatným e-mailem a ověř, zda se zobrazí červené chybové hlášení."
                        disabled={testMode === 'monkey' || testMode === 'smart_monkey' || testMode === 'smoke_test'}
                        required={testMode === 'ai'}
                      />
                    </div>

                    <button className="btn" type="submit">
                      Spustit Agentní Test <ArrowRight size={16} />
                    </button>
                  </form>
                )}

                {(isRunning || activeSession) && (
                  <div className="logs-container">
                    <div className="logs-header">
                      <span>Průběh testu</span>
                      <span style={{ fontSize: '0.75rem', color: 'var(--accent)' }}>
                        {liveProgress}
                      </span>
                    </div>

                    <div className="logs-list">
                      {liveLogs.map((step, index) => (
                        <div 
                          key={step.step} 
                          className="step-card" 
                          style={selectedStepIndex === index ? { borderColor: 'var(--accent)', backgroundColor: 'var(--bg-secondary)' } : { cursor: 'pointer' }}
                          onClick={() => setSelectedStepIndex(index)}
                        >
                          <div className="step-header">
                            <span>Krok {step.step}</span>
                            <span className="step-action-badge">{step.action}</span>
                          </div>
                          <div className="step-reasoning">
                            <strong>Úvaha:</strong> {step.reasoning}
                          </div>
                          {step.target && (
                            <div className="step-detail">
                              Prvek [QA-ID: {step.target}] {step.value ? `s hodnotou "${step.value}"` : ''}
                            </div>
                          )}
                        </div>
                      ))}
                      <div ref={logsEndRef} />
                    </div>

                    {activeSession && activeSession.status === 'completed' && (
                      <div className="completion-summary-card">
                        <div className="completion-header">
                          <div className="completion-icon">
                            {activeSession.bugs && activeSession.bugs.length > 0 ? '⚠️' : '✅'}
                          </div>
                          <div>
                            <h3 className="completion-title">Test dokončen</h3>
                            <p className="completion-subtitle">{activeSession.summary}</p>
                          </div>
                        </div>

                        {activeSession.performanceMetrics && (
                          <div style={{ display: 'flex', gap: '8px', margin: '12px 0', fontSize: '0.85rem' }}>
                            <div style={{ flex: 1, backgroundColor: 'var(--bg-primary)', padding: '8px', borderRadius: '4px', textAlign: 'center' }}>
                              <div style={{ opacity: 0.7, fontSize: '0.7rem', textTransform: 'uppercase' }}>Načtení stránky</div>
                              <div style={{ fontWeight: 'bold', color: activeSession.performanceMetrics.loadTimeMs < 2000 ? 'var(--text-success)' : 'var(--text-warning)' }}>
                                {activeSession.performanceMetrics.loadTimeMs ? `${activeSession.performanceMetrics.loadTimeMs} ms` : 'N/A'}
                              </div>
                            </div>
                            <div style={{ flex: 1, backgroundColor: 'var(--bg-primary)', padding: '8px', borderRadius: '4px', textAlign: 'center' }}>
                              <div style={{ opacity: 0.7, fontSize: '0.7rem', textTransform: 'uppercase' }}>Základní SEO (Title)</div>
                              <div style={{ fontWeight: 'bold' }}>
                                {activeSession.performanceMetrics.title ? '✅ OK' : '❌ Chybí'}
                              </div>
                            </div>
                          </div>
                        )}

                        {activeSession.videoUrl && (
                          <div style={{ marginTop: '16px', borderRadius: '8px', overflow: 'hidden', border: '1px solid var(--border-color)', backgroundColor: '#000' }}>
                            <div style={{ padding: '6px 12px', fontSize: '0.75rem', backgroundColor: 'var(--bg-secondary)', borderBottom: '1px solid var(--border-color)', color: 'var(--text-secondary)' }}>Záznam testu</div>
                            <video 
                              controls 
                              src={`http://localhost:3001${activeSession.videoUrl}`}
                              style={{ width: '100%', display: 'block', maxHeight: '400px' }}
                            />
                          </div>
                        )}

                        {activeSession.bugs && activeSession.bugs.length > 0 ? (
                          <div className="bugs-container">
                            <h4 className="bugs-title">Detekované problémy ({activeSession.bugs.length})</h4>
                            <div className="bugs-list">
                              {activeSession.bugs.map((b, idx) => {
                                const isNetworkError = b.includes('síťový');
                                const isConsoleError = b.includes('konzoli');
                                const icon = isNetworkError ? '🌐' : (isConsoleError ? '💻' : '🐛');
                                const truncatedText = b.length > 200 ? b.substring(0, 200) + '... [text byl zkrácen pro přehlednost]' : b;
                                
                                return (
                                  <div key={idx} className="bug-item">
                                    <div className="bug-icon">{icon}</div>
                                    <div className="bug-text">{truncatedText}</div>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        ) : (
                          <div className="success-banner">
                            🎉 Nebyly nalezeny žádné chyby! Aplikace vypadá stabilně.
                          </div>
                        )}
                        
                        {activeSession.generatedScript && (
                          <div style={{ marginTop: '16px' }}>
                            <h4 style={{ fontSize: '0.9rem', marginBottom: '8px' }}>Vygenerovaný Playwright Skript</h4>
                            <div style={{ backgroundColor: '#1e1e1e', padding: '12px', borderRadius: '6px', maxHeight: '200px', overflowY: 'auto' }}>
                              <pre style={{ margin: 0, fontSize: '0.75rem', fontFamily: 'monospace', color: '#d4d4d4', whiteSpace: 'pre-wrap' }}>
                                {activeSession.generatedScript}
                              </pre>
                            </div>
                          </div>
                        )}
                        <div style={{ display: 'flex', gap: '8px', marginTop: '16px' }}>
                          <button className="btn btn-secondary" style={{ flex: 1 }} onClick={handleExportJson}>
                            💾 Export (JSON)
                          </button>
                          <button className="btn btn-primary" style={{ flex: 1 }} onClick={() => {
                             setActiveSession(null);
                             setSelectedStepIndex(null);
                          }}>
                            Spustit nový test
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Right Column: Visualizer & Dev Inspector */}
              <div className="runner-right">
                <div className="live-stream-card">
                  <div className="stream-title">Živý náhled prohlížeče</div>
                  <div className="screenshot-viewport">
                    {activeScreenshot ? (
                      <img src={activeScreenshot} alt="Vizuální náhled testu" className="screenshot-image" />
                    ) : (
                      <div className="no-screenshot">
                        <ImageIcon size={48} style={{ marginBottom: '12px', opacity: 0.3 }} />
                        <p>Čekání na pořízení prvního screenshotu...</p>
                      </div>
                    )}
                  </div>

                  <div style={{ marginTop: '16px' }}>
                    <div className="inspect-tabs">
                      <div 
                        className={`inspect-tab ${inspectTab === 'console' ? 'active' : ''}`}
                        onClick={() => setInspectTab('console')}
                      >
                        Konzole
                      </div>
                      <div 
                        className={`inspect-tab ${inspectTab === 'bugs' ? 'active' : ''}`}
                        onClick={() => setInspectTab('bugs')}
                      >
                        Log chyb
                      </div>
                    </div>

                    <div style={{ height: '150px', overflowY: 'auto', backgroundColor: 'var(--bg-primary)', borderRadius: '6px', padding: '8px' }}>
                      {inspectTab === 'console' && (
                        <div>
                          {activeLogs.length > 0 ? (
                            activeLogs.map((log, idx) => (
                              <div key={idx} className={`inspect-console-item ${log.type === 'error' ? 'error' : ''}`} style={{ fontSize: '0.8rem', padding: '4px', borderBottom: '1px solid #333' }}>
                                <span style={{ opacity: 0.5 }}>[{new Date(log.timestamp).toLocaleTimeString()}]</span> <strong>{log.type.toUpperCase()}:</strong> {log.text}
                              </div>
                            ))
                          ) : (
                            <div style={{ color: 'var(--text-dark)', fontSize: '0.75rem' }}>Žádné výpisy v konzoli pro tento krok.</div>
                          )}
                        </div>
                      )}

                      {inspectTab === 'bugs' && (
                        <div>
                          {activeBugs.length > 0 ? (
                            activeBugs.map((b, idx) => (
                              <div key={idx} className="inspect-console-item error" style={{ fontSize: '0.8rem', padding: '4px', borderBottom: '1px solid #333' }}>
                                🐛 {b}
                              </div>
                            ))
                          ) : (
                            <div style={{ color: 'var(--text-dark)', fontSize: '0.75rem' }}>Zatím nebyly zachyceny žádné chyby.</div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Tab 2: Compare Tool */}
          {activeTab === 'compare' && (
            <div className="diff-layout">
              <form className="card" onSubmit={handleCompare}>
                <h3 className="card-title"><RefreshCw size={16} /> Porovnat dvě verze stránek</h3>
                
                <div className="form-group-row">
                  <div className="form-group">
                    <label htmlFor="compUrl1">Zdrojová URL (Např. Produkce)</label>
                    <input 
                      type="text" 
                      id="compUrl1" 
                      value={compareUrl1} 
                      onChange={(e) => setCompareUrl1(e.target.value)}
                      required
                    />
                  </div>
                  <div className="form-group">
                    <label htmlFor="compUrl2">Cílová URL (Např. Preview / Dev)</label>
                    <input 
                      type="text" 
                      id="compUrl2" 
                      value={compareUrl2} 
                      onChange={(e) => setCompareUrl2(e.target.value)}
                      required
                    />
                  </div>
                </div>

                <button className="btn" type="submit" disabled={compareLoading}>
                  {compareLoading ? 'Porovnávám...' : 'Spustit porovnání (Diff)'}
                </button>
              </form>

              {compareResult && (
                <div className="card">
                  <h3 className="card-title"><FileText size={16} /> Výsledky porovnání</h3>

                  <div className="diff-sides">
                    <div className="diff-image-card">
                      <div className="diff-image-title">Produkční verze</div>
                      <div className="screenshot-viewport" style={{ height: '250px' }}>
                        <img src={compareResult.screenshot1} className="screenshot-image" alt="Web 1" />
                      </div>
                    </div>
                    <div className="diff-image-card">
                      <div className="diff-image-title">Preview/Vývojová verze</div>
                      <div className="screenshot-viewport" style={{ height: '250px' }}>
                        <img src={compareResult.screenshot2} className="screenshot-image" alt="Web 2" />
                      </div>
                    </div>
                  </div>

                  <div className="diff-list">
                    <h4 style={{ marginTop: '16px', fontSize: '1rem' }}>Změny v textovém obsahu:</h4>
                    {compareResult.diffs.length === 0 ? (
                      <div style={{ color: 'var(--success)', fontSize: '0.9rem', marginTop: '10px' }}>
                        Stránky jsou textově naprosto identické!
                      </div>
                    ) : (
                      compareResult.diffs.map((d, idx) => (
                        <div key={idx} className={`diff-item ${d.type}`}>
                          <span className={`diff-type-badge ${d.type}`}>
                            {d.type === 'modified' && 'Změněno'}
                            {d.type === 'added' && 'Přidáno'}
                            {d.type === 'removed' && 'Smazáno'}
                          </span>
                          <div className="diff-selector">Selector: {d.selector} ({d.tagName})</div>
                          
                          <div className="diff-content">
                            {d.type === 'removed' && (
                              <span className="diff-old">{d.oldText}</span>
                            )}
                            {d.type === 'added' && (
                              <span className="diff-new">{d.newText}</span>
                            )}
                            {d.type === 'modified' && (
                              <div>
                                <div style={{ marginBottom: '4px', fontSize: '0.8rem', color: 'var(--text-dark)' }}>Původní:</div>
                                <div className="diff-old" style={{ marginBottom: '8px', display: 'inline-block' }}>{d.oldText}</div>
                                <div style={{ marginBottom: '4px', fontSize: '0.8rem', color: 'var(--text-dark)' }}>Nový stav:</div>
                                <div>
                                  {d.wordDiff ? d.wordDiff.map((part, pIdx) => {
                                    if (part.added) return <span key={pIdx} className="diff-new">{part.value}</span>;
                                    if (part.removed) return <span key={pIdx} className="diff-old">{part.value}</span>;
                                    return <span key={pIdx}>{part.value}</span>;
                                  }) : <span className="diff-new">{d.newText}</span>}
                                </div>
                              </div>
                            )}
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Tab 3: Translation Auditor */}
          {activeTab === 'audit' && (
            <div className="diff-layout">
              <form className="card" onSubmit={handleAuditTranslations}>
                <h3 className="card-title"><Globe size={16} /> Audit překladů</h3>

                <div className="form-group-row">
                  <div className="form-group" style={{ flexGrow: 2 }}>
                    <label htmlFor="auditUrl">URL stránky pro kontrolu</label>
                    <input 
                      type="text" 
                      id="auditUrl" 
                      value={auditUrl} 
                      onChange={(e) => setAuditUrl(e.target.value)}
                      required
                    />
                  </div>
                  <div className="form-group">
                    <label htmlFor="sourceType">Zdroj referenčního slovníku</label>
                    <select 
                      id="sourceType" 
                      value={sourceType}
                      onChange={(e) => setSourceType(e.target.value)}
                    >
                      <option value="file">Místní JSON text/soubor</option>
                      <option value="api">Externí API (REST JSON)</option>
                      <option value="postgres">PostgreSQL databáze</option>
                      <option value="mysql">MySQL databáze</option>
                      <option value="sqlite">SQLite databáze</option>
                      <option value="script">Lokální integrační skript</option>
                    </select>
                  </div>
                </div>

                {/* Source type conditional rendering */}
                {sourceType === 'file' && (
                  <div className="form-group">
                    <label htmlFor="fileContent">Referenční JSON data překladů (plochý nebo vnořený objekt)</label>
                    <textarea 
                      id="fileContent"
                      value={fileContent}
                      onChange={(e) => setFileContent(e.target.value)}
                      style={{ fontFamily: 'monospace', fontSize: '0.85rem' }}
                      required
                    />
                  </div>
                )}

                {sourceType === 'api' && (
                  <div className="form-group-row">
                    <div className="form-group">
                      <label htmlFor="apiUrl">URL API (musí vracet JSON slovník)</label>
                      <input type="text" id="apiUrl" value={apiUrl} onChange={(e) => setApiUrl(e.target.value)} required />
                    </div>
                    <div className="form-group">
                      <label htmlFor="apiHeaders">HTTP Hlavičky (JSON formát)</label>
                      <input type="text" id="apiHeaders" value={apiHeaders} onChange={(e) => setApiHeaders(e.target.value)} />
                    </div>
                  </div>
                )}

                {(sourceType === 'postgres' || sourceType === 'mysql') && (
                  <div>
                    <div className="connector-fields">
                      <div className="form-group">
                        <label>Hostitel (Host)</label>
                        <input type="text" value={dbHost} onChange={(e) => setDbHost(e.target.value)} />
                      </div>
                      <div className="form-group">
                        <label>Port</label>
                        <input type="text" value={dbPort} onChange={(e) => setDbPort(e.target.value)} />
                      </div>
                      <div className="form-group">
                        <label>Uživatel</label>
                        <input type="text" value={dbUser} onChange={(e) => setDbUser(e.target.value)} />
                      </div>
                      <div className="form-group">
                        <label>Heslo</label>
                        <input type="password" value={dbPassword} onChange={(e) => setDbPassword(e.target.value)} />
                      </div>
                      <div className="form-group">
                        <label>Název databáze</label>
                        <input type="text" value={dbName} onChange={(e) => setDbName(e.target.value)} />
                      </div>
                    </div>
                    <div className="form-group" style={{ marginTop: '12px' }}>
                      <label>SQL dotaz (Dotaz musí vracet sloupce 'key' a 'value')</label>
                      <input type="text" value={dbQuery} onChange={(e) => setDbQuery(e.target.value)} />
                    </div>
                  </div>
                )}

                {sourceType === 'sqlite' && (
                  <div className="form-group-row">
                    <div className="form-group">
                      <label>Cesta k souboru .sqlite</label>
                      <input type="text" value={sqlitePath} onChange={(e) => setSqlitePath(e.target.value)} required />
                    </div>
                    <div className="form-group">
                      <label>SQL dotaz</label>
                      <input type="text" value={dbQuery} onChange={(e) => setDbQuery(e.target.value)} required />
                    </div>
                  </div>
                )}

                {sourceType === 'script' && (
                  <div className="form-group">
                    <label>Povolený název skriptu (z whitelistu na backendu)</label>
                    <input type="text" value={scriptName} onChange={(e) => setScriptName(e.target.value)} required />
                  </div>
                )}

                <button className="btn" type="submit" disabled={auditLoading}>
                  {auditLoading ? 'Provádím audit...' : 'Spustit lokalizační audit'}
                </button>
              </form>

              {auditError && (
                <div className="floating-alert">
                  <strong>Chyba auditu:</strong> {auditError}
                </div>
              )}

              {auditResult && (
                <div className="card">
                  <h3 className="card-title">
                    <CheckCircle size={16} color="var(--success)" /> 
                    Výsledky lokalizačního auditu (Načteno {auditResult.dictionarySize} klíčů)
                  </h3>

                  <div className="screenshot-viewport" style={{ height: '300px', marginBottom: '24px' }}>
                    <img src={auditResult.screenshot} className="screenshot-image" alt="Audit" />
                  </div>

                  <div className="audit-list">
                    <h4>Nalezené nesrovnalosti a chybějící překlady ({auditResult.issuesCount}x):</h4>
                    {auditResult.issuesCount === 0 ? (
                      <div className="floating-success" style={{ marginTop: '10px' }}>
                        🎉 Všechny viditelné texty na stránce byly úspěšně spárovány s lokalizačním slovníkem!
                      </div>
                    ) : (
                      auditResult.issues.map((r, idx) => (
                        <div key={idx} className={`audit-item ${r.status}`}>
                          <div>
                            <div className="audit-text">Text na webu: "{r.text}"</div>
                            <div className="audit-selector">Cesta: {r.selector}</div>
                            {r.suggestion && <div className="audit-suggestion">💡 <strong>AI doporučení:</strong> {r.suggestion}</div>}
                          </div>
                          <div>
                            <span className={`audit-status ${r.status}`}>
                              {r.status === 'untranslated' && 'Nepřeloženo / Hardcoded'}
                              {r.status === 'typo' && 'Možný překlep'}
                              {r.status === 'matched_fuzzy' && 'Přibližná shoda'}
                            </span>
                            <div style={{ fontSize: '0.7rem', color: 'var(--text-dark)', marginTop: '4px', textAlign: 'right' }}>
                              Klíč: {r.key}
                            </div>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Tab 4: Settings */}
          {activeTab === 'settings' && (
            <div className="card">
              <h3 className="card-title"><SettingsIcon size={16} /> Globální konfigurace</h3>
              
              <div className="form-group">
                <label htmlFor="aiProvider">Poskytovatel lokální AI</label>
                <select 
                  id="aiProvider" 
                  value={aiProvider}
                  onChange={(e) => {
                    const prov = e.target.value;
                    setAiProvider(prov);
                    if (prov === 'apfel') {
                      setOllamaHost('http://127.0.0.1:11434/v1/chat/completions');
                      setOllamaModel('apple-foundationmodel');
                    } else {
                      setOllamaHost('http://localhost:11434');
                      setOllamaModel('llama3');
                    }
                  }}
                >
                  <option value="ollama">Ollama (Lokální modely jako Llama 3, Mistral)</option>
                  <option value="apfel">Apple Intelligence (přes lokální apfel AI server)</option>
                </select>
              </div>

              <div className="form-group">
                <label htmlFor="ollamaHost">URL adresa AI serveru (Endpoint)</label>
                <input 
                  type="text" 
                  id="ollamaHost" 
                  value={ollamaHost} 
                  onChange={(e) => setOllamaHost(e.target.value)} 
                />
              </div>

              <div className="form-group">
                <label htmlFor="ollamaModel">Výchozí model</label>
                <input 
                  type="text" 
                  id="ollamaModel" 
                  value={ollamaModel} 
                  onChange={(e) => setOllamaModel(e.target.value)} 
                />
                <span style={{ fontSize: '0.75rem', color: 'var(--text-dark)' }}>
                  {aiProvider === 'apfel' 
                    ? 'Pro Apple Intelligence ponechte model "apple-foundationmodel". Spusťte server v terminálu příkazem: apfel --serve'
                    : 'Doporučené vision modely: llava, bakllava. Doporučené textové modely: llama3, mistral.'
                  }
                </span>
              </div>

              <div className="form-group-row">
                <div className="form-group">
                  <label htmlFor="maxSteps">Maximální počet kroků agenta</label>
                  <input 
                    type="number" 
                    id="maxSteps" 
                    value={maxSteps} 
                    onChange={(e) => setMaxSteps(parseInt(e.target.value) || 10)} 
                  />
                </div>
                <div className="form-group" style={{ flexDirection: 'row', alignItems: 'center', gap: '8px', paddingTop: '32px' }}>
                  <input 
                    type="checkbox" 
                    id="headless" 
                    checked={headless} 
                    onChange={(e) => setHeadless(e.target.checked)} 
                  />
                  <label htmlFor="headless" style={{ cursor: 'pointer' }}>Spouštět prohlížeč v režimu na pozadí (headless)</label>
                </div>
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
