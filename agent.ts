import { chromium, Page, BrowserContext } from 'playwright';
import { diffWords } from 'diff';
import path from 'path';
import fs from 'fs';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';

export interface LLMConfig {
  provider: 'ollama' | 'apfel' | string;
  model: string;
  host: string;
  headless?: boolean;
  maxSteps?: number;
  mode?: 'smoke_test' | 'smart_monkey' | 'monkey' | 'crawler' | 'ai';
  testLogin?: string;
  testPassword?: string;
}

export interface InteractiveElement {
  id: number;
  tagName: string;
  text: string;
  type: string;
  placeholder: string;
  name: string;
  role: string;
  href: string;
  rect?: { x: number; y: number; width: number; height: number };
}

export interface StepAction {
  reasoning: string;
  action: 'click' | 'type' | 'scroll' | 'navigate' | 'wait' | 'finish';
  target: string | number | null;
  value: string | null;
  detected_bugs?: string[];
}

export interface BugDetail {
  text: string;
  stepNumber: number;
  url: string;
  screenshotPath: string;
  rect?: { x: number; y: number; width: number; height: number } | null;
}

export interface StepResult extends StepAction {
  step: number;
  url: string;
  title: string;
  screenshot: string;
  logs: any[];
  bugs: string[];
  detectedBugsDetails?: BugDetail[];
  timestamp: string;
  rect?: { x: number; y: number; width: number; height: number } | null;
}

export interface TestResult {
  success: boolean;
  steps: StepResult[];
  bugs: string[];
  bugDetails?: BugDetail[];
  summary: string;
  performanceMetrics: any;
  generatedScript: string;
  videoUrl: string | null;
}


// Helper to query LLM (Ollama or apfel/OpenAI-compatible)
async function queryLLM(prompt: string, systemPrompt: string, provider = 'ollama', model = 'llama3', host = 'http://localhost:11434'): Promise<string> {
  if (provider === 'apfel' || host.includes('/v1/chat/completions') || host.includes('/chat/completions')) {
    const url = host.includes('/v1/chat/completions') || host.includes('/chat/completions') 
      ? host 
      : `${host.replace(/\/$/, '')}/v1/chat/completions`;

    const messages = [];
    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }
    messages.push({ role: 'user', content: prompt });

    try {
      let attempts = 0;
      const maxAttempts = 12; 
      while (attempts < maxAttempts) {
        try {
          const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: model || 'apple-foundationmodel',
              messages,
              temperature: 0.1,
              max_tokens: 4096,
              response_format: { type: 'json_object' }
            })
          });

          const status = response.status;
          const ok = response.ok;

          if (status === 503 || status === 500) {
            const text = await response.text();
            if (text.includes('Model assets are loading') && attempts < maxAttempts - 1) {
              console.log(`[apfel AI] Model se načítá do paměti (pokus ${attempts + 1}/${maxAttempts}). Čekám 5 sekund...`);
              attempts++;
              await new Promise(resolve => setTimeout(resolve, 5000));
              continue;
            }
            throw new Error(`API error (${status}): ${text}`);
          }

          if (!ok) {
            const text = await response.text();
            console.warn('apfel JSON response_format failed, retrying standard completions...', text);
            // Fallback
            const retryResponse = await fetch(url, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                model: model || 'apple-foundationmodel',
                messages,
                temperature: 0.1,
                max_tokens: 4096
              })
            });
            
            const retryStatus = retryResponse.status;
            const retryOk = retryResponse.ok;
            const retryText = await retryResponse.text();

            if (retryStatus === 503 || retryStatus === 500) {
              if (retryText.includes('Model assets are loading') && attempts < maxAttempts - 1) {
                console.log(`[apfel AI] Model se načítá do paměti (pokus ${attempts + 1}/${maxAttempts}). Čekám 5 sekund...`);
                attempts++;
                await new Promise(resolve => setTimeout(resolve, 5000));
                continue;
              }
            }
            
            if (!retryOk) {
              throw new Error(`API error (${retryStatus}): ${retryText}`);
            }
            
            const result = JSON.parse(retryText);
            return result.choices[0].message.content;
          }

          const result = await response.json();
          return result.choices[0].message.content;
        } catch (err: any) {
          if (attempts < maxAttempts - 1 && (err.message.includes('fetch failed') || err.message.includes('socket hang up') || err.message.includes('ECONNREFUSED') || err.message.includes('body stream already read'))) {
            console.log(`[apfel AI] Dočasná chyba připojení (pokus ${attempts + 1}/${maxAttempts}). Čekám 5 sekund...: ${err.message}`);
            attempts++;
            await new Promise(resolve => setTimeout(resolve, 5000));
            continue;
          }
          throw new Error(`Selhání komunikace s LLM AI (${url}): ${err.message}`);
        }
      }
      throw new Error(`Max attempts reached pro LLM: ${url}`);
    } catch (outerErr: any) {
      throw new Error(`Selhání komunikace s LLM AI (${url}): ${outerErr.message}`);
    }
  } else {
    // Ollama custom chat completions API
    const url = host.includes('/api/chat') 
      ? host 
      : `${host.replace(/\/$/, '')}/api/chat`;

    const messages = [];
    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }
    messages.push({ role: 'user', content: prompt });

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: model || 'llama3',
          messages,
          stream: false,
          options: { temperature: 0.1, num_predict: 4096 },
          format: {
            type: "object",
            properties: {
              reasoning: { type: "string" },
              action: { type: "string", enum: ["click", "type", "scroll", "navigate", "wait", "finish"] },
              target: { anyOf: [{ type: "integer" }, { type: "string" }, { type: "null" }] },
              value: { anyOf: [{ type: "string" }, { type: "null" }] },
              detected_bugs: { type: "array", items: { type: "string" } }
            },
            required: ["reasoning", "action", "target", "value", "detected_bugs"]
          }
        })
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Ollama API error (${response.status}): ${text}`);
      }

      const result = await response.json();
      return result.message.content;
    } catch (err: any) {
      console.warn('Ollama connection failed, attempting fallback without JSON formatting...', err.message);
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: model || 'llama3',
          messages,
          stream: false,
          options: { temperature: 0.1, num_predict: 4096 }
        })
      });
      if (!response.ok) throw new Error(`Ollama fallback failed: ${response.statusText}`);
      const result = await response.json();
      return result.message.content;
    }
  }
}

export async function extractInteractiveElements(page: Page): Promise<InteractiveElement[]> {
  return await page.evaluate(() => {
    const interactiveTags = ['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'LABEL'];
    const elements = Array.from(document.querySelectorAll('*')) as HTMLElement[];
    const interactiveList: any[] = [];
    let qaIdCounter = 1;

    elements.forEach((el) => {
      const style = window.getComputedStyle(el);
      const isVisible = el.offsetWidth > 0 && 
                        el.offsetHeight > 0 && 
                        style.display !== 'none' && 
                        style.visibility !== 'hidden' && 
                        style.opacity !== '0';
      
      if (!isVisible) return;

      const tagName = el.tagName;
      const isInteractiveTag = interactiveTags.includes(tagName);
      const hasClickAttribute = el.hasAttribute('onclick') || el.getAttribute('role') === 'button';
      const hasPointerCursor = style.cursor === 'pointer';

      if (isInteractiveTag || hasClickAttribute || hasPointerCursor) {
        el.setAttribute('data-qa-id', String(qaIdCounter));
        
        let text = (el.innerText || (el as HTMLInputElement).value || '').trim().replace(/\s+/g, ' ');
        if (text.length > 100) text = text.substring(0, 100) + '...';

        const rect = el.getBoundingClientRect();
        interactiveList.push({
          id: qaIdCounter,
          tagName,
          text,
          type: el.getAttribute('type') || '',
          placeholder: el.getAttribute('placeholder') || '',
          name: el.getAttribute('name') || '',
          role: el.getAttribute('role') || '',
          href: el.getAttribute('href') || '',
          rect: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height)
          }
        });
        qaIdCounter++;
      }
    });

    return interactiveList;
  });
}

async function extractPageTexts(page: Page) {
  return await page.evaluate(() => {
    const results: any[] = [];
    const walk = (node: Node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.nodeValue?.trim();
        if (text && node.parentElement) {
          const parent = node.parentElement;
          const style = window.getComputedStyle(parent);
          const isVisible = parent.offsetWidth > 0 && 
                            parent.offsetHeight > 0 && 
                            style.display !== 'none' && 
                            style.visibility !== 'hidden';
          
          if (isVisible && !['SCRIPT', 'STYLE', 'NOSCRIPT'].includes(parent.tagName)) {
            let path = '';
            let current: HTMLElement | null = parent;
            while (current && current.nodeType === Node.ELEMENT_NODE && current.tagName !== 'BODY') {
              let part = current.tagName.toLowerCase();
              if (current.id) {
                part += `#${current.id}`;
                path = part + (path ? ' > ' + path : '');
                break;
              } else if (current.className && typeof current.className === 'string') {
                part += `.${Array.from(current.classList).join('.')}`;
              }
              path = part + (path ? ' > ' + path : '');
              current = current.parentElement;
            }

            results.push({
              text,
              selector: path || 'body',
              tagName: parent.tagName
            });
          }
        }
      } else {
        for (let i = 0; i < node.childNodes.length; i++) {
          walk(node.childNodes[i]);
        }
      }
    };
    walk(document.body);
    return results;
  });
}

