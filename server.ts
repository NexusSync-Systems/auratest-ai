import express, { Request, Response, NextFunction } from 'express';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { runAutonomousTest, comparePages, auditTranslations, extractInternalLinks, extractInteractiveElements, LLMConfig } from './agent.js';
import { fetchTranslations, TranslationConfig } from './db-connector.js';
import { spawn } from 'child_process';
import { chromium } from 'playwright';

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

// --- Rate Limiting (Security for Public Demo) ---
const ipRequestCounts = new Map<string, { count: number; firstRequestAt: number }>();
const MAX_REQUESTS_PER_HOUR = 3;
const HOUR_IN_MS = 60 * 60 * 1000;

app.post('/api/*', (req: Request, res: Response, next: NextFunction) => {
  const ip = (req.headers['x-forwarded-for'] as string) || req.socket.remoteAddress || 'unknown';
  const now = Date.now();

  if (!ipRequestCounts.has(ip)) {
    ipRequestCounts.set(ip, { count: 1, firstRequestAt: now });
    return next();
  }

  const record = ipRequestCounts.get(ip)!;
  if (now - record.firstRequestAt > HOUR_IN_MS) {
    // Reset after an hour
    record.count = 1;
    record.firstRequestAt = now;
    return next();
  }

  record.count++;
  if (record.count > MAX_REQUESTS_PER_HOUR) {
    console.warn(`[RateLimit] Blokován požadavek z IP: ${ip} (Příliš mnoho testů)`);
    return res.status(429).json({ 
      error: 'Zkušební limit vyčerpán.', 
      message: 'Můžete spustit maximálně 3 testy za hodinu z jedné IP adresy. Ochrana proti spamu.' 
    });
  }

  next();
});
// ------------------------------------------------

// Interfaces
interface SessionData {
  id: string;
  url: string;
  goal: string;
  status: string;
  steps: any[];
  bugs: string[];
  summary: string;
  timestamp: string;
  generatedScript?: string;
  bugDetails?: any[];
}

// In-memory sessions store
const sessions = new Map<string, SessionData>();

// Helpers for Disk Persistence of Sessions
function saveSessionToDisk(session: SessionData) {
  try {
    const dir = path.join(process.cwd(), 'sessions');
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(path.join(dir, `${session.id}.json`), JSON.stringify(session, null, 2), 'utf8');
  } catch (err: any) {
    console.error(`[Server] Chyba ukládání relace na disk: ${err.message}`);
  }
}

function loadSessionsFromDisk() {
  try {
    const dir = path.join(process.cwd(), 'sessions');
    if (fs.existsSync(dir)) {
      const files = fs.readdirSync(dir);
      for (const file of files) {
        if (file.endsWith('.json')) {
          try {
            const content = fs.readFileSync(path.join(dir, file), 'utf8');
            const session = JSON.parse(content) as SessionData;
            sessions.set(session.id, session);
          } catch (e) {}
        }
      }
      console.log(`[Server] Načteno ${sessions.size} relací z disku.`);
    }
  } catch (err: any) {
    console.error(`[Server] Chyba načítání relací z disku: ${err.message}`);
  }
}

// Load sessions on startup
loadSessionsFromDisk();

// WebSocket clients map: sessionId -> Set of WS connections
const wsClients = new Map<string, Set<WebSocket>>();

function broadcastToSession(sessionId: string, data: any) {
  const clients = wsClients.get(sessionId);
  if (clients) {
    const payload = JSON.stringify(data);
    clients.forEach((ws) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(payload);
      }
    });
  }
}

