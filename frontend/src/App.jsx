import React, { useState, useEffect, useRef, useCallback, useMemo, Suspense, lazy } from 'react';
import ReactMarkdown from 'react-markdown';
import {
  Play,
  Settings as SettingsIcon,
  Globe,
  CheckCircle,
  FileText,
  Layers,
  RefreshCw,
  Database,
  Code as CodeIcon,
  Image as ImageIcon,
  Loader2,
  Activity,
  Trash2,
  Copy,
  Plus,
  Shield,
  Zap,
  Printer,
  User,
  Wrench,
} from 'lucide-react';
import { signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut, onAuthStateChanged } from 'firebase/auth';
import { doc, setDoc, getDoc, collection, addDoc } from 'firebase/firestore';
import { firebaseAuth, firebaseDb } from './lib/firebase.js';
import { formatRedactedText, getDomain } from './lib/format.jsx';
import { complianceColor, complianceLabel, obligationColor, obligationLabel, pqcColor, pqcLabel } from './lib/compliance.js';
import { useRoutedTab } from './hooks/useRoutedTab.js';
import LandingPage from './components/public/LandingPage.jsx';

// Ukázkový report si tahá vlastní JSON a v běžném provozu ho nikdo neotevře —
// do hlavního bundlu nepatří.
const SampleReport = lazy(() => import('./components/public/SampleReport.jsx'));
const PrintReport = lazy(() => import('./components/print/PrintReport.jsx'));
import {
  TEST_TYPES, IMPACT_COLORS, IMPACT_TRANSLATIONS, RULE_TRANSLATIONS,
} from './constants/testTypes.js';

