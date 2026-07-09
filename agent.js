import { chromium } from 'playwright';
import { diffWords } from 'diff';
import path from 'path';
import fs from 'fs';
import AxeBuilder from '@axe-core/playwright';
import geoip from 'geoip-lite';


// Helper to query LLM (Ollama or apfel/OpenAI-compatible)
async function queryLLM(prompt, systemPrompt, provider = 'ollama', model = 'llama3', host = 'http://localhost:11434') {
  if (provider === 'apfel' || host.includes('/v1/chat/completions') || host.includes('/chat/completions')) {
    // OpenAI/apfel compatible chat completions
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
    const maxAttempts = 12; // Až 60 sekund celkem na studený start modelu
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
          // Fallback without response_format
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
      } catch (err) {
        if (attempts < maxAttempts - 1 && (err.message.includes('fetch failed') || err.message.includes('socket hang up') || err.message.includes('ECONNREFUSED') || err.message.includes('body stream already read'))) {
          console.log(`[apfel AI] Dočasná chyba připojení (pokus ${attempts + 1}/${maxAttempts}). Čekám 5 sekund...: ${err.message}`);
          attempts++;
          await new Promise(resolve => setTimeout(resolve, 5000));
          continue;
        }
        throw new Error(`Selhání komunikace s LLM AI (${url}): ${err.message}`);
      }
    }
    } catch (outerErr) {
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
          format: 'json'
        })
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Ollama API error (${response.status}): ${text}`);
      }

      const result = await response.json();
      return result.message.content;
    } catch (err) {
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

/**
 * Evaluates the page, finds all visible interactive elements,
 * assigns them temporary 'data-qa-id' attributes, and returns their representation.
 */
async function extractInteractiveElements(page) {
  try {
    return await page.evaluate(() => {
      const interactiveTags = ['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'LABEL'];
      const elements = Array.from(document.querySelectorAll('*'));
      const interactiveList = [];
      let qaIdCounter = 1;

    const nonVisualTags = new Set(['SCRIPT', 'STYLE', 'META', 'HEAD', 'LINK', 'NOSCRIPT', 'TITLE', 'BASE']);
    const elementsToMutate = [];

    // Phase 1: Read-only (Gathering elements and reading DOM properties without mutations)
    elements.forEach((el) => {
      const tagName = el.tagName;
      if (nonVisualTags.has(tagName)) return;

      // ⚡ Bolt: Fast visibility check using layout properties BEFORE slow getComputedStyle
      if (el.offsetWidth === 0 || el.offsetHeight === 0) return;

      const isInteractiveTag = interactiveTags.includes(tagName);
      const hasClickAttribute = el.hasAttribute('onclick') || el.getAttribute('role') === 'button';

      let style = null;

      if (!isInteractiveTag && !hasClickAttribute) {
        style = window.getComputedStyle(el);
        if (style.cursor !== 'pointer') return;
      }

      // Basic visibility check for display and opacity using computed style
      if (!style) style = window.getComputedStyle(el);
      const isVisible = style.display !== 'none' &&
                        style.visibility !== 'hidden' && 
                        style.opacity !== '0';
      
      if (!isVisible) return;

      if (isInteractiveTag || hasClickAttribute || style.cursor === 'pointer') {
        let text = (el.innerText || el.value || '').trim().replace(/\s+/g, ' ');
        if (text.length > 100) text = text.substring(0, 100) + '...';

        interactiveList.push({
          id: qaIdCounter,
          tagName,
          text,
          type: el.getAttribute('type') || '',
          placeholder: el.getAttribute('placeholder') || '',
          name: el.getAttribute('name') || '',
          role: el.getAttribute('role') || '',
          href: el.getAttribute('href') || ''
        });

        elementsToMutate.push({ el, id: String(qaIdCounter) });
        qaIdCounter++;
      }
    });

    // ⚡ Bolt: Phase 2: Write-only (Batch DOM mutations to prevent Layout Thrashing)
    elementsToMutate.forEach(({ el, id }) => {
      el.setAttribute('data-qa-id', id);
    });

    return interactiveList;
    });
  } catch (error) {
    console.error('Failed to extract interactive elements:', error);
    return [];
  }
}

/**
 * Extracts all visible text nodes from the page, along with their CSS selector.
 * Useful for translation audits and page diffs.
 */
async function extractPageTexts(page) {
  return await page.evaluate(() => {
    const results = [];
    const nonVisualTags = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT']);
    const treeWalker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode: function(node) {
          if (!node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );

    let node;
    while ((node = treeWalker.nextNode())) {
      const text = node.nodeValue.trim();
      const parent = node.parentElement;

      if (!parent || nonVisualTags.has(parent.tagName)) continue;

      // ⚡ Bolt: Fast geometry check before slow getComputedStyle
      if (parent.offsetWidth === 0 || parent.offsetHeight === 0) continue;

      const style = window.getComputedStyle(parent);
      if (style.display === 'none' || style.visibility === 'hidden') continue;

      // Generate a simple CSS selector path
      let path = '';
      let current = parent;
      while (current && current.nodeType === Node.ELEMENT_NODE && current.tagName !== 'BODY') {
        let part = current.tagName.toLowerCase();
        if (current.id) {
          part += `#${current.id}`;
          path = part + (path ? ' > ' + path : '');
          break; // Stop at ID for shorter selector
        } else if (current.className) {
          part += `.${Array.from(current.classList).join('.')}`;
        }
        path = part + (path ? ' > ' + path : '');
        current = current.parentNode;
      }

      results.push({
        text,
        selector: path || 'body',
        tagName: parent.tagName
      });
    }
    return results;
  });
}

/**
 * Runs an autonomous AI QA Test Session on a given URL.
 */