// REST Endpoints
app.get('/api/sessions', (req: Request, res: Response) => {
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

app.get('/api/sessions/:id', (req: Request, res: Response) => {
  const session = sessions.get(req.params.id as string);
  if (!session) {
    return res.status(404).json({ error: 'Relace nenalezena.' });
  }
  res.json(session);
});

app.get('/api/mock-translations', (req: Request, res: Response) => {
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

// --- RECORDER STATE & ROUTES ---
let activeRecorderBrowser: any = null;
let activeRecorderPage: any = null;
let recordedSteps: any[] = [];
let recorderStatus: 'idle' | 'recording' = 'idle';
let recorderUrl = '';

app.post('/api/recorder/start', async (req: Request, res: Response) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'Chybí URL pro nahrávání.' });

  if (recorderStatus === 'recording') {
    return res.status(400).json({ error: 'Nahrávání již probíhá.' });
  }

  recordedSteps = [];
  recorderUrl = url;
  recorderStatus = 'recording';

  res.json({ status: 'recording', message: 'Spouštím prohlížeč pro nahrávání...' });

  (async () => {
    try {
      activeRecorderBrowser = await chromium.launch({ headless: false });
      const context = await activeRecorderBrowser.newContext({ viewport: { width: 1280, height: 720 } });
      
      // Expose binding to record action from the page
      await context.exposeBinding('recordAction', async ({ page }: { page: any }, actionData: { action: string; target: number | string; value: string | null; reasoning?: string }) => {
        const currentUrl = page.url();
        const title = await page.title();
        const interactiveElements = await extractInteractiveElements(page);
        
        const simplifiedElements = interactiveElements.map(el => {
          const item: any = { id: el.id, tag: el.tagName };
          if (el.text) item.text = el.text;
          if (el.type) item.type = el.type;
          if (el.placeholder) item.placeholder = el.placeholder;
          if (el.name) item.name = el.name;
          if (el.role) item.role = el.role;
          if (el.href) item.href = el.href;
          return item;
        });

        const systemPrompt = `You are AuraTest AI, an expert QA testing agent performing a Smart Monkey Test.
Your goal: Explore EVERY part of the application. Click nav links to discover new pages. Fill forms. Try to break the app.
Prioritize: 1) Unvisited navigation links (A tags) to new pages, 2) Input fields with edge-case data, 3) Buttons you haven't clicked.
You must reply ONLY with a JSON object in this format:
{
  "reasoning": "Detailní vysvětlení, proč tento prvek vybíráš a co očekáváš.",
  "action": "click" | "type" | "scroll" | "navigate" | "wait" | "finish",
  "target": 123,
  "value": "text to type, or 'down'/'up' for scroll, or URL for navigate, else null",
  "detected_bugs": ["Konkrétní popis chyby: Co se stalo, co bylo očekáváno, kde (prvek/stránka)."]
}

Rules:
- NAVIGATION FIRST: If you see A tags with href pointing to a NEW page (not in visited URLs list), CLICK THEM! Use 'navigate' action with the full URL if needed.
- INPUT FIELDS: MUST test using 'type' with edge-case values (empty string, very long text, special chars like <script>, numbers in text fields).
- BUTTONS: Click ones you haven't tested yet.
- 'target' must match a valid data-qa-id from the interactive elements list below.
- If you've covered everything, use 'finish'.
- Bugs MUST include: what element, what happened, what was expected. Be specific!
- CRITICAL: All JSON values MUST be in Czech language (Čeština).`;

        const prompt = `Test Type: Smart AI Monkey Test
Current URL: ${currentUrl}
Page Title: ${title}
Already visited URLs: [${currentUrl}]
Progress: Step ${recordedSteps.length + 1}/30

Interactive elements on page:
${JSON.stringify(simplifiedElements)}

Recent console logs:
No console errors.

Recent network errors:
No network errors.

History of previous steps (last 15):
${recordedSteps.slice(-15).map(s => `Step ${s.step}: ${s.action} target=${s.target} value="${s.value || ''}"`).join('\n') || 'No previous steps.'}

FAILED ACTIONS MEMORY (DO NOT REPEAT):
None.

Choose the MOST VALUABLE next action to maximize coverage. Prefer unexplored pages and elements!`;

        const assistantResponse = {
          reasoning: actionData.reasoning || `Uživatel provedl akci ${actionData.action} na elementu ${actionData.target}.`,
          action: actionData.action,
          target: actionData.target,
          value: actionData.value,
          detected_bugs: []
        };

        const record = {
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: prompt },
            { role: 'assistant', content: JSON.stringify(assistantResponse) }
          ]
        };

        try {
          const datasetPath = path.join(process.cwd(), 'auratest_dataset.jsonl');
          fs.appendFileSync(datasetPath, JSON.stringify(record) + '\n', 'utf8');
        } catch (err: any) {
          console.warn('[Recorder] Chyba zápisu do datasetu:', err.message);
        }

        recordedSteps.push({
          step: recordedSteps.length + 1,
          action: actionData.action,
          target: actionData.target,
          value: actionData.value,
          url: currentUrl
        });
      });

      await context.addInitScript(() => {
        const tagElements = () => {
          const interactiveTags = ['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'LABEL'];
          const elements = Array.from(document.querySelectorAll('*')) as HTMLElement[];
          let qaIdCounter = 1;
          elements.forEach((el) => {
            const style = window.getComputedStyle(el);
            const isVisible = el.offsetWidth > 0 && el.offsetHeight > 0 && style.display !== 'none' && style.visibility !== 'hidden';
            if (!isVisible) return;
            const isInteractive = interactiveTags.includes(el.tagName) || el.hasAttribute('onclick') || el.getAttribute('role') === 'button' || style.cursor === 'pointer';
            if (isInteractive) {
              if (!el.getAttribute('data-qa-id')) {
                el.setAttribute('data-qa-id', String(qaIdCounter));
              }
              qaIdCounter++;
            }
          });
        };

        window.addEventListener('DOMContentLoaded', () => {
          tagElements();
          const observer = new MutationObserver(tagElements);
          observer.observe(document.body, { childList: true, subtree: true });
        });

        document.addEventListener('click', (e) => {
          const targetEl = (e.target as HTMLElement).closest('[data-qa-id]');
          if (targetEl) {
            const qaId = parseInt(targetEl.getAttribute('data-qa-id') || '0');
            const tagName = targetEl.tagName;
            if (tagName === 'INPUT' && ['text', 'email', 'password', 'number', 'tel'].includes((targetEl as HTMLInputElement).type)) {
              return;
            }
            // @ts-ignore
            window.recordAction({
              action: 'click',
              target: qaId,
              value: null,
              reasoning: `Uživatel kliknul na prvek <${tagName}> s textem "${((targetEl as HTMLElement).innerText || '').trim().substring(0, 30)}".`
            });
          }
        }, true);

        document.addEventListener('change', (e) => {
          const targetEl = e.target as HTMLElement;
          const qaIdEl = targetEl.closest('[data-qa-id]');
          if (qaIdEl) {
            const qaId = parseInt(qaIdEl.getAttribute('data-qa-id') || '0');
            const tagName = targetEl.tagName;
            const value = (targetEl as HTMLInputElement).value || '';
            // @ts-ignore
            window.recordAction({
              action: tagName === 'SELECT' ? 'click' : 'type',
              target: qaId,
              value: value,
              reasoning: `Uživatel vyplnil hodnotu "${value}" do pole <${tagName}>.`
            });
          }
        }, true);
      });

      activeRecorderPage = await context.newPage();
      await activeRecorderPage.goto(url, { waitUntil: 'networkidle', timeout: 30000 });

      activeRecorderPage.on('close', () => {
        recorderStatus = 'idle';
      });

    } catch (err: any) {
      console.error('[Recorder] Chyba běhu nahrávání:', err.message);
      recorderStatus = 'idle';
    }
  })();
});

