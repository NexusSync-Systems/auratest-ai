import express from 'express';
import http from 'http';
import { randomUUID, timingSafeEqual } from 'crypto';
import { WebSocketServer } from 'ws';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { runAutonomousTest, comparePages, auditTranslations, extractInternalLinks, analyzeSecurityVulnerabilities, auditAccessibility, auditNIS2AndPQC, auditGreenAndResidency, generateAutoHealPatch, auditCRA_SBOM, runChaosTest, getGridEnergyStatus, auditAIAct, auditStrictCookies, auditCRAVulnerabilities, checkPage, checkForm } from './agent.js';
import { fetchTranslations } from './db-connector.js';
import { authenticateToken } from './auth.js';
import { auth } from './db.js';
import { assertPublicHttpUrl } from './ssrf-guard.js';
import { isEmailAllowed, accessConfig } from './access-control.js';
import { verifySlackRequest, parseSlackPayload } from './slack-verify.js';
import { sendSlackNotification } from './slack-notifier.js';
import * as db from './db.js';
import { redactEventData } from './pii-redactor.js';
import { SCREENSHOTS_DIR, VIDEOS_DIR, SDK_DIR, FRONTEND_DIST_DIR, ensureDir } from './paths.js';
import { resolveSpaFallback } from './spa-fallback.js';
import {
  appendRecord,
  verifyChain,
  recordsForSession,
  readLedger,
  auditResultOf,
} from './audit-ledger.js';
import { buildCaseFile, renderCaseFileHtml } from './case-file.js';
import { renderCaseFilePdf } from './case-file-pdf.js';
import { accessWarnings } from './access-control.js';

// Global error handlers to prevent unhandled rejections from crashing the process
// Po nezachycené výjimce je proces v nedefinovaném stavu (viselé Playwright
// prohlížeče, poloviční zápisy do Firestore). Logovat a běžet dál je
// anti-pattern — ukončíme se a spoléháme na restart přes process manager.
let isShuttingDown = false;

function shutdownWithError() {
  if (isShuttingDown) return;
  isShuttingDown = true;
  try {
    server.close(() => process.exit(1));
  } catch {
    process.exit(1);
  }
  // Pojistka, kdyby se server.close() zaseklo na otevřených spojeních.
  // Bez .unref() — unref'nutý timer event loop neudrží a pojistka by se
  // nikdy nevykonala, přesně naopak, než komentář sliboval.
  setTimeout(() => process.exit(1), 5000);
}

process.on('uncaughtException', (err) => {
  console.error('Kritická chyba: Uncaught Exception:', err);
  if (process.env.NODE_ENV === 'test') return;
  shutdownWithError();
});

// Stejná politika jako u uncaughtException: neošetřené odmítnutí promise
// znamená, že nějaká cesta kódem doběhla v nedefinovaném stavu.
// (Dřív se tu jen logovalo, což bylo v rozporu s komentářem výš.)
process.on('unhandledRejection', (reason, promise) => {
  console.error('Kritická chyba: Unhandled Rejection at:', promise, 'reason:', reason);
  if (process.env.NODE_ENV === 'test') return;
  shutdownWithError();
});

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

// Za reverzní proxy / TLS terminátorem je jinak req.protocol vždy 'http'
// a req.ip je IP proxy, což rozbíjí rate limiting podle klienta.
// Pozor: Number('true') je NaN a Express pro NaN nedůvěřuje žádnému hopu,
// takže nejpravděpodobnější zápis TRUST_PROXY=true by ochranu tiše vypnul.
function parseTrustProxy(raw) {
  if (!raw) return false;
  const value = String(raw).trim();
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^\d+$/.test(value)) return Number(value);
  return value; // IP, CIDR nebo seznam ('loopback', '10.0.0.0/8', ...)
}
app.set('trust proxy', parseTrustProxy(process.env.TRUST_PROXY));

// ─────────────────────────────────────────────────────────────────────────────
// Rate limiting. Záměrně bez další závislosti — in-memory okno stačí pro
// jednoinstanční nasazení, kterým aplikace dnes je (viz wsClients a
// recentEventsCache). Při škálování na víc instancí nahradit Redisem.
//
// Chrání hlavně: /api/auraguard/report (veřejný, zapisuje do Firestore),
// /api/trigger-test (brute-force sdíleného secretu) a audit endpointy
// (každý request spouští Chromium).
// ─────────────────────────────────────────────────────────────────────────────
function rateLimit({ windowMs, max, keyFn = (req) => req.ip }) {
  const hits = new Map();

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) {
      if (now > entry.resetAt) hits.delete(key);
    }
  }, windowMs);
  if (typeof sweep.unref === 'function') sweep.unref();

  return (req, res, next) => {
    const key = keyFn(req) || 'unknown';
    const now = Date.now();
    const entry = hits.get(key);

    if (!entry || now > entry.resetAt) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }
    if (entry.count >= max) {
      res.set('Retry-After', String(Math.ceil((entry.resetAt - now) / 1000)));
      return res.status(429).json({ error: 'Příliš mnoho požadavků. Zkuste to za chvíli.' });
    }
    entry.count += 1;
    next();
  };
}

// Obecný strop pro celé API.
const apiLimiter = rateLimit({ windowMs: 60_000, max: 300 });
// Telemetrie je veřejná a zapisuje do DB — limit per projekt, ne per IP
// (jeden web má mnoho návštěvníků s různými IP).
// Klíčováno DVOJICÍ projekt+IP. Samotný `project` je neověřený vstup od
// anonyma, takže by útočník posláním cizího klíče vyčerpal okno konkrétního
// zákazníka (DoS jeho telemetrie). Samotná IP zase nefunguje, protože web
// má mnoho návštěvníků.
const reportLimiter = rateLimit({
  windowMs: 60_000,
  max: 600,
  keyFn: (req) => `${req.body?.project || 'unknown'}|${req.ip}`,
});
// Druhá vrstva: strop na projekt bez ohledu na IP, ale výrazně vyšší.
const reportProjectLimiter = rateLimit({
  windowMs: 60_000,
  max: 5000,
  keyFn: (req) => req.body?.project || req.ip,
});
// Endpointy spouštějící prohlížeč nebo LLM — drahé, přísnější limit.
const heavyLimiter = rateLimit({ windowMs: 60_000, max: 20 });
// CI/CD trigger chráněný sdíleným secretem — brzda na brute-force.
const triggerLimiter = rateLimit({ windowMs: 60_000, max: 10 });

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
// Artefakty mají vlastní, výrazně vyšší limit: stránka se session o padesáti
// krocích načte padesát screenshotů najednou a obecných 300/min by na ni
// nestačilo. Chráněné jsou capability tokenem, ne limitem.
const artifactLimiter = rateLimit({ windowMs: 60_000, max: 2000 });
app.use(['/api/screenshots', '/api/videos'], artifactLimiter);
app.use('/api', apiLimiter);

// Cesty z paths.js, ne z process.cwd()/path.resolve() — agent.js zapisoval
// jinam, než server.js servíroval, takže artefakty vracely 404, pokud se
// server spustil z jiného adresáře.
const screenshotsDir = ensureDir(SCREENSHOTS_DIR);
const videosDir = ensureDir(VIDEOS_DIR);