export function generatePlaywrightScript(steps, startUrl) {
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

export async function extractInternalLinks(startUrl) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  const internalLinks = [];
  try {
    await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
    const baseUrl = new URL(startUrl);
    const hrefs = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('a')).map(a => a.href);
    });
    
    // Filter internal links and deduplicate
    for (const href of hrefs) {
      if (!href) continue;
      try {
        const u = new URL(href, startUrl);
        // Remove hash
        u.hash = '';
        if (u.origin === baseUrl.origin && u.pathname !== baseUrl.pathname) {
          internalLinks.push(u.href);
        }
      } catch (e) {
        // invalid URL
      }
    }
  } catch (err) {
    console.error("Failed to extract links:", err.message);
  } finally {
    await browser.close();
  }
  return [...new Set(internalLinks)].slice(0, 3); // Return top 3 max
}


async function determineNextAction(llmConfig, currentUrl, title, interactiveElements, consoleLogs, networkErrors, steps, goal) {
  let actionResponse;
  const recentLogs = consoleLogs.slice(-10).map(l => `[${l.type}] ${l.text}`).join('\n');
  const recentNet = networkErrors.slice(-10).map(n => `FAIL: ${n.url} - ${n.error}`).join('\n');

  let credentialsInfo = '';
  if (llmConfig.testLogin || llmConfig.testPassword) {
    credentialsInfo = `\nTEST CREDENTIALS (Use these if you need to log in or fill out auth forms):\n- Login/Email: ${llmConfig.testLogin || 'Not provided'}\n- Password: ${llmConfig.testPassword || 'Not provided'}\n`;
  }

  if (llmConfig.mode === 'monkey') {
    if (interactiveElements.length === 0) {
      actionResponse = {
        reasoning: 'Žádné klikatelné prvky nenalezeny. Vracím se na startovní URL.',
        action: 'navigate',
        target: currentUrl,
        value: null,
        detected_bugs: []
      };
    } else {
      const rand = Math.random();
      if (rand < 0.15) {
        actionResponse = {
          reasoning: 'Průzkumné rolování stránky pro načtení dalšího obsahu.',
          action: 'scroll',
          target: null,
          value: Math.random() > 0.5 ? 'down' : 'up',
          detected_bugs: []
        };
      } else if (rand < 0.20) {
        actionResponse = {
          reasoning: 'Krátké čekání na stabilizaci rozhraní.',
          action: 'wait',
          target: null,
          value: '1500',
          detected_bugs: []
        };
      } else {
        const randomIndex = Math.floor(Math.random() * interactiveElements.length);
        const el = interactiveElements[randomIndex];

        if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
          let val = 'test';
          const nameLower = (el.name || '').toLowerCase();
          const labelLower = (el.text || '').toLowerCase();

          if (el.type === 'email' || nameLower.includes('email')) {
            val = `monkey_tester_${Date.now()}@example.com`;
          } else if (el.type === 'number' || nameLower.includes('tel') || nameLower.includes('phone')) {
            val = String(Math.floor(100000000 + Math.random() * 900000000));
          } else if (el.type === 'password' || nameLower.includes('pass')) {
            val = 'MonkeyP@ss123!';
          } else {
            val = `Monkey_${el.placeholder || el.name || 'vstup'}`;
          }
          actionResponse = {
            reasoning: `Průzkumné vyplnění vstupu <${el.tagName}> s popiskem "${el.text || el.placeholder || el.name}"`,
            action: 'type',
            target: el.id,
            value: val,
            detected_bugs: []
          };
        } else {
          actionResponse = {
            reasoning: `Průzkumné kliknutí na prvek <${el.tagName}> s textem "${el.text || 'odkaz'}"`,
            action: 'click',
            target: el.id,
            value: null,
            detected_bugs: []
          };
        }
      }
    }
  } else {
    // AI Mode
    let systemPrompt;
    let prompt;

    if (llmConfig.mode === 'smart_monkey') {
      systemPrompt = `You are AuraTest AI, an expert QA testing agent performing a Smart Monkey Test.
Your goal is to autonomously explore the web application, click various elements, fill forms with random or edge-case data, and try to break the app (find visual, logical, or functional bugs).
You don't have one specific goal - your goal is broad exploration. Do not click the same thing repeatedly.${credentialsInfo}
You must reply ONLY with a JSON object in this format:
{
  "reasoning": "Detailní vysvětlení, proč tento prvek vybíráš (např. 'Chci otestovat, co se stane po kliknutí na Vytvořit'). NIKDY NEPOUŽÍVEJ OTÁZKY typu 'Proč bych klikl na...'",
  "action": "click" | "type" | "scroll" | "navigate" | "wait" | "finish",
  "target": 123 (the data-qa-id number, or URL for 'navigate', or null for 'wait'/'finish'),
  "value": "text to type, or 'down'/'up' for 'scroll', otherwise null",
  "detected_bugs": ["SHORT summary of bugs. Max 1 sentence! Do not copy logs exactly."]
}

Rules:
- 'target' must match a valid data-qa-id from the interactive elements list.
- Explore as many different pages/elements as possible. If nothing left, use "finish".
- If you see any bugs, list them in 'detected_bugs'.
- CRITICAL: All JSON output values ('reasoning', 'detected_bugs') MUST be written in the Czech language (Čeština). Důvod (reasoning) MUSÍ být smysluplná věta popisující tvůj záměr.`;

      prompt = `Test Type: Smart AI Monkey Test
Current URL: ${currentUrl}
Page Title: ${title}

Interactive elements on page:
${JSON.stringify(interactiveElements, null, 2)}

Recent console logs:
${recentLogs || 'No console errors.'}

Recent network errors:
${recentNet || 'No network errors.'}

History of previous steps:
${steps.map(s => `Step ${s.step}: ${s.action} on ${s.target || 'page'} (Reason: ${s.reasoning})`).join('\n') || 'No previous steps.'}

CRITICAL ANTI-LOOP RULE: Review the history of previous steps. You must NOT repeat the exact same action and target as the last step. If you just scrolled down, do NOT scroll down again right away. If you are stuck, choose a different action, click a different element, or output "finish".

Decide your next step to maximize exploration and bug finding. Reply ONLY with valid JSON.`;
    } else {
      systemPrompt = `You are AuraTest AI, an expert local QA testing agent. Your goal is to help the user test a web application.
You analyze the current page state, interactive elements, and perform actions to fulfill the given goal.${credentialsInfo}
You must reply ONLY with a JSON object in this format:
{
  "reasoning": "Detailní vysvětlení, jak ti tento krok pomůže splnit cíl (např. 'Potřebuji se přihlásit, proto klikám na Login'). NIKDY NEPOUŽÍVEJ OTÁZKY typu 'Proč bych klikl na...'",
  "action": "click" | "type" | "scroll" | "navigate" | "wait" | "finish",
  "target": 123 (the data-qa-id number, or URL for 'navigate', or null for 'wait'/'finish'),
  "value": "text to type, or 'down'/'up' for 'scroll', otherwise null",
  "detected_bugs": ["SHORT summary of bugs. Max 1 sentence! Do not copy logs exactly."]
}

Rules:
- 'target' must match a valid data-qa-id from the interactive elements list.
- If the goal is fully completed or impossible to proceed, use "finish".
- If you see any bugs, list them in 'detected_bugs'.
- CRITICAL: All JSON output values ('reasoning', 'detected_bugs') MUST be written in the Czech language (Čeština). Důvod (reasoning) MUSÍ být smysluplná věta popisující tvůj záměr.`;

      prompt = `Test Goal: ${goal}
Current URL: ${currentUrl}
Page Title: ${title}

Interactive elements on page:
${JSON.stringify(interactiveElements, null, 2)}

Recent console logs:
${recentLogs || 'No console errors.'}

Recent network errors:
${recentNet || 'No network errors.'}

History of previous steps:
${steps.map(s => `Step ${s.step}: ${s.action} on ${s.target || 'page'} (Reason: ${s.reasoning})`).join('\n') || 'No previous steps.'}

CRITICAL ANTI-LOOP RULE: Review the history of previous steps. You must NOT repeat the exact same action and target as the last step. If you just scrolled down, do NOT scroll down again right away. If you are stuck, choose a different action, click a different element, or output "finish".

Decide your next step to achieve the goal. Reply ONLY with valid JSON.`;
    }

    try {
      const responseText = await queryLLM(prompt, systemPrompt, llmConfig.provider, llmConfig.model, llmConfig.host);
      let cleaned = responseText.replace(/```json/g, '').replace(/```/g, '').trim();

      try {
        actionResponse = JSON.parse(cleaned);
      } catch (parseErr) {
        console.warn('JSON parse failed, attempting auto-recovery for truncated JSON...', parseErr.message);
        const closings = ['"}', '"]}', ']}', '}'];
        let parsed = false;
        for (const ending of closings) {
          try {
            actionResponse = JSON.parse(cleaned + ending);
            parsed = true;
            break;
          } catch (e) {}
        }
        if (!parsed) {
           throw new Error(`Nelze opravit utržený JSON: ${parseErr.message}`);
        }
      }
    } catch (err) {
      console.error('LLM parsing failed:', err);
      let extractedReasoning = `(Záchranný krok) AI vygenerovalo nečitelný nebo utržený JSON: ${err.message}. Agent zkouší posunout stránku a pokračovat.`;
      try {
        // Mock fallback if string includes reasoning
        extractedReasoning = "(Záchranný krok) AI vygenerovalo nečitelný JSON, skript vynucuje rolování";
      } catch(e) {}

      actionResponse = {
        reasoning: extractedReasoning,
        action: 'scroll',
        target: null,
        value: 'down',
        detected_bugs: []
      };
    }
  }

  // Hard Anti-Loop Protection
  if (steps.length >= 2 && llmConfig.mode !== 'monkey') {
    const isLooping = (actionResponse.action === steps[steps.length - 1].action && actionResponse.target === steps[steps.length - 1].target) ||
                      (actionResponse.action === steps[steps.length - 2].action && actionResponse.target === steps[steps.length - 2].target);
    if (isLooping) {
       console.warn('AI se zaseklo ve smyčce, vynucuji náhodný krok...');
       const available = interactiveElements.filter(el => el.id !== actionResponse.target && el.id !== steps[steps.length-1].target);
       if (available.length > 0) {
         const randomEl = available[Math.floor(Math.random() * available.length)];
         actionResponse.reasoning = `(Ochrana proti smyčce) Model narazil na překážku a zacyklil se. Skript vynucuje náhodný průzkum prvku: <${randomEl.tagName}>.`;
         actionResponse.action = 'click';
         actionResponse.target = randomEl.id;
         actionResponse.value = null;
       } else {
         actionResponse.reasoning = `(Ochrana proti smyčce) Žádné další dostupné prvky, posouvám stránku dolů.`;
         actionResponse.action = 'scroll';
         actionResponse.target = null;
         actionResponse.value = 'down';
       }
    }
  }

  return actionResponse;
}