function generatePlaywrightScript(steps: StepResult[], startUrl: string): string {
  let script = `import { test, expect } from '@playwright/test';\n\n`;
  script += `test('Autonomously generated AI test', async ({ page }) => {\n`;
  script += `  await page.goto('${startUrl}');\n\n`;
  
  for (const step of steps) {
    if (!step.action || step.action === 'finish') continue;
    script += `  // Step ${step.step}: ${step.reasoning || step.action}\n`;
    if (step.action === 'click' && step.target) {
      script += `  await page.click('[data-qa-id="${step.target}"]');\n`;
    } else if (step.action === 'type' && step.target) {
      script += `  await page.fill('[data-qa-id="${step.target}"]', '${step.value}');\n`;
    } else if (step.action === 'scroll') {
      script += `  await page.mouse.wheel(0, ${step.value === 'down' ? 500 : -500});\n`;
    } else if (step.action === 'navigate' && step.target) {
      script += `  await page.goto('${step.target}');\n`;
    } else if (step.action === 'wait') {
      script += `  await page.waitForTimeout(2000);\n`;
    }
  }
  script += `\n  // Doplňte vlastní asserty (např. expect(page).toHaveTitle(...))\n});\n`;
  return script;
}

export async function extractInternalLinks(startUrl: string): Promise<string[]> {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  const internalLinks: string[] = [];
  try {
    await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
    const baseUrl = new URL(startUrl);
    const hrefs = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('a')).map(a => a.href);
    });
    
    for (const href of hrefs) {
      if (!href) continue;
      try {
        const u = new URL(href, startUrl);
        u.hash = '';
        if (u.origin === baseUrl.origin && u.pathname !== baseUrl.pathname) {
          internalLinks.push(u.href);
        }
      } catch (e) {
      }
    }
  } catch (err: any) {
    console.error("Failed to extract links:", err.message);
  } finally {
    await browser.close();
  }
  return [...new Set(internalLinks)].slice(0, 3);
}