app.post('/api/recorder/stop', async (req: Request, res: Response) => {
  if (recorderStatus === 'idle') {
    return res.json({ status: 'idle', message: 'Nahrávání neběží.' });
  }
  try {
    if (activeRecorderBrowser) {
      await activeRecorderBrowser.close();
    }
  } catch (e) {}
  recorderStatus = 'idle';
  res.json({ status: 'idle', message: 'Nahrávání úspěšně zastaveno.', stepsCount: recordedSteps.length });
});

app.get('/api/recorder/status', (req: Request, res: Response) => {
  res.json({
    status: recorderStatus,
    url: recorderUrl,
    stepsCount: recordedSteps.length,
    steps: recordedSteps
  });
});

app.get('/api/dataset/info', (req: Request, res: Response) => {
  const rawPath = path.join(process.cwd(), 'auratest_dataset.jsonl');
  const cleanedPath = path.join(process.cwd(), 'auratest_dataset_cleaned.jsonl');
  
  let totalCount = 0;
  let cleanedCount = 0;
  
  if (fs.existsSync(rawPath)) {
    const content = fs.readFileSync(rawPath, 'utf8');
    totalCount = content.split('\n').filter(line => line.trim().length > 0).length;
  }
  
  if (fs.existsSync(cleanedPath)) {
    const content = fs.readFileSync(cleanedPath, 'utf8');
    cleanedCount = content.split('\n').filter(line => line.trim().length > 0).length;
  }
  
  res.json({ totalCount, cleanedCount });
});