export async function runAutonomousTest(url, goal, llmConfig, onStepProgress, sessionId = 'session_default') {
  let browser;
  try {
    browser = await chromium.launch({ headless: llmConfig.headless !== false });
    const videosDir = path.join(process.cwd(), 'videos');
    if (!fs.existsSync(videosDir)) {
      fs.mkdirSync(videosDir, { recursive: true });
    }

    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      recordVideo: { dir: videosDir }
    });
    const page = await context.newPage();

    const trackExceptions = llmConfig.trackExceptions !== false;
    const trackPromiseRejections = llmConfig.trackPromiseRejections !== false;
    const trackLongTasks = llmConfig.trackLongTasks !== false;
    const trackNetworkErrors = llmConfig.trackNetworkErrors !== false;
    const slowApiThresholdMs = llmConfig.slowApiThresholdMs || 1500;

    // Injekce lokálního monitorovacího skriptu (AuraAuraGuard)
    await page.addInitScript(({ trackExceptions, trackPromiseRejections, trackLongTasks }) => {
      // Sledování JS chyb na úrovni window
      if (trackExceptions) {
        window.addEventListener('error', (event) => {
          if (!event.message) return;
          console.error(`[AuraAuraGuard-Error] Běhová chyba: ${event.message} v ${event.filename || 'unknown'}:${event.lineno || 0}`);
        });
      }

      // Sledování neošetřených Promise rejectionů
      if (trackPromiseRejections) {
        window.addEventListener('unhandledrejection', (event) => {
          const reason = event.reason ? (event.reason.message || String(event.reason)) : 'Neznámý důvod';
          console.error(`[AuraAuraGuard-Promise] Selhání slibu (Promise): ${reason}`);
        });
      }

      // Sledování plynulosti UI (Long Tasks)
      if (trackLongTasks) {
        try {
          const observer = new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
              if (entry.duration > 100) {
                console.warn(`[AuraAuraGuard-Performance] Zaseknutí UI (Long Task): ${Math.round(entry.duration)}ms`);
              }
            }
          });
          observer.observe({ entryTypes: ['longtask'] });
        } catch (e) {
          // Ignorovat, pokud prohlížeč nepodporuje Long Tasks API
        }
      }
    }, { trackExceptions, trackPromiseRejections, trackLongTasks });

    const steps = [];
    const bugs = [];
    let currentStep = 1;
    const maxSteps = llmConfig.maxSteps || 10;
    let isFinished = false;
    let performanceMetrics = null;

  // Listen to console messages and errors
  const consoleLogs = [];
  page.on('console', (msg) => {
    const type = msg.type();
    const text = msg.text();
    consoleLogs.push({ type, text, timestamp: new Date().toISOString() });

    if (text.startsWith('[AuraAuraGuard-')) {
      if (!bugs.includes(text)) {
        bugs.push(text);
      }
    } else if (type === 'error') {
      bugs.push(`Detekována chyba v konzoli: "${text}"`);
    }
  });

  // Listen to unhandled exceptions via Playwright
  if (trackExceptions) {
    page.on('pageerror', (exception) => {
      const bugMsg = `[AuraAuraGuard-Error] Neošetřená výjimka: ${exception.message}\nStack: ${exception.stack || 'Žádný stack trace'}`;
      if (!bugs.includes(bugMsg)) {
        bugs.push(bugMsg);
      }
    });
  }

  // Listen to network errors
  const networkErrors = [];
  page.on('requestfailed', (request) => {
    const errText = request.failure()?.errorText || 'Unknown failure';
    const reqUrl = request.url();
    if (errText === 'net::ERR_ABORTED' && reqUrl.match(/\.(mp4|webm|ogg|avi|mov)(\?.*)?$/i)) {
      return;
    }
    networkErrors.push({ url: reqUrl, error: errText });
    bugs.push(`Selhal síťový požadavek: GET ${reqUrl} - ${errText}`);
  });

  // Měření síťové latence a zachycování HTTP chyb (AuraAuraGuard)
  if (trackNetworkErrors) {
    const requestStartTimes = new Map();
    page.on('request', (request) => {
      requestStartTimes.set(request.url(), Date.now());
    });

    page.on('response', (response) => {
      const url = response.url();
      const startTime = requestStartTimes.get(url);
      const status = response.status();
      const method = response.request().method();

      if (status >= 400) {
        const resourceType = response.request().resourceType();
        const isCritical = ['fetch', 'xhr', 'document', 'script'].includes(resourceType);
        if (isCritical) {
          const bugMsg = `[AuraAuraGuard-NetworkError] Selhání API: ${method} ${url} - HTTP ${status}`;
          if (!bugs.includes(bugMsg)) {
            bugs.push(bugMsg);
          }
        }
      }

      if (startTime) {
        const duration = Date.now() - startTime;
        requestStartTimes.delete(url);

        const resourceType = response.request().resourceType();
        if (duration > slowApiThresholdMs && (resourceType === 'fetch' || resourceType === 'xhr')) {
          const bugMsg = `[AuraAuraGuard-NetworkSlow] Pomalá odpověď API: ${method} ${url} trvala ${duration}ms`;
          if (!bugs.includes(bugMsg)) {
            bugs.push(bugMsg);
          }
        }
      }
    });
  }

  try {
    if (onStepProgress) onStepProgress({ step: 0, action: 'Navigace', detail: `Otevírání ${url}` });
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });

    while (currentStep <= maxSteps && !isFinished) {
      // 1. Gather current state
      const currentUrl = page.url();
      const screenshotFileName = `${sessionId}_step_${currentStep}.png`;
      const screenshotPath = path.join(process.cwd(), 'screenshots', screenshotFileName);

      // ⚡ Bolt: Paralelizace CDP Playwright příkazů pro rychlé získání title, stavu a screenshotu
      const [title, interactiveElements] = await Promise.all([
        page.title(),
        extractInteractiveElements(page),
        page.screenshot({ path: screenshotPath }).catch(err => {
           console.warn('Nepodařilo se uložit screenshot na disk:', err.message);
        })
      ]);

      // Clean up log snippet to avoid hitting token limits
      // 2. Decide Next Action
      const actionResponse = await determineNextAction(
        llmConfig,
        currentUrl,
        title,
        interactiveElements,
        consoleLogs,
        networkErrors,
        steps,
        goal
      );

      // 3. Add any bugs identified by LLM
      if (actionResponse.detected_bugs && Array.isArray(actionResponse.detected_bugs)) {
        actionResponse.detected_bugs.forEach(b => {
          if (!bugs.includes(b)) bugs.push(b);
        });
      }

      // Record step
      const stepData = {
        step: currentStep,
        url: currentUrl,
        title,
        reasoning: actionResponse.reasoning,
        action: actionResponse.action,
        target: actionResponse.target,
        value: actionResponse.value,
        screenshot: `/api/screenshots/${screenshotFileName}`,
        logs: [...consoleLogs],
        bugs: [...bugs],
        timestamp: new Date().toISOString()
      };
      steps.push(stepData);

      if (onStepProgress) onStepProgress(stepData);

      // 4. Perform Action
      if (actionResponse.action === 'finish') {
        isFinished = true;
        break;
      }

      try {
        if (actionResponse.action === 'click') {
          const targetId = actionResponse.target;
          await page.click(`[data-qa-id="${targetId}"]`, { timeout: 5000 });
        } else if (actionResponse.action === 'type') {
          const targetId = actionResponse.target;
          await page.fill(`[data-qa-id="${targetId}"]`, actionResponse.value || '', { timeout: 5000 });
        } else if (actionResponse.action === 'scroll') {
          const direction = actionResponse.value === 'up' ? -500 : 500;
          await page.evaluate((y) => window.scrollBy(0, y), direction);
        } else if (actionResponse.action === 'navigate') {
          await page.goto(actionResponse.target, { waitUntil: 'networkidle', timeout: 15000 });
        } else if (actionResponse.action === 'wait') {
          const waitTime = parseInt(actionResponse.value) || 2000;
          await page.waitForTimeout(waitTime);
        }
        
        // Wait for page to stabilize
        await page.waitForTimeout(1000);
      } catch (actionErr) {
        console.error(`Akce '${actionResponse.action}' na prvek [data-qa-id="${actionResponse.target}"] selhala:`, actionErr.message);
        bugs.push(`Akce '${actionResponse.action}' v kroku ${currentStep} selhala: ${actionErr.message}`);
      }

      currentStep++;
    }

    // --- FÁZE 3: Získání výkonnostních a SEO metrik ---
      try {
        performanceMetrics = await page.evaluate(() => {
          const timing = performance.getEntriesByType('navigation')[0] || {};
          return {
            loadTimeMs: timing.loadEventEnd ? Math.round(timing.loadEventEnd - timing.startTime) : null,
            domInteractiveMs: timing.domInteractive ? Math.round(timing.domInteractive - timing.startTime) : null,
            title: document.title,
            h1Count: document.querySelectorAll('h1').length
          };
        });
      } catch (e) {
        console.log("Could not fetch performance metrics", e.message);
      }

    } catch (err) {
      console.error('Test execution failed:', err);
      // Musí se použít push jen pokud bugs existuje z vrchního scope
      // Tady musíme přidat proměnné, které nemusí být přístupné pokud to crashne v early setupu,
      // ale scope 'bugs' je uvnitř bloku nahoře.
      if (typeof bugs !== 'undefined') bugs.push(`Katastrofická chyba testu: ${err.message}`);
    }

    let videoUrl = null;
    try {
      if (page && page.video()) {
        const videoPath = await page.video().path();
        videoUrl = `/api/videos/${path.basename(videoPath)}`;
      }
    } catch (e) {
      console.log("Mohlo selhat získání cesty k videu", e.message);
    }

    // --- FÁZE 2: Generování Playwright kódu ---
    const generatedScript = generatePlaywrightScript(steps, url);
    const scriptsDir = path.join(process.cwd(), 'generated-scripts');
    if (!fs.existsSync(scriptsDir)) {
      fs.mkdirSync(scriptsDir, { recursive: true });
    }
    const scriptPath = path.join(scriptsDir, `test-${Date.now()}.spec.ts`);
    fs.writeFileSync(scriptPath, generatedScript, 'utf8');

    return {
      success: bugs.length === 0,
      steps,
      bugs: [...new Set(bugs)], // unique values
      summary: isFinished ? 'Test úspěšně dokončen.' : 'Test dosáhl limitu maximálního počtu kroků.',
      performanceMetrics,
      generatedScript,
      videoUrl
    };
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

