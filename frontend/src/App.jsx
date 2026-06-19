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
  AlertCircle,
  Sun,
  Moon,
  Video,
  Download,
  PlayCircle,
  Cpu,
  BookOpen,
  Activity
} from 'lucide-react';


export default function App() {
  const [theme, setTheme] = useState(() => {
    if (typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: light)').matches) {
      return 'light';
    }
    return 'dark';
  });

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  const [activeTab, setActiveTab] = useState('agent'); // 'agent', 'compare', 'audit', 'settings'
  const [sessions, setSessions] = useState([]);
  const [selectedSessionId, setSelectedSessionId] = useState(null);
  const [activeSession, setActiveSession] = useState(null);

  // Premium Toast Notification state
  const [toast, setToast] = useState(null);
  const showToast = (message, type = 'info') => {
    setToast({ message, type });
    const timer = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(timer);
  };

  // Request browser Notification permission on mount
  useEffect(() => {
    if (typeof window !== 'undefined' && 'Notification' in window) {
      if (Notification.permission === 'default') {
        Notification.requestPermission();
      }
    }
  }, []);
  
  // Settings State
  const [aiProvider, setAiProvider] = useState('ollama'); // 'ollama' or 'apfel'
  const [ollamaHost, setOllamaHost] = useState('http://localhost:11434');
  const [ollamaModel, setOllamaModel] = useState('auratest-gemma2');
  const [headless, setHeadless] = useState(true);
  const [maxSteps, setMaxSteps] = useState(30);

  // Model training state
  const [datasetInfo, setDatasetInfo] = useState({ totalCount: 0, cleanedCount: 0 });
  const [modelBuilding, setModelBuilding] = useState(false);
  const [modelBuildLog, setModelBuildLog] = useState('');
  
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
  const [compareSteps, setCompareSteps] = useState('');
  const [compareTimeout, setCompareTimeout] = useState(20);



  // Recorder State
  const [recorderUrl, setRecorderUrl] = useState('https://news.ycombinator.com');
  const [recorderActive, setRecorderActive] = useState(false);
  const [recorderLoading, setRecorderLoading] = useState(false);
  const [recordedSteps, setRecordedSteps] = useState([]);

  // Playwright Test Execution State
  const [playwrightRunning, setPlaywrightRunning] = useState(false);
  const [playwrightOutput, setPlaywrightOutput] = useState('');
  const [playwrightSuccess, setPlaywrightSuccess] = useState(null);

  // Poll recorder status periodically when tab is active or recording is on
  useEffect(() => {
    let intervalId;
    const fetchStatus = async () => {
      try {
        const res = await fetch('/api/recorder/status');
        if (res.ok) {
          const data = await res.json();
          setRecorderActive(data.status === 'recording');
          setRecordedSteps(data.steps || []);
        }
      } catch (err) {
        console.error("Chyba při zjišťování stavu rekordéru:", err);
      }
    };

    fetchStatus();
    intervalId = setInterval(fetchStatus, 1500);
    return () => clearInterval(intervalId);
  }, [activeTab, recorderActive]);

  
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
  const [scriptCommand, setScriptCommand] = useState('node get-translations.js');
  
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditResult, setAuditResult] = useState(null);
  const [auditError, setAuditError] = useState(null);
  
  // Active screenshot view tab
  const [inspectTab, setInspectTab] = useState('console'); // 'console', 'bugs'
  const [bugDetails, setBugDetails] = useState([]);

  const wsRef = useRef(null);
  const logsEndRef = useRef(null);
  const stepRefs = useRef({});

  // Load past sessions
  const fetchSessions = async () => {
    try {
      const res = await fetch('/api/sessions');
      if (res.ok) {
        const data = await res.json();
        setSessions(data);
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
        });
    }
  }, [selectedSessionId]);

  // Fetch dataset info when settings tab is active
  const fetchDatasetInfo = async () => {
    try {
      const res = await fetch('/api/dataset/info');
      if (res.ok) {
        const data = await res.json();
        setDatasetInfo(data);
      }
    } catch (err) {
      console.error("Chyba při zjišťování informací o datasetu:", err);
    }
  };

  useEffect(() => {
    if (activeTab === 'settings') {
      fetchDatasetInfo();
    }
  }, [activeTab]);

  const handleBuildModel = async () => {
    setModelBuilding(true);
    setModelBuildLog('Spouštím kompilaci modelu v Ollamě...\n');
    try {
      const res = await fetch('/api/model/build', { method: 'POST' });
      if (!res.ok) throw new Error('Chyba při komunikaci se serverem.');
      const data = await res.json();
      
      let logs = '';
      if (data.stdout) logs += data.stdout;
      if (data.stderr) logs += `\nCHYBY/VAROVÁNÍ:\n` + data.stderr;
      
      setModelBuildLog(logs || 'Model byl úspěšně zaktualizován.');
      if (data.success) {
        showToast('Lokální model Gemma byl úspěšně zkompilován!', 'success');
      } else {
        showToast('Kompilace modelu selhala.', 'error');
      }
    } catch (err) {
      setModelBuildLog(prev => prev + `❌ Chyba: ${err.message}\n`);
      showToast('Nastala chyba při kompilaci lokálního modelu.', 'error');
    } finally {
      setModelBuilding(false);
      fetchDatasetInfo();
    }
  };

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
        if (msg.bugDetails) setBugDetails(msg.bugDetails);
        
        // Show Toast
        const bugCount = msg.bugs ? msg.bugs.length : 0;
        if (bugCount > 0) {
          showToast(`Test dokončen s chybami! Nalezeno chyb: ${bugCount}`, 'error');
        } else {
          showToast('Test byl úspěšně dokončen bez chyb!', 'success');
        }

        // Show Browser Notification
        if (typeof window !== 'undefined' && 'Notification' in window && Notification.permission === 'granted') {
          new Notification('AuraTest AI - Test dokončen', {
            body: bugCount > 0 
              ? `Test byl úspěšně dokončen, ale bylo nalezeno ${bugCount} chyb.`
              : 'Test byl úspěšně dokončen bez chyb!',
            tag: 'auratest-run'
          });
        }

        fetchSessions();
        fetch(`/api/sessions/${sessionId}`)
          .then(res => res.json())
          .then(data => {
            setActiveSession(data);
            setLiveLogs(data.steps || []);
            if (data.bugDetails) setBugDetails(data.bugDetails);
          });
      } else if (msg.type === 'failed') {
        setIsRunning(false);
        setLiveProgress(`Test selhal: ${msg.error}`);
        
        // Show Toast and Browser Notification
        showToast(`Test selhal: ${msg.error}`, 'error');
        if (typeof window !== 'undefined' && 'Notification' in window && Notification.permission === 'granted') {
          new Notification('AuraTest AI - Test selhal', {
            body: `Test selhal s chybou: ${msg.error}`,
            tag: 'auratest-run'
          });
        }

        fetchSessions();
        fetch(`/api/sessions/${sessionId}`)
          .then(res => res.json())
          .then(data => {
            setActiveSession(data);
          });
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
    showToast('Spouštím autonomní testovací proces...', 'info');
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
          url2: compareUrl2,
          steps: compareSteps,
          timeout: compareTimeout
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

  // 2b. Recorder Handlers
  const handleStartRecorder = async (e) => {
    e.preventDefault();
    if (recorderLoading) return;
    setRecorderLoading(true);
    try {
      const res = await fetch('/api/recorder/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: recorderUrl })
      });
      if (!res.ok) {
        const errText = await res.text();
        throw new Error(errText);
      }
      setRecorderActive(true);
      showToast('Nahrávač byl spuštěn. V novém okně proveďte požadované interakce.', 'success');
    } catch (err) {
      alert(`Nepodařilo se spustit nahrávač: ${err.message}`);
    } finally {
      setRecorderLoading(false);
    }
  };

  const handleStopRecorder = async () => {
    if (recorderLoading) return;
    setRecorderLoading(true);
    try {
      const res = await fetch('/api/recorder/stop', {
        method: 'POST'
      });
      if (!res.ok) {
        const errText = await res.text();
        throw new Error(errText);
      }
      const data = await res.json();
      setRecorderActive(false);
      showToast(`Nahrávání dokončeno. Uloženo ${data.stepsCount} kroků do datasetu.`, 'success');
    } catch (err) {
      alert(`Nepodařilo se zastavit nahrávač: ${err.message}`);
    } finally {
      setRecorderLoading(false);
    }
  };

  // 2c. Playwright Test Runner Handlers
  const handleDownloadTest = () => {
    if (!activeSession) return;
    window.open(`/api/sessions/${activeSession.id}/download-test`, '_blank');
  };

  const handleRunPlaywrightTest = async () => {
    if (!activeSession || playwrightRunning) return;
    setPlaywrightRunning(true);
    setPlaywrightOutput('Spouštím Playwright test...\n');
    setPlaywrightSuccess(null);

    try {
      const res = await fetch(`/api/sessions/${activeSession.id}/run-generated-test`, {
        method: 'POST'
      });
      if (!res.ok) {
        const errText = await res.text();
        throw new Error(errText);
      }
      const data = await res.json();
      setPlaywrightSuccess(data.success);
      let output = `Spuštění Playwright dokončeno (kód ukončení: ${data.code}).\n\n`;
      if (data.stdout) {
        output += `--- STDOUT ---\n${data.stdout}\n`;
      }
      if (data.stderr) {
        output += `--- STDERR ---\n${data.stderr}\n`;
      }
      setPlaywrightOutput(output);
      if (data.success) {
        showToast('Playwright test proběhl úspěšně!', 'success');
      } else {
        showToast('Playwright test selhal. Zkontrolujte výstup z konzole.', 'error');
      }
    } catch (err) {
      setPlaywrightOutput(prev => prev + `Chyba při spouštění testu: ${err.message}\n`);
      setPlaywrightSuccess(false);
    } finally {
      setPlaywrightRunning(false);
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
      translationSource.scriptCommand = scriptCommand;
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
      {toast && (
        <div className={`toast-notification ${toast.type}`}>
          <span>{toast.type === 'success' ? '✅' : (toast.type === 'error' ? '❌' : 'ℹ️')}</span>
          <span style={{ fontWeight: '500' }}>{toast.message}</span>
          <button className="toast-close-btn" onClick={() => setToast(null)}>&times;</button>
        </div>
      )}
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
            className={`nav-item ${activeTab === 'recorder' ? 'active' : ''}`}
            onClick={() => { setActiveTab('recorder'); }}
          >
            <Video size={16} />
            <span>Nahrávač dat</span>
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
              {activeTab === 'recorder' && 'Interaktivní Rekordér Trénovacích Dat'}
              {activeTab === 'settings' && 'Globální nastavení'}
            </h2>
            <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
              {activeTab === 'agent' && 'Agent provádí akce jako člověk a hledá chyby za běhu'}
              {activeTab === 'compare' && 'Porovnává textový a vizuální obsah mezi dvěma verzemi webu'}
              {activeTab === 'audit' && 'Kontrola překladů na webu proti databázi nebo nadefinovanému slovníku'}
              {activeTab === 'recorder' && 'Ruční nahrávání scénářů a interakcí pro obohacení trénovacího datasetu'}
              {activeTab === 'settings' && 'Konfigurace lokální Ollama instance a výchozí nastavení prohlížeče'}
            </p>

          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
            <button 
              className="btn btn-secondary" 
              style={{ padding: '8px', borderRadius: '50%', width: '36px', height: '36px' }}
              onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}
              title={`Přepnout na ${theme === 'light' ? 'tmavý' : 'světlý'} režim`}
            >
              {theme === 'light' ? <Moon size={18} /> : <Sun size={18} />}
            </button>
            <div className="status-badge">
              <span className={`status-dot ${isRunning ? 'active' : 'idle'}`} />
              <span>{isRunning ? 'Agent běží...' : 'Připraven'}</span>
            </div>
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
                    <div className="logs-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <div>
                        <span>Průběh testu</span>
                        <span style={{ fontSize: '0.75rem', color: 'var(--accent)', marginLeft: '8px' }}>
                          {liveProgress}
                        </span>
                      </div>
                      {!isRunning && activeSession && (
                        <button 
                          className="btn btn-primary" 
                          style={{ padding: '4px 8px', fontSize: '0.8rem' }}
                          onClick={() => {
                            setActiveSession(null);
                            setSelectedStepIndex(null);
                          }}
                        >
                          + Nový test
                        </button>
                      )}
                    </div>

                    <div className="logs-list">
                      {liveLogs.map((step, index) => (
                        <div 
                          key={step.step} 
                          className="step-card" 
                          ref={el => stepRefs.current[step.step] = el}
                          style={selectedStepIndex === index ? { borderColor: 'var(--accent)', backgroundColor: 'var(--bg-secondary)' } : { cursor: 'pointer' }}
                          onClick={() => setSelectedStepIndex(index)}
                        >
                          <div className="step-header">
                            <span>Krok {step.step}</span>
                            <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                              {step.detectedBugsDetails && step.detectedBugsDetails.length > 0 && (
                                <span style={{ fontSize: '0.7rem', background: 'rgba(239,68,68,0.15)', color: 'var(--error)', padding: '1px 6px', borderRadius: '4px' }}>
                                  🐛 Bug
                                </span>
                              )}
                              <span className="step-action-badge">{step.action}</span>
                            </div>
                          </div>
                          <div className="step-reasoning">
                            <strong>Úvaha:</strong> {step.reasoning}
                          </div>
                          {step.target && (
                            <div className="step-detail">
                              Prvek [QA-ID: {step.target}] {step.value ? `s hodnotou "${step.value}"` : ''}
                            </div>
                          )}
                          {step.url && step.url !== liveLogs[index - 1]?.url && (
                            <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: '4px', opacity: 0.7 }}>
                              📍 {step.url}
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
                          <div style={{ marginTop: '16px', borderRadius: '8px', overflow: 'hidden', border: '1px solid var(--border)', backgroundColor: '#000' }}>
                            <div style={{ padding: '6px 12px', fontSize: '0.75rem', backgroundColor: 'var(--bg-secondary)', borderBottom: '1px solid var(--border)', color: 'var(--text-muted)' }}>Záznam testu</div>
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
                                const truncatedText = b.length > 200 ? b.substring(0, 200) + '...' : b;
                                // Najdi odpovídající bugDetail pro klikatelný link
                                const detail = bugDetails.find(d => d.text === b) || 
                                               (activeSession.bugDetails || []).find(d => d.text === b);
                                
                                return (
                                  <div 
                                    key={idx} 
                                    className="bug-item"
                                    style={detail ? { cursor: 'pointer' } : {}}
                                    onClick={() => {
                                      if (detail) {
                                        const stepEl = stepRefs.current[detail.stepNumber];
                                        if (stepEl) {
                                          stepEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
                                          const stepIndex = liveLogs.findIndex(s => s.step === detail.stepNumber);
                                          if (stepIndex !== -1) setSelectedStepIndex(stepIndex);
                                        }
                                      }
                                    }}
                                    title={detail ? `Klikni pro skok na Krok ${detail.stepNumber}` : ''}
                                  >
                                    <div className="bug-icon">{icon}</div>
                                    <div style={{ flex: 1 }}>
                                      <div className="bug-text">{truncatedText}</div>
                                      {detail && (
                                        <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: '4px', display: 'flex', gap: '8px' }}>
                                          <span>🔢 Krok {detail.stepNumber}</span>
                                          <span style={{ opacity: 0.7 }}>·</span>
                                          <span style={{ opacity: 0.7 }}>{detail.url ? new URL(detail.url).pathname : ''}</span>
                                          {detail ? <span style={{ marginLeft: 'auto', color: 'var(--accent)', fontSize: '0.7rem' }}>↑ Skok na krok</span> : null}
                                        </div>
                                      )}
                                    </div>
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
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                              <h4 style={{ fontSize: '0.9rem', margin: 0 }}>Vygenerovaný Playwright Skript</h4>
                              <div style={{ display: 'flex', gap: '8px' }}>
                                <button 
                                  className="btn btn-secondary" 
                                  style={{ padding: '6px 12px', fontSize: '0.78rem', display: 'flex', alignItems: 'center', gap: '4px' }} 
                                  onClick={handleDownloadTest}
                                >
                                  <Download size={14} /> Stáhnout .spec.ts
                                </button>
                                <button 
                                  className="btn btn-primary" 
                                  style={{ padding: '6px 12px', fontSize: '0.78rem', display: 'flex', alignItems: 'center', gap: '4px' }} 
                                  onClick={handleRunPlaywrightTest}
                                  disabled={playwrightRunning}
                                >
                                  <PlayCircle size={14} /> {playwrightRunning ? 'Spouštím...' : 'Spustit v Playwrightu'}
                                </button>
                              </div>
                            </div>
                            <div className="code-block" style={{ maxHeight: '200px', overflowY: 'auto' }}>
                              <pre>
                                {activeSession.generatedScript}
                              </pre>
                            </div>

                            {(playwrightRunning || playwrightOutput) && (
                              <div style={{ marginTop: '16px' }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                                  <span style={{ fontSize: '0.85rem', fontWeight: '600' }}><Terminal size={14} /> Playwright Konzolový Výstup</span>
                                  {playwrightSuccess !== null && (
                                    <span style={{ 
                                      fontSize: '0.75rem', 
                                      padding: '2px 8px', 
                                      borderRadius: '4px', 
                                      backgroundColor: playwrightSuccess ? 'rgba(76, 175, 80, 0.2)' : 'rgba(244, 67, 54, 0.2)',
                                      color: playwrightSuccess ? 'var(--success)' : 'var(--error)',
                                      fontWeight: 'bold'
                                    }}>
                                      {playwrightSuccess ? 'ÚSPĚCH' : 'CHYBA'}
                                    </span>
                                  )}
                                </div>
                                <div style={{ 
                                  fontFamily: 'monospace', 
                                  fontSize: '0.75rem', 
                                  backgroundColor: '#1E1E1E', 
                                  color: '#D4D4D4', 
                                  padding: '12px', 
                                  borderRadius: '6px', 
                                  maxHeight: '250px', 
                                  overflowY: 'auto',
                                  whiteSpace: 'pre-wrap'
                                }}>
                                  {playwrightOutput}
                                  {playwrightRunning && (
                                    <span style={{ animation: 'pulse-border 1.5s infinite', color: 'var(--accent)' }}>_</span>
                                  )}
                                </div>
                              </div>
                            )}
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
                      <div style={{ position: 'relative', display: 'inline-block', maxWidth: '100%', maxHeight: '100%', aspectRatio: '16 / 9' }}>
                        <img 
                          src={activeScreenshot} 
                          alt="Vizuální náhled testu" 
                          className="screenshot-image" 
                          style={{ width: '100%', height: '100%', display: 'block', objectFit: 'contain' }}
                        />
                        {activeStep && activeStep.rect && (
                          <div 
                            className="element-highlight-box"
                            style={{
                              position: 'absolute',
                              left: `${(activeStep.rect.x / 1280) * 100}%`,
                              top: `${(activeStep.rect.y / 720) * 100}%`,
                              width: `${(activeStep.rect.width / 1280) * 100}%`,
                              height: `${(activeStep.rect.height / 720) * 100}%`
                            }}
                          >
                            <div className="element-highlight-label">
                              {activeStep.action.toUpperCase()} {activeStep.target ? `[ID: ${activeStep.target}]` : ''}
                            </div>
                          </div>
                        )}
                      </div>
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
                              <div key={idx} className={`inspect-console-item ${log.type === 'error' ? 'error' : ''}`} style={{ fontSize: '0.8rem', padding: '4px', borderBottom: '1px solid var(--border)' }}>
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
                              <div key={idx} className="inspect-console-item error" style={{ fontSize: '0.8rem', padding: '4px', borderBottom: '1px solid var(--border)' }}>
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

                <div className="form-group" style={{ marginTop: '16px', marginBottom: '16px' }}>
                  <label htmlFor="compSteps">Interaktivní kroky scénáře (Volitelné, např. pro nákupní proces)</label>
                  <textarea
                    id="compSteps"
                    value={compareSteps}
                    onChange={(e) => setCompareSteps(e.target.value)}
                    placeholder={`type #vehicle-spz 123\nclick button:has-text("Pokračovat")`}
                    rows={4}
                    style={{ 
                      fontFamily: 'monospace', 
                      fontSize: '0.85rem', 
                      padding: '10px', 
                      borderRadius: 'var(--radius-sm)', 
                      border: '1px solid var(--border)', 
                      backgroundColor: 'var(--bg-secondary)', 
                      color: 'var(--text-main)',
                      width: '100%',
                      boxSizing: 'border-box',
                      resize: 'vertical'
                    }}
                  />
                  <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: '4px', display: 'block' }}>
                    Formát: <code>click [selector]</code> nebo <code>type [selector] [hodnota]</code> (jeden krok na řádek, nepovinné).
                  </span>
                </div>

                <button className="btn" type="submit" disabled={compareLoading}>

                  {compareLoading ? 'Porovnávám...' : 'Spustit porovnání (Diff)'}
                </button>
              </form>

              {compareResult && (
                <div className="card">
                  <h3 className="card-title"><FileText size={16} /> Výsledky porovnání</h3>

                  <div className="diff-sides" style={compareResult.visualDiff ? { gridTemplateColumns: '1fr 1fr 1fr' } : {}}>
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
                    {compareResult.visualDiff && (
                      <div className="diff-image-card">
                        <div className="diff-image-title" style={{ color: 'var(--error)' }}>Rozdílový obraz (Pixel Diff)</div>
                        <div className="screenshot-viewport" style={{ height: '250px' }}>
                          <img src={compareResult.visualDiff} className="screenshot-image" alt="Rozdílový obraz" />
                        </div>
                      </div>
                    )}
                  </div>

                  {((compareResult.errors1 && compareResult.errors1.length > 0) || 
                    (compareResult.errors2 && compareResult.errors2.length > 0)) && (
                    <div style={{ marginTop: '20px', borderTop: '1px solid var(--border)', paddingTop: '16px' }}>
                      <h4 style={{ fontSize: '0.95rem', marginBottom: '12px', color: 'var(--error)' }}>
                        ⚠️ Detekované chybové a varovné hlášky:
                      </h4>
                      <div className="diff-sides">
                        <div style={{ backgroundColor: 'var(--bg-tertiary)', padding: '12px', borderRadius: '6px', border: '1px solid var(--border)' }}>
                          <div style={{ fontWeight: 'bold', fontSize: '0.8rem', marginBottom: '8px' }}>Web 1 (Produkce/Dev)</div>
                          {compareResult.errors1 && compareResult.errors1.length > 0 ? (
                            <ul style={{ paddingLeft: '20px', margin: 0, fontSize: '0.85rem' }}>
                              {compareResult.errors1.map((err, idx) => (
                                <li key={idx} style={{ color: 'var(--error)', marginBottom: '4px' }}>{err}</li>
                              ))}
                            </ul>
                          ) : (
                            <span style={{ fontSize: '0.8rem', color: 'var(--success)', fontStyle: 'italic' }}>Nebyly detekovány žádné chyby.</span>
                          )}
                        </div>
                        <div style={{ backgroundColor: 'var(--bg-tertiary)', padding: '12px', borderRadius: '6px', border: '1px solid var(--border)' }}>
                          <div style={{ fontWeight: 'bold', fontSize: '0.8rem', marginBottom: '8px' }}>Web 2 (Preview/Dev)</div>
                          {compareResult.errors2 && compareResult.errors2.length > 0 ? (
                            <ul style={{ paddingLeft: '20px', margin: 0, fontSize: '0.85rem' }}>
                              {compareResult.errors2.map((err, idx) => (
                                <li key={idx} style={{ color: 'var(--error)', marginBottom: '4px' }}>{err}</li>
                              ))}
                            </ul>
                          ) : (
                            <span style={{ fontSize: '0.8rem', color: 'var(--success)', fontStyle: 'italic' }}>Nebyly detekovány žádné chyby.</span>
                          )}
                        </div>
                      </div>
                    </div>
                  )}

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
                    <label>Shell příkaz k provedení (musí vypsat JSON objekt na stdout)</label>
                    <input type="text" value={scriptCommand} onChange={(e) => setScriptCommand(e.target.value)} required />
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
            <>
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
                    } else if (prov === 'copilot') {
                      setOllamaHost('http://localhost:3030/v1/chat/completions');
                      setOllamaModel('default');
                    } else {
                      setOllamaHost('http://localhost:11434');
                      setOllamaModel('llama3');
                    }
                  }}
                >
                  <option value="ollama">Ollama (Lokální modely jako Llama 3, Mistral)</option>
                  <option value="apfel">Apple Intelligence (přes lokální apfel AI server)</option>
                  <option value="copilot">GitHub Copilot (přes lokální API bránu)</option>
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
                <div style={{ display: 'flex', gap: '6px', marginTop: '8px', flexWrap: 'wrap' }}>
                  {[
                    { name: 'auratest-gemma2', label: '🤖 AuraTest 2B', desc: 'Trénovaný na QA', recommended: true },
                    { name: 'phi3:mini', label: 'Phi-3 Mini', desc: 'Microsoft · ~2.3GB RAM' },
                    { name: 'qwen2:1.5b', label: 'Qwen2 1.5B', desc: 'Nejrychlejší · ~900MB' },
                    { name: 'apple-foundationmodel', label: '⌘ Apple AI', desc: 'Apple Intelligence' },
                  ].map(m => (
                    <button
                      key={m.name}
                      type="button"
                      onClick={() => setOllamaModel(m.name)}
                      style={{
                        padding: '4px 10px',
                        borderRadius: '6px',
                        border: `1px solid ${ollamaModel === m.name ? 'var(--accent)' : 'var(--border)'}`,
                        background: ollamaModel === m.name ? 'var(--accent-glow)' : 'var(--bg-tertiary)',
                        color: ollamaModel === m.name ? 'var(--accent)' : 'var(--text-muted)',
                        fontSize: '0.75rem',
                        cursor: 'pointer',
                        transition: 'all 0.15s'
                      }}
                      title={m.desc}
                    >
                      {m.recommended && <span style={{ marginRight: '3px' }}>★</span>}{m.label}
                    </button>
                  ))}
                </div>
                 <span style={{ fontSize: '0.75rem', color: 'var(--text-dark)', marginTop: '6px', display: 'block' }}>
                  {aiProvider === 'apfel' && 'Pro Apple Intelligence ponechte model "apple-foundationmodel". Spusťte server v terminálu příkazem: apfel --serve'}
                  {aiProvider === 'copilot' && 'Pro GitHub Copilot nastavte model na "default". Lokální API brána (např. běžící na portu 3030) automaticky přesměruje dotazy na nejlepší dostupný model z vašeho předplatného.'}
                  {aiProvider === 'ollama' && '⭐ auratest-gemma2 = gemma2:2b speciálně natrénovaný pro QA testování. Vytvořen příkazem: ollama create auratest-gemma2 -f auratest-gemma2.Modelfile'}
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

              <div className="form-group-row" style={{ marginTop: '16px' }}>
                <div className="form-group">
                  <label htmlFor="compareTimeout">Základní časový limit srovnávání (v sekundách)</label>
                  <input 
                    type="number" 
                    id="compareTimeout" 
                    value={compareTimeout} 
                    onChange={(e) => setCompareTimeout(parseInt(e.target.value) || 5)} 
                  />
                  <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: '4px' }}>
                    Výchozí: 20s. Limit se navíc automaticky prodlužuje o 1 sekundu na každý nahraný krok scénáře.
                  </span>
                </div>
              </div>
            </div>

            <div className="card" style={{ marginTop: '20px' }}>
              <h3 className="card-title"><Cpu size={16} /> Trénink & Aktualizace lokálního modelu (Gemma)</h3>
              <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '16px' }}>
                Lokální QA agenta lze přizpůsobit a doučit dvěma způsoby: Rychlým automatickým vytvořením Modelfilu s nahranými few-shot scénáři, nebo plným doladěním vah (Fine-Tuning) pomocí LoRA.
              </p>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px', marginTop: '16px' }}>
                
                {/* Left Column: Fast compiler */}
                <div style={{ borderRight: '1px solid var(--border)', paddingRight: '20px' }}>
                  <h4 style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.95rem', margin: '0 0 10px 0' }}>
                    <Activity size={15} color="var(--accent)" /> Rychlá kompilace (Modelfile Few-Shots)
                  </h4>
                  <p style={{ fontSize: '0.8rem', color: 'var(--text-dark)', lineHeight: '1.4', marginBottom: '12px' }}>
                    Převede zaznamenané interakce z rekordéru na reprezentativní testovací příklady (Few-Shot učení), zapíše je do <code>auratest-gemma2.Modelfile</code> a automaticky provede sestavení modelu v lokální Ollamě. Nevyžaduje dedikovanou grafickou kartu.
                  </p>
                  
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '16px', backgroundColor: 'var(--bg-tertiary)', padding: '10px', borderRadius: '6px', border: '1px solid var(--border)' }}>
                    <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                      Celkem nahraných stavů: <strong style={{ color: 'var(--text-muted)' }}>{datasetInfo.totalCount}</strong>
                    </div>
                    <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                      Validních a vyčištěných stavů: <strong style={{ color: 'var(--success)' }}>{datasetInfo.cleanedCount}</strong>
                    </div>
                  </div>

                  <button 
                    className="btn btn-primary" 
                    onClick={handleBuildModel} 
                    disabled={modelBuilding}
                    style={{ width: '100%' }}
                  >
                    {modelBuilding ? 'Sestavuji model v Ollamě...' : '⚡ Sestavit a aktualizovat model'}
                  </button>

                  {modelBuildLog && (
                    <div style={{ marginTop: '16px' }}>
                      <div style={{ fontSize: '0.75rem', fontWeight: 'bold', marginBottom: '4px', color: 'var(--text-muted)' }}>Console Output:</div>
                      <pre style={{ 
                        backgroundColor: '#1e1e1e', 
                        color: '#d4d4d4', 
                        padding: '10px', 
                        borderRadius: '6px', 
                        fontSize: '0.75rem', 
                        maxHeight: '180px', 
                        overflowY: 'auto',
                        whiteSpace: 'pre-wrap',
                        fontFamily: 'monospace',
                        border: '1px solid var(--border)'
                      }}>
                        {modelBuildLog}
                      </pre>
                    </div>
                  )}
                </div>

                {/* Right Column: LoRA Fine-Tuning */}
                <div>
                  <h4 style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.95rem', margin: '0 0 10px 0' }}>
                    <BookOpen size={15} color="var(--accent)" /> Plnohodnotný Fine-Tuning (SFT / LoRA)
                  </h4>
                  <p style={{ fontSize: '0.8rem', color: 'var(--text-dark)', lineHeight: '1.4', marginBottom: '12px' }}>
                    Pokud chcete model skutečně přeučit na nové chování, spusťte plný trénink vah pomocí připraveného Python skriptu. Skript provede doladění modelu <code>gemma-2-2b-it</code> s využitím LoRA adaptérů. Trénink automaticky využívá GPU (CUDA / Apple Silicon MPS).
                  </p>

                  <div style={{ backgroundColor: 'var(--bg-tertiary)', padding: '12px', borderRadius: '6px', border: '1px solid var(--border)', fontSize: '0.75rem' }}>
                    <div style={{ fontWeight: 'bold', marginBottom: '6px', color: 'var(--text-muted)' }}>Jak spustit trénink lokálně:</div>
                    <code style={{ display: 'block', whiteSpace: 'pre', overflowX: 'auto', padding: '8px', backgroundColor: '#1e1e1e', color: '#8ad4ff', borderRadius: '4px', fontFamily: 'monospace', marginBottom: '8px' }}>
{`# 1. Aktivujte virtuální prostředí
python3 -m venv venv
source venv/bin/activate

# 2. Nainstalujte závislosti
pip install -r scripts/requirements-lora.txt

# 3. Spusťte trénink na nasbíraných datech
python scripts/train_lora.py`}
                    </code>
                    <p style={{ margin: '0', color: 'var(--text-dark)', fontSize: '0.72rem', lineHeight: '1.3' }}>
                      Po dokončení tréninku stačí zkopírovat cestu k výslednému adaptéru a zadat ji do <code>Modelfilu</code> jako <code>ADAPTER /cesta/k/adapteru</code> a sestavit model.
                    </p>
                  </div>
                </div>

              </div>
            </div>
          </>
        )}


          {/* Tab 5: Interactive Recorder */}
          {activeTab === 'recorder' && (
            <div className="diff-layout">
              <div className="card">
                <h3 className="card-title"><Video size={16} /> Konfigurace Rekordéru</h3>
                <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '16px' }}>
                  Spusťte interaktivní prohlížeč, proveďte akce (kliky, psaní do polí) a systém automaticky zaznamená tyto akce jako optimální ChatML trénovací příklady pro lokální model Gemma.
                </p>
                
                <form onSubmit={handleStartRecorder}>
                  <div className="form-group" style={{ marginBottom: '16px' }}>
                    <label htmlFor="recorderUrl">Počáteční URL adresa</label>
                    <input 
                      type="url" 
                      id="recorderUrl" 
                      value={recorderUrl} 
                      onChange={(e) => setRecorderUrl(e.target.value)}
                      placeholder="https://example.com"
                      disabled={recorderActive || recorderLoading}
                      required
                    />
                  </div>
                  
                  {!recorderActive ? (
                    <button 
                      className="btn btn-primary" 
                      type="submit" 
                      disabled={recorderLoading}
                    >
                      {recorderLoading ? 'Spouštím...' : 'Spustit nahrávání'}
                    </button>
                  ) : (
                    <button 
                      className="btn btn-danger" 
                      type="button"
                      onClick={handleStopRecorder}
                      disabled={recorderLoading}
                    >
                      {recorderLoading ? 'Zastavuji...' : 'Zastavit a uložit do datasetu'}
                    </button>
                  )}
                </form>
              </div>

              {(recorderActive || recordedSteps.length > 0) && (
                <div className="card">
                  <h3 className="card-title"><Terminal size={16} /> {recorderActive ? 'Aktuální stav nahrávání' : 'Zaznamenaný scénář'}</h3>
                  
                  {recorderActive ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '16px' }}>
                      <span className="status-dot active" style={{ animation: 'pulse-border 1.5s infinite' }} />
                      <span style={{ fontSize: '0.9rem', fontWeight: 'bold', color: 'var(--success)' }}>
                        Nahrávání probíhá na: {recorderUrl}
                      </span>
                    </div>
                  ) : (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '16px' }}>
                      <span className="status-dot idle" />
                      <span style={{ fontSize: '0.9rem', fontWeight: 'bold', color: 'var(--text-muted)' }}>
                        Nahrávání dokončeno. Scénář je připraven.
                      </span>
                    </div>
                  )}

                  {!recorderActive && recordedSteps.length > 0 && (
                    <div style={{ display: 'flex', gap: '8px', marginBottom: '16px' }}>
                      <button 
                        className="btn btn-primary" 
                        type="button"
                        style={{ flex: 1, padding: '8px 16px', fontSize: '0.85rem' }}
                        onClick={() => {
                          const formatted = recordedSteps.map(s => {
                            if (s.action === 'click') {
                              return `click [data-qa-id="${s.target}"]`;
                            } else if (s.action === 'type') {
                              return `type [data-qa-id="${s.target}"] "${s.value || ''}"`;
                            }
                            return '';
                          }).filter(Boolean).join('\n');
                          
                          setCompareSteps(formatted);
                          setCompareUrl1(recorderUrl);
                          setCompareUrl2(recorderUrl); 
                          setActiveTab('compare');
                          showToast('Scénář byl exportován do Srovnávače. Doplňte cílovou URL a spusťte porovnání.', 'success');
                        }}
                      >
                        🔄 Porovnat chybové stavy přes Srovnávač
                      </button>
                      <button 
                        className="btn btn-secondary" 
                        type="button"
                        style={{ padding: '8px 16px', fontSize: '0.85rem' }}
                        onClick={() => setRecordedSteps([])}
                      >
                        🗑️ Smazat
                      </button>
                    </div>
                  )}

                  <div className="step-counter" style={{ fontSize: '1.1rem', marginBottom: '16px' }}>
                    Zaznamenáno kroků: <strong style={{ color: 'var(--accent)', fontSize: '1.25rem' }}>{recordedSteps.length}</strong>
                  </div>


                  {recordedSteps.length > 0 ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                      <h4 style={{ fontSize: '0.9rem', borderBottom: '1px solid var(--border)', paddingBottom: '6px' }}>
                        Historie zaznamenaných kroků:
                      </h4>
                      <div style={{ maxHeight: '300px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                        {recordedSteps.map((s) => (
                          <div 
                            key={s.step} 
                            style={{ 
                              display: 'flex', 
                              gap: '12px', 
                              padding: '10px', 
                              backgroundColor: 'var(--bg-tertiary)', 
                              border: '1px solid var(--border)', 
                              borderRadius: '4px',
                              alignItems: 'center'
                            }}
                          >
                            <span style={{ 
                              background: 'var(--accent)', 
                              color: 'white', 
                              borderRadius: '50%', 
                              width: '24px', 
                              height: '24px', 
                              display: 'flex', 
                              alignItems: 'center', 
                              justifyContent: 'center',
                              fontSize: '0.8rem',
                              fontWeight: 'bold'
                            }}>
                              {s.step}
                            </span>
                            <div style={{ flex: 1 }}>
                              <div style={{ fontWeight: '600', fontSize: '0.85rem' }}>
                                Akce: <span style={{ color: 'var(--accent)' }}>{s.action}</span> (target: {s.target})
                              </div>
                              {s.value && (
                                <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                                  Hodnota: <code>"{s.value}"</code>
                                </div>
                              )}
                              <div style={{ fontSize: '0.75rem', color: 'var(--text-dark)' }}>
                                URL: {s.url}
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <div style={{ color: 'var(--text-dark)', fontSize: '0.9rem', fontStyle: 'italic' }}>
                      Zatím nebyly zaznamenány žádné interakce. Klikněte nebo zadejte text v otevřeném okně prohlížeče.
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

      </main>
    </div>
  );
}