export async function runAutonomousTest(url: string, goal: string, llmConfig: LLMConfig, onStepProgress: (info: any) => void, sessionId = 'session_default'): Promise<TestResult> {
  const browser = await chromium.launch({ headless: llmConfig.headless !== false });
  const videosDir = path.join(process.cwd(), 'videos');
  if (!fs.existsSync(videosDir)) {
    fs.mkdirSync(videosDir, { recursive: true });
  }

  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    recordVideo: { dir: videosDir }
  });
  const page = await context.newPage();

  const steps: StepResult[] = [];
  const bugs: string[] = [];
  let currentStep = 1;
  const maxSteps = llmConfig.maxSteps || 10;
  let isFinished = false;
  let performanceMetrics: any = null;

  const consoleLogs: any[] = [];
  page.on('console', (msg) => {
    const type = msg.type();
    const text = msg.text();
    consoleLogs.push({ type, text, timestamp: new Date().toISOString() });
    if (type === 'error') {
      bugs.push(`Detekována chyba v konzoli: "${text}"`);
    }
  });

  const networkErrors: any[] = [];
  page.on('requestfailed', (request) => {
    const errText = request.failure()?.errorText || 'Unknown failure';
    const reqUrl = request.url();
    if (errText === 'net::ERR_ABORTED' && reqUrl.match(/\.(mp4|webm|ogg|avi|mov)(\?.*)?$/i)) {
      return;
    }
    networkErrors.push({ url: reqUrl, error: errText });
    bugs.push(`Selhal síťový požadavek: GET ${reqUrl} - ${errText}`);
  });

  // Trackování navštívených URL pro inteligentní průzkum
  const visitedUrls = new Set<string>([url]);
  // Globální paměť všech kliknutých/otestovaných prvků (napříč kroky)
  const testedElements = new Set<number>();
  const bugDetails: BugDetail[] = [];

  // ANTI-LOOP V4 MEMORY
  const failedActionsMemory: string[] = [];
  let consecutiveLoopFailures = 0;
  const interactionCounts = new Map<string, number>(); // klíč: 'akce:target_id:url'

  try {
    if (onStepProgress) onStepProgress({ step: 0, action: 'Navigace', detail: `Otevírání ${url}` });
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    
    while (currentStep <= maxSteps && !isFinished) {
      const currentUrl = page.url();
      const title = await page.title();
      const interactiveElements = await extractInteractiveElements(page);
      
      const screenshotFileName = `${sessionId}_step_${currentStep}.png`;
      const screenshotPath = path.join(process.cwd(), 'screenshots', screenshotFileName);
      try {
        await page.screenshot({ path: screenshotPath });
      } catch (err: any) {
        console.warn('Nepodařilo se uložit screenshot na disk:', err.message);
      }

      const recentLogs = consoleLogs.slice(-10).map(l => `[${l.type}] ${l.text}`).join('\n');
      const recentNet = networkErrors.slice(-10).map(n => `FAIL: ${n.url} - ${n.error}`).join('\n');

      let systemPrompt = '';
      let prompt = '';

      let credentialsInfo = '';
      if (llmConfig.testLogin || llmConfig.testPassword) {
        credentialsInfo = `\nTEST CREDENTIALS (Use these if you need to log in or fill out auth forms):\n- Login/Email: ${llmConfig.testLogin || 'Not provided'}\n- Password: ${llmConfig.testPassword || 'Not provided'}\n`;
      }

      const failedTargets = failedActionsMemory
        .map(f => {
          const match = f.match(/Target:\s*(\d+)/);
          return match ? parseInt(match[1]) : null;
        })
        .filter(id => id !== null);

      let forbiddenTargetsInfo = '';
      if (failedTargets.length > 0) {
        forbiddenTargetsInfo = `\nCRITICAL: DO NOT use the following targets (they failed or caused loops): [${failedTargets.join(', ')}]. You MUST pick a different target.`;
      }

      const filteredElements = interactiveElements.filter(el => {
        if (failedTargets.includes(el.id)) return false;

        const clickCount = interactionCounts.get(`click:${el.id}:${currentUrl}`) || 0;
        const typeCount = interactionCounts.get(`type:${el.id}:${currentUrl}`) || 0;

        // Odkazy a navigaci soft-blockujeme po 2 úspěšných kliknutích na dané URL
        if ((el.tagName === 'A' || el.role === 'link') && clickCount >= 2) {
          return false;
        }
        // Ostatní elementy soft-blockujeme po 3 interakcích na dané URL
        if (clickCount >= 3 || typeCount >= 3) {
          return false;
        }

        return true;
      });
      const visitedUrlsList = Array.from(visitedUrls).join(', ');

      const alreadyTestedIds = Array.from(testedElements);
      let alreadyTestedNote = '';
      if (alreadyTestedIds.length > 0) {
        alreadyTestedNote = `\nAlready tested element IDs (prefer NEW ones, but you may re-test inputs with different values): [${alreadyTestedIds.slice(-20).join(', ')}]`;
      }

      // Simplify elements to save prompt tokens for local LLM (removes empty fields, keeps it compact)
      const simplifiedElements = filteredElements.map(el => {
        const item: any = { id: el.id, tag: el.tagName };
        if (el.text) item.text = el.text;
        if (el.type) item.type = el.type;
        if (el.placeholder) item.placeholder = el.placeholder;
        if (el.name) item.name = el.name;
        if (el.role) item.role = el.role;
        if (el.href) item.href = el.href;
        return item;
      });

      // Construct optional hints for input testing
      let inputTestingHints = '';
      const inputElements = simplifiedElements.filter(el => ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tag));
      if (inputElements.length > 0) {
        inputTestingHints = `\nSUGGESTED VALUES TO TEST IN INPUT FIELDS (choose different ones to maximize input validation coverage):`;
        inputElements.forEach(el => {
          const type = (el.type || '').toLowerCase();
          const name = (el.name || '').toLowerCase();
          const placeholder = (el.placeholder || '').toLowerCase();
          const text = (el.text || '').toLowerCase();
          
          let fieldType = 'generic';
          if (type === 'email' || name.includes('email') || placeholder.includes('email')) {
            fieldType = 'email';
          } else if (type === 'password' || name.includes('pass') || placeholder.includes('heslo') || placeholder.includes('pass')) {
            fieldType = 'password';
          } else if (type === 'tel' || name.includes('phone') || name.includes('tel') || name.includes('mobil') || placeholder.includes('telefon')) {
            fieldType = 'tel';
          } else if (type === 'number' || name.includes('price') || name.includes('amount') || name.includes('sazba') || placeholder.includes('cena') || placeholder.includes('sazba') || text.includes('sazba')) {
            fieldType = 'number';
          } else if (name.includes('zip') || name.includes('psc') || placeholder.includes('psc') || placeholder.includes('zip')) {
            fieldType = 'zip';
          }
          
          if (fieldType === 'email') {
            inputTestingHints += `\n- Element ID ${el.id} (E-mail): Použij validní "test@example.com" nebo nevalidní "chybny-email"`;
          } else if (fieldType === 'password') {
            inputTestingHints += `\n- Element ID ${el.id} (Heslo): Použij silné "SecurePass123!" nebo příliš krátké "123"`;
          } else if (fieldType === 'tel') {
            inputTestingHints += `\n- Element ID ${el.id} (Telefon): Použij validní "+420777123456" nebo nevalidní "text_misto_cisla"`;
          } else if (fieldType === 'number') {
            inputTestingHints += `\n- Element ID ${el.id} (Číslo): Použij validní kladné číslo "150", desetinné "12.5" nebo nevalidní záporné "-50"`;
          } else if (fieldType === 'zip') {
            inputTestingHints += `\n- Element ID ${el.id} (PSČ): Použij validní "11000" nebo nevalidní "ABCDE"`;
          } else {
            inputTestingHints += `\n- Element ID ${el.id} (Text): Použij standardní "Zkušební text", prázdný řetězec "", XSS script injection "<script>alert('XSS')</script>" nebo velmi dlouhý text`;
          }
        });
        inputTestingHints += '\n';
      }

      if (llmConfig.mode === 'smart_monkey') {
        systemPrompt = `You are AuraTest AI, an expert QA testing agent performing a Smart Monkey Test.
Your goal: Explore EVERY part of the application. Click nav links to discover new pages. Fill forms. Try to break the app.
Prioritize: 1) Unvisited navigation links (A tags) to new pages, 2) Input fields with edge-case data, 3) Buttons you haven't clicked.${credentialsInfo}${forbiddenTargetsInfo}${alreadyTestedNote}
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
- NO BUGS = EMPTY ARRAY: If no bugs are present on the page, the "detected_bugs" array MUST be empty: []. NEVER copy your reasoning or element descriptions into detected_bugs.
- CRITICAL: All JSON values MUST be in Czech language (Čeština).`;

        prompt = `Test Type: Smart AI Monkey Test
Current URL: ${currentUrl}
Page Title: ${title}
Already visited URLs: [${visitedUrlsList}]
Progress: Step ${currentStep}/${maxSteps}

Interactive elements on page (focus on ones NOT in 'Already tested' list):
${JSON.stringify(simplifiedElements)}
${inputTestingHints}
Recent console logs:
${recentLogs || 'No console errors.'}

Recent network errors:
${recentNet || 'No network errors.'}

History of previous steps (last 15):
${steps.slice(-15).map(s => `Step ${s.step} [${s.url}]: ${s.action} target=${s.target} value="${s.value || ''}" | ${s.reasoning?.substring(0, 80)}`).join('\n') || 'No previous steps.'}

FAILED ACTIONS MEMORY (DO NOT REPEAT):
${failedActionsMemory.join('\n') || 'None.'}

Choose the MOST VALUABLE next action to maximize coverage. Prefer unexplored pages and elements!`;

      } else {
        systemPrompt = `You are AuraTest AI, an expert QA testing agent.
Your primary goal is: "${goal}"
Follow the user's instructions and try to achieve this goal by interacting with the page.
Think step-by-step.${credentialsInfo}${forbiddenTargetsInfo}
You must reply ONLY with a JSON object in this format:
{
  "reasoning": "Detailní vysvětlení, jak ti tento krok pomůže splnit cíl.",
  "action": "click" | "type" | "scroll" | "navigate" | "wait" | "finish",
  "target": 123 (the data-qa-id number, or URL for 'navigate', or null for 'wait'/'finish'),
  "value": "text to type, or 'down'/'up' for 'scroll', otherwise null",
  "detected_bugs": ["SHORT summary of bugs. Max 1 sentence!"]
}

Rules:
- 'target' must match a valid data-qa-id from the interactive elements list.
- If the goal is fully completed or impossible to proceed, use "finish".
- If you see any bugs, list them in 'detected_bugs'.
- NO BUGS = EMPTY ARRAY: If no bugs are found, "detected_bugs" MUST be empty []. Never copy your reasoning or description into it.
- CRITICAL: All JSON output values ('reasoning', 'detected_bugs') MUST be written in the Czech language (Čeština).`;

        prompt = `Test Goal: ${goal}
Current URL: ${currentUrl}
Page Title: ${title}
Already visited URLs: [${visitedUrlsList}]
Progress: Step ${currentStep}/${maxSteps}

Interactive elements on page:
${JSON.stringify(simplifiedElements)}
${inputTestingHints}
Recent console logs:
${recentLogs || 'No console errors.'}

Recent network errors:
${recentNet || 'No network errors.'}

History of previous steps (last 15):
${steps.slice(-15).map(s => `Step ${s.step} [${s.url}]: ${s.action} target=${s.target} value="${s.value || ''}" | ${s.reasoning?.substring(0, 80)}`).join('\n') || 'No previous steps.'}

FAILED ACTIONS MEMORY (DO NOT REPEAT):
${failedActionsMemory.join('\n') || 'None.'}

Choose the next best action. Reply ONLY with valid JSON.`;
      }

      let actionResponse: StepAction = {
        reasoning: 'Fallback',
        action: 'wait',
        target: null,
        value: null,
        detected_bugs: []
      };

      if (llmConfig.mode === 'monkey') {
         if (interactiveElements.length === 0) {
           actionResponse = { reasoning: 'Žádné prvky', action: 'finish', target: null, value: null };
         } else {
           const rand = Math.random();
           if (rand < 0.15) {
             actionResponse = { reasoning: 'Random scroll', action: 'scroll', target: null, value: Math.random() > 0.5 ? 'down' : 'up' };
           } else {
             const el = interactiveElements[Math.floor(Math.random() * interactiveElements.length)];
             if (el.tagName === 'INPUT') {
               actionResponse = { reasoning: 'Random type', action: 'type', target: el.id, value: 'test' };
             } else {
               actionResponse = { reasoning: 'Random click', action: 'click', target: el.id, value: null };
             }
           }
         }
       } else {
        try {
          const lastStep = steps[steps.length - 1];
          if (filteredElements.length === 0 && lastStep && lastStep.action === 'scroll') {
            actionResponse = {
              reasoning: "Všechny dostupné interaktivní prvky byly již otestovány a scrollování neodhalilo nový obsah. Ukončuji test.",
              action: 'finish',
              target: null,
              value: null,
              detected_bugs: []
            };
          } else {
            const responseText = await queryLLM(prompt, systemPrompt, llmConfig.provider, llmConfig.model, llmConfig.host);
            let cleaned = responseText.replace(/```json/g, '').replace(/```/g, '').trim();
          
          try {
            actionResponse = JSON.parse(cleaned);
          } catch (parseErr: any) {
            console.warn('JSON parse failed, attempting auto-recovery...', parseErr.message);
            const closings = ['"}', '"]}', ']}', '}'];
            let parsed = false;
            for (const ending of closings) {
              try {
                actionResponse = JSON.parse(cleaned + ending);
                cleaned = cleaned + ending;
                parsed = true;
                break;
              } catch (e) {}
            }
            if (!parsed) {
               throw new Error(`Nelze opravit JSON: ${parseErr.message}`);
            }
          }

          // Zaznamenání úspěšného kroku pro trénovací dataset (fine-tuning)
          try {
            const datasetPath = path.join(process.cwd(), 'auratest_dataset.jsonl');
            const record = {
              messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: prompt },
                { role: 'assistant', content: cleaned }
              ]
            };
            fs.appendFileSync(datasetPath, JSON.stringify(record) + '\n', 'utf8');
          } catch (err: any) {
            console.warn('[Dataset Logger] Chyba při zápisu do trénovacího souboru:', err.message);
          }
          }
        } catch (err: any) {
          console.error('LLM komunikace selhala:', err);
          
          if (!err.message.includes('Nelze opravit JSON')) {
            throw err; // Fatální chyba spojení nebo API (např. nenalezen model), nepokračovat.
          }
          
          actionResponse = {
            reasoning: `(Záchranný krok) AI JSON error: ${err.message}.`,
            action: 'scroll',
            target: null,
            value: 'down',
            detected_bugs: []
          };
        }
      }

      // V4 Anti-Loop Protection
      let isLooping = false;
      if (llmConfig.mode !== 'monkey') {
        const actionSignature = `Action: ${actionResponse.action}, Target: ${actionResponse.target}`;
        
        if (failedActionsMemory.some(f => f.startsWith(actionSignature))) {
          // Model zkouší akci, která je explicitně v paměti zakázaných akcí
          isLooping = true;
        } else if (
          actionResponse.target !== null &&
          actionResponse.target !== undefined &&
          filteredElements.length > 0 &&
          !filteredElements.some(el => el.id == actionResponse.target)
        ) {
          // Model halucinuje QA-ID, které vůbec NENÍ v aktuálním filteredElements (bylo ghostováno)
          console.warn(`Anti-loop V4: Model halucinoval QA-ID ${actionResponse.target}, které neexistuje ve filteredElements!`);
          isLooping = true;
        } else if (steps.length >= 1) {
          const lastStep = steps[steps.length - 1];
          if (
            actionResponse.action === lastStep.action && 
            actionResponse.target == lastStep.target &&
            actionResponse.target !== null
          ) {
            isLooping = true;
          }
        }
      }

      if (isLooping) {
        consecutiveLoopFailures++;
        console.warn(`Anti-loop triggered (Pokus ${consecutiveLoopFailures}/5). Model zopakoval zacyklenou nebo halucinovanou akci.`);
        
        const actionSignature = `Action: ${actionResponse.action}, Target: ${actionResponse.target}`;
        if (!failedActionsMemory.some(f => f.startsWith(actionSignature))) {
           failedActionsMemory.push(`${actionSignature} -> Tato akce nepřinesla změnu stavu nebo byla halucinace!`);
        }
        
        if (consecutiveLoopFailures >= 5) {
          console.warn("Anti-loop: Dosažen limit zacyklení. Ukončuji test.");
          actionResponse = {
            reasoning: "Všechny dostupné prvky na stránce byly prozkoumány a otestovány. Ukončuji průchod.",
            action: 'finish',
            target: null,
            value: null,
            detected_bugs: []
          };
        }

        // Dynamická recovery: střídá scroll dolů a scroll nahoru, aby model viděl jiné prvky
        const recoveryAction = consecutiveLoopFailures % 2 === 0 ? 'up' : 'down';
        actionResponse = {
           reasoning: `(Ochrana V4, pokus ${consecutiveLoopFailures}/5) Detekována halucinace nebo smyčka. Ghostuji cíl, posúvám obrazovku ${recoveryAction === 'up' ? 'nahoru' : 'dolů'} pro rozšíření kontextu.`,
           action: 'scroll',
           target: null,
           value: recoveryAction,
           detected_bugs: []
        };
      } else {
        consecutiveLoopFailures = 0; // Reset na úspěšném novém kroku
      }

      // Vyhledání souřadnic cílového elementu pro vizuální zvýraznění v UI
      const targetElement = actionResponse.target !== null && actionResponse.target !== undefined && typeof actionResponse.target === 'number'
        ? interactiveElements.find(el => el.id === actionResponse.target)
        : null;
      const targetRect = targetElement?.rect || null;

      if (actionResponse.detected_bugs && Array.isArray(actionResponse.detected_bugs)) {
        actionResponse.detected_bugs.forEach(b => {
          const cleanBug = b.trim();
          if (!cleanBug) return;
          
          // Pokud se nahlášená chyba shoduje s odůvodněním (reasoning), ignorujeme ji (halucinace)
          if (cleanBug === actionResponse.reasoning?.trim()) return;
          
          // Ignorujeme popisy běžných akcí / uvažování, které nejsou skutečnými chybami
          const lower = cleanBug.toLowerCase();
          if (
            lower.startsWith('první krok') || 
            lower.startsWith('vidím') || 
            lower.startsWith('zkontroluji') || 
            lower.startsWith('začínám') || 
            lower.startsWith('kliknu') ||
            lower.includes('přejděme na')
          ) {
            return;
          }

          if (!bugs.includes(cleanBug)) {
            bugs.push(cleanBug);
            bugDetails.push({
              text: cleanBug,
              stepNumber: currentStep,
              url: currentUrl,
              screenshotPath: `/api/screenshots/${screenshotFileName}`,
              rect: targetRect
            });
          }
        });
      }

      const stepData: StepResult = {
        step: currentStep,
        url: currentUrl,
        title,
        reasoning: actionResponse.reasoning,
        action: actionResponse.action as any,
        target: actionResponse.target,
        value: actionResponse.value,
        screenshot: `/api/screenshots/${screenshotFileName}`,
        logs: [...consoleLogs],
        bugs: [...bugs],
        detectedBugsDetails: bugDetails.filter(bd => bd.stepNumber === currentStep),
        timestamp: new Date().toISOString(),
        rect: targetRect
      };
      
      steps.push(stepData);
      if (onStepProgress) onStepProgress(stepData);

      // Sleduj otestované prvky
      if (actionResponse.target !== null && actionResponse.target !== undefined && typeof actionResponse.target === 'number') {
        testedElements.add(actionResponse.target as number);
      }

      if (actionResponse.action === 'finish') {
        isFinished = true;
        break;
      }

      try {
        if (actionResponse.action === 'click') {
          await page.click(`[data-qa-id="${actionResponse.target}"]`, { timeout: 5000 });
          const key = `click:${actionResponse.target}:${currentUrl}`;
          interactionCounts.set(key, (interactionCounts.get(key) || 0) + 1);
          // Po kliknutí na navigaci počkáme déle na načtení nové stránky
          await page.waitForTimeout(1500);
          const newUrl = page.url();
          if (newUrl !== currentUrl) {
            visitedUrls.add(newUrl);
            console.log(`[Agent] Přechod na novou stránku: ${newUrl}`);
          }
        } else if (actionResponse.action === 'type') {
          await page.fill(`[data-qa-id="${actionResponse.target}"]`, actionResponse.value || '', { timeout: 5000 });
          const key = `type:${actionResponse.target}:${currentUrl}`;
          interactionCounts.set(key, (interactionCounts.get(key) || 0) + 1);
          await page.waitForTimeout(500);
        } else if (actionResponse.action === 'scroll') {
          const direction = actionResponse.value === 'up' ? -600 : 600;
          await page.evaluate((y) => window.scrollBy(0, y), direction);
          await page.waitForTimeout(500);
        } else if (actionResponse.action === 'navigate') {
          let navTarget = actionResponse.target;
          // Ochrana: pokud model vrátil číslo (QA-ID) místo URL, dohledáme href elementu
          if (typeof navTarget === 'number' || (typeof navTarget === 'string' && !navTarget.startsWith('http') && !navTarget.startsWith('/'))) {
            const element = interactiveElements.find(el => el.id == navTarget);
            if (element?.href && (element.href.startsWith('http') || element.href.startsWith('/'))) {
              console.log(`[Agent] Navigate: převádím QA-ID ${navTarget} na href: ${element.href}`);
              navTarget = element.href;
            } else {
              // Fallback: zkus kliknout na prvek místo navigate
              console.log(`[Agent] Navigate: QA-ID ${navTarget} nemá href, přepínám na click.`);
              await page.click(`[data-qa-id="${navTarget}"]`, { timeout: 5000 }).catch(() => {});
              const key = `click:${navTarget}:${currentUrl}`;
              interactionCounts.set(key, (interactionCounts.get(key) || 0) + 1);
              navTarget = null;
            }
          }
          if (navTarget) {
            let targetUrl = String(navTarget);
            if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://') && !targetUrl.startsWith('file://')) {
              try {
                targetUrl = new URL(targetUrl, page.url()).href;
              } catch (e) {
                console.warn(`Nepodařilo se přeložit relativní URL: ${targetUrl}`, e);
              }
            }
            console.log(`[Agent] Navigate: Přejíždím na ${targetUrl}`);
            await page.goto(targetUrl, { waitUntil: 'networkidle', timeout: 15000 });
          }
          visitedUrls.add(page.url());
          await page.waitForTimeout(1000);
        } else if (actionResponse.action === 'wait') {
          const waitTime = parseInt(actionResponse.value as string) || 2000;
          await page.waitForTimeout(waitTime);
        }
      } catch (actionErr: any) {
        console.error(`Akce '${actionResponse.action}' selhala:`, actionErr.message);
        failedActionsMemory.push(`Action: ${actionResponse.action}, Target: ${actionResponse.target} -> Chyba provedení: ${actionErr.message}`);
        bugs.push(`Akce '${actionResponse.action}' selhala: ${actionErr.message}`);
      }

      currentStep++;
    }

    try {
      performanceMetrics = await page.evaluate(() => {
        const timing = performance.getEntriesByType('navigation')[0] as any || {};
        return {
          loadTimeMs: timing.loadEventEnd ? Math.round(timing.loadEventEnd - timing.startTime) : null,
          domInteractiveMs: timing.domInteractive ? Math.round(timing.domInteractive - timing.startTime) : null,
          title: document.title,
          h1Count: document.querySelectorAll('h1').length
        };
      });
    } catch (e: any) {
      console.log("Could not fetch performance metrics", e.message);
    }

  } catch (err: any) {
    console.error('Test execution failed:', err);
    bugs.push(`Katastrofická chyba testu: ${err.message}`);
  }

  let videoUrl: string | null = null;
  try {
    if (page.video()) {
      const videoPath = await page.video()!.path();
      videoUrl = `/api/videos/${path.basename(videoPath)}`;
    }
  } catch (e: any) {
    console.log("Mohlo selhat získání cesty k videu", e.message);
  }

  await browser.close();

  const generatedScript = generatePlaywrightScript(steps, url);
  const scriptsDir = path.join(process.cwd(), 'generated-scripts');
  if (!fs.existsSync(scriptsDir)) {
    fs.mkdirSync(scriptsDir, { recursive: true });
  }
  const scriptPath = path.join(scriptsDir, `test-${Date.now()}.spec.ts`);
  fs.writeFileSync(scriptPath, generatedScript, 'utf8');

  let finalSummary = 'Test úspěšně dokončen.';
  if (!isFinished) {
    if (consecutiveLoopFailures >= 5) {
      finalSummary = 'Test byl předčasně ukončen z důvodu kritického zacyklení agenta.';
    } else {
      finalSummary = `Test dosáhl maximálního počtu kroků (${maxSteps}) a byl úspěšně ukončen.`;
    }
  }

  return {
    success: bugs.length === 0,
    steps,
    bugs: [...new Set(bugs)],
    bugDetails,
    summary: finalSummary,
    performanceMetrics,
    generatedScript,
    videoUrl
  };
}