/**
 * Compares two web pages (e.g. Production vs Preview)
 * Performs side-by-side text diffing and captures screenshots.
 */
export async function comparePages(url1, url2) {
  let browser;
  let screenshot1 = '';
  let screenshot2 = '';
  let texts1 = [];
  let texts2 = [];
  let error1 = null;
  let error2 = null;

  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    
    // ⚡ Bolt: Načítat obě stránky paralelně pomocí Promise.all pro zrychlení ~50%
    const page1 = await context.newPage();
    const page2 = await context.newPage();

    await Promise.all([
      (async () => {
        try {
          await page1.goto(url1, { waitUntil: 'networkidle', timeout: 20000 });
          screenshot1 = `data:image/png;base64,${await page1.screenshot({ type: 'png', encoding: 'base64' })}`;
          texts1 = await extractPageTexts(page1);
        } catch (e) {
          error1 = e.message;
        }
      })(),
      (async () => {
        try {
          await page2.goto(url2, { waitUntil: 'networkidle', timeout: 20000 });
          screenshot2 = `data:image/png;base64,${await page2.screenshot({ type: 'png', encoding: 'base64' })}`;
          texts2 = await extractPageTexts(page2);
        } catch (e) {
          error2 = e.message;
        }
      })()
    ]);

  } finally {
    if (browser) {
      await browser.close();
    }
  }

  if (error1 || error2) {
    return {
      success: false,
      error: `Chyba při načítání stránek. Web 1: ${error1 || 'OK'}, Web 2: ${error2 || 'OK'}`
    };
  }

  // Diffing texts
  const diffs = [];
  
  // Create mapping of selector -> text for fast lookup
  const map1 = {};
  texts1.forEach(t => { map1[t.selector] = t.text; });
  const map2 = {};
  texts2.forEach(t => { map2[t.selector] = t.text; });

  // 1. Check for modified or deleted texts from page 1
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
      // Calculate word level diff
      const wordsDiff = diffWords(t.text, text2);
      diffs.push({
        selector: t.selector,
        tagName: t.tagName,
        type: 'modified',
        oldText: t.text,
        newText: text2,
        wordDiff: wordsDiff.map(part => ({
          added: part.added || false,
          removed: part.removed || false,
          value: part.value
        }))
      });
    }
  });

  // 2. Check for added texts on page 2
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

  return {
    success: true,
    url1,
    url2,
    screenshot1,
    screenshot2,
    diffs
  };
}