app.post('/api/model/build', async (req: Request, res: Response) => {
  try {
    const child = spawn('npx', ['tsx', 'scripts/build-model.ts'], { shell: true });
    
    let stdout = '';
    let stderr = '';
    
    child.stdout.on('data', (data) => { stdout += data.toString(); });
    child.stderr.on('data', (data) => { stderr += data.toString(); });
    
    child.on('close', (code) => {
      res.json({
        success: code === 0,
        code,
        stdout,
        stderr
      });
    });
  } catch (err: any) {
    res.status(500).json({ error: `Chyba při kompilaci modelu: ${err.message}` });
  }
});

// --- DOWNLOAD & RUN PLAYWRIGHT TEST ENDPOINTS ---
app.get('/api/sessions/:id/download-test', (req: Request, res: Response) => {
  const session = sessions.get(req.params.id as string);
  if (!session) return res.status(404).json({ error: 'Relace nenalezena.' });
  if (!session.generatedScript) return res.status(400).json({ error: 'Pro tuto relaci nebyl vygenerován žádný test.' });
  
  res.setHeader('Content-Type', 'text/javascript');
  res.setHeader('Content-Disposition', `attachment; filename="auratest_${session.id}.spec.ts"`);
  res.send(session.generatedScript);
});

app.post('/api/sessions/:id/run-generated-test', async (req: Request, res: Response) => {
  const session = sessions.get(req.params.id as string);
  if (!session) return res.status(404).json({ error: 'Relace nenalezena.' });
  if (!session.generatedScript) return res.status(400).json({ error: 'Chybí vygenerovaný skript.' });

  const tempFilePath = path.join(process.cwd(), 'tests', 'e2e', `temp_run_${session.id}.spec.ts`);
  
  try {
    fs.writeFileSync(tempFilePath, session.generatedScript, 'utf8');
    const child = spawn('npx', ['playwright', 'test', `tests/e2e/temp_run_${session.id}.spec.ts`], { shell: true });
    
    let stdout = '';
    let stderr = '';
    
    child.stdout.on('data', (data) => { stdout += data.toString(); });
    child.stderr.on('data', (data) => { stderr += data.toString(); });
    
    child.on('close', (code) => {
      try {
        if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
      } catch (e) {}
      res.json({
        success: code === 0,
        code,
        stdout,
        stderr
      });
    });
  } catch (err: any) {
    try {
      if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
    } catch (e) {}
    res.status(500).json({ error: `Chyba při spouštění testu: ${err.message}` });
  }
});