export default function App() {
  const [user, setUser] = useState(null);
  const [selectedTestType, setSelectedTestType] = useState('agent');
  const [authEmail, setAuthEmail] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [authMode, setAuthMode] = useState('login'); // 'login' or 'register'
  const [authError, setAuthError] = useState('');

  // Profile State
  const [profileName, setProfileName] = useState('');
  const [profileDefaultUrl, setProfileDefaultUrl] = useState('');
  const [profileSlackWebhook, setProfileSlackWebhook] = useState('');
  const [profileLoading, setProfileLoading] = useState(false);

  // AuraGuard Projects State
  const [projects, setProjects] = useState([]);
  const [selectedProjectId, setSelectedProjectId] = useState('');
  const [projectName, setProjectName] = useState('');
  const [projectOrigins, setProjectOrigins] = useState('');

  // Sekce se promítá do adresního řádku (/hub, /audit-prekladu, …), takže na
  // ni jde poslat odkaz a Zpět v prohlížeči přepíná sekce místo odchodu
  // z aplikace. Rozhraní je stejné jako u useState.
  //
  // Hook zároveň hlídá, že odhlášený uživatel neuvízne na zamčené sekci
  // a přihlášený na úvodní stránce.
  const [activeTab, setActiveTab] = useRoutedTab(!!user);
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
  // Co tahle instalace umí. Načítá se ze serveru — bez toho by UI nabízelo
  // AI režimy i tam, kde žádný jazykový model neběží, a uživatel by se to
  // dozvěděl až selháním testu.
  const [capabilities, setCapabilities] = useState(null);
  const llmConfigured = capabilities?.llmConfigured !== false;
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
  const [monitorTab, setMonitorTab] = useState('summary'); // 'summary' (bugs), 'monitoring' (AuraAuraGuard)

  // AuraAuraGuard Hub State
  const [monitors, setMonitors] = useState([]);
  const [auraguardEvents, setAuraGuardEvents] = useState([]);
  const [activeAuraGuardProjectFilter, setActiveAuraGuardProjectFilter] = useState('all');
  const [activeAuraGuardTypeFilter, setActiveAuraGuardTypeFilter] = useState('all');
  
  // Security Analysis State
  const [securityAnalysisLoading, setSecurityAnalysisLoading] = useState(false);
  const [securityAnalysisResult, setSecurityAnalysisResult] = useState(null);

  // A11y Audit State
  const [a11yLoading, setA11yLoading] = useState(false);
  const [a11yResult, setA11yResult] = useState(null);

  // NIS2 & PQC Audit State
  const [nis2Loading, setNis2Loading] = useState(false);
  const [nis2Result, setNis2Result] = useState(null);

  // Green Deal & GDPR State
  const [greenLoading, setGreenLoading] = useState(false);
  const [greenResult, setGreenResult] = useState(null);

  // CRA SBOM State
  const [craLoading, setCraLoading] = useState(false);
  const [craResult, setCraResult] = useState(null);

  // Auto-Heal State
  const [autoHealLoading, setAutoHealLoading] = useState({});
  // Mapa eventId -> navržený patch (dřív jediná hodnota pro všechny události).
  const [autoHealPatch, setAutoHealPatch] = useState({});

  // DORA Chaos State
  const [chaosLoading, setChaosLoading] = useState(false);
  const [chaosResult, setChaosResult] = useState(null);
  // Seed pro zopakování konkrétního běhu chaos testu. Prázdné = nový běh.
  const [chaosSeed, setChaosSeed] = useState('');

  // Grid-Aware State
  const [gridStatus, setGridStatus] = useState(null);

  // New Audits State (Phase 3)
  const [aiActLoading, setAiActLoading] = useState(false);
  const [aiActResult, setAiActResult] = useState(null);

  const [cookieLoading, setCookieLoading] = useState(false);
  const [cookieResult, setCookieResult] = useState(null);

  const [craVulnLoading, setCraVulnLoading] = useState(false);
  const [craVulnResult, setCraVulnResult] = useState(null);

  // New Monitors State (Phase 4)
  const [monitorPageLoading, setMonitorPageLoading] = useState(false);
  const [monitorPageResult, setMonitorPageResult] = useState(null);

  const [monitorFormLoading, setMonitorFormLoading] = useState(false);
  const [monitorFormResult, setMonitorFormResult] = useState(null);

  // Monitor Form State
  const [monitorName, setMonitorName] = useState('');
  const [monitorUrl, setMonitorUrl] = useState('https://news.ycombinator.com');
  const [monitorGoal, setMonitorGoal] = useState('Najdi jakékoliv chyby na úvodní stránce');
  const [monitorInterval, setMonitorInterval] = useState('1h');
  const [monitorMaxSteps, setMonitorMaxSteps] = useState(5);
  const [monitorExceptions, setMonitorExceptions] = useState(true);
  const [monitorPromiseRejections, setMonitorPromiseRejections] = useState(true);
  const [monitorLongTasks, setMonitorLongTasks] = useState(true);
  const [monitorNetworkErrors, setMonitorNetworkErrors] = useState(true);
  const [monitorSlowApiThresholdMs, setMonitorSlowApiThresholdMs] = useState(1500);
  const [isAddingMonitor, setIsAddingMonitor] = useState(false);

  // SDK Code Generator Config
  const [sdkProject, setSdkProject] = useState('muj-projekt');
  const [sdkErrors, setSdkErrors] = useState(true);
  const [gdprSentinel, setGdprSentinel] = useState(true);
  const [sdkPerf, setSdkPerf] = useState(true);
  const [sdkSlowThreshold, setSdkSlowThreshold] = useState(1500);

  // Dvě nezávislá spojení: globální telemetrie vs. živé logy konkrétního běhu.
  const wsRef = useRef(null);
  const sessionWsRef = useRef(null);
  const artifactTokenRef = useRef(null);
  const logsEndRef = useRef(null);

  // Load past sessions
  const fetchSessions = async () => {
    try {
      const res = await authFetch('/api/sessions');
      if (res.ok) {
        const data = await res.json();
        setSessions(prev => (JSON.stringify(prev) === JSON.stringify(data)) ? prev : data);
      }
    } catch (e) {
      console.error('Nepodařilo se stáhnout relace:', e);
    }
  };

  const fetchMonitors = async () => {
    try {
      const res = await authFetch('/api/monitors');
      if (res.ok) setMonitors(await res.json());
    } catch (e) {
      console.error('Chyba stahování monitorů:', e);
    }
  };

  // Fetch Grid Status on load
  useEffect(() => {
    if (!user) return;
    const fetchGrid = async () => {
      try {
        const response = await authFetch('/api/auraguard/grid-status', {
          headers: { 'Authorization': `Bearer ${await user.getIdToken()}` }
        });
        if (response.ok) {
          const data = await response.json();
          setGridStatus(data);
        }
      } catch (err) {
        console.error('Grid fetch error:', err);
      }
    };
    fetchGrid();
    const interval = setInterval(fetchGrid, 60000); // Každou minutu
    return () => clearInterval(interval);
  }, [user]);

  
  const clearAllResults = () => {
    setA11yResult(null);
    setNis2Result(null);
    setGreenResult(null);
    setCraResult(null);
    setCookieResult(null);
    setCraVulnResult(null);
    setMonitorPageResult(null);
    setMonitorFormResult(null);
    setSecurityAnalysisResult(null);
    // Dřív se tyhle dva nečistily, takže staré výsledky visely přes nové běhy.
    setAiActResult(null);
    setChaosResult(null);
  };

  const handleRunA11yAudit = async (skipClear = false) => {
    if (skipClear !== true) clearAllResults();
    if (!agentUrl) {
      alert('Zadejte URL pro audit přístupnosti.');
      return;
    }
    setA11yLoading(true);
    try {
      const response = await authFetch('/api/auraguard/analyze-accessibility', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: agentUrl })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      setA11yResult(data);
    } catch (err) {
      alert('Chyba auditu: ' + err.message);
    } finally {
      setA11yLoading(false);
    }
  };

  const handleRunNis2Audit = async (skipClear = false) => {
    if (skipClear !== true) clearAllResults();
    if (!agentUrl) {
      alert('Zadejte URL pro kybernetický audit (NIS2/PQC).');
      return;
    }
    setNis2Loading(true);
    try {
      const response = await authFetch('/api/auraguard/analyze-nis2', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: agentUrl })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      setNis2Result(data);
    } catch (err) {
      alert('Chyba auditu: ' + err.message);
    } finally {
      setNis2Loading(false);
    }
  };

  const handleRunGreenAudit = async (skipClear = false) => {
    if (skipClear !== true) clearAllResults();
    if (!agentUrl) {
      alert('Zadejte URL pro Green/GDPR audit.');
      return;
    }
    setGreenLoading(true);
    try {
      const response = await authFetch('/api/auraguard/analyze-green-gdpr', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: agentUrl })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      setGreenResult(data);
    } catch (err) {
      alert('Chyba auditu: ' + err.message);
    } finally {
      setGreenLoading(false);
    }
  };

  const handleRunCraAudit = async (skipClear = false) => {
    if (skipClear !== true) clearAllResults();
    if (!agentUrl) {
      alert('Zadejte URL pro CRA SBOM audit.');
      return;
    }
    setCraLoading(true);
    try {
      const response = await authFetch('/api/auraguard/analyze-cra', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: agentUrl })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      setCraResult(data);
    } catch (err) {
      alert('Chyba auditu: ' + err.message);
    } finally {
      setCraLoading(false);
    }
  };

  // Schopnosti se načtou jednou při startu. Když LLM chybí, výchozí režim
  // se přepne na monkey, aby první kliknutí neskončilo chybou.
  useEffect(() => {
    let cancelled = false;
    fetch('/api/capabilities')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || !data) return;
        setCapabilities(data);
        if (data.llmConfigured === false) setTestMode('monkey');
      })
      .catch(() => {
        // Nedostupné schopnosti nejsou důvod blokovat UI — chová se pak
        // jako dřív, tedy jako by LLM k dispozici bylo.
      });
    return () => { cancelled = true; };
  }, []);

  const handleRunChaosTest = async (skipClear = false, seedOverride = null) => {
    // Jako jediný z handlerů dřív nečistil předchozí výsledky, takže po
    // samostatném spuštění DORA testu zůstaly na obrazovce viset staré
    // výsledky NIS2/CRA/GDPR — případně proti úplně jiné URL.
    if (skipClear !== true) clearAllResults();
    if (!agentUrl) {
      alert('Zadejte URL pro DORA Chaos test.');
      return;
    }
    setChaosLoading(true);
    try {
      const response = await authFetch('/api/auraguard/chaos-test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Seed umožní zopakovat konkrétní běh. Prázdný = server vygeneruje nový.
        // `seedOverride` je potřeba proto, že setState se v témže ticku
        // do `chaosSeed` ještě nepropíše.
        body: JSON.stringify((() => {
          const seed = seedOverride || chaosSeed;
          return seed ? { url: agentUrl, seed } : { url: agentUrl };
        })())
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      setChaosResult(data);
    } catch (err) {
      alert('Chyba Chaos testu: ' + err.message);
    } finally {
      setChaosLoading(false);
    }
  };

  const handleRunAiActAudit = async (skipClear = false) => {
    if (skipClear !== true) clearAllResults();
    if (!agentUrl) { alert('Zadejte URL pro AI Act audit.'); return; }
    setAiActLoading(true);
    try {
      const response = await authFetch('/api/auraguard/ai-act-audit', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: agentUrl })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      setAiActResult(data);
    } catch (err) {
      alert('Chyba auditu: ' + err.message);
    } finally {
      setAiActLoading(false);
    }
  };

  const handleRunCookieAudit = async (skipClear = false) => {
    if (skipClear !== true) clearAllResults();
    if (!agentUrl) { alert('Zadejte URL pro GDPR Cookie audit.'); return; }
    setCookieLoading(true);
    try {
      const response = await authFetch('/api/auraguard/cookie-audit', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: agentUrl })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      setCookieResult(data);
    } catch (err) {
      alert('Chyba auditu: ' + err.message);
    } finally {
      setCookieLoading(false);
    }
  };

  const handleRunCraVulnAudit = async (skipClear = false) => {
    if (skipClear !== true) clearAllResults();
    if (!agentUrl) { alert('Zadejte URL pro CRA Vuln audit.'); return; }
    setCraVulnLoading(true);
    try {
      const response = await authFetch('/api/auraguard/cra-vuln-audit', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: agentUrl })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      setCraVulnResult(data);
    } catch (err) {
      alert('Chyba auditu: ' + err.message);
    } finally {
      setCraVulnLoading(false);
    }
  };

  const handleRunMonitorPage = async () => {
    if (!agentUrl) { alert('Zadejte URL pro test dostupnosti.'); return; }
    setMonitorPageLoading(true);
    try {
      const response = await authFetch('/api/auraguard/monitor-page', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target: { url: agentUrl, name: 'On-Demand Page Check' } })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      setMonitorPageResult(data);
    } catch (err) {
      alert('Chyba auditu: ' + err.message);
    } finally {
      setMonitorPageLoading(false);
    }
  };

  const handleRunMonitorForm = async () => {
    if (!agentUrl) { alert('Zadejte cílové URL (action) formuláře.'); return; }
    setMonitorFormLoading(true);
    try {
      // V reálném nasazení bychom zde měli další inputy pro jména políček. Pro on-demand demo posíláme prázdný formulář.
      const response = await authFetch('/api/auraguard/monitor-form', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target: { url: agentUrl, name: 'On-Demand Form Check', method: 'POST', fields: { test: '1' } } })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      setMonitorFormResult(data);
    } catch (err) {
      alert('Chyba auditu: ' + err.message);
    } finally {
      setMonitorFormLoading(false);
    }
  };

  const handleSendToSlack = async () => {
    if (!profileSlackWebhook) {
      alert("Nejprve si nastavte Slack Webhook v Nastavení (Profil).");
      return;
    }
    // Slack incoming webhooky neposílají CORS hlavičky, takže volání přímo
    // z prohlížeče vždy selhalo — a catch blok to hlásil jako úspěch.
    // Odesílá proto backend, který zároveň drží webhook mimo klientský kód.
    try {
      const response = await authFetch('/api/notify/slack', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          webhookUrl: profileSlackWebhook,
          text: `AuraGuard dokončil audit pro *${agentUrl}*.\nPodívejte se do aplikace pro detailní výsledky!`
        })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      alert('Report byl odeslán na Slack.');
    } catch (e) {
      alert(`Odeslání na Slack selhalo: ${e.message}`);
    }
  };

  const handleRunAllTests = async () => {
    if (!agentUrl) {
      alert('Zadejte URL pro komplexní audit.');
      return;
    }
    clearAllResults();
    
    // Zapneme loadery naprázdno, protože se pak zapnou i uvnitř metod, 
    // ale tímto zajistíme, že uživatel vidí progress okamžitě pro všechny testy
    setA11yLoading(true);
    setNis2Loading(true);
    setGreenLoading(true);
    setCraLoading(true);
    setAiActLoading(true);
    setCookieLoading(true);
    setCraVulnLoading(true);
    setMonitorPageLoading(true);
    setMonitorFormLoading(true);
    setChaosLoading(true);

    try {
      await Promise.allSettled([
        handleRunA11yAudit(true),
        handleRunNis2Audit(true),
        handleRunGreenAudit(true),
        handleRunCraAudit(true),
        handleRunAiActAudit(true),
        handleRunCookieAudit(true),
        handleRunCraVulnAudit(true),
        handleRunMonitorPage(),
        handleRunMonitorForm(),
        handleRunChaosTest()
      ]);

      if (user) {
        try {
          await addDoc(collection(firebaseDb, 'users', user.uid, 'history'), {
            type: 'all_in_one',
            url: agentUrl,
            timestamp: new Date().toISOString(),
          });
        } catch (e) {
          console.error("Nepodařilo se uložit historii testu:", e);
        }
      }
    } catch (e) {
      console.error("Komplexní audit selhal:", e);
    }
  };

  const handleAutoHeal = async (event) => {
    setAutoHealLoading(prev => ({ ...prev, [event.id]: true }));
    try {
      const response = await authFetch('/api/auraguard/auto-heal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventData: event, llmConfig: { provider: aiProvider, model: ollamaModel, host: ollamaHost } })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      setAutoHealPatch(prev => ({ ...prev, [event.id]: data.patch }));
    } catch (err) {
      alert('Chyba Auto-Heal: ' + err.message);
    } finally {
      setAutoHealLoading(prev => ({ ...prev, [event.id]: false }));
    }
  };

  const runSecurityAnalysis = async (eventsToAnalyze) => {
    setSecurityAnalysisLoading(true);
    setSecurityAnalysisResult(null);
    try {
      // Posíláme jen ID — obsah událostí si server načte sám a ověří vlastnictví.
      const res = await authFetch('/api/auraguard/analyze-security', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventIds: (eventsToAnalyze || []).map((e) => e.id).filter(Boolean) })
      });
      const data = await res.json();
      if (res.ok) {
        setSecurityAnalysisResult(data.analysis);
      } else {
        setSecurityAnalysisResult(`**Chyba při analýze:** ${data.error}`);
      }
    } catch (e) {
      console.error('Chyba při spouštění bezpečnostní analýzy:', e);
      setSecurityAnalysisResult(`**Kritická chyba:** ${e.message}`);
    } finally {
      setSecurityAnalysisLoading(false);
    }
  };

  const fetchAuraGuardEvents = async () => {
    try {
      const res = await authFetch('/api/auraguard/events');
      if (res.ok) setAuraGuardEvents(await res.json());
    } catch (e) {
      console.error('Chyba stahování auraguard logů:', e);
    }
  };

  const fetchProjects = async () => {
    try {
      const res = await authFetch('/api/projects');
      if (res.ok) setProjects(await res.json());
    } catch (e) {
      console.error('Chyba stahování projektů:', e);
    }
  };

  // Token se ke každému /api/ požadavku připojuje tímhle tenkým wrapperem.
  //
  // Dřív se místo toho přepisoval globální window.fetch přímo z komponenty:
  // globální mutace prostředí, selhání pro Request objekt i absolutní URL,
  // a neošetřené vyhození z getIdToken() rozbilo každý fetch v aplikaci.
  // Navíc to maskovalo chybu, že 11 volání posílalo `Bearer ${user.token}` —
  // Firebase User vlastnost `.token` nemá, takže se posílalo "Bearer undefined"
  // a fungovalo to jen díky tomu, že override hlavičku přepsal.
  const authFetch = useCallback(async (path, options = {}) => {
    let authHeaders = {};
    try {
      const token = await firebaseAuth.currentUser?.getIdToken();
      if (token) authHeaders = { Authorization: `Bearer ${token}` };
    } catch (err) {
      console.warn('Nepodařilo se získat ID token:', err.message);
    }
    return fetch(path, { ...options, headers: { ...options.headers, ...authHeaders } });
  }, []);

  const handleSaveProfile = async () => {
    if (!user) return;
    setProfileLoading(true);
    try {
      await setDoc(doc(firebaseDb, 'users', user.uid), {
        name: profileName,
        defaultUrl: profileDefaultUrl,
        slackWebhook: profileSlackWebhook,
        updatedAt: new Date().toISOString()
      }, { merge: true });
      alert('Profil byl úspěšně uložen do cloudu.');
    } catch (e) {
      alert('Chyba při ukládání profilu: ' + e.message);
    } finally {
      setProfileLoading(false);
    }
  };

  const handleAuth = async (e) => {
    e.preventDefault();
    setAuthError('');
    try {
      if (authMode === 'login') {
        await signInWithEmailAndPassword(firebaseAuth, authEmail, authPassword);
      } else {
        await createUserWithEmailAndPassword(firebaseAuth, authEmail, authPassword);
      }
    } catch (err) {
      console.error(err);
      let friendlyMessage = err.message;
      if (err.code === 'auth/wrong-password' || err.code === 'auth/user-not-found' || err.code === 'auth/invalid-credential') {
        friendlyMessage = 'Nesprávný e-mail nebo heslo.';
      } else if (err.code === 'auth/email-already-in-use') {
        friendlyMessage = 'Tento e-mail již používá jiný účet.';
      } else if (err.code === 'auth/weak-password') {
        friendlyMessage = 'Heslo musí mít alespoň 6 znaků.';
      }
      setAuthError(friendlyMessage);
    }
  };

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(firebaseAuth, async (currentUser) => {
      if (currentUser) {
        setUser(currentUser);

        // Načtení profilu
        try {
          const docRef = doc(firebaseDb, 'users', currentUser.uid);
          const docSnap = await getDoc(docRef);
          if (docSnap.exists()) {
            const data = docSnap.data();
            if (data.name) setProfileName(data.name);
            if (data.defaultUrl) {
              setProfileDefaultUrl(data.defaultUrl);
              setAgentUrl(data.defaultUrl);
            }
            if (data.slackWebhook) setProfileSlackWebhook(data.slackWebhook);
          }
        } catch (e) {
          console.error("Chyba při načítání profilu:", e);
        }

        fetchSessions();
        fetchMonitors();
        fetchAuraGuardEvents();
        fetchProjects();

        // Connect to global WS for real-time updates.
        // Token jde v query — WebSocket API v prohlížeči neumí vlastní hlavičky.
        const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
        const wsToken = await currentUser.getIdToken();
        const wsUrl = `${protocol}://${window.location.host}/ws?sessionId=global_auraguard&token=${encodeURIComponent(wsToken)}`;
        const ws = new WebSocket(wsUrl);

        ws.onmessage = (event) => {
          let msg;
          try {
            msg = JSON.parse(event.data);
          } catch {
            console.warn('Nečitelná WS zpráva, přeskakuji.');
            return;
          }
          if (msg.type === 'monitors_updated') {
            setMonitors(msg.monitors);
          } else if (msg.type === 'auraguard_live_event') {
            const newEvent = { ...msg.event, count: msg.event.count || 1 };
            setAuraGuardEvents((prev) => [newEvent, ...prev].slice(0, 500));
          } else if (msg.type === 'event_deduplicated') {
            setAuraGuardEvents((prev) => 
              prev.map(evt => 
                evt.id === msg.data.id ? { ...evt, count: msg.data.count } : evt
              )
            );
          }
        };

        wsRef.current = ws;
      } else {
        setUser(null);
        setSessions([]);
        setMonitors([]);
        setAuraGuardEvents([]);
        setProjects([]);
        if (wsRef.current) wsRef.current.close();
      }
    });

    // Bez cleanupu zůstávalo spojení otevřené i po unmountu; v React.StrictMode
    // se efekt v dev módu spustí dvakrát → dvě spojení a duplicitní eventy.
    return () => {
      unsubscribe();
      wsRef.current?.close();
      wsRef.current = null;
      sessionWsRef.current?.close();
      sessionWsRef.current = null;
    };
  }, []);

  // Fetch full details when selecting a session
  useEffect(() => {
    if (!selectedSessionId) return;

    // Bez AbortControlleru mohlo rychlé překlikávání historie zobrazit
    // odpověď staré session přes novou.
    const controller = new AbortController();
    authFetch(`/api/sessions/${selectedSessionId}`, { signal: controller.signal })
      .then(res => res.json())
      .then(data => {
        setActiveSession(data);
        setLiveLogs(data.steps || []);
        setSelectedStepIndex(null);
        if (data.status !== 'running') {
          setIsRunning(false);
        }
      })
      .catch(err => {
        if (err.name !== 'AbortError') console.error(err);
      });

    return () => controller.abort();
  }, [selectedSessionId]);

  // Scroll to bottom of steps log list
  useEffect(() => {
    if (logsEndRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [liveLogs]);

  // Connect to WS for live logs during active runs.
  // Vlastní ref (sessionWsRef) — dřív sdílel wsRef s globálním kanálem, takže
  // první spuštění testu natrvalo zabilo živou telemetrii AuraGuardu.
  const connectWebSocket = async (sessionId) => {
    if (sessionWsRef.current) sessionWsRef.current.close();

    const token = await firebaseAuth.currentUser?.getIdToken();
    if (!token) return;

    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const wsUrl = `${protocol}://${window.location.host}/ws?sessionId=${encodeURIComponent(sessionId)}&token=${encodeURIComponent(token)}`;

    const ws = new WebSocket(wsUrl);
    sessionWsRef.current = ws;

    ws.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        console.warn('Nečitelná WS zpráva, přeskakuji.');
        return;
      }
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

  const handleRunSelectedTest = async (e) => {
    e.preventDefault();
    if (isRunning) return;
    
    switch (selectedTestType) {
      case 'all_in_one': return handleRunAllTests();
      case 'agent': return handleRunTest(e);
      case 'eaa': return handleRunA11yAudit();
      case 'nis2': return handleRunNis2Audit();
      case 'green': return handleRunGreenAudit();
      case 'cra_sbom': return handleRunCraAudit();
      case 'dora': return handleRunChaosTest();
      case 'ai_act': return handleRunAiActAudit();
      case 'cookies': return handleRunCookieAudit();
      case 'cve': return handleRunCraVulnAudit();
      case 'http_page': return handleRunMonitorPage();
      case 'http_form': return handleRunMonitorForm();
      default: return handleRunTest(e);
    }
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
      const res = await authFetch('/api/run-test', {
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
      // Capability token pro screenshoty/video — <img> a <video> hlavičku
      // Authorization neposílají, takže token jde do query.
      artifactTokenRef.current = data.artifactToken || null;
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
      const res = await authFetch('/api/compare', {
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
      const res = await authFetch('/api/audit-translations', {
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

  const targetStepIndex = selectedStepIndex !== null ? selectedStepIndex : (liveLogs.length > 0 ? liveLogs.length - 1 : null);
  const activeStep = targetStepIndex !== null ? liveLogs[targetStepIndex] : null;
  // Artefakty (screenshoty, video) jsou chráněné capability tokenem session.
  const artifactToken = activeSession?.artifactToken || artifactTokenRef.current;
  const withArtifactToken = (url) => {
    if (!url || !artifactToken) return url;
    return `${url}${url.includes('?') ? '&' : '?'}t=${encodeURIComponent(artifactToken)}`;
  };
  const activeScreenshot = activeStep ? withArtifactToken(activeStep.screenshot) : null;
  // Kroky nesou od optimalizace paměti jen PŘÍRŮSTEK logů a chyb, ne celou
  // historii. Prázdné pole je ale truthy, takže původní fallback na
  // activeSession.bugs byl nedosažitelný a inspektor hlásil "žádné chyby",
  // i když session chyby měla. Kumulujeme proto sami.
  const cumulativeUpTo = (index, field) =>
    liveLogs.slice(0, index + 1).flatMap((step) => step?.[field] || []);

  const activeLogs = activeStep
    ? cumulativeUpTo(targetStepIndex, 'logs')
    : [];
  const activeBugs = activeStep
    ? cumulativeUpTo(targetStepIndex, 'bugs')
    : (activeSession?.bugs || []);
  const activeWarnings = activeStep
    ? cumulativeUpTo(targetStepIndex, 'warnings')
    : (activeSession?.warnings || []);
  const renderLogin = () => (
    <div className="login-container" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', minHeight: '400px', background: 'transparent' }}>
      <form onSubmit={handleAuth} className="card" style={{ width: '380px', display: 'flex', flexDirection: 'column', gap: '16px', border: '1px solid rgba(255,255,255,0.1)', padding: '24px', background: 'rgba(255,255,255,0.02)', borderRadius: 'var(--radius-md)' }}>
        <h2 style={{ display: 'flex', alignItems: 'center', gap: '10px', margin: 0, fontSize: '1.5rem', color: 'white', fontWeight: 'bold' }}>
          <Layers color="var(--accent)" size={24} /> Přihlášení
        </h2>
        <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', margin: 0 }}>
          {authMode === 'login' ? 'Tato sekce vyžaduje přihlášení.' : 'Zaregistrujte si nový účet.'}
        </p>

        {authError && (
          <div role="alert" style={{ background: 'rgba(239,68,68,0.15)', color: '#ef4444', padding: '10px', borderRadius: 'var(--radius-sm)', fontSize: '0.8rem', border: '1px solid rgba(239,68,68,0.2)' }}>
            {authError}
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          <label htmlFor="auth-email" style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>E-mailová adresa</label>
          <input 
            id="auth-email"
            type="email" 
            value={authEmail} 
            onChange={(e) => setAuthEmail(e.target.value)} 
            placeholder="name@example.com" 
            required 
            style={{ padding: '8px 12px', background: 'rgba(0,0,0,0.2)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 'var(--radius-sm)', color: 'white', fontSize: '0.9rem' }}
          />
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          <label htmlFor="auth-password" style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Heslo</label>
          <input 
            id="auth-password"
            type="password" 
            value={authPassword} 
            onChange={(e) => setAuthPassword(e.target.value)} 
            placeholder="••••••••" 
            required 
            style={{ padding: '8px 12px', background: 'rgba(0,0,0,0.2)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 'var(--radius-sm)', color: 'white', fontSize: '0.9rem' }}
          />
        </div>

        <button type="submit" className="btn btn-primary" style={{ padding: '10px', fontWeight: 'bold', display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
          {authMode === 'login' ? 'Přihlásit se' : 'Zaregistrovat se'}
        </button>

        <div style={{ textAlign: 'center', fontSize: '0.8rem', marginTop: '8px' }}>
          {authMode === 'login' ? (
            <span>Nemáte účet? <button type="button" className="link-button" onClick={() => { setAuthMode('register'); setAuthError(''); }}>Zaregistrujte se</button></span>
          ) : (
            <span>Již máte účet? <button type="button" className="link-button" onClick={() => { setAuthMode('login'); setAuthError(''); }}>Přihlaste se</button></span>
          )}
        </div>
      </form>
    </div>
  );

  const selectedTestData = TEST_TYPES.find(t => t.id === selectedTestType) || TEST_TYPES[0];

  // Stejný filtr běžel dřív třikrát v jednom renderu (jednou v onClick
  // closure, dvakrát v JSX kvůli `.length === 0 ? ... : ...`) nad bufferem
  // až 500 událostí.
  const filteredAuraGuardEvents = useMemo(
    () => auraguardEvents.filter((evt) => {
      const passProj = activeAuraGuardProjectFilter === 'all' || evt.project === activeAuraGuardProjectFilter;
      const passType = activeAuraGuardTypeFilter === 'all' || evt.type === activeAuraGuardTypeFilter;
      return passProj && passType;
    }),
    [auraguardEvents, activeAuraGuardProjectFilter, activeAuraGuardTypeFilter]
  );

  const auraGuardProjectOptions = useMemo(
    () => [...new Set(auraguardEvents.map((e) => e.project))],
    [auraguardEvents]
  );

  const sdkSnippet = useMemo(() => (
    `<script \n  src="${window.location.protocol}//${window.location.host}/sdk/auraguard.js" \n`
    + `  data-project-id="${selectedProjectId}" \n`
    + `  data-track-errors="${sdkErrors}" \n`
    + `  data-track-perf="${sdkPerf}" \n`
    + `  data-gdpr-sentinel="${gdprSentinel}" \n`
    + `  data-slow-api-threshold="${sdkSlowThreshold}">\n</script>`
  ), [selectedProjectId, sdkErrors, sdkPerf, gdprSentinel, sdkSlowThreshold]);

  // <select> bez prázdné option vizuálně ukazoval první projekt, ale stav
  // zůstal '' — vygenerovaný snippet měl pak prázdné data-project-id
  // a tlačítko Kopírovat hlásilo "nejprve vyberte projekt".
  useEffect(() => {
    if (!selectedProjectId && projects.length > 0) {
      setSelectedProjectId(projects[0].id);
    }
  }, [projects, selectedProjectId]);

  // aiActLoading a chaosLoading tu dřív chyběly, takže při samostatném
  // spuštění těchto auditů se nezobrazil ani spinner.
  const isAnyAuditLoading = a11yLoading || nis2Loading || greenLoading || craLoading
    || craVulnLoading || monitorPageLoading || monitorFormLoading || securityAnalysisLoading
    || cookieLoading || aiActLoading || chaosLoading;

  // Veřejné obrazovky se vykreslují MÍSTO aplikace, ne uvnitř ní.
  //
  // Cizí návštěvník dřív viděl kompletní postranní menu a nad ním přihlašovací
  // kartu — tedy rozhraní, na které nemá přístup, plus žádné vysvětlení, co ta
  // aplikace vlastně dělá. Landing a ukázka proto stojí samostatně.
  if (activeTab === 'landing') {
    return (
      <LandingPage
        onLogin={() => setActiveTab('login')}
        onSample={() => setActiveTab('sample')}
      />
    );
  }

  if (activeTab === 'sample') {
    return (
      <Suspense fallback={<div className="public-page">Načítám ukázku…</div>}>
        <SampleReport onBack={() => setActiveTab(user ? 'auraguard' : 'landing')} />
      </Suspense>
    );
  }

  return (
    <div className="app-container">
      {/* Sidebar navigation */}
      <aside className="sidebar" style={{ display: 'flex', flexDirection: 'column' }}>
        <div className="logo-section">
          <div className="logo-icon">
            <Layers size={18} color="white" />
          </div>
          <span className="logo-text">AuraTest AI</span>
        </div>

        {/* Menu se odhlášenému nezobrazuje.
            Všechny položky vedou na zamčené sekce, takže kliknutí jen odrazí
            zpátky na přihlášení — rozhraní, které nikam nevede, je horší než
            žádné. */}
        {user && (
        <nav className="nav-menu">
          <button
            className={`nav-item ${activeTab === 'agent' ? 'active' : ''}`}
            aria-current={activeTab === 'agent' ? 'page' : undefined}
            onClick={() => { setActiveTab('agent'); }}
          >
            <Play size={16} />
            <span>AI QA Agent</span>
          </button>
          <button 
            className={`nav-item ${activeTab === 'compare' ? 'active' : ''}`}
            aria-current={activeTab === 'compare' ? 'page' : undefined}
            onClick={() => { setActiveTab('compare'); }}
          >
            <Layers size={16} />
            <span>Porovnání verzí</span>
          </button>
          <button 
            className={`nav-item ${activeTab === 'audit' ? 'active' : ''}`}
            aria-current={activeTab === 'audit' ? 'page' : undefined}
            onClick={() => { setActiveTab('audit'); }}
          >
            <Globe size={16} />
            <span>Audit Překladů</span>
          </button>
          <button 
            className={`nav-item ${activeTab === 'auraguard' ? 'active' : ''}`}
            aria-current={activeTab === 'auraguard' ? 'page' : undefined}
            onClick={() => { setActiveTab('auraguard'); }}
          >
            <Activity size={16} />
            <span>AuraAuraGuard Hub</span>
          </button>
          <button 
            className={`nav-item ${activeTab === 'settings' ? 'active' : ''}`}
            aria-current={activeTab === 'settings' ? 'page' : undefined}
            onClick={() => { setActiveTab('settings'); }}
          >
            <SettingsIcon size={16} />
            <span>Nastavení</span>
          </button>
        </nav>
        )}

        <div className="sidebar-divider" />
        <span className="sidebar-section-title">Historie testů</span>
        
        <div className="history-list" style={{ flexGrow: 1, overflowY: 'auto' }}>
          {sessions.length === 0 ? (
            <div style={{ color: 'var(--text-dark)', fontSize: '0.75rem', padding: '8px' }}>
              Žádné předchozí testy.
            </div>
          ) : (
            sessions.map((s) => (
              /* Dřív <div onClick> — nefokusovatelné, neovladatelné klávesnicí. */
              <button
                type="button"
                key={s.id}
                className={`history-item ${selectedSessionId === s.id ? 'active' : ''}`}
                onClick={() => { setSelectedSessionId(s.id); setActiveTab('agent'); }}
                aria-current={selectedSessionId === s.id ? 'true' : undefined}
                style={selectedSessionId === s.id ? { borderColor: 'var(--accent)' } : {}}
              >
                <div className="history-item-header">
                  <span className="history-url">{getDomain(s.url)}</span>
                  {s.bugsCount > 0 && (
                    <span className="history-bugs">
                      <span aria-hidden="true">{s.bugsCount}x 🐛</span>
                      <span className="sr-only">{`${s.bugsCount} nalezených chyb`}</span>
                    </span>
                  )}
                </div>
                <div className="history-goal">{s.goal}</div>
              </button>
            ))
          )}
        </div>

        <div style={{ padding: '12px', display: 'flex', flexDirection: 'column', gap: '8px', borderTop: '1px solid rgba(255,255,255,0.05)', marginTop: 'auto' }}>
          {user ? (
            <>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap' }} title={user.email}>
                Účet: <strong>{user.email}</strong>
              </div>
              <button 
                className="btn btn-secondary" 
                onClick={() => signOut(firebaseAuth)}
                style={{ width: '100%', padding: '6px', fontSize: '0.75rem', color: '#ef4444', background: 'rgba(239,68,68,0.1)', border: 'none', cursor: 'pointer', borderRadius: 'var(--radius-sm)' }}
              >
                Odhlásit se
              </button>
            </>
          ) : (
            <button 
              className="btn btn-primary" 
              onClick={() => setActiveTab('agent')}
              style={{ width: '100%', padding: '8px', fontSize: '0.85rem', fontWeight: 'bold', border: 'none', cursor: 'pointer', borderRadius: 'var(--radius-sm)' }}
            >
              Přihlásit se
            </button>
          )}
        </div>
      </aside>

      {/* Main Workspace Workspace */}
      <main className="workspace">
        <header className="workspace-header">
          <div>
            {/* Nadpis stránky musí být <h1>. Jediný <h1> byl dřív uvnitř
                .print-only s display:none, takže na obrazovce nebyl žádný —
                porušení axe pravidla `page-has-heading-one`, které tenhle
                nástroj sám překládá. */}
            <h1 style={{ fontSize: '1.25rem', margin: 0 }}>
              {activeTab === 'agent' && 'Autonomní AI QA Agent'}
              {activeTab === 'compare' && 'Porovnávání stránek (Prod vs Preview)'}
              {activeTab === 'audit' && 'Audit překladů a lokalizace'}
              {activeTab === 'auraguard' && 'AuraAuraGuard Hub'}
              {activeTab === 'settings' && 'Globální nastavení'}
            </h1>
            <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
              {activeTab === 'agent' && 'Agent provádí akce jako člověk a hledá chyby za běhu'}
              {activeTab === 'compare' && 'Porovnává textový a vizuální obsah mezi dvěma verzemi webu'}
              {activeTab === 'audit' && 'Kontrola překladů na webu proti databázi nebo nadefinovanému slovníku'}
              {activeTab === 'auraguard' && 'Plánovaný syntetický monitoring a sběr klientských chyb v reálném čase'}
              {activeTab === 'settings' && 'Konfigurace lokální Ollama instance a výchozí nastavení prohlížeče'}
            </p>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '20px' }}>
            {/* Grid-Aware Status Widget */}
            {gridStatus && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 12px', borderRadius: '20px', background: gridStatus.status === 'LOW_CARBON' ? 'rgba(16, 185, 129, 0.1)' : 'rgba(245, 158, 11, 0.1)', border: `1px solid ${gridStatus.status === 'LOW_CARBON' ? '#10b981' : '#f59e0b'}` }} title={gridStatus.recommendation}>
                <Zap size={16} color={gridStatus.status === 'LOW_CARBON' ? '#10b981' : '#f59e0b'} />
                <span style={{ fontSize: '0.85rem', color: gridStatus.status === 'LOW_CARBON' ? '#10b981' : '#f59e0b', fontWeight: 'bold' }}>
                  EU Grid: {gridStatus.renewablePercentage}% Zelené (Eco {gridStatus.status === 'LOW_CARBON' ? 'ON' : 'OFF'})
                </span>
              </div>
            )}
            <div className="status-badge" role="status" aria-live="polite">
              <span className={`status-dot ${isRunning ? 'active' : 'idle'}`} aria-hidden="true" />
              <span>{isRunning ? 'Agent běží...' : 'Připraven'}</span>
            </div>
          </div>
        </header>

        {/* Tab panels */}
        <div className="tab-content">
          {/* AuraGuard Hub byl jako jediná záložka přístupný bez přihlášení —
              a zároveň je výchozí. Anonymní uživatel tak viděl UI, které pak
              střílelo /api/monitors a /api/projects bez tokenu a 401 mizely
              v prázdném catch bloku. */}
          {!user && renderLogin()}

          {/* Tab 1: QA Agent Runner */}
          {user && activeTab === 'agent' && (
            <div className="runner-layout">
              {/* Left Column: Form and Logs */}
              <div className="runner-left">
                {!isRunning && !activeSession && (
                  <form className="card" onSubmit={handleRunSelectedTest}>
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
                        <label htmlFor="testType">Druh testu (Compliance & QA)</label>
                        <select 
                          id="testType" 
                          value={selectedTestType}
                          onChange={(e) => setSelectedTestType(e.target.value)}
                        >
                          {TEST_TYPES.map(t => (
                            <option key={t.id} value={t.id}>{t.label}</option>
                          ))}
                        </select>
                      </div>
                    </div>

                    <div style={{ backgroundColor: '#1e1e1e', borderLeft: `4px solid ${selectedTestData.color}`, padding: '12px 16px', borderRadius: '4px', marginBottom: '16px', fontSize: '0.9rem', color: '#a1a1aa' }}>
                      {selectedTestData.desc}
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

                    {selectedTestType === 'agent' && (
                      <>
                        <div className="form-group">
                          <label htmlFor="testMode">Režim testování AI Agenta</label>
                          <select 
                            id="testMode" 
                            value={testMode}
                            onChange={(e) => setTestMode(e.target.value)}
                          >
                            {/* Režimy závislé na LLM se nabízejí jen tam, kde
                                nějaký běží. Nabízet je jinak znamená slíbit
                                funkci, která skončí chybou spojení. */}
                            {llmConfigured && <option value="ai">Cílený (AI Agent)</option>}
                            {llmConfigured && <option value="crawler">Spider (Prohledat web s AI)</option>}
                            {llmConfigured && <option value="smart_monkey">Chytrý průzkum s AI (Smart Monkey)</option>}
                            <option value="smoke_test">Automatický Smoke Test</option>
                            <option value="monkey">Náhodný (Monkey Test bez AI)</option>
                          </select>
                          {!llmConfigured && (
                            <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginTop: '8px' }}>
                              Tahle instalace nemá nakonfigurovaný jazykový model, takže AI režimy
                              nejsou k dispozici. Compliance skenery (NIS2/PQC, CRA, AI Act, GDPR,
                              EAA, DORA) fungují bez omezení.
                            </p>
                          )}
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
                      </>
                    )}

                    <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', marginTop: '16px' }}>
                      <button className="btn" type="submit" style={{ flex: 1, minWidth: '200px', backgroundColor: selectedTestData.color, borderColor: selectedTestData.color }}>
                        Spustit: {selectedTestData.label}
                        {React.createElement(selectedTestData.icon, { size: 16, style: { marginLeft: '8px' } })}
                      </button>
                    </div>
                  </form>
                )}

                {(isRunning || activeSession) && (
                  <div className="logs-container">
                    <div className="logs-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <span>Průběh testu</span>
                        <span role="status" aria-live="polite" style={{ fontSize: '0.75rem', color: 'var(--accent)' }}>
                          {liveProgress}
                        </span>
                      </div>
                      
                      {activeSession && !isRunning && (
                        <div style={{ display: 'flex', gap: '8px' }}>
                          <button className="btn" type="button" onClick={() => window.print()} style={{ backgroundColor: 'var(--accent)', color: 'white', padding: '6px 12px', fontSize: '0.85rem' }}>
                            <Printer size={16} style={{ marginRight: '6px' }} /> Generovat PDF
                          </button>
                          <button className="btn" type="button" onClick={handleSendToSlack} style={{ backgroundColor: '#2eb67d', color: 'white', padding: '6px 12px', fontSize: '0.85rem' }}>
                            Odeslat na Slack
                          </button>
                        </div>
                      )}
                    </div>

                    <div className="logs-list">
                      {liveLogs.map((step, index) => (
                        <button
                          type="button"
                          key={step.step}
                          className="step-card"
                          aria-pressed={selectedStepIndex === index}
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
                        </button>
                      ))}
                      <div ref={logsEndRef} />
                    </div>

                    {activeSession && activeSession.status === 'completed' && (
                      <div className="completion-summary-card">
                        <div className="completion-header">
                          <div className="completion-icon">
                            <span aria-hidden="true">
                              {activeSession.bugs && activeSession.bugs.length > 0 ? '⚠️' : '✅'}
                            </span>
                            <span className="sr-only">
                              {activeSession.bugs && activeSession.bugs.length > 0 ? 'Nalezeny chyby' : 'Bez nálezu'}
                            </span>
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
                            {/* Němý screencast běhu prohlížeče: `muted` je tu
                                věcně správně (žádné mluvené slovo), takže
                                titulky nemají co přenášet. Textový přepis kroků
                                je v seznamu vedle. */}
                            <video 
                              controls 
                              muted
                              aria-label={`Němý záznam testovacího běhu pro ${activeSession.url || 'testovanou stránku'}. Textový přepis kroků je v seznamu vlevo.`}
                              src={withArtifactToken(activeSession.videoUrl)}
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

              {/* Right Column: Visualizer & Dev Inspector OR Audit Results */}
              <div className="runner-right">
                {isAnyAuditLoading ? (
                  <div className="audit-inline-results" role="status" aria-live="polite" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', backgroundColor: 'var(--bg-secondary)', borderRadius: 'var(--radius-md)', padding: '24px', flex: 1, height: '100%' }}>
                    <div className="spinner" aria-hidden="true" style={{ width: '50px', height: '50px', border: '4px solid rgba(255,255,255,0.1)', borderTopColor: 'var(--accent)', borderRadius: '50%', animation: 'spin 1s linear infinite' }}></div>
                    <h3 style={{ marginTop: '20px', color: 'var(--text-main)' }}>Probíhá audit...</h3>
                    <p style={{ color: 'var(--text-secondary)' }}>Prosím čekejte, analyzujeme cíl a shromažďujeme data.</p>
                  </div>
                ) : (a11yResult || cookieResult || nis2Result || greenResult || craResult
                     || craVulnResult || monitorPageResult || monitorFormResult
                     /* aiActResult a chaosResult tu chyběly — jejich výsledky se nikdy nezobrazily */
                     || aiActResult || chaosResult || securityAnalysisResult) ? (
                  <div className="audit-inline-results" style={{ backgroundColor: 'var(--bg-secondary)', borderRadius: 'var(--radius-md)', padding: '24px', overflowY: 'auto', flex: 1, height: '100%' }}>
                     <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px', paddingBottom: '16px', borderBottom: '1px solid rgba(255,255,255,0.1)' }}>
                       <h2 style={{ margin: 0, fontSize: '1.4rem', color: 'var(--text-main)', display: 'flex', alignItems: 'center' }}>
                         <Shield size={24} style={{ marginRight: '10px', color: 'var(--accent)' }} /> 
                         Výsledky Auditu
                       </h2>
                       <div style={{ display: 'flex', gap: '8px' }}>
                         <button className="btn" type="button" onClick={() => window.print()} style={{ backgroundColor: 'var(--accent)', color: 'white', padding: '8px 16px', fontSize: '0.9rem' }}>
                            <Printer size={16} style={{ marginRight: '6px' }} /> Generovat PDF Report
                         </button>
                         <button className="btn" type="button" onClick={handleSendToSlack} style={{ backgroundColor: '#2eb67d', color: 'white', padding: '8px 16px', fontSize: '0.9rem' }}>
                            Odeslat na Slack
                         </button>
                       </div>
                     </div>

                     {/* EAA Audit */}
                     {a11yResult && (
                       <div>
                         <h3 style={{ color: 'var(--accent)', marginTop: 0 }}>EAA Audit Přístupnosti (WCAG)</h3>
                         <div style={{ padding: '15px', background: 'rgba(0,0,0,0.2)', borderRadius: '8px', borderLeft: `4px solid ${a11yResult.violations.length === 0 ? '#10b981' : '#ef4444'}`, marginBottom: '16px' }}>
                           <strong style={{ color: a11yResult.violations.length === 0 ? '#10b981' : '#ef4444' }}>
                             Nalezeno porušení: {a11yResult.violations.length}
                           </strong>
                         </div>
                         {a11yResult.violations.map(v => (
                           <div key={v.id} style={{ background: 'rgba(255,255,255,0.05)', padding: '16px', borderRadius: '8px', marginBottom: '12px' }}>
                             <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
                               <strong style={{ color: 'white' }}>{RULE_TRANSLATIONS[v.id] || v.id}</strong>
                               <span style={{ fontSize: '0.75rem', padding: '2px 8px', borderRadius: '12px', background: IMPACT_COLORS[v.impact] || '#333', color: 'white' }}>{IMPACT_TRANSLATIONS[v.impact] || v.impact}</span>
                             </div>
                             <p style={{ margin: '0 0 12px 0', fontSize: '0.9rem', color: 'var(--text-secondary)' }}>{v.description}</p>
                             {v.nodes.length > 0 && (
                               <div style={{ background: 'rgba(0,0,0,0.4)', padding: '12px', borderRadius: '4px', overflowX: 'auto' }}>
                                 <div style={{ color: '#ef4444', fontSize: '0.8rem', marginBottom: '8px' }}>
                                   {v.nodes[0].failureSummary.replace('Fix any of the following:', 'Opravte jednu z následujících chyb:')}
                                 </div>
                                 <pre style={{ margin: 0, color: '#a9b7c6', fontSize: '0.8rem' }}>{v.nodes[0].html}</pre>
                               </div>
                             )}
                           </div>
                         ))}
                       </div>
                     )}

                     {/* GDPR Cookie Result */}
                     {cookieResult && (
                       <div>
                         <h3 style={{ color: 'var(--accent)', marginTop: 0 }}>Striktní GDPR Cookie Auditor</h3>
                         <div style={{ padding: '15px', background: 'rgba(0,0,0,0.2)', borderRadius: '8px', borderLeft: `4px solid ${cookieResult.gdpr.isCompliant ? '#10b981' : '#ef4444'}`, marginBottom: '16px' }}>
                           <strong style={{ color: cookieResult.gdpr.isCompliant ? '#10b981' : '#ef4444' }}>
                             {cookieResult.gdpr.rating}
                           </strong>
                         </div>
                         {cookieResult.gdpr.suspiciousItems.length > 0 && (
                           <div style={{ background: 'rgba(255,255,255,0.05)', padding: '16px', borderRadius: '8px' }}>
                             <strong style={{ color: '#ef4444' }}>Nalezeny trackery před souhlasem:</strong>
                             <ul style={{ paddingLeft: '20px', marginTop: '8px', color: 'var(--text-secondary)' }}>
                               {cookieResult.gdpr.suspiciousItems.map((item, i) => <li key={i}>{item}</li>)}
                             </ul>
                           </div>
                         )}
                       </div>
                     )}

                     {/* CRA Vuln Result */}
                     {craVulnResult && (
                       <div>
                         <h3 style={{ color: 'var(--accent)', marginTop: 0 }}>CRA Zranitelnosti (CVE OSV)</h3>
                         <div style={{ padding: '15px', background: 'rgba(0,0,0,0.2)', borderRadius: '8px', borderLeft: `4px solid ${complianceColor(craVulnResult.cra.isCompliant)}`, marginBottom: '16px' }}>
                           <strong style={{ color: complianceColor(craVulnResult.cra.isCompliant) }}>
                             {`[${complianceLabel(craVulnResult.cra.isCompliant)}] `}
                             {craVulnResult.cra.rating}
                           </strong>
                         </div>
                         {craVulnResult.cra.vulnerabilities.map((v, i) => (
                           <div key={i} style={{ background: 'rgba(255,255,255,0.05)', padding: '16px', borderRadius: '8px', borderLeft: '4px solid #ef4444', marginBottom: '12px' }}>
                             <strong style={{ color: '#ef4444' }}>{v.cve} ({v.severity})</strong>
                             <div style={{ color: 'var(--text-main)', margin: '4px 0' }}>Knihovna: {v.library} {v.version}</div>
                             <div style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>{v.details}</div>
                           </div>
                         ))}
                       </div>
                     )}

                     {/* NIS2 Result */}
                     {nis2Result && (
                       <div>
                         <h3 style={{ color: 'var(--accent)', marginTop: 0 }}>Evropský bezpečnostní audit (NIS2)</h3>
                         <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '16px' }}>
                           <div style={{ padding: '12px', background: 'rgba(255,255,255,0.05)', borderRadius: '8px', borderLeft: `4px solid ${nis2Result.nis2.hsts ? '#10b981' : '#ef4444'}` }}>
                             <strong>HSTS</strong>: {nis2Result.nis2.hsts ? 'Aktivní' : 'Chybí'}
                           </div>
                           <div style={{ padding: '12px', background: 'rgba(255,255,255,0.05)', borderRadius: '8px', borderLeft: `4px solid ${nis2Result.nis2.csp ? '#10b981' : '#ef4444'}` }}>
                             <strong>CSP</strong>: {nis2Result.nis2.csp ? 'Aktivní' : 'Chybí'}
                           </div>
                         </div>
                         {/*
                           Dřív tahle karta ukazovala jen název protokolu a vydavatele
                           certifikátu — o post-kvantové odolnosti neříkala nic, přestože
                           se tak jmenovala. Teď zobrazuje skutečně změřený výsledek sondy,
                           včetně stavu „neprůkazné", když sonda proběhnout nemohla.
                         */}
                         <div style={{
                           background: 'rgba(0,0,0,0.2)', padding: '16px', borderRadius: '8px',
                           borderLeft: `4px solid ${pqcColor(nis2Result.pqc.isQuantumSafe)}`,
                         }}>
                           {/* Vlastní škála: chybějící PQC není porušení předpisu. */}
                           <strong style={{ color: pqcColor(nis2Result.pqc.isQuantumSafe) }}>
                             {`Post-kvantová výměna klíčů [${pqcLabel(nis2Result.pqc.isQuantumSafe)}]`}
                           </strong>
                           <div style={{ color: 'var(--text-secondary)', marginTop: '8px' }}>
                             Testovaná skupina: {nis2Result.pqc.pqcGroup || '—'}<br />
                             Vyjednaný protokol: {nis2Result.pqc.protocol}<br />
                             {nis2Result.pqc.protocolsEnabled?.length > 0 && (
                               <>Server přijímá: {nis2Result.pqc.protocolsEnabled.join(', ')}<br /></>
                             )}
                             Autorita: {nis2Result.pqc.issuer}
                           </div>
                           {nis2Result.pqc.recommendation && (
                             <p style={{ color: 'var(--text-secondary)', marginBottom: 0, marginTop: '10px' }}>
                               {nis2Result.pqc.recommendation}
                             </p>
                           )}
                           {nis2Result.pqc.tlsIssues?.length > 0 && (
                             <ul style={{ color: '#ef4444', paddingLeft: '20px', marginBottom: 0, marginTop: '10px' }}>
                               {nis2Result.pqc.tlsIssues.map((issue) => <li key={issue}>{issue}</li>)}
                             </ul>
                           )}
                           {nis2Result.pqc.tlsNotes?.length > 0 && (
                             <ul style={{ color: '#f59e0b', paddingLeft: '20px', marginBottom: 0, marginTop: '10px' }}>
                               {nis2Result.pqc.tlsNotes.map((note) => <li key={note}>{note}</li>)}
                             </ul>
                           )}
                         </div>
                       </div>
                     )}

                     {/* Green Deal & GDPR */}
                     {greenResult && (
                       <div>
                         <h3 style={{ color: 'var(--accent)', marginTop: 0 }}>Green Deal & GDPR (Hostování a Uhlík)</h3>
                         <div style={{ padding: '15px', background: 'rgba(0,0,0,0.2)', borderRadius: '8px', borderLeft: `4px solid ${greenResult.green.rating.includes('A') ? '#10b981' : greenResult.green.rating.includes('C') ? '#f59e0b' : '#ef4444'}`, marginBottom: '16px' }}>
                           <strong style={{ color: greenResult.green.rating.includes('A') ? '#10b981' : greenResult.green.rating.includes('C') ? '#f59e0b' : '#ef4444' }}>
                             Eko Třída: {greenResult.green.rating}
                           </strong>
                         </div>
                         <ul style={{ color: 'var(--text-secondary)', paddingLeft: '20px', marginBottom: '16px' }}>
                           <li>Uhlíková stopa: {greenResult.green.co2Grams} g CO2 / načtení</li>
                           <li>Přenesená data: {greenResult.green.totalMb} MB</li>
                         </ul>
                         <div style={{ padding: '15px', background: 'rgba(0,0,0,0.2)', borderRadius: '8px', borderLeft: `4px solid ${complianceColor(greenResult.residency.isEUCompliant)}`, marginBottom: '16px' }}>
                           <strong style={{ color: complianceColor(greenResult.residency.isEUCompliant) }}>
                             {`GDPR Rezidence [${complianceLabel(greenResult.residency.isEUCompliant)}]: `}
                             {greenResult.residency.warning}
                           </strong>
                         </div>
                         <ul style={{ color: 'var(--text-secondary)', paddingLeft: '20px' }}>
                           {greenResult.residency.locations.map((loc, i) => (
                             <li key={i}>{loc.domain} ({loc.country}) - {loc.isEU ? 'EU/EEA' : 'Mimo EU'}</li>
                           ))}
                         </ul>
                       </div>
                     )}

                     {/* AI Act */}
                     {aiActResult && (
                       <div>
                         <h3 style={{ color: 'var(--accent)', marginTop: 0 }}>EU AI Act — článek 50 (Transparentnost)</h3>

                         <div style={{ padding: '15px', background: 'rgba(0,0,0,0.2)', borderRadius: '8px', borderLeft: `4px solid ${complianceColor(aiActResult.aiAct.isCompliant)}`, marginBottom: '16px' }}>
                           <strong style={{ color: complianceColor(aiActResult.aiAct.isCompliant) }}>
                             {`[${complianceLabel(aiActResult.aiAct.isCompliant)}] `}
                             {aiActResult.aiAct.rating}
                           </strong>
                         </div>

                         {/* Článek 50 obsahuje ČTYŘI samostatné povinnosti. Dřív se
                             slučovaly do jednoho výsledku, takže report tvrdil víc,
                             než uměl doložit. */}
                         {Array.isArray(aiActResult.aiAct.obligations) && (
                           <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginBottom: '16px' }}>
                             {aiActResult.aiAct.obligations.map((ob) => (
                               <div
                                 key={ob.id}
                                 style={{
                                   padding: '12px',
                                   background: 'rgba(0,0,0,0.15)',
                                   borderRadius: '6px',
                                   borderLeft: `3px solid ${obligationColor(ob.status)}`,
                                 }}
                               >
                                 <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                                   <span style={{
                                     fontSize: '0.65rem',
                                     fontWeight: 'bold',
                                     padding: '2px 6px',
                                     borderRadius: '4px',
                                     color: obligationColor(ob.status),
                                     border: `1px solid ${obligationColor(ob.status)}`,
                                   }}>
                                     {obligationLabel(ob.status)}
                                   </span>
                                   <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>{ob.id}</span>
                                   <strong style={{ fontSize: '0.85rem', color: 'var(--text-main)' }}>{ob.title}</strong>
                                   {ob.outOfScope && (
                                     <span style={{ fontSize: '0.65rem', color: '#94a3b8', fontStyle: 'italic' }}>
                                       mimo dosah skeneru
                                     </span>
                                   )}
                                 </div>
                                 <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', marginTop: '6px' }}>
                                   {ob.rationale}
                                 </div>
                               </div>
                             ))}
                           </div>
                         )}

                         {aiActResult.aiAct.apisDetected.length > 0 && (
                           <>
                             <h4 style={{ fontSize: '0.8rem', color: 'var(--text-muted)', margin: '0 0 4px' }}>
                               Zachycená volání AI API
                             </h4>
                             <ul style={{ color: 'var(--text-secondary)', paddingLeft: '20px', fontSize: '0.78rem' }}>
                               {aiActResult.aiAct.apisDetected.map((api, i) => <li key={i}>{api}</li>)}
                             </ul>
                           </>
                         )}
                       </div>
                     )}

                     {/* CRA SBOM */}
                     {craResult && (
                       <div>
                         <h3 style={{ color: 'var(--accent)', marginTop: 0 }}>CRA SBOM (Softwarový kusovník)</h3>
                         <div style={{ padding: '15px', background: 'rgba(0,0,0,0.2)', borderRadius: '8px', borderLeft: `4px solid #3b82f6`, marginBottom: '16px' }}>
                           <strong style={{ color: '#bfdbfe' }}>
                             Detekováno technologií: {craResult.sbom.length}
                           </strong>
                         </div>
                         <div style={{ background: 'rgba(255,255,255,0.05)', borderRadius: '8px', padding: '16px' }}>
                           {craResult.sbom.map((lib, i) => (
                             <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', borderBottom: '1px solid rgba(255,255,255,0.1)', padding: '8px 0' }}>
                               <strong style={{ color: 'white' }}>{lib.name} ({lib.type})</strong>
                               <span style={{ color: 'var(--text-secondary)', textAlign: 'right' }}>
                                 {/*
                                   „Verze neznámá" je poctivější než `v undefined`.
                                   Knihovnu bez verze nejde ověřit proti databázi CVE.
                                 */}
                                 {lib.version ? `v${lib.version}` : 'verze neznámá'}
                                 {lib.sources?.length > 0 && (
                                   <span style={{ display: 'block', fontSize: '0.75rem', opacity: 0.7 }}>
                                     zdroj: {lib.sources.join(', ')}
                                   </span>
                                 )}
                               </span>
                             </div>
                           ))}
                         </div>
                         {craResult.conflicts?.length > 0 && (
                           <ul style={{ color: '#f59e0b', paddingLeft: '20px', marginTop: '10px' }}>
                             {craResult.conflicts.map((c) => (
                               <li key={c.library}>{c.library}: zdroje hlásí {c.versions.join(' vs ')} — {c.note}</li>
                             ))}
                           </ul>
                         )}
                         {craResult.evidence && (
                           <p style={{ color: 'var(--text-secondary)', fontSize: '0.8rem', marginBottom: 0 }}>
                             Prohledáno {craResult.evidence.scriptsScanned} skriptů
                             {craResult.evidence.sourceMapPackages > 0
                               && `, ze source map ${craResult.evidence.sourceMapPackages} balíčků`}
                             {craResult.evidence.scriptsUnreadable > 0
                               && `, ${craResult.evidence.scriptsUnreadable} skriptů se nepodařilo přečíst`}
                             {craResult.evidence.truncated && ' (dosažen limit prohledávaných skriptů)'}.
                           </p>
                         )}
                         {craResult.scope && (
                           <p style={{ color: 'var(--text-secondary)', fontSize: '0.8rem' }}>{craResult.scope}</p>
                         )}
                       </div>
                     )}

                     {/* Monitor Page Result */}
                     {monitorPageResult && (
                       <div>
                         <h3 style={{ color: 'var(--accent)', marginTop: 0 }}>Test Dostupnosti (HTTP)</h3>
                         <div style={{ padding: '15px', background: 'rgba(0,0,0,0.2)', borderRadius: '8px', borderLeft: `4px solid ${monitorPageResult.ok ? '#10b981' : '#ef4444'}`, marginBottom: '16px' }}>
                           <strong style={{ color: monitorPageResult.ok ? '#10b981' : '#ef4444' }}>
                             {monitorPageResult.ok ? 'Uptime OK' : 'Výpadek Zaznamenán'}
                           </strong>
                         </div>
                         <ul style={{ color: 'var(--text-secondary)', paddingLeft: '20px' }}>
                           <li>URL: {monitorPageResult.url}</li>
                           <li>Doba odezvy: {monitorPageResult.durationMs} ms</li>
                           <li>Status: {monitorPageResult.status}</li>
                           {!monitorPageResult.ok && <li style={{color: '#ef4444'}}>Chyba: {monitorPageResult.error}</li>}
                         </ul>
                       </div>
                     )}

                     {/* Monitor Form Result */}
                     {monitorFormResult && (
                       <div>
                         <h3 style={{ color: 'var(--accent)', marginTop: 0 }}>Test Formuláře (HTTP)</h3>
                         <div style={{ padding: '15px', background: 'rgba(0,0,0,0.2)', borderRadius: '8px', borderLeft: `4px solid ${monitorFormResult.ok ? '#10b981' : '#ef4444'}`, marginBottom: '16px' }}>
                           <strong style={{ color: monitorFormResult.ok ? '#10b981' : '#ef4444' }}>
                             {monitorFormResult.ok ? 'Formulář prošel' : 'Formulář zamítnut'}
                           </strong>
                         </div>
                         <ul style={{ color: 'var(--text-secondary)', paddingLeft: '20px' }}>
                           <li>URL: {monitorFormResult.url}</li>
                           <li>Doba odezvy: {monitorFormResult.durationMs} ms</li>
                           <li>Status: {monitorFormResult.status}</li>
                           {!monitorFormResult.ok && <li style={{color: '#ef4444'}}>Chyba: {monitorFormResult.error}</li>}
                         </ul>
                       </div>
                     )}

                     {/* DORA Chaos — render tu dřív ÚPLNĚ chyběl, takže
                         spuštění testu otevřelo prázdný panel s hlavičkou. */}
                     {chaosResult && chaosResult.chaos && (
                       <div>
                         <h3 style={{ color: 'var(--accent)', marginTop: 0 }}>DORA Chaos Engineering</h3>
                         <div style={{ padding: '15px', background: 'rgba(0,0,0,0.2)', borderRadius: '8px', borderLeft: `4px solid ${complianceColor(chaosResult.chaos.isResilient)}`, marginBottom: '16px' }}>
                           <strong style={{ color: complianceColor(chaosResult.chaos.isResilient) }}>
                             {`[${complianceLabel(chaosResult.chaos.isResilient)}] `}
                             {chaosResult.chaos.rating}
                           </strong>
                         </div>
                         <ul style={{ color: 'var(--text-secondary)', paddingLeft: '20px' }}>
                           <li>Zahozené požadavky: {chaosResult.chaos.abortedRequests}</li>
                           <li>Zpožděné požadavky: {chaosResult.chaos.delayedRequests}</li>
                           <li>Chyb v konzoli: {chaosResult.chaos.consoleErrors}</li>
                           <li>Stránka se zhroutila: {chaosResult.chaos.pageCrashed ? 'ano' : 'ne'}</li>
                           {chaosResult.chaos.baseline && (
                             <li>
                               Z toho nových oproti baseline běhu bez injektáže:{' '}
                               <strong>{chaosResult.chaos.newConsoleErrors}</strong>
                               {' '}(baseline sám hlásil {chaosResult.chaos.baseline.consoleErrors})
                             </li>
                           )}
                           {/* Seed je to, co dělá z náhodného pokusu opakovatelný test. */}
                           {chaosResult.chaos.seed && (
                             <li>Seed běhu: <code>{chaosResult.chaos.seed}</code></li>
                           )}
                         </ul>
                         {chaosResult.chaos.seed && (
                           <button
                             type="button"
                             onClick={() => {
                               setChaosSeed(chaosResult.chaos.seed);
                               handleRunChaosTest(true, chaosResult.chaos.seed);
                             }}
                             style={{ marginBottom: '10px' }}
                           >
                             Zopakovat se stejným seedem
                           </button>
                         )}
                         {chaosResult.chaos.scope && (
                           <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
                             {chaosResult.chaos.scope}
                           </p>
                         )}
                       </div>
                     )}

                     {/* Security Analysis Result */}
                     {securityAnalysisResult && (
                       <div>
                         <h3 style={{ color: 'var(--accent)', marginTop: 0 }}>Komplexní AI Bezpečnostní Analýza</h3>
                         <div className="markdown-body" style={{ color: 'var(--text-main)', background: 'rgba(0,0,0,0.2)', padding: '20px', borderRadius: '8px' }}>
                           <ReactMarkdown>{securityAnalysisResult}</ReactMarkdown>
                         </div>
                       </div>
                     )}

                  </div>
                ) : (
                  <>
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
                        {/* Dřív <div onClick> bez role, fokusu a klávesnice. */}
                        <div className="inspect-tabs" role="tablist" aria-label="Inspektor kroku">
                          <button
                            type="button"
                            role="tab"
                            id="inspect-tab-console"
                            aria-selected={inspectTab === 'console'}
                            aria-controls="inspect-panel"
                            className={`inspect-tab ${inspectTab === 'console' ? 'active' : ''}`}
                            onClick={() => setInspectTab('console')}
                          >
                            Konzole
                          </button>
                          <button
                            type="button"
                            role="tab"
                            id="inspect-tab-bugs"
                            aria-selected={inspectTab === 'bugs'}
                            aria-controls="inspect-panel"
                            className={`inspect-tab ${inspectTab === 'bugs' ? 'active' : ''}`}
                            onClick={() => setInspectTab('bugs')}
                          >
                            Log chyb
                          </button>
                        </div>

                        <div
                          id="inspect-panel"
                          role="tabpanel"
                          aria-labelledby={inspectTab === 'console' ? 'inspect-tab-console' : 'inspect-tab-bugs'}
                          style={{ height: '150px', overflowY: 'auto', backgroundColor: 'var(--bg-primary)', borderRadius: '6px', padding: '8px' }}
                        >
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
                              {activeWarnings.length > 0 && (
                                <div style={{ marginBottom: '8px' }}>
                                  {activeWarnings.map((w, idx) => (
                                    <div key={`w-${idx}`} style={{ fontSize: '0.75rem', padding: '4px', color: '#f59e0b', borderBottom: '1px solid #333' }}>
                                      {formatRedactedText(w)}
                                    </div>
                                  ))}
                                </div>
                              )}
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
                  </>
                )}
              </div>
            </div>
          )}

          {/* Tab 2: Compare Tool */}
          {user && activeTab === 'compare' && (
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
                  {compareLoading ? (
                    <>
                      <Loader2 className="spin" size={16} />
                      Porovnávám...
                    </>
                  ) : (
                    'Spustit porovnání (Diff)'
                  )}
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
          {user && activeTab === 'audit' && (
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
                        <label htmlFor="f-hostitel-host">Hostitel (Host)</label>
                        <input id="f-hostitel-host" type="text" value={dbHost} onChange={(e) => setDbHost(e.target.value)} />
                      </div>
                      <div className="form-group">
                        <label htmlFor="f-port">Port</label>
                        <input id="f-port" type="text" value={dbPort} onChange={(e) => setDbPort(e.target.value)} />
                      </div>
                      <div className="form-group">
                        <label htmlFor="f-uzivatel">Uživatel</label>
                        <input id="f-uzivatel" type="text" value={dbUser} onChange={(e) => setDbUser(e.target.value)} />
                      </div>
                      <div className="form-group">
                        <label htmlFor="f-heslo">Heslo</label>
                        <input id="f-heslo" type="password" value={dbPassword} onChange={(e) => setDbPassword(e.target.value)} />
                      </div>
                      <div className="form-group">
                        <label htmlFor="f-nazev-databaze">Název databáze</label>
                        <input id="f-nazev-databaze" type="text" value={dbName} onChange={(e) => setDbName(e.target.value)} />
                      </div>
                    </div>
                    <div className="form-group" style={{ marginTop: '12px' }}>
                      <label htmlFor="f-sql-dotaz-dotaz-musi-vracet-sloupce-key-">SQL dotaz (Dotaz musí vracet sloupce 'key' a 'value')</label>
                      <input id="f-sql-dotaz-dotaz-musi-vracet-sloupce-key-" type="text" value={dbQuery} onChange={(e) => setDbQuery(e.target.value)} />
                    </div>
                  </div>
                )}

                {sourceType === 'sqlite' && (
                  <div className="form-group-row">
                    <div className="form-group">
                      <label htmlFor="f-cesta-k-souboru-sqlite">Cesta k souboru .sqlite</label>
                      <input id="f-cesta-k-souboru-sqlite" type="text" value={sqlitePath} onChange={(e) => setSqlitePath(e.target.value)} required />
                    </div>
                    <div className="form-group">
                      <label htmlFor="f-sql-dotaz">SQL dotaz</label>
                      <input id="f-sql-dotaz" type="text" value={dbQuery} onChange={(e) => setDbQuery(e.target.value)} required />
                    </div>
                  </div>
                )}

                {sourceType === 'script' && (
                  <div className="form-group">
                    <label htmlFor="f-povoleny-nazev-skriptu-z-whitelistu-na-b">Povolený název skriptu (z whitelistu na backendu)</label>
                    <input id="f-povoleny-nazev-skriptu-z-whitelistu-na-b" type="text" value={scriptName} onChange={(e) => setScriptName(e.target.value)} required />
                  </div>
                )}

                <button className="btn" type="submit" disabled={auditLoading}>
                  {auditLoading ? (
                    <>
                      <Loader2 className="spin" size={16} />
                      Provádím audit...
                    </>
                  ) : (
                    'Spustit lokalizační audit'
                  )}
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
          {user && activeTab === 'settings' && (
            <>
              <div className="card" style={{ marginBottom: '24px' }}>
                <h3 className="card-title"><User size={16} /> Můj Profil (Uloženo v cloudu)</h3>
                <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginBottom: '16px' }}>
                  Zde uložená data se propíšou napříč všemi zařízeními, na kterých se přihlásíte.
                </p>
                
                <div className="form-group">
                  <label htmlFor="profileName">Zobrazované Jméno</label>
                  <input 
                    type="text" 
                    id="profileName" 
                    placeholder="Např. Jan Novák"
                    value={profileName} 
                    onChange={(e) => setProfileName(e.target.value)} 
                  />
                </div>

                <div className="form-group">
                  <label htmlFor="profileDefaultUrl">Výchozí Testovací URL</label>
                  <input 
                    type="text" 
                    id="profileDefaultUrl" 
                    placeholder="https://..."
                    value={profileDefaultUrl} 
                    onChange={(e) => setProfileDefaultUrl(e.target.value)} 
                  />
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '4px' }}>
                    Tato URL se po přihlášení vždy automaticky předvyplní do všech testů a agentů.
                  </div>
                </div>

                <div className="form-group">
                  <label htmlFor="profileSlackWebhook">Slack Webhook URL (Pro budoucí notifikace a odesílání reportů)</label>
                  <input 
                    type="text" 
                    id="profileSlackWebhook" 
                    placeholder="https://hooks.slack.com/services/..."
                    value={profileSlackWebhook} 
                    onChange={(e) => setProfileSlackWebhook(e.target.value)} 
                  />
                </div>

                <button 
                  className="btn btn-primary" 
                  onClick={handleSaveProfile}
                  disabled={profileLoading}
                  style={{ marginTop: '8px' }}
                >
                  {profileLoading ? 'Ukládám...' : 'Uložit do cloudu'}
                </button>
              </div>

              <div className="card">
                <h3 className="card-title"><SettingsIcon size={16} /> Globální konfigurace (Lokální prohlížeč)</h3>
              
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
                  aria-describedby="ollamaHost-hint"
                />
                {/* Server od zavedení SSRF ochrany bere host jen z allowlistu
                    (ALLOWED_LLM_HOSTS). Bez téhle poznámky vypadalo pole jako
                    funkční, ale hodnota se tiše zahazovala. */}
                <small id="ollamaHost-hint" style={{ color: 'var(--text-muted)', fontSize: '0.75rem' }}>
                  Server přijme jen adresy uvedené v <code>ALLOWED_LLM_HOSTS</code>.
                  Jiná hodnota se ignoruje a použije se výchozí endpoint serveru.
                </small>
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
            </>
          )}

          {/* Tab 5: AuraAuraGuard Hub */}
          {user && activeTab === 'auraguard' && (
            <div className="auraguard-hub-layout" style={{ display: 'grid', gridTemplateColumns: '1fr 1.2fr', gap: '20px', alignItems: 'start' }}>
              
              {/* Leve sloupce: Syntetický monitoring */}
              <div className="auraguard-left-panel" style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
                
                {/* Správa monitorů */}
                <div className="card">
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
                    <h3 className="card-title" style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <Activity size={16} color="var(--accent)" /> Syntetický monitoring
                    </h3>
                    {user && (
                      <button 
                        className="btn btn-secondary" 
                        onClick={() => setIsAddingMonitor(!isAddingMonitor)}
                        style={{ padding: '4px 8px', display: 'flex', alignItems: 'center', gap: '4px', fontSize: '0.8rem' }}
                      >
                        <Plus size={14} /> Přidat monitor
                      </button>
                    )}
                  </div>

                  {isAddingMonitor && (
                    <form 
                      onSubmit={async (e) => {
                        e.preventDefault();
                        const monitorData = {
                          name: monitorName,
                          url: monitorUrl,
                          goal: monitorGoal,
                          interval: monitorInterval,
                          maxSteps: monitorMaxSteps,
                          trackExceptions: monitorExceptions,
                          trackPromiseRejections: monitorPromiseRejections,
                          trackLongTasks: monitorLongTasks,
                          trackNetworkErrors: monitorNetworkErrors,
                          slowApiThresholdMs: monitorSlowApiThresholdMs,
                          active: true
                        };
                        try {
                          const res = await authFetch('/api/monitors', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(monitorData)
                          });
                          if (res.ok) {
                            fetchMonitors();
                            setMonitorName('');
                            setIsAddingMonitor(false);
                          }
                        } catch (e) {
                          console.error(e);
                        }
                      }}
                      style={{ background: 'rgba(255,255,255,0.05)', padding: '12px', borderRadius: 'var(--radius)', marginBottom: '16px', display: 'flex', flexDirection: 'column', gap: '10px' }}
                    >
                      <div className="form-group">
                        <label htmlFor="f-nazev-monitoru">Název monitoru</label>
                        <input id="f-nazev-monitoru" type="text" value={monitorName} onChange={(e) => setMonitorName(e.target.value)} placeholder="Např. Homepage Checker" required />
                      </div>
                      <div className="form-group">
                        <label htmlFor="f-cilova-url">Cílová URL</label>
                        <input id="f-cilova-url" type="url" value={monitorUrl} onChange={(e) => setMonitorUrl(e.target.value)} required />
                      </div>
                      <div className="form-group">
                        <label htmlFor="f-zadani-pro-ai-agent">Zadání pro AI Agent</label>
                        <input id="f-zadani-pro-ai-agent" type="text" value={monitorGoal} onChange={(e) => setMonitorGoal(e.target.value)} required />
                      </div>
                      
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                        <div className="form-group">
                          <label htmlFor="f-interval-kontroly">Interval kontroly</label>
                          <select id="f-interval-kontroly" value={monitorInterval} onChange={(e) => setMonitorInterval(e.target.value)}>
                            <option value="1m">Každou 1 minutu (test)</option>
                            <option value="5m">Každých 5 minut</option>
                            <option value="15m">Každých 15 minut</option>
                            <option value="1h">Každou hodinu</option>
                            <option value="12h">Každých 12 hodin</option>
                            <option value="24h">Jednou denně</option>
                          </select>
                        </div>
                        <div className="form-group">
                          <label htmlFor="f-max-kroku-agenta">Max kroků agenta</label>
                          <input id="f-max-kroku-agenta" type="number" value={monitorMaxSteps} onChange={(e) => setMonitorMaxSteps(parseInt(e.target.value) || 5)} />
                        </div>
                      </div>

                      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '0.8rem' }}>
                        <strong style={{ display: 'block', margin: '4px 0 2px 0' }}>Co vše hlídat:</strong>
                        <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
                          <label style={{ display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer' }}>
                            <input type="checkbox" checked={monitorExceptions} onChange={(e) => setMonitorExceptions(e.target.checked)} /> JS Výjimky
                          </label>
                          <label style={{ display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer' }}>
                            <input type="checkbox" checked={monitorPromiseRejections} onChange={(e) => setMonitorPromiseRejections(e.target.checked)} /> Promises
                          </label>
                          <label style={{ display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer' }}>
                            <input type="checkbox" checked={monitorLongTasks} onChange={(e) => setMonitorLongTasks(e.target.checked)} /> Zasekávání UI
                          </label>
                          <label style={{ display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer' }}>
                            <input type="checkbox" checked={monitorNetworkErrors} onChange={(e) => setMonitorNetworkErrors(e.target.checked)} /> Síťové chyby
                          </label>
                        </div>
                      </div>

                      <div className="form-group">
                        <label htmlFor="monitor-slow-api-threshold">Limit pro pomalou odezvu API (ms)</label>
                        <input id="monitor-slow-api-threshold" type="number" value={monitorSlowApiThresholdMs} onChange={(e) => setMonitorSlowApiThresholdMs(parseInt(e.target.value) || 1500)} />
                      </div>

                      <div style={{ display: 'flex', gap: '8px', marginTop: '4px' }}>
                        <button type="submit" className="btn btn-primary" style={{ flex: 1, padding: '6px' }}>Uložit monitor</button>
                        <button type="button" className="btn btn-secondary" onClick={() => setIsAddingMonitor(false)} style={{ padding: '6px' }}>Zrušit</button>
                      </div>
                    </form>
                  )}

                  <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                    {monitors.length === 0 ? (
                      <div style={{ color: 'var(--text-muted)', fontSize: '0.85rem', textAlign: 'center', padding: '16px' }}>
                        Žány aktivní monitory. Přidejte monitor pro periodickou kontrolu webů na pozadí.
                      </div>
                    ) : (
                      monitors.map((mon) => {
                        const statusColor = mon.lastRunStatus === 'success' ? '#22c55e' : (mon.lastRunStatus === 'failure' ? '#ef4444' : (mon.lastRunStatus === 'error' ? '#f59e0b' : 'var(--text-muted)'));
                        return (
                          <div 
                            key={mon.id} 
                            style={{ border: '1px solid rgba(255,255,255,0.1)', padding: '12px', borderRadius: 'var(--radius)', background: 'rgba(255,255,255,0.02)', display: 'flex', flexDirection: 'column', gap: '8px' }}
                          >
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start' }}>
                              <div>
                                <h4 style={{ margin: 0, fontSize: '0.95rem', display: 'flex', alignItems: 'center', gap: '6px' }}>
                                  {mon.name}
                                  <span style={{ fontSize: '0.7rem', background: mon.active ? 'rgba(34,197,94,0.15)' : 'rgba(255,255,255,0.1)', color: mon.active ? '#4ade80' : 'var(--text-muted)', padding: '2px 6px', borderRadius: '10px' }}>
                                    {mon.active ? 'Aktivní' : 'Neaktivní'}
                                  </span>
                                </h4>
                                <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{mon.url}</span>
                              </div>
                              <div style={{ display: 'flex', gap: '6px' }}>
                                <button 
                                  className="btn btn-secondary"
                                  onClick={async () => {
                                    try {
                                      await authFetch(`/api/monitors/${mon.id}`, {
                                        method: 'PATCH',
                                        headers: { 'Content-Type': 'application/json' },
                                        body: JSON.stringify({ active: !mon.active })
                                      });
                                      fetchMonitors();
                                    } catch (e) { console.error(e); }
                                  }}
                                  style={{ padding: '3px 6px', fontSize: '0.75rem' }}
                                >
                                  {mon.active ? 'Vypnout' : 'Zapnout'}
                                </button>
                                <button 
                                  className="btn btn-secondary"
                                  onClick={async () => {
                                    if (confirm('Opravdu chcete smazat tento monitor?')) {
                                      try {
                                        await authFetch(`/api/monitors/${mon.id}`, { method: 'DELETE' });
                                        fetchMonitors();
                                      } catch (e) { console.error(e); }
                                    }
                                  }}
                                  style={{ padding: '3px 6px', fontSize: '0.75rem', color: '#ef4444' }}
                                >
                                  <Trash2 size={12} />
                                </button>
                              </div>
                            </div>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.75rem', borderTop: '1px solid rgba(255,255,255,0.05)', paddingTop: '8px', marginTop: '4px' }}>
                              <span>Interval: <strong>{mon.interval}</strong></span>
                              <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                                Stav: <strong style={{ color: statusColor }}>
                                  {mon.lastRunStatus === 'success' && 'V pořádku (OK)'}
                                  {mon.lastRunStatus === 'failure' && `Chyby (${mon.lastRunBugsCount}x 🐛)`}
                                  {mon.lastRunStatus === 'error' && 'Chyba běhu'}
                                  {mon.lastRunStatus === 'none' && 'Dosud neběžel'}
                                </strong>
                              </span>
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>
                <div className="card">
                  <h3 className="card-title" style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px' }}>
                    <Database size={16} color="var(--accent)" /> Projekty a API Klíče
                  </h3>
                  
                  {/* Formulář pro nový projekt */}
                  <form 
                    onSubmit={async (e) => {
                      e.preventDefault();
                      if (!projectName) return;
                      const allowedOrigins = projectOrigins.split(',').map(o => o.trim()).filter(Boolean);
                      try {
                        const res = await authFetch('/api/projects', {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ name: projectName, allowedOrigins })
                        });
                        if (res.ok) {
                          setProjectName('');
                          setProjectOrigins('');
                          fetchProjects();
                        }
                      } catch (err) {
                        console.error(err);
                      }
                    }}
                    style={{ background: 'rgba(255,255,255,0.03)', padding: '12px', borderRadius: 'var(--radius-sm)', marginBottom: '16px', display: 'flex', flexDirection: 'column', gap: '10px' }}
                  >
                    <div className="form-group" style={{ margin: 0 }}>
                      <label style={{ fontSize: '0.75rem' }} htmlFor="f-nazev-noveho-projektu">Název nového projektu</label>
                      <input id="f-nazev-noveho-projektu" 
                        type="text" 
                        value={projectName} 
                        onChange={(e) => setProjectName(e.target.value)} 
                        placeholder="Např. Eshop Production" 
                        required 
                        style={{ padding: '6px', fontSize: '0.8rem' }}
                      />
                    </div>
                    <div className="form-group" style={{ margin: 0 }}>
                      <label style={{ fontSize: '0.75rem' }} htmlFor="f-povolene-domeny-origin-whitelist">Povolené domény (Origin whitelist)</label>
                      <input id="f-povolene-domeny-origin-whitelist" 
                        type="text" 
                        value={projectOrigins} 
                        onChange={(e) => setProjectOrigins(e.target.value)} 
                        placeholder="Např. http://localhost:3000, https://mujweb.cz" 
                        style={{ padding: '6px', fontSize: '0.8rem' }}
                      />
                      <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>Čárkami oddělený seznam domén. Nechte prázdné pro povolení všech domén.</span>
                    </div>
                    <button type="submit" className="btn btn-primary" style={{ padding: '6px', fontSize: '0.8rem', alignSelf: 'flex-start', display: 'flex', alignItems: 'center', gap: '4px' }}>
                      <Plus size={12} /> Vytvořit projekt
                    </button>
                  </form>

                  {/* Seznam projektů */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', maxHeight: '180px', overflowY: 'auto' }}>
                    {projects.length === 0 ? (
                      <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textAlign: 'center', padding: '12px' }}>
                        Zatím nemáte vytvořený žádný projekt.
                      </div>
                    ) : (
                      projects.map(p => (
                        <div key={p.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px', borderRadius: '4px', background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)', fontSize: '0.75rem' }}>
                          <div>
                            <strong style={{ color: 'white' }}>{p.name}</strong>
                            <div style={{ color: 'var(--text-muted)', fontFamily: 'monospace', fontSize: '0.7rem', display: 'flex', alignItems: 'center', gap: '4px', marginTop: '2px' }}>
                              Klíč: {p.id}
                              <button 
                                onClick={() => { navigator.clipboard.writeText(p.id); alert('Klíč projektu zkopírován!'); }}
                                style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', padding: 0 }}
                              >
                                <Copy size={10} />
                              </button>
                            </div>
                            {p.allowedOrigins && p.allowedOrigins.length > 0 && (
                              <div style={{ fontSize: '0.65rem', color: '#fbbf24', marginTop: '2px' }}>
                                Whitelist: {p.allowedOrigins.join(', ')}
                              </div>
                            )}
                          </div>
                          <button 
                            onClick={async () => {
                              if (confirm(`Opravdu smazat projekt ${p.name}?`)) {
                                await authFetch(`/api/projects/${p.id}`, { method: 'DELETE' });
                                fetchProjects();
                              }
                            }}
                            style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer', padding: '4px' }}
                          >
                            <Trash2 size={12} />
                          </button>
                        </div>
                      ))
                    )}
                  </div>
                </div>

                {/* Generátor SDK kódu */}
                <div className="card">
                  <h3 className="card-title" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <CodeIcon size={16} color="var(--accent)" /> Integrace AuraAuraGuard SDK
                  </h3>
                  <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '12px' }}>
                    Chcete monitorovat výskyt chyb přímo z produkčních webů od reálných uživatelů? Zaklikněte konfiguraci níže a vložte kód do své HTML šablony.
                  </p>

                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', background: 'rgba(0,0,0,0.2)', padding: '12px', borderRadius: 'var(--radius)', marginBottom: '12px' }}>
                    <div className="form-group">
                      <label htmlFor="sdk-project-select">Vyberte Projekt</label>
                      {projects.length === 0 ? (
                        <span style={{ fontSize: '0.75rem', color: '#ef4444' }}>Nejprve vytvořte projekt výše.</span>
                      ) : (
                        <select 
                          id="sdk-project-select"
                          value={selectedProjectId} 
                          onChange={(e) => setSelectedProjectId(e.target.value)} 
                          style={{ fontSize: '0.8rem', padding: '6px', width: '100%' }}
                        >
                          {projects.map(p => (
                            <option key={p.id} value={p.id}>{p.name} ({p.id})</option>
                          ))}
                        </select>
                      )}
                    </div>
                    
                    <div style={{ display: 'flex', gap: '12px', fontSize: '0.75rem', flexWrap: 'wrap' }}>
                      <label style={{ display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer' }}>
                        <input type="checkbox" checked={sdkErrors} onChange={(e) => setSdkErrors(e.target.checked)} /> Hlídat chyby JS
                      </label>
                      <label style={{ display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer' }}>
                        <input type="checkbox" checked={sdkPerf} onChange={(e) => setSdkPerf(e.target.checked)} /> Hlídat plynulost a API
                      </label>
                      <label style={{ display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer', color: 'var(--accent)', fontWeight: 'bold' }}>
                        <input type="checkbox" checked={gdprSentinel} onChange={(e) => setGdprSentinel(e.target.checked)} /> 🔒 Aktivovat GDPR AI Sentinel
                      </label>
                    </div>

                    {sdkPerf && (
                      <div className="form-group">
                        <label htmlFor="sdk-slow-threshold">Limit pomalých API (ms)</label>
                        <input id="sdk-slow-threshold" type="number" value={sdkSlowThreshold} onChange={(e) => setSdkSlowThreshold(parseInt(e.target.value) || 1500)} style={{ fontSize: '0.8rem', padding: '4px' }} />
                      </div>
                    )}
                  </div>

                  <div style={{ position: 'relative' }}>
                    {/* Jeden zdroj pravdy: dřív se zobrazený snippet a ten
                        zkopírovaný lišily (tlačítko vynechávalo
                        data-gdpr-sentinel), takže uživatel nasadil jinou
                        konfiguraci, než jakou viděl. */}
                    <pre style={{ margin: 0, background: 'black', color: '#a9b7c6', padding: '12px', borderRadius: 'var(--radius-sm)', fontSize: '0.7rem', overflowX: 'auto', whiteSpace: 'pre-wrap', fontFamily: 'monospace' }}>
{sdkSnippet}
                    </pre>
                    <button 
                      className="btn btn-secondary" 
                      onClick={() => {
                        if (!selectedProjectId) {
                          alert('Nejprve vyberte nebo vytvořte projekt!');
                          return;
                        }
                        navigator.clipboard.writeText(sdkSnippet);
                        alert('Kód SDK byl zkopírován do schránky!');
                      }}
                      style={{ position: 'absolute', top: '8px', right: '8px', padding: '3px 6px', fontSize: '0.7rem', background: 'rgba(255,255,255,0.1)', cursor: 'pointer' }}
                    >
                      <Copy size={12} /> Kopírovat
                    </button>
                  </div>
                </div>
              </div>

              {/* Pravý sloupec: Live Stream produkčních chyb */}
              <div className="card" style={{ height: 'calc(100vh - 130px)', display: 'flex', flexDirection: 'column' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                  <h3 className="card-title" style={{ margin: 0 }}>
                    📊 Produkční telemetry Live Stream
                  </h3>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <button 
                      className="btn btn-primary" 
                      onClick={() => runSecurityAnalysis(filteredAuraGuardEvents)}
                      style={{ padding: '3px 8px', fontSize: '0.75rem', display: 'flex', alignItems: 'center', gap: '4px' }}
                    >
                      <Shield size={14} /> AI Audit
                    </button>
                    <button 
                      className="btn btn-secondary" 
                      onClick={() => { setAuraGuardEvents([]); }}
                      style={{ padding: '3px 8px', fontSize: '0.75rem' }}
                    >
                      Vymazat log
                    </button>
                  </div>
                </div>

                {/* Filtry */}
                <div style={{ display: 'flex', gap: '8px', marginBottom: '12px' }}>
                  <div style={{ flex: 1 }}>
                    <label style={{ fontSize: '0.7rem', color: 'var(--text-muted)', display: 'block', marginBottom: '2px' }} htmlFor="f-filtrovat-projekt">Filtrovat projekt</label>
                    <select id="f-filtrovat-projekt" 
                      value={activeAuraGuardProjectFilter} 
                      onChange={(e) => setActiveAuraGuardProjectFilter(e.target.value)}
                      style={{ width: '100%', fontSize: '0.75rem', padding: '4px' }}
                    >
                      <option value="all">Všechny projekty</option>
                      {auraGuardProjectOptions.map(proj => (
                        <option key={proj} value={proj}>{proj}</option>
                      ))}
                    </select>
                  </div>
                  <div style={{ flex: 1 }}>
                    <label style={{ fontSize: '0.7rem', color: 'var(--text-muted)', display: 'block', marginBottom: '2px' }} htmlFor="f-filtrovat-typ">Filtrovat typ</label>
                    <select id="f-filtrovat-typ" 
                      value={activeAuraGuardTypeFilter} 
                      onChange={(e) => setActiveAuraGuardTypeFilter(e.target.value)}
                      style={{ width: '100%', fontSize: '0.75rem', padding: '4px' }}
                    >
                      <option value="all">Všechny události</option>
                      <option value="error">JS Chyby (Error)</option>
                      <option value="promise">Sliby (Promise)</option>
                      <option value="performance">Plynulost (UI Block)</option>
                      <option value="network_slow">Pomalá API</option>
                      <option value="network_error">Chyby API (status &gt;= 400)</option>
                    </select>
                  </div>
                </div>

                {/* Výpis událostí */}
                <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {filteredAuraGuardEvents.length === 0 ? (
                    <div style={{ color: 'var(--text-muted)', textAlign: 'center', padding: '32px', fontSize: '0.85rem' }}>
                      Žádné přicházející události. Zde se v reálném čase zobrazí chyby ze stránek s integrovaným AuraAuraGuard SDK.
                    </div>
                  ) : (
                    filteredAuraGuardEvents.map((evt) => {
                      const dateStr = new Date(evt.timestamp).toLocaleTimeString();
                      const typeBadge = evt.type === 'error' ? '❌ JS ERROR' : (evt.type === 'promise' ? '⚠️ PROMISE' : (evt.type === 'performance' ? '⚡ PERFORMANCE' : (evt.type === 'network_slow' ? '⏳ SLOW API' : '🌐 NET ERROR')));
                      const badgeBg = evt.type === 'error' || evt.type === 'network_error' ? 'rgba(239,68,68,0.15)' : (evt.type === 'performance' || evt.type === 'network_slow' ? 'rgba(245,158,11,0.15)' : 'rgba(59,130,246,0.15)');
                      const badgeColor = evt.type === 'error' || evt.type === 'network_error' ? '#ef4444' : (evt.type === 'performance' || evt.type === 'network_slow' ? '#fbbf24' : '#60a5fa');

                      return (
                        <div 
                          key={evt.id} 
                          style={{ border: '1px solid rgba(255,255,255,0.06)', padding: '10px', borderRadius: 'var(--radius-sm)', background: 'rgba(255,255,255,0.01)', fontSize: '0.8rem', display: 'flex', flexDirection: 'column', gap: '4px' }}
                        >
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <span style={{ fontSize: '0.75rem', fontWeight: 'bold', color: 'var(--accent)' }}>Project: {evt.project}</span>
                            <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>{dateStr}</span>
                          </div>
                          
                          <div style={{ display: 'flex', gap: '6px', alignItems: 'center', marginTop: '2px' }}>
                            <span style={{ background: badgeBg, color: badgeColor, fontSize: '0.65rem', padding: '2px 6px', borderRadius: '4px', fontWeight: 'bold' }}>
                              {typeBadge}
                            </span>
                            {evt.count > 1 && (
                              <span style={{ background: 'rgba(255, 255, 255, 0.1)', color: 'var(--text-light)', fontSize: '0.65rem', padding: '2px 6px', borderRadius: '4px', fontWeight: 'bold' }}>
                                x{evt.count}
                              </span>
                            )}
                            <span style={{ fontWeight: '600' }}>
                              {evt.type === 'error' && formatRedactedText(evt.data.message)}
                              {evt.type === 'promise' && formatRedactedText(evt.data.message)}
                              {evt.type === 'performance' && 'Zablokování UI hlavního vlákna'}
                              {evt.type === 'network_slow' && `Pomalé API: ${evt.data.method} ${getDomain(evt.data.url)}`}
                              {evt.type === 'network_error' && `Selhání API: HTTP ${evt.data.status} pro ${evt.data.method}`}
                            </span>
                          </div>

                          <div style={{ fontSize: '0.75rem', color: 'var(--text-dark)', wordBreak: 'break-all', background: 'rgba(0,0,0,0.1)', padding: '6px', borderRadius: '4px', fontFamily: 'monospace' }}>
                            {evt.type === 'error' && `Chyba v ${evt.data.filename || 'unknown'}:${evt.data.lineno || 0}`}
                            {evt.type === 'promise' && `Neošetřený Slib (Promise rejection)`}
                            {evt.type === 'performance' && `Trvání blokování: ${evt.data.duration} ms`}
                            {evt.type === 'network_slow' && `Odezva: ${evt.data.duration} ms, URL: ${evt.data.url}`}
                            {evt.type === 'network_error' && `URL: ${evt.data.url}`}
                          </div>

                          {/* Auto-Heal: handler i serverový endpoint existovaly,
                              ale z UI nešlo nic spustit a patch se neměl kde
                              zobrazit — celá funkce byla nedostupná. */}
                          {(evt.type === 'error' || evt.type === 'promise') && (
                            <div style={{ marginTop: '6px' }}>
                              <button
                                type="button"
                                className="btn btn-secondary"
                                disabled={Boolean(autoHealLoading[evt.id])}
                                onClick={() => handleAutoHeal(evt)}
                                style={{ padding: '3px 8px', fontSize: '0.7rem', display: 'inline-flex', alignItems: 'center', gap: '4px' }}
                              >
                                <Wrench size={12} />
                                {autoHealLoading[evt.id] ? 'Generuji návrh…' : 'Navrhnout opravu (Auto-Heal)'}
                              </button>

                              {autoHealPatch[evt.id] && (
                                <pre style={{ marginTop: '6px', background: 'black', color: '#a9b7c6', padding: '8px', borderRadius: '4px', fontSize: '0.7rem', whiteSpace: 'pre-wrap', maxHeight: '220px', overflowY: 'auto' }}>
                                  {autoHealPatch[evt.id]}
                                </pre>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })
                  )}
                </div>
              </div>

            </div>
          )}
        </div>
      </main>

      {/* Skrytý tiskový report (Executive Summary) */}
      {/* Tiskový report je lazy — na obrazovce je skrytý přes .print-only,
          takže do hlavního bundlu ani do každého renderu nepatří. */}
      <Suspense fallback={null}>
        <PrintReport
          user={user}
          agentUrl={agentUrl}
          liveLogs={liveLogs}
          a11yResult={a11yResult}
          nis2Result={nis2Result}
          greenResult={greenResult}
          craResult={craResult}
          craVulnResult={craVulnResult}
          cookieResult={cookieResult}
          aiActResult={aiActResult}
          monitorPageResult={monitorPageResult}
          monitorFormResult={monitorFormResult}
          securityAnalysisResult={securityAnalysisResult}
          chaosResult={chaosResult}
          selectedTestType={selectedTestType}
          authEmail={authEmail}
        />
      </Suspense>

    </div>
  );
}