export async function comparePages(url1: string, url2: string, steps?: any[], baseTimeoutMs = 20000): Promise<any> {
  const browser = await chromium.launch({ headless: true });
  
  let screenshot1 = '';
  let screenshot2 = '';
  let visualDiff = '';
  let texts1: any[] = [];
  let texts2: any[] = [];
  let error1: string | null = null;
  let error2: string | null = null;
  let errors1: string[] = [];
  let errors2: string[] = [];

  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const stepsCount = steps ? steps.length : 0;
    const calculatedTimeout = baseTimeoutMs + (stepsCount * 1000);
    
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
    });

    
    let buf1: Buffer | null = null;
    const page1 = await context.newPage();
    try {
      await page1.goto(url1, { waitUntil: 'networkidle', timeout: calculatedTimeout });
      
      if (steps && steps.length > 0) {
        for (const step of steps) {
          if (step.action === 'click' && step.selector) {
            await page1.click(step.selector);
          } else if (step.action === 'type' && step.selector) {
            await page1.fill(step.selector, step.value || '');
          }
          await page1.waitForTimeout(500);
        }
      }

      errors1 = await page1.evaluate(() => {
        const selectors = [
          '[role="alert"]',
          '.error',
          '.warning',
          '.invalid-feedback',
          '.validation-error',
          '[class*="error"]',
          '[class*="warning"]',
          '[id*="error"]',
          '[id*="warning"]'
        ];
        const found: string[] = [];
        selectors.forEach(sel => {
          document.querySelectorAll(sel).forEach(el => {
            const text = (el as HTMLElement).innerText || '';
            const isVisible = el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0;
            if (text.trim() && isVisible && !found.includes(text.trim())) {
              found.push(text.trim());
            }
          });
        });
        return found;
      });

      buf1 = await page1.screenshot({ type: 'png' });
      screenshot1 = `data:image/png;base64,${buf1.toString('base64')}`;
      texts1 = await extractPageTexts(page1);
    } catch (e: any) {
      error1 = e.message;
    }

    let buf2: Buffer | null = null;
    const page2 = await context.newPage();
    try {
      await page2.goto(url2, { waitUntil: 'networkidle', timeout: calculatedTimeout });
      
      if (steps && steps.length > 0) {
        for (const step of steps) {
          if (step.action === 'click' && step.selector) {
            await page2.click(step.selector);
          } else if (step.action === 'type' && step.selector) {
            await page2.fill(step.selector, step.value || '');
          }
          await page2.waitForTimeout(500);
        }
      }

      errors2 = await page2.evaluate(() => {
        const selectors = [
          '[role="alert"]',
          '.error',
          '.warning',
          '.invalid-feedback',
          '.validation-error',
          '[class*="error"]',
          '[class*="warning"]',
          '[id*="error"]',
          '[id*="warning"]'
        ];
        const found: string[] = [];
        selectors.forEach(sel => {
          document.querySelectorAll(sel).forEach(el => {
            const text = (el as HTMLElement).innerText || '';
            const isVisible = el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0;
            if (text.trim() && isVisible && !found.includes(text.trim())) {
              found.push(text.trim());
            }
          });
        });
        return found;
      });

      buf2 = await page2.screenshot({ type: 'png' });
      screenshot2 = `data:image/png;base64,${buf2.toString('base64')}`;
      texts2 = await extractPageTexts(page2);
    } catch (e: any) {
      error2 = e.message;
    }

    if (buf1 && buf2 && !error1 && !error2) {
      try {
        const img1 = PNG.sync.read(buf1);
        const img2 = PNG.sync.read(buf2);
        const { width, height } = img1;
        const diff = new PNG({ width, height });
        pixelmatch(img1.data, img2.data, diff.data, width, height, { threshold: 0.1 });
        const diffBuf = PNG.sync.write(diff);
        visualDiff = `data:image/png;base64,${diffBuf.toString('base64')}`;
      } catch (diffErr: any) {
        console.warn("Chyba při tvorbě vizuálního diffu:", diffErr.message);
      }
    }

  } finally {
    await browser.close();
  }

  if (error1 || error2) {
    return {
      success: false,
      error: `Chyba při načítání stránek. Web 1: ${error1 || 'OK'}, Web 2: ${error2 || 'OK'}`
    };
  }

  const diffs: any[] = [];
  const map1: Record<string, string> = {};
  texts1.forEach(t => { map1[t.selector] = t.text; });
  const map2: Record<string, string> = {};
  texts2.forEach(t => { map2[t.selector] = t.text; });

  texts1.forEach(t => {
    const text2 = map2[t.selector];
    if (text2 === undefined) {
      diffs.push({
        selector: t.selector,
        tagName: t.tagName,
        type: 'removed',
        oldText: t.text,
        newText: '',
        details: 'Prvek nebo text byl odstraněn.'
      });
    } else if (text2 !== t.text) {
      const wordsDiff = diffWords(t.text, text2);
      diffs.push({
        selector: t.selector,
        tagName: t.tagName,
        type: 'modified',
        oldText: t.text,
        newText: text2,
        wordDiff: wordsDiff.map((part: any) => ({
          added: part.added || false,
          removed: part.removed || false,
          value: part.value
        }))
      });
    }
  });

  texts2.forEach(t => {
    const text1 = map1[t.selector];
    if (text1 === undefined) {
      diffs.push({
        selector: t.selector,
        tagName: t.tagName,
        type: 'added',
        oldText: '',
        newText: t.text,
        details: 'Nově přidaný text.'
      });
    }
  });

  return { success: true, url1, url2, screenshot1, screenshot2, visualDiff, diffs, errors1, errors2 };
}