app.post('/api/run-test', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { url, goal, model, host, headless, maxSteps, mode, provider, testLogin, testPassword } = req.body;

    if (!url || (mode !== 'monkey' && mode !== 'smart_monkey' && !goal)) {
      return res.status(400).json({ error: 'Chybí URL nebo cíl testu.' });
    }

    const sessionId = `session_${Date.now()}`;
    const sessionData: SessionData = {
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
    saveSessionToDisk(sessionData);

    // Return sessionId immediately, run Playwright test in background
    res.json({ sessionId, status: 'running' });

    const llmConfig: LLMConfig = {
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
        if (mode === 'crawler') {
          broadcastToSession(sessionId, { type: 'progress', message: '🕷️ CRAWLER: Hledám podstránky na webu...' });
          const links = await extractInternalLinks(url);
          const targetUrls = [url, ...links].slice(0, 4);

          let totalBugs: string[] = [];
          let combinedScripts = '';
          let lastPerformance: any = null;
          let lastVideoUrl: string | null = null;

          const stepsPerPage = Math.max(5, Math.floor((llmConfig.maxSteps || 10) / targetUrls.length));

          for (const targetUrl of targetUrls) {
            broadcastToSession(sessionId, { type: 'progress', message: `🕷️ CRAWLER: Otevírám ${targetUrl} (Limit: ${stepsPerPage} kroků)` });
            const result = await runAutonomousTest(targetUrl, 'Prozkoumat funkčnost', { ...llmConfig, maxSteps: stepsPerPage }, (stepInfo) => {
              if (stepInfo.step === 0) return;
              stepInfo.action = `[${new URL(targetUrl).pathname}] ${stepInfo.action || ''}` as any;
              sessionData.steps.push(stepInfo);
              saveSessionToDisk(sessionData);
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
          saveSessionToDisk(sessionData);
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
            saveSessionToDisk(sessionData);
            broadcastToSession(sessionId, { type: 'step', step: stepInfo });
          }, sessionId);

          sessionData.status = 'completed';
          sessionData.bugs = result.bugs;
          sessionData.bugDetails = (result as any).bugDetails || [];
          sessionData.summary = result.summary;
          saveSessionToDisk(sessionData);
          broadcastToSession(sessionId, {
            type: 'completed',
            bugs: result.bugs,
            bugDetails: (result as any).bugDetails || [],
            summary: result.summary,
            success: result.success,
            performanceMetrics: result.performanceMetrics,
            generatedScript: result.generatedScript,
            videoUrl: result.videoUrl
          });
        }
      } catch (err: any) {
        sessionData.status = 'failed';
        sessionData.summary = `Selhání testu: ${err.message}`;
        sessionData.bugs.push(`Kritická chyba backendu: ${err.message}`);
        saveSessionToDisk(sessionData);
        broadcastToSession(sessionId, {
          type: 'failed',
          error: err.message,
          summary: `Test selhal: ${err.message}`
        });
      }
    })();
  } catch (err) {
    next(err); // Předáme do Error Handleru pro vyhnutí 500 pádům serveru
  }
});