// ─────────────────────────────────────────────────────────────────────────────
// Artefakty (screenshoty, videa) byly dřív servírované přes express.static bez
// autentizace. Názvy jsou `<sessionId>_step_N.png`, takže s dřívějším
// predikovatelným sessionId (Date.now()) šly cizí screenshoty prostě uhodnout —
// a ty typicky obsahují přihlášené obrazovky.
//
// Bearer token tu použít nejde: <img src> ani <video src> hlavičky neposílají.
// Řešíme capability tokenem — každá session má `artifactToken` (128 bit),
// který se posílá v query. Bez znalosti tokenu je artefakt nedostupný.
// Jméno souboru navíc prochází regexem a servíruje se root-relativně, takže
// neprojde path traversal.
// ─────────────────────────────────────────────────────────────────────────────
const ARTIFACT_NAME = /^[A-Za-z0-9_-]+\.(png|webm)$/;

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function serveArtifact(dir) {
  return async (req, res) => {
    const name = req.params.file;
    if (!ARTIFACT_NAME.test(name)) {
      return res.status(400).json({ error: 'Neplatný název souboru.' });
    }

    const token = req.query.t;
    if (!token) return res.status(401).json({ error: 'Chybí přístupový token artefaktu.' });

    // Názvy artefaktů: `<sessionId>_step_<n>.png` a `<sessionId>_video.webm`
    // (viz agent.js). Z obou se sessionId vytáhne odstraněním přípony.
    const sessionId = name
      .replace(/_step_\d+\.png$/, '')
      .replace(/_video\.webm$/, '');
    try {
      const session = await db.getSession(sessionId);
      if (!session || !session.artifactToken || !safeEqual(token, session.artifactToken)) {
        return res.status(404).json({ error: 'Artefakt nenalezen.' });
      }
    } catch (err) {
      console.error('Chyba ověření artefaktu:', err);
      return res.status(500).json({ error: 'Artefakt se nepodařilo ověřit.' });
    }

    res.sendFile(name, { root: dir }, (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: 'Artefakt nenalezen.' });
    });
  };
}

app.get('/api/screenshots/:file', serveArtifact(screenshotsDir));
app.get('/api/videos/:file', serveArtifact(videosDir));

app.use('/sdk', express.static(ensureDir(SDK_DIR)));

const PORT = process.env.PORT || 3001;
const MAX_AGENT_STEPS = parseInt(process.env.MAX_AGENT_STEPS, 10) || 50;
// Veřejná adresa serveru. Dřív se do generovaného SDK reflektovala hlavička
// Host z requestu — útočník s kontrolou nad Host (nebo přes cache poisoning)
// tak mohl přesměrovat telemetrii zákazníků na vlastní server.
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || '';
// Sdílený kanál pro živou telemetrii; doručení je filtrované podle ws.userId.
const GLOBAL_WS_CHANNEL = 'global_auraguard';

const MAX_ANALYZED_EVENTS = 200;

// ─────────────────────────────────────────────────────────────────────────────
// Strop na souběžně běžící Playwright instance. Každý audit i test spouští
// Chromium; bez limitu vyčerpá pár desítek paralelních požadavků RAM stroje.
// ─────────────────────────────────────────────────────────────────────────────
const MAX_CONCURRENT_BROWSERS = parseInt(process.env.MAX_CONCURRENT_BROWSERS, 10) || 3;
// Strop, po kterém se slot uvolní i bez dokončené odpovědi (zamrzlý handler).
const BROWSER_SLOT_MAX_HOLD_MS = parseInt(process.env.BROWSER_SLOT_MAX_HOLD_MS, 10) || 10 * 60_000;

const browserSlots = {
  inUse: 0,
  tryAcquire() {
    if (this.inUse >= MAX_CONCURRENT_BROWSERS) return false;
    this.inUse += 1;
    return true;
  },
  release() {
    this.inUse = Math.max(0, this.inUse - 1);
  },
};

/** Odmítne požadavek s 429, když nejsou volné sloty pro prohlížeč. */
function browserSlotGuard(req, res, next) {
  if (!browserSlots.tryAcquire()) {
    res.set('Retry-After', '30');
    return res.status(429).json({ error: 'Server právě zpracovává maximum souběžných testů. Zkuste to za chvíli.' });
  }
  // Slot se uvolní, až odpověď doopravdy skončí.
  //
  // Dřív se poslouchalo i na 'close', jenže ten padne i když se klient odpojí
  // uprostřed zpracování — Chromium přitom běží dál. Šlo tak limit obejít
  // spamováním požadavků a okamžitým odpojením.
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    browserSlots.release();
  };
  res.on('finish', release);
  // Pojistka pro případ, že se odpověď nikdy neodešle (např. zamrzlý handler).
  const safetyTimer = setTimeout(release, BROWSER_SLOT_MAX_HOLD_MS);
  if (typeof safetyTimer.unref === 'function') safetyTimer.unref();
  res.on('finish', () => clearTimeout(safetyTimer));
  next();
}

// Whitelist polí, která smí klient měnit přes PATCH /api/monitors/:id.
// Mimo něj zůstávají userId, lastRunTime, lastRunStatus, lastRunBugsCount.
const MONITOR_PATCHABLE_FIELDS = [
  'name', 'url', 'goal', 'interval', 'active', 'provider', 'model', 'host',
  'maxSteps', 'mode', 'trackExceptions', 'trackPromiseRejections',
  'trackLongTasks', 'trackNetworkErrors', 'slowApiThresholdMs',
];

// Pozn.: dřív tu byla in-memory `sessions` mapa — zapisovalo se do ní, ale
// nikdy se z ní nečetlo, takže jen rostla. Zdrojem pravdy je Firestore.
// WebSocket clients map: sessionId -> Set of WS connections
const wsClients = new Map();