export async function auditTranslations(url: string, dictionary: Record<string, string>, llmConfig: LLMConfig): Promise<any> {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();

  let texts: any[] = [];
  let screenshot = '';

  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 25000 });
    const screenshotBuf = await page.screenshot({ type: 'png' });
    screenshot = `data:image/png;base64,${screenshotBuf.toString('base64')}`;
    texts = await extractPageTexts(page);
  } catch (e: any) {
    await browser.close();
    return { success: false, error: `Nepodařilo se otevřít URL: ${e.message}` };
  } finally {
    await browser.close();
  }

  const auditResults: any[] = [];
  const dictValues = Object.values(dictionary);
  const dictEntries = Object.entries(dictionary);

  for (const item of texts) {
    const pageText = item.text.trim();
    if (!pageText || pageText.length < 2) continue;

    const isMatched = dictValues.some(val => val.trim().toLowerCase() === pageText.toLowerCase());

    if (isMatched) {
      const keyEntry = dictEntries.find(([k, val]) => val.trim().toLowerCase() === pageText.toLowerCase());
      auditResults.push({
        text: pageText,
        selector: item.selector,
        tagName: item.tagName,
        status: 'matched',
        key: keyEntry ? keyEntry[0] : 'Neznámý'
      });
    } else {
      let aiDecision = { status: 'untranslated', suggestion: '', key: '' };
      
      const systemPrompt = `You are AuraTest AI, a software localization specialist.
You will be given text found on a web page and a reference translation dictionary in JSON format.
You must evaluate whether the page text is a correct translation from the dictionary (which may be formatted differently), or if it's hardcoded text, or if a translation is missing.
Reply ONLY with a JSON object:
{
  "status": "matched_fuzzy" | "untranslated" | "typo" | "ignored",
  "key": "the localization key from the dictionary that matches this text, if any",
  "suggestion": "Recommendation for fixing or explanation"
}

CRITICAL: All JSON output values ('suggestion') MUST be written in the Czech language (Čeština).`;

      const keywords = pageText.toLowerCase().split(/\s+/).filter((w: string) => w.length > 3);
      const relevantDict: Record<string, string> = {};
      dictEntries.forEach(([k, val]) => {
        const valLower = val.toLowerCase();
        const hasKeyword = keywords.some((word: string) => valLower.includes(word) || k.toLowerCase().includes(word));
        if (hasKeyword || Object.keys(relevantDict).length < 20) {
          relevantDict[k] = val;
        }
      });

      const prompt = `Page Text: "${pageText}"
HTML Tag: <${item.tagName}>
Element Selector: ${item.selector}

Reference localization dictionary (subset):
${JSON.stringify(relevantDict, null, 2)}

Determine the status of this text. Reply ONLY with JSON.`;

      try {
        const responseText = await queryLLM(prompt, systemPrompt, llmConfig.provider, llmConfig.model, llmConfig.host);
        const cleaned = responseText.replace(/```json/g, '').replace(/```/g, '').trim();
        const parsed = JSON.parse(cleaned);
        aiDecision = {
          status: parsed.status || 'untranslated',
          key: parsed.key || '',
          suggestion: parsed.suggestion || ''
        };
      } catch (err: any) {
        console.warn('AI evaluation failed for text:', pageText, err.message);
      }

      auditResults.push({
        text: pageText,
        selector: item.selector,
        tagName: item.tagName,
        status: aiDecision.status,
        key: aiDecision.key || 'Nenalezen',
        suggestion: aiDecision.suggestion
      });
    }
  }

  const issues = auditResults.filter(r => r.status !== 'matched' && r.status !== 'ignored');

  return {
    success: true,
    screenshot,
    results: auditResults,
    issuesCount: issues.length,
    issues
  };
}
