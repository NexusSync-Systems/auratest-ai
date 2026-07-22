import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { runAutonomousTest, comparePages, auditTranslations, extractInternalLinks, analyzeSecurityVulnerabilities, auditAccessibility, auditNIS2AndPQC, auditGreenAndResidency, generateAutoHealPatch, auditCRA_SBOM, runChaosTest, getGridEnergyStatus, auditAIAct, auditStrictCookies, auditCRAVulnerabilities, checkPage, checkForm } from './agent.js';
import { fetchTranslations } from './db-connector.js';
import { authenticateToken } from './auth.js';
import { assertPublicHttpUrl } from './ssrf-guard.js';
import { verifySlackRequest, parseSlackPayload } from './slack-verify.js';
import { sendSlackNotification } from './slack-notifier.js';
import * as db from './db.js';
import { redactEventData } from './pii-redactor.js';

// Global error handlers to prevent unhandled rejections from crashing the process
process.on('uncaughtException', (err) => {
  console.error('Kritická chyba: Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Kritická chyba: Unhandled Rejection at:', promise, 'reason:', reason);
});

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

// CORS: veřejné SDK/telemetrické cesty mají otevřené CORS (volají je weby
// zákazníků), zbytek API je omezen na povolené originy z ALLOWED_ORIGINS.
// V dev (bez ALLOWED_ORIGINS) se povolí lokální vývojové originy.
const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:5173,http://localhost:3000')
  .split(',').map((s) => s.trim()).filter(Boolean);

const publicCors = cors(); // permisivní — pro veřejné SDK endpointy
const restrictedCors = cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true); // server-to-server / curl / stejný původ
    return cb(null, allowedOrigins.includes(origin));
  },
  credentials: true,
});

app.use((req, res, next) => {
  const isPublicSdk =
    req.path.startsWith('/sdk') ||
    req.path === '/api/auraguard/report' ||
    req.path === '/api/auraguard/sdk.js';
  return (isPublicSdk ? publicCors : restrictedCors)(req, res, next);
});

app.use(express.json({ limit: '10mb' }));

const __dirname = path.resolve();
const screenshotsDir = path.join(__dirname, 'screenshots');
if (!fs.existsSync(screenshotsDir)) {
  fs.mkdirSync(screenshotsDir, { recursive: true });
}
app.use('/api/screenshots', express.static(screenshotsDir));

const videosDir = path.join(__dirname, 'videos');
if (!fs.existsSync(videosDir)) {
  fs.mkdirSync(videosDir, { recursive: true });
}
app.use('/api/videos', express.static(videosDir));

const sdkDir = path.join(__dirname, 'public/sdk');
if (!fs.existsSync(sdkDir)) {
  fs.mkdirSync(sdkDir, { recursive: true });
}
app.use('/sdk', express.static(sdkDir));

const PORT = process.env.PORT || 3001;

// In-memory sessions store
const sessions = new Map();
// WebSocket clients map: sessionId -> Set of WS connections
const wsClients = new Map();

// Helper to broadcast step updates to WebSocket clients for a session
function broadcastToSession(sessionId, data) {
  const clients = wsClients.get(sessionId);
  if (clients) {
    const payload = JSON.stringify(data);
    clients.forEach((ws) => {
      if (ws.readyState === 1) { // OPEN
        ws.send(payload);
      }
    });
  }
}