/**
 * Audits translations on a page using a loaded localization dictionary.
 */
export async function auditTranslations(url, dictionary, llmConfig) {
  let browser;
  let texts = [];
  let screenshot = '';

  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await context.newPage();

    await page.goto(url, { waitUntil: 'networkidle', timeout: 25000 });

    // ⚡ Bolt: Paralelizace extrakce textu a tvorby screenshotu
    const [screenshotBuffer, extractedTexts] = await Promise.all([
      page.screenshot({ type: 'png', encoding: 'base64' }),
      extractPageTexts(page)
    ]);

    screenshot = `data:image/png;base64,${screenshotBuffer}`;
    texts = extractedTexts;
  } catch (e) {
    if (browser) await browser.close();
    return { success: false, error: `Nepodařilo se otevřít URL: ${e.message}` };
  }

  try {
    // Auditing logic
  const auditResults = [];
  const dictEntries = Object.entries(dictionary);

  // ⚡ Bolt: Optimize translation lookup (O(N*M) -> O(N))
  // Pre-calculate lowercased values to a Map for O(1) lookups instead of repeated array iterations
  const valueToKeyMap = new Map();
  const dictSize = dictEntries.length;
  const processedDict = new Array(dictSize);
  for (let i = 0; i < dictSize; i++) {
    const [k, val] = dictEntries[i];
    const normalizedVal = val.trim().toLowerCase();
    if (normalizedVal && !valueToKeyMap.has(normalizedVal)) {
      valueToKeyMap.set(normalizedVal, k);
    }
    processedDict[i] = {
      k,
      val,
      kLower: k.toLowerCase(),
      valLower: val.toLowerCase()
    };
  }

  for (const item of texts) {
    const pageText = item.text.trim();
    if (!pageText || pageText.length < 2) continue; // skip single characters or empty

    const normalizedPageText = pageText.toLowerCase();

    // 1. Strict match check
    const matchedKey = valueToKeyMap.get(normalizedPageText);

    if (matchedKey !== undefined) {
      auditResults.push({
        text: pageText,
        selector: item.selector,
        tagName: item.tagName,
        status: 'matched',
        key: matchedKey
      });
    } else {
      // Let AI review the untranslated / mismatched text
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

      // Show a subset of the dictionary to the LLM to avoid overwhelming context
      // Filter dictionary entries that might be related to the text to keep it small
      // ⚡ Bolt: Optimize O(N*M) dictionary iteration for LLM context filtering
      const keywords = pageText.toLowerCase().split(/\s+/).filter(w => w.length > 3);
      const keywordsLen = keywords.length;

      const relevantDict = {};
      let currentDictSize = 0;

      for (let i = 0; i < dictSize; i++) {
        const entry = processedDict[i];
        let hasKeyword = false;
        for (let j = 0; j < keywordsLen; j++) {
          const word = keywords[j];
          if (entry.valLower.includes(word) || entry.kLower.includes(word)) {
            hasKeyword = true;
            break;
          }
        }

        if (hasKeyword || currentDictSize < 20) {
          if (relevantDict[entry.k] === undefined) {
             relevantDict[entry.k] = entry.val;
             currentDictSize++;
          }
        }
      }

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
      } catch (err) {
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
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

export async function analyzeSecurityVulnerabilities(events, llmConfig = {}) {
  const prompt = `Zde jsou zachycené AuraGuard události (chyby/výjimky). Prosím analyzuj je z hlediska bezpečnosti (kybernetická bezpečnost). 
Hledej indikátory OWASP zranitelností (XSS, SQL Injection, IDOR, atd.), nesprávnou konfiguraci, nebo úniky citlivých dat v logovaných událostech.

Vstupní data:
${JSON.stringify(events, null, 2)}

Pokud nenajdeš žádné zjevné zranitelnosti, uveď, že události vypadají z bezpečnostního hlediska standardně.
Pokud najdeš podezřelé vzorce, podrobně popiš hrozbu a navrhni jak to opravit. Odpověď naformátuj pomocí Markdownu.`;

  const systemPrompt = `Jsi expert na kybernetickou bezpečnost a webové technologie. Analyzuješ chybové logy a hledáš slabiny v aplikacích. Buď velmi konkrétní a analytický.
DŮLEŽITÉ (EU AI Act): Ke každé navržené opravě nebo identifikované hrozbě MUSÍŠ připojit "Explainability Trail" (Stopu vysvětlitelnosti). To znamená uvést konkrétní odkaz na CVE, číslo položky z OWASP Top 10, nebo jiný veřejně uznávaný bezpečnostní standard, o který se tvé tvrzení opírá. Bez tohoto zdůvodnění tvé výstupy nesplňují předpisy o transparentnosti AI.`;

  // Sovereign Mode - vynucení bezpečného EU/Lokálního modelu (Mistral)
  const isSovereignMode = llmConfig.sovereignMode === true;
  const provider = isSovereignMode ? 'ollama' : (llmConfig.provider || 'ollama');
  const model = isSovereignMode ? 'mistral' : (llmConfig.model || 'llama3');
  const host = llmConfig.host || 'http://localhost:11434';

  const analysis = await queryLLM(prompt, systemPrompt, provider, model, host);
  return analysis;
}

export async function auditAccessibility(url) {
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();
    
    await page.goto(url, { waitUntil: 'networkidle' });
    
    // Získání reportu z axe pomocí AxeBuilder
    const results = await new AxeBuilder({ page }).analyze();
    
    return {
      success: true,
      url,
      violations: results.violations.map(v => ({
        id: v.id,
        impact: v.impact,
        description: v.description,
        help: v.help,
        helpUrl: v.helpUrl,
        nodes: v.nodes.map(n => ({
          html: n.html,
          target: n.target,
          failureSummary: n.failureSummary
        }))
      }))
    };
  } catch (err) {
    console.error('Chyba při auditu přístupnosti:', err);
    throw err;
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

export async function auditNIS2AndPQC(url) {
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    
    let securityDetails = null;
    let headers = null;

    page.on('response', response => {
      if (response.url() === url || response.url() === url + '/') {
        headers = response.headers();
        try {
          securityDetails = response.securityDetails();
        } catch (e) {
          // fallback pokud securityDetails není dostupné (např. HTTP bez S)
        }
      }
    });

    await page.goto(url, { waitUntil: 'domcontentloaded' });
    
    // Zpracování NIS2 (hlavičky)
    const hsts = headers && headers['strict-transport-security'];
    const csp = headers && headers['content-security-policy'];
    const xcto = headers && headers['x-content-type-options'];
    const xfo = headers && headers['x-frame-options'];

    const nis2 = {
      hsts: !!hsts,
      csp: !!csp,
      xContentTypeOptions: xcto === 'nosniff',
      xFrameOptions: !!xfo,
    };

    // Zpracování PQC / TLS 
    const pqc = {
      secure: !!securityDetails,
      protocol: securityDetails ? securityDetails.protocol : 'None',
      subjectName: securityDetails ? securityDetails.subjectName : 'None',
      issuer: securityDetails ? securityDetails.issuer : 'None',
      isQuantumSafe: false, // Zatím je ML-KEM/Kyber vzácné
      recommendation: ''
    };

    const protocol = pqc.protocol || '';
    if (protocol.includes('TLS 1.3') || protocol.includes('QUIC')) {
      pqc.recommendation = "TLS 1.3 je vynikající základ. Doporučujeme sledovat implementaci ML-KEM (Kyber) na straně poskytovatele certifikátů pro plnou PQC odolnost.";
    } else if (protocol.includes('TLS 1.2')) {
      pqc.recommendation = "TLS 1.2 je přijatelné, ale pro budoucí PQC odolnost zvažte přechod na TLS 1.3.";
    } else {
      pqc.recommendation = "Zastaralý protokol! Okamžitě aktualizujte konfiguraci serveru kvůli zranitelnosti.";
    }

    return {
      success: true,
      url,
      nis2,
      pqc
    };
  } catch (err) {
    console.error('Chyba při auditu NIS2/PQC:', err);
    throw err;
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

export async function auditGreenAndResidency(url) {
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    
    let totalBytes = 0;
    const ipAddresses = new Set();
    const domainToIp = new Map();

    page.on('response', async (response) => {
      try {
        const headers = response.headers();
        const urlObj = new URL(response.url());
        
        let size = 0;
        if (headers['content-length']) {
          size = parseInt(headers['content-length'], 10);
        } else {
          try {
            const body = await response.body();
            size = body.length;
          } catch (e) {
            // ignorovat (např. CORS)
          }
        }
        totalBytes += size;

        const serverAddr = await response.serverAddr();
        if (serverAddr && serverAddr.ipAddress) {
          ipAddresses.add(serverAddr.ipAddress);
          domainToIp.set(urlObj.hostname, serverAddr.ipAddress);
        }
      } catch (e) {}
    });

    await page.goto(url, { waitUntil: 'networkidle' });

    const locations = [];
    const nonEULocations = [];
    let usesUSServers = false;

    // EEA seznam
    const euCountries = ['AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE'];

    for (const [domain, ip] of domainToIp.entries()) {
      const geo = geoip.lookup(ip);
      if (geo) {
        const isEU = euCountries.includes(geo.country);
        const locInfo = { domain, ip, country: geo.country, isEU };
        locations.push(locInfo);
        
        if (!isEU) {
          nonEULocations.push(locInfo);
          if (geo.country === 'US') usesUSServers = true;
        }
      }
    }

    const mbTransferred = totalBytes / (1024 * 1024);
    const co2Grams = mbTransferred * 0.81;

    return {
      success: true,
      url,
      green: {
        totalMb: parseFloat(mbTransferred.toFixed(2)),
        co2Grams: parseFloat(co2Grams.toFixed(3)),
        rating: co2Grams < 1 ? 'A (Zelený)' : (co2Grams < 3 ? 'C (Průměr)' : 'F (Znečišťující)')
      },
      residency: {
        totalDomains: domainToIp.size,
        locations,
        nonEULocations,
        usesUSServers
      }
    };
  } catch (err) {
    console.error('Chyba při auditu Green/GDPR:', err);
    throw err;
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

export async function generateAutoHealPatch(eventData, llmConfig = {}) {
  const prompt = `Působíš jako expertní polyglotní vývojář (Multi-Language Auto-Healing AI). 
Zde je hlášení o chybě z produkce (stack trace, zpráva, kontext).
Tvým úkolem je analyzovat tuto chybu, detekovat programovací jazyk (např. Python, Java, JavaScript, PHP) a navrhnout konkrétní opravu kódu ve formátu Unified Diff (patch).

Detail chyby:
${JSON.stringify(eventData, null, 2)}

Očekávaný výstup:
1. Stručné vysvětlení příčiny (1-2 věty).
2. Kód s opravou naformátovaný jako platný \`git diff\` (pokud nelze přesně určit soubor, použij názvy ze stack trace nebo "unknown_file").

Formátuj výstup striktně v Markdownu s diff blokem.`;

  const systemPrompt = `Jsi Auto-Healing AI. Odpovídáš výhradně poskytnutím přesného unified diffu a stručného vysvětlení. Žádný balast.`;

  return await queryLLM(prompt, systemPrompt, llmConfig.provider, llmConfig.model, llmConfig.host);
}

export async function auditCRA_SBOM(url) {
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    
    await page.goto(url, { waitUntil: 'networkidle' });

    // Injekce skriptu do stránky pro detekci globálních proměnných známých frameworků
    const detectedLibraries = await page.evaluate(() => {
      const libs = [];
      
      // Detekce jQuery
      if (window.jQuery) {
        libs.push({ name: 'jQuery', version: window.jQuery.fn.jquery, type: 'Library' });
      }
      
      // Detekce Reactu
      if (window.__REACT_DEVTOOLS_GLOBAL_HOOK__) {
        libs.push({ name: 'React', version: 'detekováno (přes DevTools)', type: 'Framework' });
      }
      
      // Detekce Vue
      if (window.__VUE__) {
        libs.push({ name: 'Vue.js', version: '3.x', type: 'Framework' });
      } else if (window.Vue) {
        libs.push({ name: 'Vue.js', version: window.Vue.version || '2.x', type: 'Framework' });
      }
      
      // Detekce Angularu
      if (window.getAllAngularRootElements || window.ng) {
        libs.push({ name: 'Angular', version: 'detekováno', type: 'Framework' });
      }
      
      // Detekce Lodash
      if (window._ && window._.VERSION) {
        libs.push({ name: 'Lodash', version: window._.VERSION, type: 'Library' });
      }

      // Detekce Next.js
      if (window.__NEXT_DATA__) {
        libs.push({ name: 'Next.js', version: 'detekováno', type: 'Framework' });
      }

      return libs;
    });

    return {
      success: true,
      url,
      sbom: detectedLibraries,
      timestamp: new Date().toISOString()
    };
  } catch (err) {
    console.error('Chyba při CRA SBOM auditu:', err);
    throw err;
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

export async function runChaosTest(url) {
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();

    let abortedRequests = 0;
    let delayedRequests = 0;
    
    // Zapnutí request interception
    await page.route('**/*', async (route) => {
      const request = route.request();
      const resourceType = request.resourceType();
      
      // Simulace výpadků pro skripty, API (fetch/xhr) a obrázky
      if (['script', 'fetch', 'xhr', 'image'].includes(resourceType)) {
        const random = Math.random();
        if (random < 0.1) {
          // 10% šance na zahození paketu (výpadek)
          abortedRequests++;
          return route.abort('failed');
        } else if (random < 0.3) {
          // 20% šance na simulaci obrovské latence (lag 3 sekundy)
          delayedRequests++;
          await new Promise(r => setTimeout(r, 3000));
          return route.continue();
        }
      }
      return route.continue();
    });

    let pageCrashed = false;
    let consoleErrors = 0;
    
    page.on('console', msg => {
      if (msg.type() === 'error') consoleErrors++;
    });
    
    page.on('pageerror', () => {
      pageCrashed = true;
    });

    // Timeout nastavíme delší kvůli simulaci latence
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {
      pageCrashed = true;
    });

    const isResilient = !pageCrashed && consoleErrors < 10; // Primitivní heuristika

    return {
      success: true,
      url,
      chaos: {
        abortedRequests,
        delayedRequests,
        consoleErrors,
        pageCrashed,
        rating: isResilient ? 'DORA Compliant (Resilient)' : 'Failed (Fragile)'
      }
    };
  } catch (err) {
    console.error('Chyba při DORA Chaos auditu:', err);
    throw err;
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

export function getGridEnergyStatus() {
  // Simulátor (Mock) pro energetický status sítě.
  // V reálné produkci by toto volalo API jako ENTSO-E nebo národní operátory sítě.
  const hour = new Date().getHours();
  // Simulujeme, že v noci a odpoledne je více "šedé" energie, přes den (soláry) více "zelené"
  const isHighCarbon = (hour < 8 || hour > 18);
  
  return {
    status: isHighCarbon ? 'HIGH_CARBON' : 'LOW_CARBON',
    renewablePercentage: isHighCarbon ? Math.floor(Math.random() * 20) + 10 : Math.floor(Math.random() * 40) + 50, // 10-30% vs 50-90%
    recommendation: isHighCarbon 
      ? 'Doporučujeme odložit náročné výpočetní úlohy (ML, zálohování) na dobu s vyšším podílem zelené energie v síti.' 
      : 'Síť má dostatek obnovitelné energie. Ideální čas pro spuštění náročných batch jobů.'
  };
}