app.post('/api/trigger-test', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { url, goal, mode, headless, maxSteps, testLogin, testPassword } = req.body;
    if (!url) return res.status(400).json({ error: 'Chybí URL pro test.' });

    const llmConfig: LLMConfig = {
      provider: 'ollama',
      model: 'llama3',
      host: 'http://localhost:11434',
      headless: headless !== false,
      maxSteps: parseInt(maxSteps) || 10,
      mode: mode || 'smoke_test',
      testLogin: testLogin || '',
      testPassword: testPassword || ''
    };

    const result = await runAutonomousTest(url, goal || 'Automatický CI/CD test', llmConfig, () => {});
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

function parseStepsText(text: any): any[] {
  if (!text) return [];
  if (Array.isArray(text)) return text;
  if (typeof text !== 'string') return [];
  if (!text.trim()) return [];
  
  if (text.trim().startsWith('[') || text.trim().startsWith('{')) {
    try {
      return JSON.parse(text);
    } catch (e) {}
  }
  
  const steps: any[] = [];
  const lines = text.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) continue;
    
    const firstSpace = trimmed.indexOf(' ');
    if (firstSpace === -1) continue;
    
    const action = trimmed.substring(0, firstSpace).trim().toLowerCase();
    const rest = trimmed.substring(firstSpace + 1).trim();
    
    if (action === 'click') {
      steps.push({ action: 'click', selector: rest });
    } else if (action === 'type') {
      let selector = '';
      let value = '';
      
      const quoteMatch = rest.match(/(.+?)\s+["'](.+?)["']$/);
      if (quoteMatch) {
        selector = quoteMatch[1];
        value = quoteMatch[2];
      } else {
        const lastSpace = rest.lastIndexOf(' ');
        if (lastSpace !== -1) {
          selector = rest.substring(0, lastSpace).trim();
          value = rest.substring(lastSpace + 1).trim();
        } else {
          selector = rest;
          value = '';
        }
      }
      steps.push({ action: 'type', selector, value });
    }
  }
  return steps;
}

app.post('/api/compare', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { url1, url2, steps, timeout } = req.body;

    if (!url1 || !url2) {
      return res.status(400).json({ error: 'Chybí URL1 nebo URL2 pro srovnání.' });
    }

    const parsedSteps = parseStepsText(steps);
    const baseTimeoutMs = timeout ? parseInt(timeout) * 1000 : 20000;
    const diffResult = await comparePages(url1, url2, parsedSteps, baseTimeoutMs);
    res.json(diffResult);
  } catch (err) {
    next(err);
  }
});



app.post('/api/audit-translations', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { url, translationSource, model, host, provider } = req.body;

    if (!url || !translationSource) {
      return res.status(400).json({ error: 'Chybí URL nebo specifikace zdroje překladů.' });
    }

    let dictionary: Record<string, string> = {};

    if (translationSource.type === 'file') {
      if (typeof translationSource.fileContent === 'string') {
        dictionary = JSON.parse(translationSource.fileContent);
      } else {
        dictionary = translationSource.fileContent || {};
      }
    } else {
      dictionary = await fetchTranslations(translationSource as TranslationConfig);
    }

    const llmConfig: LLMConfig = {
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
    next(err);
  }
});

// Global Error Handler Middleware (Ochrana proti 500 pádům)
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  console.error('Unhandled Server Error:', err.stack || err.message);
  res.status(500).json({
    error: 'Internal Server Error',
    message: err.message || 'Při zpracování požadavku došlo k systémové chybě.'
  });
});

server.on('upgrade', (request, socket, head) => {
  const { pathname, searchParams } = new URL(request.url || '', `http://${request.headers.host}`);
  
  if (pathname === '/ws') {
    const sessionId = searchParams.get('sessionId');
    if (!sessionId) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws: any) => {
      wss.emit('connection', ws, request, sessionId);
    });
  } else {
    socket.destroy();
  }
});

wss.on('connection', (ws: WebSocket, request: any, sessionId: string) => {
  if (!wsClients.has(sessionId)) {
    wsClients.set(sessionId, new Set());
  }
  wsClients.get(sessionId)!.add(ws);

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

const frontendDistPath = path.join(__dirname, 'frontend', 'dist');
if (fs.existsSync(frontendDistPath)) {
  app.use(express.static(frontendDistPath));
  app.get('*', (req, res) => {
    res.sendFile(path.join(frontendDistPath, 'index.html'));
  });
}

// Allow importing the app for testing
export { app, server };

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1] === __filename || require.main === module) {
  server.listen(PORT, () => {
    console.log(`AuraTest AI server běží na http://localhost:${PORT}`);
  });
}