// REST Endpoints
app.get('/api/sessions', authenticateToken, async (req, res) => {
  try {
    const list = await db.getSessions(req.user.userId);
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/sessions/:id', authenticateToken, async (req, res) => {
  try {
    const session = await db.getSession(req.params.id);
    if (!session) {
      return res.status(404).json({ error: 'Relace nenalezena.' });
    }
    if (session.userId !== req.user.userId) {
      return res.status(403).json({ error: 'Přístup odepřen. Relace nepatří vám.' });
    }
    res.json(session);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Mock translations API for dynamic loading test
app.get('/api/mock-translations', (req, res) => {
  res.json({
    "hn.title": "Hacker News",
    "hn.new": "new",
    "hn.past": "past",
    "hn.comments": "comments",
    "hn.ask": "ask",
    "hn.show": "show",
    "hn.jobs": "jobs",
    "hn.submit": "submit"
  });
});

// 1. Run Autonomous Test
app.post('/api/run-test', authenticateToken, async (req, res) => {
  const { url, goal, model, host, headless, maxSteps, mode, provider, testLogin, testPassword } = req.body;

  if (!url || (mode !== 'monkey' && mode !== 'smart_monkey' && !goal)) {
    return res.status(400).json({ error: 'Chybí URL nebo cíl testu.' });
  }

  const sessionId = `session_${Date.now()}`;
  const sessionData = {
    id: sessionId,
    userId: req.user.userId,
    url,
    goal: mode === 'monkey' 
      ? 'Průzkumný test (Monkey Mode - bez AI)' 
      : (mode === 'smart_monkey' ? 'Chytrý průzkum s AI (Smart Monkey)' : goal),
    status: 'running',
    steps: [],
    bugs: [],
    summary: '',
    timestamp: new Date().toISOString()
  };

  sessions.set(sessionId, sessionData);
  await db.saveSession(sessionId, sessionData);

  // Return sessionId immediately, run Playwright test in background
  res.json({ sessionId, status: 'running' });

  // Background agent run
  const llmConfig = {
    provider: provider || 'ollama',
    model: model || 'llama3',
    host: host || 'http://localhost:11434',
    headless: headless !== false,
    maxSteps: parseInt(maxSteps) || 10,
    mode: mode || 'ai',
    testLogin: testLogin || '',
    testPassword: testPassword || ''
  };

  (async () => {
    try {
      try {
        if (mode === 'crawler') {
          broadcastToSession(sessionId, { type: 'progress', message: '🕷️ CRAWLER: Hledám podstránky na webu...' });
          const links = await extractInternalLinks(url);
          const targetUrls = [url, ...links].slice(0, 4); // home + max 3 links

          let totalBugs = [];
          let combinedScripts = '';
          let lastPerformance = null;
          let lastVideoUrl = null;

          for (const targetUrl of targetUrls) {
            broadcastToSession(sessionId, { type: 'progress', message: `🕷️ CRAWLER: Otevírám ${targetUrl}` });
            const result = await runAutonomousTest(targetUrl, 'Prozkoumat funkčnost', { ...llmConfig, maxSteps: 5 }, (stepInfo) => {
              if (stepInfo.step === 0) return;
              stepInfo.action = `[${new URL(targetUrl).pathname}] ${stepInfo.action || ''}`;
              sessionData.steps.push(stepInfo);
              db.saveSession(sessionId, sessionData);
              broadcastToSession(sessionId, { type: 'step', step: stepInfo });
            }, sessionId);

            totalBugs.push(...result.bugs);
            lastPerformance = result.performanceMetrics || lastPerformance;
            lastVideoUrl = result.videoUrl || lastVideoUrl;
            if (result.generatedScript) {
              combinedScripts += `\n// --- Test pro ${targetUrl} ---\n` + result.generatedScript;
            }
          }

          sessionData.status = 'completed';
          sessionData.bugs = [...new Set(totalBugs)];
          sessionData.summary = `Crawler prozkoumal ${targetUrls.length} stránek. Nalezeno ${sessionData.bugs.length} chyb.`;
          sessionData.generatedScript = combinedScripts;
          sessionData.performanceMetrics = lastPerformance;
          sessionData.videoUrl = lastVideoUrl;
          await db.saveSession(sessionId, sessionData);

          broadcastToSession(sessionId, {
            type: 'completed',
            bugs: sessionData.bugs,
            summary: sessionData.summary,
            success: sessionData.bugs.length === 0,
            generatedScript: combinedScripts,
            performanceMetrics: lastPerformance,
            videoUrl: lastVideoUrl
          });

        } else {
          const result = await runAutonomousTest(url, sessionData.goal, llmConfig, (stepInfo) => {
            if (stepInfo.step === 0) {
              broadcastToSession(sessionId, { type: 'progress', message: stepInfo.detail });
              return;
            }
            sessionData.steps.push(stepInfo);
            db.saveSession(sessionId, sessionData);
            broadcastToSession(sessionId, { type: 'step', step: stepInfo });
          }, sessionId);

          sessionData.status = 'completed';
          sessionData.bugs = result.bugs;
          sessionData.summary = result.summary;
          sessionData.performanceMetrics = result.performanceMetrics;
          sessionData.generatedScript = result.generatedScript;
          sessionData.videoUrl = result.videoUrl;
          await db.saveSession(sessionId, sessionData);

          broadcastToSession(sessionId, {
            type: 'completed',
            bugs: result.bugs,
            summary: result.summary,
            success: result.success,
            performanceMetrics: result.performanceMetrics,
            generatedScript: result.generatedScript,
            videoUrl: result.videoUrl
          });

          // Odeslat do Slacku, pokud test najde chyby (zapojení AI do Slacku)
          if (!result.success && result.bugs && result.bugs.length > 0) {
            const channel = process.env.SLACK_CHANNEL || '#general';
            const blocks = [
              { type: 'section', text: { type: 'mrkdwn', text: `*Zpráva agenta:*\n${result.summary}` } },
              {
                type: 'actions',
                elements: [
                  { type: 'button', text: { type: 'plain_text', text: 'Spustit znovu', emoji: true }, style: 'primary', value: url, action_id: 'run_audit_again' },
                  { type: 'button', text: { type: 'plain_text', text: 'Ignorovat upozornění', emoji: true }, style: 'danger', value: 'ignore', action_id: 'ignore_alert' }
                ]
              }
            ];
            await sendSlackNotification(channel, 'AuraGuard AI: Nalezena funkční chyba na webu', `URL: *${url}*\nTestováno: _${sessionData.goal}_\nBugs: ${result.bugs.length}`, true, blocks, 'ai');
          }
        }
      } catch (err) {
        sessionData.status = 'failed';
        sessionData.summary = `Selhání testu: ${err.message}`;
        sessionData.bugs.push(`Kritická chyba backendu: ${err.message}`);
        await db.saveSession(sessionId, sessionData);

        broadcastToSession(sessionId, {
          type: 'failed',
          error: err.message,
          summary: `Test selhal: ${err.message}`
        });
      }
    } catch (criticalErr) {
      console.error('Fatální chyba v asynchronním procesu na pozadí:', criticalErr);
      broadcastToSession(sessionId, {
        type: 'failed',
        error: criticalErr.message,
        summary: `Interní chyba serveru: ${criticalErr.message}`
      });
    }
  })();
});

// 1.5 Trigger Autonomous Test (CI/CD integration - Synchronous)
// Strojová autentizace pro CI/CD trigger — vyžaduje sdílený bearer secret.
// Fail-closed: pokud TRIGGER_TEST_SECRET není nastaven, endpoint je zakázán.
function requireTriggerSecret(req, res, next) {
  const secret = process.env.TRIGGER_TEST_SECRET;
  if (!secret) {
    return res.status(503).json({ error: 'Endpoint je zakázán: chybí TRIGGER_TEST_SECRET v konfiguraci serveru.' });
  }
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token || token !== secret) {
    return res.status(401).json({ error: 'Neplatný nebo chybějící trigger token.' });
  }
  next();
}

app.post('/api/trigger-test', requireTriggerSecret, async (req, res) => {
  const { url, goal, mode, headless, maxSteps, testLogin, testPassword } = req.body;
  if (!url) return res.status(400).json({ error: 'Chybí URL pro test.' });

  // SSRF ochrana: povol jen veřejné http(s) cíle (blokuj interní/metadata IP).
  let safeUrl;
  try {
    safeUrl = await assertPublicHttpUrl(url);
  } catch (err) {
    return res.status(400).json({ error: `Nepovolená cílová URL: ${err.message}` });
  }

  const llmConfig = {
    provider: 'ollama',
    model: 'llama3',
    host: 'http://localhost:11434',
    headless: headless !== false,
    maxSteps: parseInt(maxSteps) || 10,
    mode: mode || 'smoke_test',
    testLogin: testLogin || '',
    testPassword: testPassword || ''
  };

  try {
    const result = await runAutonomousTest(safeUrl, goal || 'Automatický CI/CD test', llmConfig, () => {});
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- AURAAURAGUARD SYNTHETIC MONITORS & TELEMETRY ---

// Helper to broadcast to all WebSocket clients regardless of sessionId
function broadcastToAll(data) {
  const payload = JSON.stringify(data);
  wsClients.forEach((clientsSet) => {
    clientsSet.forEach((ws) => {
      if (ws.readyState === 1) { // OPEN
        ws.send(payload);
      }
    });
  });
}

// Background scheduler running every minute
const schedulerInterval = setInterval(async () => {
  try {
    const activeMonitors = await db.getAllActiveMonitors();
    const now = Date.now();

    for (const monitor of activeMonitors) {
      const intervalMap = {
        '1m': 60000,
        '5m': 300000,
        '15m': 900000,
        '1h': 3600000,
        '12h': 43200000,
        '24h': 86400000
      };
      const intervalMs = intervalMap[monitor.interval] || 3600000;
      const lastRun = monitor.lastRunTime || 0;

      if (now - lastRun >= intervalMs) {
        // Update lastRunTime in db immediately to prevent duplicate runs
        await db.updateMonitor(monitor.id, { lastRunTime: now });

        const sessionId = `session_monitor_${monitor.id}_${Date.now()}`;
        console.log(`[AuraAuraGuard] Spouštím monitor: ${monitor.name} (${monitor.url}) -> ${sessionId}`);

        const sessionData = {
          id: sessionId,
          userId: monitor.userId,
          url: monitor.url,
          goal: monitor.goal,
          status: 'running',
          steps: [],
          bugs: [],
          summary: 'Syntetický monitoring na pozadí...',
          timestamp: new Date().toISOString(),
          isSynthetic: true,
          monitorId: monitor.id
        };
        await db.saveSession(sessionId, sessionData);

        const llmConfig = {
          provider: monitor.provider || 'ollama',
          model: monitor.model || 'llama3',
          host: monitor.host || 'http://localhost:11434',
          headless: true,
          maxSteps: monitor.maxSteps || 10,
          mode: 'ai',
          trackExceptions: monitor.trackExceptions !== false,
          trackPromiseRejections: monitor.trackPromiseRejections !== false,
          trackLongTasks: monitor.trackLongTasks !== false,
          trackNetworkErrors: monitor.trackNetworkErrors !== false,
          slowApiThresholdMs: monitor.slowApiThresholdMs || 1500
        };

        (async () => {
          try {
            const result = await runAutonomousTest(
              monitor.url,
              monitor.goal,
              llmConfig,
              (progress) => {
                if (progress.step === 0) return;
                sessionData.steps.push(progress);
                db.saveSession(sessionId, sessionData);
                broadcastToSession(sessionId, { type: 'step', step: progress });
              },
              sessionId
            );

            sessionData.status = 'completed';
            sessionData.bugs = result.bugs;
            sessionData.summary = result.summary;
            sessionData.performanceMetrics = result.performanceMetrics;
            sessionData.generatedScript = result.generatedScript;
            sessionData.videoUrl = result.videoUrl;
            await db.saveSession(sessionId, sessionData);

            await db.updateMonitor(monitor.id, {
              lastRunStatus: result.bugs.length === 0 ? 'success' : 'failure',
              lastRunBugsCount: result.bugs.length
            });

            const userMonitors = await db.getMonitors(monitor.userId);
            broadcastToAll({ type: 'monitors_updated', monitors: userMonitors });
          } catch (err) {
            console.error(`[AuraAuraGuard] Monitor ${monitor.name} selhal:`, err.message);
            sessionData.status = 'failed';
            sessionData.bugs.push(`Kritická chyba plánovače: ${err.message}`);
            await db.saveSession(sessionId, sessionData);

            await db.updateMonitor(monitor.id, { lastRunStatus: 'error' });

            const userMonitors = await db.getMonitors(monitor.userId);
            broadcastToAll({ type: 'monitors_updated', monitors: userMonitors });
          }
        })();
      }
    }
  } catch (err) {
    console.error('Chyba plánovače na pozadí:', err.message);
  }
}, 60000);

if (schedulerInterval && typeof schedulerInterval.unref === 'function') {
  schedulerInterval.unref();
}

// REST Endpoints for Projects
app.get('/api/projects', authenticateToken, async (req, res) => {
  try {
    const list = await db.getProjects(req.user.userId);
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/projects', authenticateToken, async (req, res) => {
  const { name, allowedOrigins } = req.body;
  if (!name) return res.status(400).json({ error: 'Chybí název projektu.' });

  try {
    const newProject = await db.createProject(req.user.userId, name, allowedOrigins || []);
    res.status(201).json(newProject);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/projects/:id', authenticateToken, async (req, res) => {
  try {
    const project = await db.getProjectByKey(req.params.id);
    if (!project) return res.status(404).json({ error: 'Projekt nenalezen.' });
    if (project.userId !== req.user.userId) return res.status(403).json({ error: 'Přístup odepřen.' });

    await db.deleteProject(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// REST Endpoints for Monitors
app.get('/api/monitors', authenticateToken, async (req, res) => {
  try {
    const list = await db.getMonitors(req.user.userId);
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/monitors', authenticateToken, async (req, res) => {
  const { name, url, goal, interval, provider, model, host, maxSteps, trackExceptions, trackPromiseRejections, trackLongTasks, trackNetworkErrors, slowApiThresholdMs } = req.body;
  if (!name || !url) {
    return res.status(400).json({ error: 'Chybí název nebo URL monitoru.' });
  }

  try {
    const newMonitor = await db.createMonitor(req.user.userId, {
      name,
      url,
      goal: goal || 'Prohledej stránku a najdi jakékoliv chyby',
      interval: interval || '1h',
      provider: provider || 'ollama',
      model: model || 'llama3',
      host: host || 'http://localhost:11434',
      maxSteps: parseInt(maxSteps) || 10,
      trackExceptions: trackExceptions !== false,
      trackPromiseRejections: trackPromiseRejections !== false,
      trackLongTasks: trackLongTasks !== false,
      trackNetworkErrors: trackNetworkErrors !== false,
      slowApiThresholdMs: parseInt(slowApiThresholdMs) || 1500
    });
    res.status(201).json(newMonitor);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/monitors/:id', authenticateToken, async (req, res) => {
  try {
    const monitor = await db.getMonitorById(req.params.id);
    if (!monitor) return res.status(404).json({ error: 'Monitor nenalezen.' });
    if (monitor.userId !== req.user.userId) return res.status(403).json({ error: 'Přístup odepřen.' });

    const updated = await db.updateMonitor(req.params.id, req.body);
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/monitors/:id', authenticateToken, async (req, res) => {
  try {
    const monitor = await db.getMonitorById(req.params.id);
    if (!monitor) return res.status(404).json({ error: 'Monitor nenalezen.' });
    if (monitor.userId !== req.user.userId) return res.status(403).json({ error: 'Přístup odepřen.' });

    await db.deleteMonitor(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// REST Endpoints for AuraGuard Live Telemetry
app.get('/api/auraguard/events', authenticateToken, async (req, res) => {
  try {
    const list = await db.getAuraGuardEvents(req.user.userId);
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Endpoint pro manuální spuštění AI bezpečnostní analýzy
app.post('/api/auraguard/analyze-security', authenticateToken, async (req, res) => {
  try {
    const { events } = req.body; // Můžeme poslat vybrané události
    if (!events || !Array.isArray(events)) {
      return res.status(400).json({ error: 'Missing or invalid events array' });
    }
    
    // Validace, že události patří projektům uživatele (zjednodušeně, ověřujeme na frontendu)
    // Ideálně by server ještě zkontroloval, jestli event.project patří req.user.userId
    
    const analysis = await analyzeSecurityVulnerabilities(events, { provider: 'ollama', model: 'llama3' });
    res.json({ analysis });
  } catch (err) {
    console.error('Error during security analysis:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auraguard/analyze-accessibility', authenticateToken, async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'Chybí URL pro audit' });
    
    const report = await auditAccessibility(url);
    res.json(report);
  } catch (err) {
    console.error('Error during accessibility audit:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auraguard/analyze-nis2', authenticateToken, async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'Chybí URL pro audit' });
    
    const report = await auditNIS2AndPQC(url);
    res.json(report);
  } catch (err) {
    console.error('Error during NIS2 audit:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auraguard/analyze-green-gdpr', authenticateToken, async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'Chybí URL pro audit' });
    
    const report = await auditGreenAndResidency(url);
    res.json(report);
  } catch (err) {
    console.error('Error during Green/GDPR audit:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auraguard/analyze-cra', authenticateToken, async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'Chybí URL pro CRA SBOM audit' });
    
    const report = await auditCRA_SBOM(url);
    res.json(report);
  } catch (err) {
    console.error('Error during CRA SBOM audit:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auraguard/auto-heal', authenticateToken, async (req, res) => {
  try {
    const { eventData, llmConfig } = req.body;
    if (!eventData) return res.status(400).json({ error: 'Chybí data události' });
    
    const result = await generateAutoHealPatch(eventData, llmConfig || {});
    res.json({ patch: result.text || result.response || result });
  } catch (err) {
    console.error('Error during Auto-Heal:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auraguard/chaos-test', authenticateToken, async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'Chybí URL pro DORA Chaos test' });
    
    const report = await runChaosTest(url);
    res.json(report);
  } catch (err) {
    console.error('Error during DORA Chaos test:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/auraguard/grid-status', authenticateToken, (req, res) => {
  try {
    const status = getGridEnergyStatus();
    res.json(status);
  } catch (err) {
    console.error('Error getting grid status:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auraguard/ai-act-audit', authenticateToken, async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'Chybí URL' });
    const report = await auditAIAct(url);
    res.json(report);
  } catch (err) {
    console.error('Error during AI Act audit:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auraguard/cookie-audit', authenticateToken, async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'Chybí URL' });
    const report = await auditStrictCookies(url);
    res.json(report);
  } catch (err) {
    console.error('Error during Cookie audit:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auraguard/cra-vuln-audit', authenticateToken, async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL je povinné.' });
    const result = await auditCRAVulnerabilities(url);
    res.json(result);
  } catch (error) {
    console.error('CRA Vuln Audit error:', error);
    res.status(500).json({ error: error.message || 'CRA Vuln selhal' });
  }
});

app.post('/api/auraguard/monitor-page', authenticateToken, async (req, res) => {
  try {
    const { target } = req.body;
    if (!target || !target.url) return res.status(400).json({ error: 'Cíl monitoringu (url) je povinný.' });
    const result = await checkPage(target);
    
    // Slack notifikace při výpadku
    if (!result.ok) {
      const channel = process.env.SLACK_CHANNEL || '#general';
      const blocks = [
        { type: 'section', text: { type: 'mrkdwn', text: `*Detail chyby:*\n${result.error || 'Neznámá chyba'}` } },
        { type: 'context', elements: [{ type: 'mrkdwn', text: `Odezva: ${result.responseTime}ms` }] },
        { type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: 'Zkontrolovat znovu', emoji: true }, style: 'primary', value: target.url, action_id: 'run_audit_again' }] }
      ];
      await sendSlackNotification(channel, 'AuraGuard: VÝPADEK WEBU', `Stránka *${target.url}* neodpovídá správně!`, true, blocks, 'uptime');
    }
    
    res.json(result);
  } catch (error) {
    console.error('Monitor Page error:', error);
    res.status(500).json({ error: error.message || 'Monitor Page selhal' });
  }
});

app.post('/api/auraguard/monitor-form', authenticateToken, async (req, res) => {
  try {
    const { target } = req.body;
    if (!target || !target.url) return res.status(400).json({ error: 'Cíl formuláře (url) je povinný.' });
    const result = await checkForm(target);

    // Slack notifikace při chybě formuláře
    if (!result.ok) {
      const channel = process.env.SLACK_CHANNEL || '#general';
      const blocks = [
        { type: 'section', text: { type: 'mrkdwn', text: `*Detail chyby:*\n${result.error || 'Formulář nešel odeslat'}` } },
        { type: 'context', elements: [{ type: 'mrkdwn', text: `Odezva: ${result.responseTime}ms` }] }
      ];
      await sendSlackNotification(channel, 'AuraGuard: CHYBA FORMULÁŘE', `Formulář na *${target.url}* selhal v odeslání.`, true, blocks, 'uptime');
    }
    
    res.json(result);
  } catch (error) {
    console.error('Monitor Form error:', error);
    res.status(500).json({ error: error.message || 'Monitor Form selhal' });
  }
});

// --- Slack Interactivity Endpoint ---
// Přijímá události typu "kliknutí na tlačítko" ze Slack zpráv
// Slack route zachytává RAW tělo (express.raw), aby šlo ověřit podpis.
app.post('/api/slack/events', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
  try {
    const rawBody = req.body; // Buffer (díky express.raw)

    // Ověření pravosti požadavku podle Slack podpisu (v0).
    const verdict = verifySlackRequest(rawBody, req.headers);
    if (!verdict.ok) {
      console.warn('[Slack] Odmítnut neověřený požadavek:', verdict.reason);
      return res.status(401).send('Neplatný podpis');
    }

    const payload = parseSlackPayload(rawBody);
    if (!payload) {
      return res.status(400).send('Chybí nebo neplatný payload');
    }

    // Rychlá odpověď Slacku, že jsme request přijali
    res.status(200).send();
    
    if (payload.type === 'block_actions') {
      const action = payload.actions[0];
      const channelId = payload.channel.id;
      
      console.log(`Slack uživatel ${payload.user.username} kliknul na tlačítko: ${action.action_id} s hodnotou: ${action.value}`);
      
      if (action.action_id === 'run_audit_again') {
        const urlToTest = action.value;
        // Zašleme potvrzení do vlákna (nebo do kanálu)
        await sendSlackNotification(
          channelId,
          'Test znovu spuštěn',
          `Spouštím nový on-demand test pro URL: ${urlToTest} na žádost uživatele @${payload.user.username}...`,
          false,
          [],
          'compliance' // Pro teď použijeme compliance jako fallback
        );
        // Zde by normálně následovalo asynchronní volání agent.js (runAutonomousTest nebo podobně)
        // ...
      } else if (action.action_id === 'ignore_alert') {
        await sendSlackNotification(
          channelId,
          'Upozornění ignorováno',
          `Uživatel @${payload.user.username} označil tento alert jako vyřešený.`,
          false,
          [],
          'compliance'
        );
      }
    }
  } catch (err) {
    console.error('Chyba při zpracování Slack události:', err);
    if (!res.headersSent) res.status(500).send('Interní chyba serveru');
  }
});

// Uchování v paměti nedávných eventů pro deduplikaci (v produkci použít např. Redis)
const recentEventsCache = new Map();
const CACHE_TTL_MS = 60 * 60 * 1000; // 60 minut

app.post('/api/auraguard/report', async (req, res) => {
  const { project, type, data, timestamp } = req.body;
  if (!project) return res.status(400).json({ error: 'Chybí ID projektu.' });

  try {
    const proj = await db.getProjectByKey(project);
    if (!proj) return res.status(404).json({ error: 'Projekt nebyl nalezen nebo je neaktivní.' });
    if (!proj.active) return res.status(403).json({ error: 'Projekt je deaktivován.' });

    // Ověření povolených domén (Origin check)
    const origin = req.headers.origin || req.headers.referer;
    if (proj.allowedOrigins && proj.allowedOrigins.length > 0 && origin) {
      const match = proj.allowedOrigins.some(o => origin.startsWith(o));
      if (!match) {
        return res.status(403).json({ error: 'Přístup zamítnut. Nepovolená doména odesílatele.' });
      }
    }

    // GDPR AI Sentinel (RegEx Layer) - Cenzura PII před uložením do DB
    const redactedData = redactEventData(data || {});

    // Eco-Mode Deduplikace: Kontrola, zda už stejná chyba neexistuje v cache
    const eventSignature = `${project}:${type}:${redactedData.message || ''}:${redactedData.filename || ''}:${redactedData.lineno || ''}`;
    
    if (recentEventsCache.has(eventSignature)) {
      const cachedEvent = recentEventsCache.get(eventSignature);
      if (Date.now() - cachedEvent.lastSeen < CACHE_TTL_MS) {
        // Pouze zvedneme počítadlo, neukládáme nový event
        cachedEvent.count += 1;
        cachedEvent.lastSeen = Date.now();
        
        // Aktualizace existujícího záznamu v DB (pokud by to bylo žádoucí) - pro jednoduchost zde jen notifikujeme WSS
        // Notifikujeme frontend (WSS), že počet se zvýšil
        if (req.app.locals.wss) {
          req.app.locals.wss.clients.forEach(client => {
            if (client.readyState === 1 && client.projectId === project) {
              client.send(JSON.stringify({ 
                type: 'event_deduplicated', 
                data: { id: cachedEvent.id, count: cachedEvent.count, timestamp: new Date().toISOString() } 
              }));
            }
          });
        }
        
        return res.status(200).json({ success: true, deduplicated: true, count: cachedEvent.count });
      }
    }

    const newEvent = await db.createAuraGuardEvent({
      project,
      type: type || 'error',
      data: redactedData,
      timestamp: timestamp || new Date().toISOString()
    });
    
    // Uložení do deduplikační cache
    recentEventsCache.set(eventSignature, {
      id: newEvent.id,
      count: 1,
      lastSeen: Date.now()
    });

    broadcastToAll({ type: 'auraguard_live_event', event: newEvent });
    res.json({ success: true, eventId: newEvent.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/auraguard/sdk.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.send(`
(function() {
  const scriptTag = document.currentScript;
  const project = scriptTag ? scriptTag.getAttribute('data-project') : '';
  const trackErrors = scriptTag ? scriptTag.getAttribute('data-track-errors') !== 'false' : true;
  const trackPerf = scriptTag ? scriptTag.getAttribute('data-track-perf') !== 'false' : true;
  const slowThreshold = parseInt(scriptTag ? scriptTag.getAttribute('data-slow-api-threshold') : '1500') || 1500;
  const reportUrl = '${req.protocol}://${req.get('host')}/api/auraguard/report';

  if (!project) {
    console.error('[AuraAuraGuard] Chybí data-project atribut pro odesílání logů.');
    return;
  }

  function sendReport(type, data) {
    fetch(reportUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: project, type: type, data: data, timestamp: new Date().toISOString() })
    }).catch(function() {});
  }

  if (trackErrors) {
    window.addEventListener('error', function(event) {
      if (!event.message) return;
      sendReport('error', {
        message: event.message,
        filename: event.filename,
        lineno: event.lineno,
        colno: event.colno
      });
    });

    window.addEventListener('unhandledrejection', function(event) {
      const reason = event.reason ? (event.reason.message || String(event.reason)) : 'Neznámý důvod';
      sendReport('promise', { message: reason });
    });
  }

  if (trackPerf) {
    try {
      const observer = new PerformanceObserver(function(list) {
        const entries = list.getEntries();
        for (let i = 0; i < entries.length; i++) {
          const entry = entries[i];
          if (entry.duration > 100) {
            sendReport('performance', {
              message: 'UI Thread blocked (Long Task)',
              duration: Math.round(entry.duration)
            });
          }
        }
      });
      observer.observe({ entryTypes: ['longtask'] });
    } catch (e) {}

    // Track slow fetch/xhr
    const originalFetch = window.fetch;
    if (originalFetch) {
      window.fetch = function(...args) {
        const start = Date.now();
        return originalFetch.apply(this, args).then(function(response) {
          const duration = Date.now() - start;
          if (duration > slowThreshold) {
            sendReport('network_slow', {
              url: response.url,
              duration: duration,
              status: response.status,
              method: 'FETCH'
            });
          }
          if (response.status >= 400) {
            sendReport('network_error', {
              url: response.url,
              status: response.status,
              method: 'FETCH'
            });
          }
          return response;
        });
      };
    }
  }
})();
  `);
});

// 2. Compare Pages (Prod vs Preview Diff)
app.post('/api/compare', authenticateToken, async (req, res) => {
  const { url1, url2 } = req.body;

  if (!url1 || !url2) {
    return res.status(400).json({ error: 'Chybí URL1 nebo URL2 pro srovnání.' });
  }

  // SSRF ochrana pro obě cílové URL.
  let safeUrl1, safeUrl2;
  try {
    safeUrl1 = await assertPublicHttpUrl(url1);
    safeUrl2 = await assertPublicHttpUrl(url2);
  } catch (err) {
    return res.status(400).json({ error: `Nepovolená cílová URL: ${err.message}` });
  }

  try {
    const diffResult = await comparePages(safeUrl1, safeUrl2);
    res.json(diffResult);
  } catch (err) {
    res.status(500).json({ error: `Chyba při porovnávání stránek: ${err.message}` });
  }
});

// 3. Audit Translations
app.post('/api/audit-translations', authenticateToken, async (req, res) => {
  const { url, translationSource, model, host, provider } = req.body;

  if (!url || !translationSource) {
    return res.status(400).json({ error: 'Chybí URL nebo specifikace zdroje překladů.' });
  }

  // SSRF ochrana pro auditovanou URL.
  let safeUrl;
  try {
    safeUrl = await assertPublicHttpUrl(url);
  } catch (err) {
    return res.status(400).json({ error: `Nepovolená cílová URL: ${err.message}` });
  }

  try {
    let dictionary = {};

    // Retrieve dictionary from custom source
    if (translationSource.type === 'file') {
      if (typeof translationSource.fileContent === 'string') {
        dictionary = JSON.parse(translationSource.fileContent);
      } else {
        dictionary = translationSource.fileContent || {};
      }
    } else {
      // Dynamic load from DB / API / Script
      dictionary = await fetchTranslations(translationSource);
    }

    const llmConfig = {
      provider: provider || 'ollama',
      model: model || 'llama3',
      host: host || 'http://localhost:11434'
    };

    const auditResult = await auditTranslations(safeUrl, dictionary, llmConfig);
    res.json({
      success: true,
      dictionarySize: Object.keys(dictionary).length,
      ...auditResult
    });

  } catch (err) {
    res.status(500).json({ error: `Chyba při auditu překladů: ${err.message}` });
  }
});

// Handle WebSocket connections
server.on('upgrade', (request, socket, head) => {
  try {
    const { pathname, searchParams } = new URL(request.url, `http://${request.headers.host}`);

    if (pathname === '/ws') {
      const sessionId = searchParams.get('sessionId');
      if (!sessionId) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request, sessionId);
      });
    } else {
      socket.destroy();
    }
  } catch (err) {
    socket.destroy();
  }
});

wss.on('connection', (ws, request, sessionId) => {
  if (!wsClients.has(sessionId)) {
    wsClients.set(sessionId, new Set());
  }
  wsClients.get(sessionId).add(ws);

  ws.on('close', () => {
    const clients = wsClients.get(sessionId);
    if (clients) {
      clients.delete(ws);
      if (clients.size === 0) {
        wsClients.delete(sessionId);
      }
    }
  });
});

// Fallback to static serving if frontend dist folder exists
const frontendDistPath = path.join(__dirname, 'frontend', 'dist');
if (fs.existsSync(frontendDistPath)) {
  app.use(express.static(frontendDistPath));
  app.get('*', (req, res) => {
    res.sendFile(path.join(frontendDistPath, 'index.html'));
  });
}

// Global Express error handling middleware
app.use((err, req, res, next) => {
  console.error('Express zachytil neošetřenou chybu routy:', err);
  res.status(500).json({ error: 'Interní chyba serveru.', details: err.message });
});

if (process.env.NODE_ENV !== 'test') {
  server.listen(PORT, () => {
    console.log(`AuraTest AI server běží na http://localhost:${PORT}`);
  });
}

export { app };
