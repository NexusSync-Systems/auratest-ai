import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { runAutonomousTest, comparePages, auditTranslations, extractInternalLinks } from './agent.js';
import { fetchTranslations } from './db-connector.js';

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

app.use(cors());
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
app.get('/api/sessions', (req, res) => {
  const list = Array.from(sessions.values()).map(s => ({
    id: s.id,
    url: s.url,
    goal: s.goal,
    status: s.status,
    stepCount: s.steps.length,
    bugsCount: s.bugs.length,
    summary: s.summary,
    timestamp: s.timestamp
  }));
  res.json(list.reverse());
});

app.get('/api/sessions/:id', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) {
    return res.status(404).json({ error: 'Relace nenalezena.' });
  }
  res.json(session);
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
app.post('/api/run-test', async (req, res) => {
  const { url, goal, model, host, headless, maxSteps, mode, provider, testLogin, testPassword } = req.body;

  if (!url || (mode !== 'monkey' && mode !== 'smart_monkey' && !goal)) {
    return res.status(400).json({ error: 'Chybí URL nebo cíl testu.' });
  }

  const sessionId = `session_${Date.now()}`;
  const sessionData = {
    id: sessionId,
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
          broadcastToSession(sessionId, { type: 'step', step: stepInfo });
        }, sessionId);

          sessionData.status = 'completed';
          sessionData.bugs = result.bugs;
          sessionData.summary = result.summary;
          broadcastToSession(sessionId, {
            type: 'completed',
            bugs: result.bugs,
            summary: result.summary,
            success: result.success,
            performanceMetrics: result.performanceMetrics,
            generatedScript: result.generatedScript,
            videoUrl: result.videoUrl
          });
        }
      } catch (err) {
        sessionData.status = 'failed';
        sessionData.summary = `Selhání testu: ${err.message}`;
        sessionData.bugs.push(`Kritická chyba backendu: ${err.message}`);
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
app.post('/api/trigger-test', async (req, res) => {
  const { url, goal, mode, headless, maxSteps, testLogin, testPassword } = req.body;
  if (!url) return res.status(400).json({ error: 'Chybí URL pro test.' });

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
    const result = await runAutonomousTest(url, goal || 'Automatický CI/CD test', llmConfig, () => {});
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 2. Compare Pages (Prod vs Preview Diff)
app.post('/api/compare', async (req, res) => {
  const { url1, url2 } = req.body;

  if (!url1 || !url2) {
    return res.status(400).json({ error: 'Chybí URL1 nebo URL2 pro srovnání.' });
  }

  try {
    const diffResult = await comparePages(url1, url2);
    res.json(diffResult);
  } catch (err) {
    res.status(500).json({ error: `Chyba při porovnávání stránek: ${err.message}` });
  }
});

// 3. Audit Translations
app.post('/api/audit-translations', async (req, res) => {
  const { url, translationSource, model, host, provider } = req.body;

  if (!url || !translationSource) {
    return res.status(400).json({ error: 'Chybí URL nebo specifikace zdroje překladů.' });
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

    const auditResult = await auditTranslations(url, dictionary, llmConfig);
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

server.listen(PORT, () => {
  console.log(`AuraTest AI server běží na http://localhost:${PORT}`);
});