// ─────────────────────────────────────────────────────────────────────────────
// SSRF: middleware, které ověří uživatelem zadanou URL dřív, než na ni server
// pošle prohlížeč nebo HTTP požadavek. Ověřenou URL dá do req.safeUrl.
//
// Dřív se assertPublicHttpUrl volal ručně jen na 3 endpointech z ~15 — právě
// proto, že se handlery přidávaly kopírováním. Middleware to řeší systémově.
// ─────────────────────────────────────────────────────────────────────────────
function urlGuard(pick = (req) => req.body?.url) {
  return async (req, res, next) => {
    const raw = pick(req);
    if (!raw) return res.status(400).json({ error: 'Chybí URL.' });
    try {
      req.safeUrl = await assertPublicHttpUrl(raw);
      next();
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// LLM host allowlist: `host` se dřív bral přímo z těla requestu a queryLLM na
// něj poslal POST — tedy libovolný POST na interní službu. Host teď pochází
// výhradně z konfigurace serveru; klient smí zvolit jen provider a model.
// ─────────────────────────────────────────────────────────────────────────────
const DEFAULT_LLM_HOST = process.env.LLM_HOST || 'http://localhost:11434';
const ALLOWED_LLM_HOSTS = (process.env.ALLOWED_LLM_HOSTS ?? DEFAULT_LLM_HOST)
  .split(',').map((s) => s.trim()).filter(Boolean);

/**
 * Je v týhle instalaci vůbec nějaký LLM?
 *
 * `ALLOWED_LLM_HOSTS=` (prázdné) znamená VYPNUTO — proto `??` místo `||`,
 * které by prázdný řetězec přepsalo výchozím localhostem.
 *
 * Bez tohohle rozlišení skončilo nasazení bez Ollamy tak, že každý běh
 * agenta v AI režimu spadl na odmítnuté spojení na localhost:11434.
 * Uživatel dostal „fetch failed" a neměl šanci poznat, že jde o chybějící
 * konfiguraci, ne o chybu testovaného webu.
 */
export const isLlmConfigured = () => ALLOWED_LLM_HOSTS.length > 0;

/** Režimy agenta, které se bez LLM obejdou. */
const LLM_FREE_MODES = new Set(['monkey', 'smoke_test']);

function resolveLlmHost(requested) {
  if (!requested) return DEFAULT_LLM_HOST;
  return ALLOWED_LLM_HOSTS.includes(requested) ? requested : DEFAULT_LLM_HOST;
}

/**
 * Vrátí chybovou hlášku, pokud zvolený režim potřebuje LLM a žádný není.
 * Jinak null.
 */
function llmUnavailableFor(mode) {
  if (LLM_FREE_MODES.has(mode) || isLlmConfigured()) return null;
  return 'Tahle instalace nemá nakonfigurovaný jazykový model, takže režimy '
    + 'závislé na LLM nejsou k dispozici. Použijte režim "monkey" (náhodná '
    + 'interakce) nebo "smoke_test". Compliance skenery (NIS2/PQC, CRA, AI Act, '
    + 'GDPR, EAA, DORA) fungují bez LLM v plném rozsahu.';
}

function sanitizeLlmConfig(raw = {}) {
  return {
    provider: raw.provider || 'ollama',
    model: raw.model || 'llama3',
    host: resolveLlmHost(raw.host),
  };
}

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
/**
 * Zapíše dokončený audit do neměnného záznamu.
 *
 * Selhání zápisu NESMÍ shodit dokončený audit — výsledek už existuje
 * a zahodit ho kvůli logu by bylo horší. Nesmí se ale ani zamlčet: session
 * si nese `ledger.recorded`, takže report umí říct „tenhle běh v záznamu
 * není" místo aby doložitelnost jen předstíral.
 */
function recordInLedger(sessionData, rules = []) {
  try {
    const record = appendRecord({
      sessionId: sessionData.id,
      target: sessionData.url,
      userId: sessionData.userId,
      // Identifikátory pravidel, na která se běh odvolává. Spis pak vytiskne
      // znění JEN těchto — dřív tiskl celý registr pod nadpisem „Znění
      // použitých pravidel", takže kontrolor četl i o kontrolách, které
      // vůbec neproběhly.
      //
      // Agentní běh (prozkoumání aplikace jazykovým modelem) se na žádné
      // pravidlo registru neodvolává, a prázdný seznam to říká pravdivě.
      rules,
      // Do otisku jde to, co tvoří zjištění. Předpis je vyexportovaný
      // v audit-ledger.js, aby ho spis mohl použít k PŘEPOČÍTÁNÍ otisku
      // a k porovnání — jinak by to bylo číslo, které nikdo neověří.
      result: auditResultOf(sessionData),
    });
    sessionData.ledger = { recorded: true, hash: record.hash, recordedAt: record.recordedAt };
  } catch (err) {
    console.error('Zápis do záznamu auditů selhal:', err.message);
    sessionData.ledger = { recorded: false, error: err.message };
  }
}

/**
 * Ověření neporušenosti záznamu.
 *
 * Dostupné každému přihlášenému záměrně: kdo má důkazy doložit, musí je
 * umět i ověřit, aniž by o to musel žádat.
 */
app.get('/api/ledger/verify', authenticateToken, (req, res) => {
  try {
    // Ověřuje se podmnožina vlastníka. Ověření celého souboru sem vracelo
    // počet záznamů všech nájemců a v `problems` i jejich sessionId —
    // a projevilo by se to zrovna ve chvíli porušené integrity, tedy tehdy,
    // kdy se to hodí nejmíň.
    const mine = readLedger().filter(
      (r) => !r.__malformed && r.userId === req.user.userId
    );
    const result = verifyChain(undefined, mine);
    res.json({
      ok: result.ok,
      count: result.count,
      scope: result.scope,
      problems: result.problems.map(({ index, problem }) => ({ index, problem })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** Záznamy k jedné session. Filtrováno na vlastníka — cizí audity sem nepatří. */
app.get('/api/ledger/session/:sessionId', authenticateToken, (req, res) => {
  try {
    const records = recordsForSession(req.params.sessionId)
      .filter((r) => r.userId === req.user.userId);
    res.json(records);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Spis za období — to, co se odevzdává při kontrole.
 *
 * `format=pdf` drží slot pro prohlížeč: vykreslení spouští Chromium a bez
 * limitu by opakovaný export položil stroj stejně jako spuštěné audity.
 */
app.get('/api/case-file', authenticateToken, (req, res, next) => {
  // Slot drží jen PDF: vykreslení spouští Chromium. Strojově čitelný export
  // důkazů žádný prohlížeč nepotřebuje a vyčerpané sloty ho blokovat nemají.
  if (req.query.format === 'pdf') return browserSlotGuard(req, res, next);
  return next();
}, async (req, res) => {
  try {
    const { from, to, format = 'json' } = req.query;

    for (const [name, value] of [['from', from], ['to', to]]) {
      if (value && Number.isNaN(Date.parse(value))) {
        return res.status(400).json({ error: `Neplatné datum v parametru ${name}.` });
      }
    }

    const sessions = await db.getSessionsDetailed(req.user.userId);
    // Záznam se filtruje na vlastníka stejně jako běhy — spis nesmí
    // prozradit, že v systému existují cizí audity.
    const records = readLedger().filter(
      (r) => !r.__malformed && r.userId === req.user.userId
    );

    const caseFile = buildCaseFile({
      sessions,
      records,
      from,
      to,
      subject: req.user.email || req.user.userId,
    });

    if (format === 'json') {
      return res.json(caseFile);
    }

    if (format === 'pdf') {
      const html = renderCaseFileHtml(caseFile);
      const pdf = await renderCaseFilePdf(html);
      const stamp = new Date().toISOString().slice(0, 10);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="spis-auditu-${stamp}.pdf"`);
      return res.send(pdf);
    }

    return res.status(400).json({ error: 'Neznámý formát. Použij json nebo pdf.' });
  } catch (err) {
    console.error('Export spisu selhal:', err);
    res.status(500).json({ error: err.message });
  }
});

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

/**
 * Co tahle konkrétní instalace umí.
 *
 * Frontend si podle toho nastaví výchozí režim a schová volby, které by
 * stejně skončily chybou. Bez toho uživatel klikne na AI režim, počká
 * a dostane „fetch failed".
 *
 * Bez autentizace schválně: přihlašovací obrazovka potřebuje vědět, co
 * nabídnout, ještě než se kdokoli přihlásí. Nevrací nic citlivého — jen
 * příznaky funkcí, žádné hosty ani tokeny.
 */
app.get('/api/capabilities', (req, res) => {
  res.json({
    llmConfigured: isLlmConfigured(),
    // Režimy, které jsou v týhle instalaci reálně použitelné.
    agentModes: isLlmConfigured()
      ? ['ai', 'smart_monkey', 'monkey', 'smoke_test']
      : ['monkey', 'smoke_test'],
    // Compliance skenery na LLM nezávisí — běží vždycky.
    complianceAudits: ['nis2', 'cra', 'cve', 'eaa', 'ai-act', 'gdpr', 'dora', 'green'],
  });
});

// 1. Run Autonomous Test
app.post('/api/run-test', authenticateToken, heavyLimiter, urlGuard(), async (req, res) => {
  const { goal, model, headless, maxSteps, mode, provider, testLogin, testPassword } = req.body;
  const url = req.safeUrl;

  if (mode !== 'monkey' && mode !== 'smart_monkey' && !goal) {
    return res.status(400).json({ error: 'Chybí cíl testu.' });
  }

  // Chybějící LLM se musí ohlásit TEĎ, ne až selháním spojení uvnitř agenta.
  // Kontrola je před založením session, aby po sobě nezůstávala mrtvá session
  // ve stavu "running".
  const llmError = llmUnavailableFor(mode || 'ai');
  if (llmError) {
    return res.status(503).json({ error: llmError, llmConfigured: false });
  }

  // Nepredikovatelné ID: `session_${Date.now()}` šlo uhodnout (odposlech cizího
  // WebSocketu, stahování cizích screenshotů) a při dvou requestech ve stejné
  // milisekundě se session slily dohromady.
  const sessionId = `session_${randomUUID()}`;
  const artifactToken = randomUUID();
  const sessionData = {
    id: sessionId,
    userId: req.user.userId,
    artifactToken,
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

  // Express 4 nepředává odmítnuté promise z async handleru do error middleware,
  // takže selhání zápisu tu dřív znamenalo request visící do timeoutu
  // a jedinou stopou byl unhandledRejection.
  try {
    await db.saveSession(sessionId, sessionData);
  } catch (err) {
    console.error('Nepodařilo se založit session:', err);
    return res.status(503).json({ error: 'Session se nepodařilo založit. Zkuste to znovu.' });
  }

  // Return sessionId immediately, run Playwright test in background
  res.json({ sessionId, artifactToken, status: 'running' });

  // Background agent run
  const llmConfig = {
    ...sanitizeLlmConfig({ provider, model, host: req.body.host }),
    // headless natvrdo true mimo dev — klient si nesmí na serveru otevřít GUI
    // prohlížeč, a maxSteps má strop, aby jeden request nevytížil stroj.
    headless: process.env.NODE_ENV === 'production' ? true : headless !== false,
    maxSteps: Math.min(Math.max(parseInt(maxSteps) || 10, 1), MAX_AGENT_STEPS),
    mode: mode || 'ai',
    testLogin: testLogin || '',
    testPassword: testPassword || ''
  };

  // Test běží na pozadí až po odeslání odpovědi, takže slot pro prohlížeč
  // se drží ručně (res.finish by ho uvolnil předčasně).
  (async () => {
    if (!browserSlots.tryAcquire()) {
      sessionData.status = 'failed';
      sessionData.summary = 'Server zpracovává maximum souběžných testů. Zkuste to znovu za chvíli.';
      await db.saveSession(sessionId, sessionData).catch(() => {});
      broadcastToSession(sessionId, { type: 'failed', error: sessionData.summary, summary: sessionData.summary });
      return;
    }
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
              db.saveSession(sessionId, sessionData)
                .catch((e) => console.error('Uložení kroku selhalo:', e.message));
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
          recordInLedger(sessionData);
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
            db.saveSession(sessionId, sessionData)
              .catch((e) => console.error('Uložení kroku selhalo:', e.message));
            broadcastToSession(sessionId, { type: 'step', step: stepInfo });
          }, sessionId);

          // Běh, jehož měření se nedokončilo, NENÍ `completed`.
          //
          // `completed` znamená ve spisu „výsledek platí". Kdyby sem spadl
          // timeout nebo pád prohlížeče, zapsal by se do neměnného záznamu
          // jako platné zjištění o zákazníkově webu.
          sessionData.status = result.measured === false ? 'failed' : 'completed';
          sessionData.bugs = result.bugs;
          // Chyby měření se ukládají odděleně, aby je nikdo nemohl číst
          // jako nálezy.
          sessionData.runErrors = result.runErrors || [];
          // Výkonnostní varování se dřív nikam nepropsala — agent je odděluje
          // od bugů, ale žádný konzument je nečetl.
          sessionData.warnings = result.warnings || [];
          sessionData.summary = result.summary;
          sessionData.performanceMetrics = result.performanceMetrics;
          sessionData.generatedScript = result.generatedScript;
          sessionData.videoUrl = result.videoUrl;
          recordInLedger(sessionData);
          await db.saveSession(sessionId, sessionData);

          broadcastToSession(sessionId, {
            type: 'completed',
            bugs: result.bugs,
            warnings: result.warnings || [],
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
        // Do `bugs` NE — chyba na naší straně není nález na cizím webu.
        sessionData.runErrors = [
          ...(sessionData.runErrors || []),
          `Chyba serveru při měření: ${err.message}`,
        ];
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
    } finally {
      browserSlots.release();
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
  // Přímé !== prosakuje délku i pozici prvního rozdílu (timing).
  // Správný vzor je v repu už použit ve slack-verify.js.
  if (!token || !safeEqual(token, secret)) {
    return res.status(401).json({ error: 'Neplatný nebo chybějící trigger token.' });
  }
  next();
}

app.post('/api/trigger-test', triggerLimiter, requireTriggerSecret, browserSlotGuard, async (req, res) => {
  const { url, goal, mode, headless, maxSteps, testLogin, testPassword } = req.body;
  if (!url) return res.status(400).json({ error: 'Chybí URL pro test.' });

  // SSRF ochrana: povol jen veřejné http(s) cíle (blokuj interní/metadata IP).
  let safeUrl;
  try {
    safeUrl = await assertPublicHttpUrl(url);
  } catch (err) {
    return res.status(400).json({ error: `Nepovolená cílová URL: ${err.message}` });
  }

  // Host se bere z konfigurace serveru, ne natvrdo. Dřív tu byl zadrátovaný
  // localhost:11434 bez ohledu na LLM_HOST i na allowlist.
  const ciMode = mode || 'smoke_test';
  const ciLlmError = llmUnavailableFor(ciMode);
  if (ciLlmError) {
    return res.status(503).json({ success: false, error: ciLlmError, llmConfigured: false });
  }

  const llmConfig = {
    ...sanitizeLlmConfig({}),
    headless: headless !== false,
    maxSteps: parseInt(maxSteps) || 10,
    mode: ciMode,
    testLogin: testLogin || '',
    testPassword: testPassword || ''
  };

  try {
    // Vlastní nepredikovatelné ID i pro CI běh — artefakty pod společným
    // jménem by si mohl přisvojit kdokoli, kdo to jméno uhodne.
    const sessionId = `session_ci_${randomUUID()}`;
    const result = await runAutonomousTest(
      safeUrl,
      goal || 'Automatický CI/CD test',
      llmConfig,
      () => {},
      sessionId
    );
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- AURAAURAGUARD SYNTHETIC MONITORS & TELEMETRY ---

// Dřív tu bylo broadcastToAll(), které posílalo monitory a telemetrii VŠECH
// uživatelů každému připojenému klientovi. Teď se doručuje jen vlastníkovi.
function broadcastToUser(userId, data) {
  if (!userId) return;
  const payload = JSON.stringify(data);
  wsClients.forEach((clientsSet) => {
    clientsSet.forEach((ws) => {
      if (ws.readyState === 1 && ws.userId === userId) {
        ws.send(payload);
      }
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Plánovač monitorů.
//
// Dřív to byl setInterval s async callbackem: když jeden tik trval déle než
// 60 s (getAllActiveMonitors + N síťových updateMonitor), spustil se další
// paralelně. Teď se další tik plánuje až po dokončení předchozího.
//
// Pozn.: plánovač běží v každé instanci procesu. Rezervace přes lastRunTime
// (read-then-write) není atomická, takže při víc instancích může monitor
// naskočit dvakrát. Pro víceinstanční nasazení je potřeba Firestore
// transakce nebo externí scheduler — viz TODO níž.
// ─────────────────────────────────────────────────────────────────────────────
const SCHEDULER_TICK_MS = 60000;
let schedulerTimer = null;

async function schedulerTick() {
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
        // Cíl se ověřuje ZNOVU, těsně před spuštěním.
        //
        // `POST /api/monitors` sice `urlGuard` má, ale to je jen jedna ze
        // dvou cest, jak se do kolekce dostane záznam. Plánovač bere URL
        // z databáze a otevře ji vlastním prohlížečem — pokud se tam adresa
        // dostala jinudy, nebo se mezitím změnila, byla by tohle přímá cesta
        // na vnitřní síť (169.254.169.254, 127.0.0.1, 10.x).
        //
        // Monitor s nepřijatelným cílem se vypne. Nechat ho aktivní znamená
        // opakovat totéž každou minutu.
        try {
          await assertPublicHttpUrl(monitor.url);
        } catch (err) {
          console.warn(
            `[AuraGuard] Monitor ${monitor.id} deaktivován — nepřijatelný cíl: ${err.message}`
          );
          await db.updateMonitor(monitor.id, {
            active: false,
            lastError: `Cíl odmítnut při kontrole: ${err.message}`,
          });
          continue;
        }

        // Rezervace slotu. TODO: převést na Firestore transakci (uvnitř znovu
        // přečíst lastRunTime a zapsat jen když je stále starý) — dnešní
        // read-then-write není atomická napříč instancemi.
        await db.updateMonitor(monitor.id, { lastRunTime: now });

        // Strop na souběžné běhy: bez něj znamená 50 aktivních monitorů
        // 50 současně spuštěných Chromium procesů.
        //
        // Slot se bere až těsně před spuštěním testu. Dřív se bral tady nahoře,
        // ale mezi tím byl `await db.saveSession(...)` mimo try/finally —
        // selhání zápisu (kvóta, síť) slot NIKDY neuvolnilo a po několika
        // takových chybách se plánovač i audity zablokovaly natrvalo.
        //
        // sessionId musí být nepredikovatelné — je součástí názvu screenshotů.
        const sessionId = `session_monitor_${randomUUID()}`;
        console.log(`[AuraAuraGuard] Spouštím monitor: ${monitor.name} (${monitor.url}) -> ${sessionId}`);

        const sessionData = {
          id: sessionId,
          userId: monitor.userId,
          artifactToken: randomUUID(),
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
        try {
          await db.saveSession(sessionId, sessionData);
        } catch (err) {
          console.error(`[AuraAuraGuard] Nepodařilo se založit session monitoru ${monitor.name}:`, err.message);
          continue;
        }

        if (!browserSlots.tryAcquire()) {
          console.warn(`[AuraAuraGuard] Monitor ${monitor.name} odložen: vyčerpán limit souběžných prohlížečů.`);
          // Rezervaci vrátíme, aby se monitor zkusil znovu v dalším tiku
          // a nečekal celý svůj interval.
          await db.updateMonitor(monitor.id, { lastRunTime: lastRun }).catch(() => {});
          continue;
        }

        const llmConfig = {
          // Host prochází allowlistem i tady — do DB se mohl dostat dřív,
          // než PATCH /api/monitors začal validovat.
          ...sanitizeLlmConfig({ provider: monitor.provider, model: monitor.model, host: monitor.host }),
          headless: true,
          maxSteps: Math.min(Math.max(monitor.maxSteps || 10, 1), MAX_AGENT_STEPS),
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
                // Bez .catch() končilo selhání zápisu jako unhandled rejection.
                db.saveSession(sessionId, sessionData)
                  .catch((e) => console.error('Uložení kroku monitoru selhalo:', e.message));
                broadcastToSession(sessionId, { type: 'step', step: progress });
              },
              sessionId
            );

            // Nedokončené měření není `completed` — viz /api/run-test.
            sessionData.status = result.measured === false ? 'failed' : 'completed';
            sessionData.bugs = result.bugs;
            // Výkonnostní varování se dřív nikam nepropsala — agent je odděluje
            // od bugů, ale žádný konzument je nečetl.
            sessionData.warnings = result.warnings || [];
            sessionData.runErrors = result.runErrors || [];
            sessionData.summary = result.summary;
            sessionData.performanceMetrics = result.performanceMetrics;
            sessionData.generatedScript = result.generatedScript;
            sessionData.videoUrl = result.videoUrl;
            recordInLedger(sessionData);
            await db.saveSession(sessionId, sessionData);

            await db.updateMonitor(monitor.id, {
              // Nezměřený běh není ani „v pořádku", ani „nález" — je to chyba
              // našeho měření a monitor to musí ukázat jako takovou.
              lastRunStatus:
                result.measured === false
                  ? 'error'
                  : result.bugs.length === 0
                    ? 'success'
                    : 'failure',
              lastRunBugsCount: result.measured === false ? 0 : result.bugs.length
            });

            const userMonitors = await db.getMonitors(monitor.userId);
            broadcastToUser(monitor.userId, { type: 'monitors_updated', monitors: userMonitors });
          } catch (err) {
            console.error(`[AuraAuraGuard] Monitor ${monitor.name} selhal:`, err.message);
            sessionData.status = 'failed';
            // Do `bugs` NE — chyba plánovače není nález na sledovaném webu.
            sessionData.runErrors = [
              ...(sessionData.runErrors || []),
              `Chyba plánovače při měření: ${err.message}`,
            ];
            await db.saveSession(sessionId, sessionData);

            await db.updateMonitor(monitor.id, { lastRunStatus: 'error' });

            const userMonitors = await db.getMonitors(monitor.userId);
            broadcastToUser(monitor.userId, { type: 'monitors_updated', monitors: userMonitors });
          } finally {
            browserSlots.release();
          }
        })();
      }
    }
  } catch (err) {
    console.error('Chyba plánovače na pozadí:', err.message);
  }
}

function scheduleNextTick() {
  schedulerTimer = setTimeout(async () => {
    await schedulerTick();
    scheduleNextTick();
  }, SCHEDULER_TICK_MS);
  if (typeof schedulerTimer.unref === 'function') schedulerTimer.unref();
}

if (process.env.NODE_ENV !== 'test') {
  scheduleNextTick();
}

// Bez tohohle se `schedulerTimer` jen přiřazoval a nikdy nerušil, takže
// aplikace neuměla korektně skončit (a v Dockeru navíc npm jako PID 1
// SIGTERM ani nepředával — viz Dockerfile).
function gracefulShutdown(signal) {
  console.log(`Přijat ${signal}, ukončuji…`);
  if (schedulerTimer) clearTimeout(schedulerTimer);
  wss.clients.forEach((ws) => ws.close(1001, 'Server se ukončuje'));
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000);
}

if (process.env.NODE_ENV !== 'test') {
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
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

// urlGuard je tu podstatný: uloženou URL volá scheduler opakovaně, takže bez
// kontroly by šlo založit persistentní SSRF na interní adresu.
app.post('/api/monitors', authenticateToken, urlGuard(), async (req, res) => {
  const { name, goal, interval, provider, model, host, maxSteps, trackExceptions, trackPromiseRejections, trackLongTasks, trackNetworkErrors, slowApiThresholdMs } = req.body;
  if (!name) {
    return res.status(400).json({ error: 'Chybí název monitoru.' });
  }

  try {
    const newMonitor = await db.createMonitor(req.user.userId, {
      name,
      url: req.safeUrl,
      goal: goal || 'Prohledej stránku a najdi jakékoliv chyby',
      interval: interval || '1h',
      ...sanitizeLlmConfig({ provider, model, host }),
      maxSteps: Math.min(Math.max(parseInt(maxSteps) || 10, 1), MAX_AGENT_STEPS),
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

    // Mass assignment: dřív šlo celé req.body rovnou do docRef.update(), takže
    // uživatel mohl přepsat userId (a ukrást cizí monitor) nebo lastRunTime.
    const patch = {};
    for (const key of MONITOR_PATCHABLE_FIELDS) {
      if (Object.hasOwn(req.body, key)) patch[key] = req.body[key];
    }
    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ error: 'Žádné povolené pole k úpravě.' });
    }

    // URL smí být jen veřejná — monitor ji periodicky volá ze serveru.
    if (patch.url) {
      try {
        patch.url = await assertPublicHttpUrl(patch.url);
      } catch (e) {
        return res.status(400).json({ error: e.message });
      }
    }
    if (patch.host) patch.host = resolveLlmHost(patch.host);
    if (patch.maxSteps) patch.maxSteps = Math.min(Math.max(parseInt(patch.maxSteps) || 10, 1), MAX_AGENT_STEPS);

    const updated = await db.updateMonitor(req.params.id, patch);
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
    // Dřív se sem posílal celý obsah událostí od klienta bez ověření — endpoint
    // tak fungoval jako neomezená LLM proxy a otevíral prompt injection přes
    // events[].data.message, jejíž výstup se uživateli zobrazí jako bezpečnostní
    // doporučení. Teď přijímáme jen ID a data načítáme serverem.
    const { eventIds } = req.body;
    if (!Array.isArray(eventIds) || eventIds.length === 0) {
      return res.status(400).json({ error: 'Chybí seznam ID událostí (eventIds).' });
    }
    if (eventIds.length > MAX_ANALYZED_EVENTS) {
      return res.status(400).json({ error: `Najednou lze analyzovat nejvýše ${MAX_ANALYZED_EVENTS} událostí.` });
    }

    const owned = await db.getAuraGuardEvents(req.user.userId);
    const ownedById = new Map(owned.map((e) => [e.id, e]));
    const events = eventIds.map((id) => ownedById.get(id)).filter(Boolean);

    if (events.length === 0) {
      return res.status(404).json({
        error: 'Žádná z uvedených událostí nebyla nalezena mezi vašimi nedávnými událostmi.'
      });
    }

    // getAuraGuardEvents vrací jen posledních 500 událostí, takže starší ID
    // tiše propadnou. Bez téhle informace vypadá výsledek jako úplný.
    const missing = eventIds.filter((id) => !ownedById.has(id));

    const analysis = await analyzeSecurityVulnerabilities(events, { provider: 'ollama', model: 'llama3' });
    res.json({
      analysis,
      analyzedCount: events.length,
      skippedCount: missing.length,
      ...(missing.length > 0 && {
        note: `${missing.length} událostí nebylo nalezeno mezi posledními 500 — analýza je nezahrnuje.`
      })
    });
  } catch (err) {
    console.error('Error during security analysis:', err);
    res.status(500).json({ error: 'Bezpečnostní analýza selhala.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Audit endpointy — dřív 8 doslova identických handlerů (validace url → zavolat
// funkci → res.json). Kopírování bylo důvod, proč u všech osmi chyběla SSRF
// kontrola. Teď je registrace tabulková: jedno místo = jeden urlGuard.
// Cesty zůstávají stejné kvůli kompatibilitě s frontendem.
// ─────────────────────────────────────────────────────────────────────────────
const URL_AUDITS = {
  'analyze-accessibility': auditAccessibility,
  'analyze-nis2': auditNIS2AndPQC,
  'analyze-green-gdpr': auditGreenAndResidency,
  'analyze-cra': auditCRA_SBOM,
  'chaos-test': runChaosTest,
  'ai-act-audit': auditAIAct,
  'cookie-audit': auditStrictCookies,
  'cra-vuln-audit': auditCRAVulnerabilities,
};

/**
 * Volitelné parametry auditů. Tělo requestu se sem nepředává celé — jen to,
 * co je výslovně vyjmenované, aby nešlo protlačit do agenta cokoli.
 */
const AUDIT_OPTIONS = {
  // Seed umožní zopakovat konkrétní běh chaos testu. Bez toho by šlo
  // o jednorázový náhodný pokus, ne o doložitelný test.
  'chaos-test': (body) => (
    typeof body?.seed === 'string' && body.seed.length > 0 && body.seed.length <= 128
      ? { seed: body.seed }
      : {}
  ),
};

for (const [slug, auditFn] of Object.entries(URL_AUDITS)) {
  app.post(`/api/auraguard/${slug}`, authenticateToken, heavyLimiter, browserSlotGuard, urlGuard(), async (req, res) => {
    try {
      const options = AUDIT_OPTIONS[slug] ? AUDIT_OPTIONS[slug](req.body) : undefined;
      res.json(await auditFn(req.safeUrl, options));
    } catch (err) {
      console.error(`Audit ${slug} selhal:`, err);
      res.status(500).json({ error: `Audit ${slug} selhal.` });
    }
  });
}

app.post('/api/auraguard/auto-heal', authenticateToken, async (req, res) => {
  try {
    const { eventData, llmConfig } = req.body;
    if (!eventData) return res.status(400).json({ error: 'Chybí data události' });

    // llmConfig.host z těla requestu se ignoruje (SSRF) — viz sanitizeLlmConfig.
    const result = await generateAutoHealPatch(eventData, sanitizeLlmConfig(llmConfig));
    res.json({ patch: result.text || result.response || result });
  } catch (err) {
    console.error('Error during Auto-Heal:', err);
    res.status(500).json({ error: 'Auto-Heal selhal.' });
  }
});

/**
 * Odeslání reportu na Slack incoming webhook.
 *
 * Dřív to frontend posílal přímo z prohlížeče. Slack u incoming webhooků
 * neposílá CORS hlavičky, takže request VŽDY selhal — a catch blok pak
 * uživateli zobrazil "Report odeslán (Simulace)". Navíc byl webhook (tajemství)
 * vystavený v klientském kódu a v DevTools.
 */
app.post('/api/notify/slack', authenticateToken, async (req, res) => {
  const { webhookUrl, text } = req.body;
  if (!webhookUrl || !text) {
    return res.status(400).json({ error: 'Chybí webhookUrl nebo text.' });
  }

  let safeWebhook;
  try {
    safeWebhook = await assertPublicHttpUrl(webhookUrl);
    if (new URL(safeWebhook).hostname !== 'hooks.slack.com') {
      return res.status(400).json({ error: 'Povolené jsou pouze webhooky na hooks.slack.com.' });
    }
  } catch (err) {
    return res.status(400).json({ error: `Neplatná adresa webhooku: ${err.message}` });
  }

  try {
    const slackRes = await fetch(safeWebhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
      body: JSON.stringify({ text: String(text).slice(0, 3000) }),
    });

    if (!slackRes.ok) {
      const detail = await slackRes.text().catch(() => '');
      console.error('Slack webhook odmítl zprávu:', slackRes.status, detail);
      return res.status(502).json({ error: `Slack zprávu odmítl (HTTP ${slackRes.status}).` });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Odeslání na Slack selhalo:', err);
    res.status(502).json({ error: 'Odeslání na Slack selhalo.' });
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

app.post('/api/auraguard/monitor-page', authenticateToken, urlGuard((req) => req.body?.target?.url), async (req, res) => {
  try {
    const target = { ...req.body.target, url: req.safeUrl };
    const result = await checkPage(target);
    
    // Slack notifikace při výpadku
    if (!result.ok) {
      const channel = process.env.SLACK_CHANNEL || '#general';
      const blocks = [
        { type: 'section', text: { type: 'mrkdwn', text: `*Detail chyby:*\n${result.error || 'Neznámá chyba'}` } },
        { type: 'context', elements: [{ type: 'mrkdwn', text: `Odezva: ${result.durationMs ?? '?'}ms` }] },
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

app.post('/api/auraguard/monitor-form', authenticateToken, urlGuard((req) => req.body?.target?.url), async (req, res) => {
  try {
    const target = { ...req.body.target, url: req.safeUrl };
    const result = await checkForm(target);

    // Slack notifikace při chybě formuláře
    if (!result.ok) {
      const channel = process.env.SLACK_CHANNEL || '#general';
      const blocks = [
        { type: 'section', text: { type: 'mrkdwn', text: `*Detail chyby:*\n${result.error || 'Formulář nešel odeslat'}` } },
        { type: 'context', elements: [{ type: 'mrkdwn', text: `Odezva: ${result.durationMs ?? '?'}ms` }] }
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
    // Když globální express.json tělo už zpracoval (Content-Type: application/json),
    // express.raw se přeskočí a req.body je objekt. Syrové tělo si proto bereme
    // z req.rawBody, které ukládá `verify` callback u express.json.
    const rawBody = Buffer.isBuffer(req.body) ? req.body : req.rawBody;
    if (!rawBody) {
      console.warn('[Slack] Chybí syrové tělo požadavku, nelze ověřit podpis.');
      return res.status(400).send('Chybí tělo požadavku');
    }

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

// ─────────────────────────────────────────────────────────────────────────────
// Deduplikace nedávných eventů.
//
// Dřív to byla obyčejná Map, jejíž TTL se kontrolovalo jen při čtení —
// expirované položky se nikdy nemazaly. Signatura obsahuje message, filename
// i lineno, takže útočník na veřejném endpointu vygeneroval neomezeně
// unikátních klíčů → OOM. Teď LRU se stropem a periodickým úklidem.
//
// Stále per-proces: po restartu se okno ztratí a při víc instancích
// deduplikace nefunguje napříč. Pro víceinstanční nasazení nahradit Redisem.
// ─────────────────────────────────────────────────────────────────────────────
const CACHE_TTL_MS = 60 * 60 * 1000; // 60 minut
const CACHE_MAX_ENTRIES = parseInt(process.env.EVENT_CACHE_MAX_ENTRIES, 10) || 10000;

const recentEventsCache = new Map();

function cacheEvent(signature, entry) {
  // Map si drží pořadí vložení, takže nejstarší klíč je první.
  if (recentEventsCache.size >= CACHE_MAX_ENTRIES) {
    const oldestKey = recentEventsCache.keys().next().value;
    recentEventsCache.delete(oldestKey);
  }
  recentEventsCache.set(signature, entry);
}

const eventCacheSweep = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of recentEventsCache) {
    if (now - entry.lastSeen >= CACHE_TTL_MS) recentEventsCache.delete(key);
  }
}, CACHE_TTL_MS / 4);
if (typeof eventCacheSweep.unref === 'function') eventCacheSweep.unref();

app.post('/api/auraguard/report', reportLimiter, reportProjectLimiter, async (req, res) => {
  const { project, type, data, timestamp } = req.body;
  if (!project) return res.status(400).json({ error: 'Chybí ID projektu.' });

  try {
    const proj = await db.getProjectByKey(project);
    if (!proj) return res.status(404).json({ error: 'Projekt nebyl nalezen nebo je neaktivní.' });
    if (!proj.active) return res.status(403).json({ error: 'Projekt je deaktivován.' });

    // Ověření povolených domén (Origin check).
    //
    // Dřív: `... && origin` — když útočník hlavičku Origin vůbec neposlal
    // (curl, server-to-server), kontrola se CELÁ přeskočila. A `startsWith`
    // propustil `https://example.com.evil.com` pro allowlist `https://example.com`.
    // Teď: chybějící Origin = odmítnutí, porovnává se normalizovaný origin.
    if (proj.allowedOrigins && proj.allowedOrigins.length > 0) {
      const originHeader = req.headers.origin || req.headers.referer;
      if (!originHeader) {
        return res.status(403).json({ error: 'Přístup zamítnut. Chybí hlavička Origin.' });
      }
      let requestOrigin;
      try {
        requestOrigin = new URL(originHeader).origin;
      } catch {
        return res.status(403).json({ error: 'Přístup zamítnut. Neplatná hlavička Origin.' });
      }
      const allowed = proj.allowedOrigins.some((o) => {
        try { return new URL(o).origin === requestOrigin; } catch { return false; }
      });
      if (!allowed) {
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
        
        // Dřív se tu notifikovalo přes `req.app.locals.wss`, které se nikde
        // nenastavovalo (a ws.projectId taky ne) — celá větev byla no-op.
        broadcastToUser(proj.userId, {
          type: 'event_deduplicated',
          data: { id: cachedEvent.id, count: cachedEvent.count, timestamp: new Date().toISOString() }
        });

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
    cacheEvent(eventSignature, { id: newEvent.id, count: 1, lastSeen: Date.now() });

    // Telemetrie jde jen vlastníkovi projektu, ne všem připojeným klientům.
    broadcastToUser(proj.userId, { type: 'auraguard_live_event', event: newEvent });
    res.json({ success: true, eventId: newEvent.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/auraguard/sdk.js', (req, res) => {
  // Bez PUBLIC_BASE_URL se dřív reflektovala hlavička Host — útočník s kontrolou
  // nad ní (nebo přes cache poisoning na CDN) přesměroval telemetrii zákazníků
  // na vlastní server. Fail-closed: bez konfigurace SDK negenerujeme.
  const reportBaseUrl = PUBLIC_BASE_URL
    || (process.env.NODE_ENV === 'production' ? null : `${req.protocol}://${req.get('host')}`);

  if (!reportBaseUrl) {
    return res.status(503)
      .type('text/plain')
      .send('// AuraGuard SDK není nakonfigurováno: chybí PUBLIC_BASE_URL na serveru.');
  }

  res.setHeader('Content-Type', 'application/javascript');
  // Odpověď závisí na konfiguraci, ne na požadavku — ale ať ji CDN nemíchá.
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.send(`
(function() {
  const scriptTag = document.currentScript;
  const project = scriptTag ? scriptTag.getAttribute('data-project') : '';
  const trackErrors = scriptTag ? scriptTag.getAttribute('data-track-errors') !== 'false' : true;
  const trackPerf = scriptTag ? scriptTag.getAttribute('data-track-perf') !== 'false' : true;
  const slowThreshold = parseInt(scriptTag ? scriptTag.getAttribute('data-slow-api-threshold') : '1500') || 1500;
  const reportUrl = '${reportBaseUrl}/api/auraguard/report';

  if (!project) {
    console.error('[AuraAuraGuard] Chybí data-project atribut pro odesílání logů.');
    return;
  }

  // Reference na nativní fetch DŘÍV, než ho níž přepíšeme kvůli měření
  // latence. Bez toho posílal sendReport přes přepsanou verzi: report na
  // endpoint vrátí 4xx (nepovolená doména, neznámý projekt, rate limit),
  // wrapper z toho udělá další 'network_error' report, ten zase dostane 4xx
  // → nekonečná smyčka požadavků z prohlížeče zákazníka.
  const nativeFetch = window.fetch ? window.fetch.bind(window) : null;

  // Strop na počet reportů ze stránky. Chyba v requestAnimationFrame nebo
  // setInterval by jinak generovala tisíce reportů za sekundu.
  var reportCount = 0;
  var MAX_REPORTS_PER_PAGE = 25;
  var seenSignatures = {};
  var isSending = false;

  function sendReport(type, data) {
    // Ochrana proti rekurzi: výjimka uvnitř error listeneru by spustila
    // listener znovu.
    if (isSending) return;
    if (reportCount >= MAX_REPORTS_PER_PAGE) return;

    var signature = type + '|' + (data.message || '') + '|' + (data.filename || '') + '|' + (data.lineno || '');
    if (seenSignatures[signature]) return;
    seenSignatures[signature] = true;
    reportCount++;

    isSending = true;
    try {
      if (!nativeFetch) return;
      nativeFetch(reportUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project: project, type: type, data: data, timestamp: new Date().toISOString() })
      }).catch(function() {});
    } catch (e) {
      // SDK nikdy nesmí rozbít web zákazníka
    } finally {
      isSending = false;
    }
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
          // Vlastní telemetrický endpoint se nereportuje — jinak vzniká smyčka.
          if (response.url && response.url.indexOf(reportUrl) === 0) return response;
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
app.post('/api/compare', authenticateToken, heavyLimiter, browserSlotGuard, async (req, res) => {
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
app.post('/api/audit-translations', authenticateToken, heavyLimiter, browserSlotGuard, async (req, res) => {
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

    // Audit překladů LLM potřebuje vždycky — bez něj nemá smysl ho spouštět.
    if (!isLlmConfigured()) {
      return res.status(503).json({
        success: false,
        error: 'Audit překladů vyžaduje jazykový model, který v téhle instalaci není nakonfigurovaný.',
        llmConfigured: false,
      });
    }

    const llmConfig = sanitizeLlmConfig({ provider, model, host });

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

// ─────────────────────────────────────────────────────────────────────────────
// WebSocket upgrade
//
// Dřív se kontrolovala jen PŘÍTOMNOST sessionId — ne token a ne vlastnictví.
// Se sessionId tvaru `session_${Date.now()}` stačilo ID uhodnout a člověk četl
// živě kroky, screenshoty a bugy cizích testů.
//
// Teď: povinný Firebase ID token a ověření, že session patří volajícímu.
// Klient posílá token v query (`?token=`) — WebSocket API v prohlížeči
// vlastní hlavičky nastavit neumí.
// ─────────────────────────────────────────────────────────────────────────────
server.on('upgrade', async (request, socket, head) => {
  // Node po emitu 'upgrade' odebere vlastní error listener a socket předá nám.
  // Bez tohohle posluchače stačí spojení resetnout během await verifyIdToken()
  // a socket vyhodí neošetřenou chybu → uncaughtException → (nově) exit.
  // Tedy triviální vzdálený DoS.
  const onSocketError = (err) => {
    console.warn('Chyba socketu při WS upgrade:', err.message);
    socket.destroy();
  };
  socket.on('error', onSocketError);

  const reject = (code, reason) => {
    if (!socket.destroyed && socket.writable) {
      socket.write(`HTTP/1.1 ${code} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    }
    socket.destroy();
  };

  try {
    const { pathname, searchParams } = new URL(request.url, `http://${request.headers.host}`);
    if (pathname !== '/ws') return socket.destroy();

    const sessionId = searchParams.get('sessionId');
    const token = searchParams.get('token');
    if (!sessionId || !token) return reject(401, 'Unauthorized');

    let userId;
    try {
      const decoded = await auth.verifyIdToken(token);
      // Allowlist platí i tady. Dřív se ověřoval jen podpis tokenu, takže
      // účet mimo seznam sice nedostal žádná data (broadcast filtruje podle
      // userId), ale spojení navázal a držel — tedy neomezený zdroj spojení
      // pro kohokoli, kdo si u Firebase založí účet.
      const access = isEmailAllowed(decoded.email);
      if (!access.allowed) return reject(403, 'Forbidden');
      userId = decoded.uid;
    } catch {
      return reject(401, 'Unauthorized');
    }

    // `global_auraguard` je per-uživatelský kanál telemetrie, ne konkrétní běh.
    if (sessionId !== GLOBAL_WS_CHANNEL) {
      const session = await db.getSession(sessionId);
      // Neexistující session se odmítá. Klient se připojuje až poté, co mu
      // `/api/run-test` vrátí ID — v tu chvíli už dokument existuje.
      // Propouštět "zatím neexistuje" znamenalo, že si kdokoli držel spojení
      // na libovolné ID a čekal, až ho někdo obsadí.
      if (!session || session.userId !== userId) return reject(403, 'Forbidden');
    }

    // Socket je předán ws knihovně, která si dál chyby řeší sama.
    socket.removeListener('error', onSocketError);
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request, sessionId, userId);
    });
  } catch (err) {
    console.error('Chyba WS upgrade:', err);
    socket.destroy();
  }
});

wss.on('connection', (ws, request, sessionId, userId) => {
  ws.userId = userId;

  // Bez posluchače by chyba socketu (reset spojení) vyletěla jako
  // neošetřená výjimka a shodila proces.
  ws.on('error', (err) => {
    console.warn('Chyba WebSocket spojení:', err.message);
  });

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
const frontendDistPath = FRONTEND_DIST_DIR;
if (fs.existsSync(frontendDistPath)) {
  app.use(express.static(frontendDistPath));

  // Catch-all vrací index.html, aby fungovaly cesty SPA (/hub, /ukazka, …)
  // při přímém otevření i po obnovení stránky. Rozhodování je
  // v `spa-fallback.js` — viz tamní komentář, proč „200 s HTML" u chybějícího
  // souboru způsobí zmatek na úplně jiném místě.
  app.get('*', (req, res) => {
    const decision = resolveSpaFallback(req.path);
    if (!decision.serveIndex) {
      return res.status(decision.status).json({ error: decision.reason });
    }
    res.sendFile(path.join(frontendDistPath, 'index.html'));
  });
}

// Global Express error handling middleware
app.use((err, req, res, next) => {
  // Po částečně odeslané odpovědi už hlavičky měnit nejde.
  if (res.headersSent) return next(err);

  // Chyby body-parseru nesou vlastní status (400 u nevalidního JSON,
  // 413 u příliš velkého těla). Dřív se všechno přepsalo na 500, takže
  // klient nepoznal chybu ve svém požadavku od chyby serveru.
  const status = Number(err.status || err.statusCode) || 500;

  if (status >= 500) {
    // Detaily (Firestore/pg/mysql chyby) prozrazují názvy kolekcí, hostnames
    // a cesty — logujeme je serverově, klientovi dáme jen dohledávací ID.
    const errorId = randomUUID();
    console.error(`Express zachytil neošetřenou chybu routy [${errorId}]:`, err);
    const body = { error: 'Interní chyba serveru.', errorId };
    if (process.env.NODE_ENV !== 'production') body.details = err.message;
    return res.status(status).json(body);
  }

  res.status(status).json({ error: err.message || 'Neplatný požadavek.' });
});

// V produkci se s neomezeným přístupem nestartuje.
//
// `console.warn` při startu byl jediná pojistka — a v `docker compose logs`
// s rotací po 10 MB ho nikdo neuvidí. Nasazení, kde chybí ALLOWED_EMAILS,
// je přitom otevřený skener pro kohokoli na internetu. Výchozí stav musí být
// zavřený; kdo chce otevřený, řekne si o to výslovně.
if (
  process.env.NODE_ENV === 'production' &&
  !accessConfig().restricted &&
  process.env.ALLOW_ANY_EMAIL !== 'true'
) {
  console.error(
    'Server nelze spustit: přístup není omezený.\n' +
      '  Nastav ALLOWED_EMAILS nebo ALLOWED_EMAIL_DOMAINS v .env.\n' +
      '  Vědomě otevřená instalace vyžaduje ALLOW_ANY_EMAIL=true.'
  );
  process.exit(1);
}

if (process.env.NODE_ENV !== 'test') {
  server.listen(PORT, () => {
    console.log(`AuraTest AI server běží na http://localhost:${PORT}`);
    // Neomezený přístup se musí ozvat. Tichá otevřenost je horší než
    // hlučná — provozovatel jinak netuší, že si účet může založit kdokoli.
    accessWarnings().forEach((line) => console.warn(`  ${line}`));
  });
}

export { app };
