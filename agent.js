import { chromium } from 'playwright';
import { diffWords } from 'diff';
import path from 'path';
import fs from 'fs';
import AxeBuilder from '@axe-core/playwright';
import geoip from 'geoip-lite';
import { assertPublicHttpUrl, resolvePublicHttpTarget, guardNavigation } from './ssrf-guard.js';
import { SCREENSHOTS_DIR, VIDEOS_DIR, GENERATED_SCRIPTS_DIR, ensureDir, safeFileToken } from './paths.js';
import { inspectTls, summarizeTls, PQC_GROUP } from './tls-audit.js';
import { createSeededRandom, generateRunSeed } from './seeded-random.js';
import { collectBundleEvidence, mergeFindings } from './sbom-fingerprint.js';
import { normalizeSemver } from './semver.js';
import { classifyActionFailure } from './action-failure.js';
import { auditCsp } from './csp-audit.js';
import { assessDisclosurePlacement } from './disclosure-placement.js';
import { inspectImageBytes, summarizeC2pa } from './c2pa.js';
import { auditCookieFlags } from './cookie-flags.js';
import { auditHsts } from './hsts-audit.js';

// Volby pro Chromium jsou ve vlastním modulu — potřebuje je i generátor PDF
// spisu a duplikát by se jednou opravil jen na jednom místě.
import { launchOptions } from './browser-options.js';
import {
  AI_DISCLAIMER_PATTERN,
  isAiApiUrl,
  isChatWidgetUrl,
  evaluateInteractionObligation,
  evaluateSyntheticMarkingObligation,
  evaluateOutOfScopeObligations,
  summarizeObligations,
} from './ai-act.js';

// Kolik obrázků maximálně prověřit na C2PA označení. Stahuje se jen hlavička.
const MAX_C2PA_SAMPLES = parseInt(process.env.MAX_C2PA_SAMPLES, 10) || 8;

// Bez timeoutu drželo zaseknuté spojení celou testovací session — a s 12
// opakováními po 5 s to mohlo běžet prakticky neomezeně.
const LLM_TIMEOUT_MS = parseInt(process.env.LLM_TIMEOUT_MS, 10) || 60_000;

/**
 * Vytáhne text odpovědi z OpenAI-kompatibilního i Ollama tvaru a ověří, že
 * tam vůbec je. Dřív se sahalo rovnou na result.choices[0].message.content
 * (resp. result.message.content) a jiný tvar odpovědi shodil agenta na
 * nicneříkajícím TypeError.
 */
function requireLlmContent(result, url) {
  const content = result?.choices?.[0]?.message?.content ?? result?.message?.content;
  if (typeof content !== 'string' || content.length === 0) {
    throw new Error(`LLM (${url}) vrátilo odpověď v neočekávaném tvaru.`);
  }
  return content;
}

/**
 * Zástupné symboly pro testovací přihlašovací údaje. Do promptu (a tím i do
 * DB, WS broadcastu a generovaného skriptu) jde jen placeholder; skutečná
 * hodnota se dosazuje až v okamžiku vyplnění formuláře.
 */
const CREDENTIAL_PLACEHOLDERS = {
  login: '{{TEST_LOGIN}}',
  password: '{{TEST_PASSWORD}}',
};

function resolveCredentialPlaceholders(value, llmConfig = {}) {
  if (typeof value !== 'string') return value;
  return value
    .split(CREDENTIAL_PLACEHOLDERS.login).join(llmConfig.testLogin || '')
    .split(CREDENTIAL_PLACEHOLDERS.password).join(llmConfig.testPassword || '');
}

/**
 * Vrátí registrovatelnou doménu (eTLD+1 aproximace): `app.example.co.uk`
 * -> `example.co.uk`. Nejde o plný seznam veřejných sufixů, ale pro
 * porovnání "jsme pořád na stejném webu" to stačí.
 */
function registrableDomain(hostname) {
  const host = String(hostname).toLowerCase();

  // IP literál se musí porovnávat celý. Jinak by `1.2.3.4` a `9.9.3.4`
  // vyšly jako "stejná doména" (obojí -> '3.4'). SSRF guard sice interní
  // rozsahy stejně zachytí, ale politika originu by tu byla bezzubá.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':')) return host;

  const parts = host.split('.');
  if (parts.length <= 2) return parts.join('.');
  // Dvoudílné sufixy typu .co.uk, .com.au, .gov.cz
  const twoLevel = /^(co|com|net|org|gov|edu|ac|gob|gouv)\.[a-z]{2}$/;
  const lastTwo = parts.slice(-2).join('.');
  return twoLevel.test(lastTwo) ? parts.slice(-3).join('.') : lastTwo;
}

/**
 * Agent se během běhu naviguje na URL, kterou vybral LLM podle obsahu
 * testované stránky — prompt injection na cizím webu by ho jinak poslal
 * na interní adresu a obsah by se vrátil do reportu.
 *
 * Držíme ho proto na téže registrovatelné doméně jako startovní URL, ne na
 * přesném originu: první verze porovnávala origin, takže po běžném
 * přesměrování (http -> https, apex -> www) selhala KAŽDÁ další navigace
 * a vyráběla falešné bugy. Subdomény a jazykové mutace jsou legitimní cíle.
 *
 * `currentUrl` je aktuální adresa po případných přesměrováních.
 */
async function assertNavigationAllowed(target, startUrl, currentUrl = startUrl) {
  let parsed;
  try {
    parsed = new URL(target, currentUrl);
  } catch {
    throw new Error(`Neplatný cíl navigace: ${target}`);
  }

  const allowed = new Set([
    registrableDomain(new URL(startUrl).hostname),
    registrableDomain(new URL(currentUrl).hostname),
  ]);

  if (!allowed.has(registrableDomain(parsed.hostname))) {
    throw new Error(`Navigace mimo testovaný web (${parsed.hostname}) byla zablokována.`);
  }
  return await assertPublicHttpUrl(parsed.href);
}

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
          signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
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
            signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
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
          
          return requireLlmContent(JSON.parse(retryText), url);
        }

        return requireLlmContent(await response.json(), url);
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
    // Bez tohohle throw mohla funkce po vyčerpání pokusů propadnout za smyčku
    // a vrátit undefined — volající pak spadl na responseText.replace().
    throw new Error(`LLM nedostupné po ${maxAttempts} pokusech (${url}).`);
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
        signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
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
      return requireLlmContent(result, url);
    } catch (err) {
      console.warn('Ollama connection failed, attempting fallback without JSON formatting...', err.message);
      // Fallback byl dřív mimo try/catch — jeho selhání skončilo jako
      // neošetřená chyba, a `result.message.content` spadlo na jiném tvaru.
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
          body: JSON.stringify({
            model: model || 'llama3',
            messages,
            stream: false,
            options: { temperature: 0.1, num_predict: 4096 }
          })
        });
        if (!response.ok) throw new Error(`Ollama fallback failed: ${response.statusText}`);
        const result = await response.json();
        return requireLlmContent(result, url);
      } catch (fallbackErr) {
        throw new Error(`Selhání komunikace s Ollamou (${url}): ${fallbackErr.message}`);
      }
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
      const interactiveTags = new Set(['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'LABEL']);
      const elements = Array.from(document.querySelectorAll('*'));
      const interactiveList = [];
      let qaIdCounter = 1;

      const nonVisualTags = new Set(['SCRIPT', 'STYLE', 'META', 'HEAD', 'LINK', 'NOSCRIPT', 'TITLE', 'BASE']);
      const elementsToMutate = [];

      // FÁZE 1 — jen čtení. Zápisy do DOM se odkládají do fáze 2, aby
      // prohlížeč nemusel po každé změně přepočítávat rozvržení.
      //
      // Indexovaná smyčka místo `forEach`: u stránek s desítkami tisíc
      // prvků je znatelně rychlejší a nevytváří closure na každý průchod.
      const elementsLen = elements.length;
      for (let i = 0; i < elementsLen; i++) {
        const el = elements[i];

        // Vnitřek SVG (path, g, circle…) NENÍ HTMLElement, takže
        // `offsetWidth` je undefined a rychlá kontrola viditelnosti ho
        // nezachytí. Zároveň dědí `cursor: pointer` od tlačítka, ve kterém
        // leží, takže se dřív registroval jako klikatelný prvek. Agent pak
        // klikal na <path>, Playwright hlásil „element is not stable"
        // a z toho vznikl FALEŠNÝ BUG na naprosto funkčním webu.
        if (!(el instanceof HTMLElement)) continue;

        const tagName = el.tagName;
        if (nonVisualTags.has(tagName)) continue;

        // Rychlá kontrola viditelnosti PŘED pomalým getComputedStyle.
        if (el.offsetWidth === 0 || el.offsetHeight === 0) continue;

        const isInteractiveTag = interactiveTags.has(tagName);
        const hasClickAttribute = el.hasAttribute('onclick') || el.getAttribute('role') === 'button';

        let style = null;

        if (!isInteractiveTag && !hasClickAttribute) {
          style = window.getComputedStyle(el);
          if (style.cursor !== 'pointer') continue;

          // `cursor: pointer` se dědí, takže každý <span> uvnitř tlačítka by
          // se registroval zvlášť. Klikat se má na skutečný ovládací prvek,
          // ne na jeho vnitřek — pokud takový předek existuje, přeskočíme.
          const control = el.closest('a, button, [role="button"], input, select, textarea, label');
          if (control && control !== el) continue;
        }

        if (!style) style = window.getComputedStyle(el);
        const isVisible = style.display !== 'none' &&
                          style.visibility !== 'hidden' &&
                          style.opacity !== '0';

        if (!isVisible) continue;

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
            href: el.getAttribute('href') || '',
            // Bez těchto tří polí byly hasElementValue() i isDisabledElement()
            // vždy false, takže logika „nepřepisuj vyplněné pole" a „neklikej
            // na disabled tlačítko" nikdy nefungovala.
            value: typeof el.value === 'string' ? el.value : '',
            disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
            checked: el.checked === true
          });

          elementsToMutate.push({ el, id: String(qaIdCounter) });
          qaIdCounter++;
        }
      }

      // FÁZE 2 — jen zápis. Dávkově, aby se rozvržení přepočítalo jednou.
      const mutationsLen = elementsToMutate.length;
      for (let i = 0; i < mutationsLen; i++) {
        elementsToMutate[i].el.setAttribute('data-qa-id', elementsToMutate[i].id);
      }

    return interactiveList;
    });
  } catch (error) {
    console.error('Failed to extract interactive elements:', error);
    return [];
  }
}

const AGENT_ACTIONS = new Set(['click', 'type', 'scroll', 'navigate', 'wait', 'finish']);
const TEXT_INPUT_TYPES = new Set(['', 'text', 'email', 'password', 'search', 'tel', 'url', 'number']);

function normalizeTargetValue(target) {
  if (target === null || target === undefined) return null;
  if (typeof target === 'number') return target;
  if (typeof target === 'string' && /^\d+$/.test(target.trim())) return Number(target.trim());
  return target;
}

function actionTargetKey(action, target) {
  return `${action}:${target === null || target === undefined ? 'null' : String(target)}`;
}

function hasRuntimeSignals(consoleLogs, networkErrors) {
  const hasConsoleError = (consoleLogs || []).some((log) => log?.type === 'error' || /\berror\b/i.test(log?.text || ''));
  return hasConsoleError || (networkErrors || []).length > 0;
}

function summarizeRuntimeSignal(consoleLogs, networkErrors) {
  const consoleError = (consoleLogs || []).find((log) => log?.type === 'error' || /\berror\b|ReferenceError|TypeError/i.test(log?.text || ''));
  if (consoleError) {
    return `V konzoli je chyba: ${String(consoleError.text || consoleError.message || 'neznámá chyba').slice(0, 160)}`;
  }
  const networkError = (networkErrors || [])[0];
  if (networkError) {
    return `Selhal síťový požadavek: ${String(networkError.url || networkError.error || networkError.message || networkError).slice(0, 160)}`;
  }
  return null;
}

function cleanDetectedBugs(detectedBugs, reasoning, consoleLogs, networkErrors) {
  if (!hasRuntimeSignals(consoleLogs, networkErrors)) return [];
  if (!Array.isArray(detectedBugs) || detectedBugs.length === 0) {
    const summary = summarizeRuntimeSignal(consoleLogs, networkErrors);
    return summary ? [summary] : [];
  }

  const normalizedReasoning = String(reasoning || '').trim().replace(/\s+/g, ' ');
  const cleaned = [...new Set(detectedBugs
    .filter((bug) => typeof bug === 'string')
    .map((bug) => bug.trim())
    .filter(Boolean)
    .filter((bug) => bug.replace(/\s+/g, ' ') !== normalizedReasoning)
  )];
  if (cleaned.length > 0) return cleaned;
  const summary = summarizeRuntimeSignal(consoleLogs, networkErrors);
  return summary ? [summary] : [];
}

function isTextInputElement(el) {
  if (!el) return false;
  if (el.tagName === 'TEXTAREA') return true;
  if (el.tagName !== 'INPUT') return false;
  return TEXT_INPUT_TYPES.has(String(el.type || '').toLowerCase());
}

function isFileInputElement(el) {
  return el?.tagName === 'INPUT' && String(el.type || '').toLowerCase() === 'file';
}

function isCheckboxElement(el) {
  return el?.tagName === 'INPUT' && String(el.type || '').toLowerCase() === 'checkbox';
}

function hasElementValue(el) {
  // U checkboxů a radiobuttonů `value` nevypovídá o vyplněnosti (výchozí je
  // 'on' bez ohledu na zaškrtnutí) — rozhoduje `checked`.
  if (isCheckboxElement(el) || String(el?.type || '').toLowerCase() === 'radio') {
    return el?.checked === true;
  }
  return el?.value !== undefined && el.value !== null && String(el.value).trim() !== '';
}

function isSubmitLikeElement(el) {
  if (!el) return false;
  const text = `${el.text || ''} ${el.type || ''} ${el.role || ''}`.toLowerCase();
  return el.tagName === 'BUTTON' && /submit|odeslat|přihlásit|prihlasit|uložit|ulozit|importovat|import|send|save|login|order/.test(text);
}

function isRetryLikeElement(el) {
  if (!el) return false;
  const text = `${el.text || ''} ${el.type || ''} ${el.role || ''}`.toLowerCase();
  return el.tagName === 'BUTTON' && /znovu|obnovit|načíst|nacist|retry|reload|refresh|zkusit/.test(text);
}

function isDisabledElement(el) {
  return Boolean(el?.disabled) || String(el?.disabled || '').toLowerCase() === 'true';
}

// Akce bez cíle (scroll, wait) se opakují legitimně — dřív je klíč
// `akce:null` po prvním použití zablokoval natrvalo a fallback pak alternoval
// scroll down/up až do vyčerpání maxSteps.
const REPEATABLE_ACTIONS = new Set(['scroll', 'wait']);
const LOOP_LOOKBACK_STEPS = 3;

function wasActionTargetUsed(steps, action, target, lookback = LOOP_LOOKBACK_STEPS) {
  if (REPEATABLE_ACTIONS.has(action)) return false;
  const key = actionTargetKey(action, target);
  // Jen nedávná historie: kliknout na stejný prvek po deseti krocích je
  // legitimní návrat, ne smyčka.
  return (steps || []).slice(-lookback).some((step) => actionTargetKey(step.action, step.target) === key);
}

function wasInputTyped(steps, id) {
  return (steps || []).some((step) => step.action === 'type' && Number(step.target) === Number(id));
}

function wasClicked(steps, id) {
  return (steps || []).some((step) => step.action === 'click' && Number(step.target) === Number(id));
}

function testValueForElement(el) {
  const haystack = `${el.name || ''} ${el.placeholder || ''} ${el.text || ''}`.toLowerCase();
  const type = String(el.type || '').toLowerCase();
  if (type === 'file') return 'fixtures/import-valid.csv';
  if (type === 'email' || haystack.includes('email') || haystack.includes('e-mail')) return 'neplatny-email@';
  if (type === 'password' || haystack.includes('heslo') || haystack.includes('password')) return 'TestPassword123!';
  if (type === 'number' || haystack.includes('psč') || haystack.includes('psc')) return '12345';
  if (haystack.includes('jméno') || haystack.includes('jmeno') || haystack.includes('name')) return 'Jan Novak';
  return 'TestValue123';
}

function isGenericHomeLink(el) {
  if (!el || el.tagName !== 'A') return false;
  const text = String(el.text || '').toLowerCase();
  const href = String(el.href || '').trim();
  return href === '/' || /home|dashboard|hlavn[ií]|zp[eě]t|back/.test(text);
}

function isSpecificContentLink(el) {
  if (!el || el.tagName !== 'A') return false;
  if (isGenericHomeLink(el)) return false;
  const text = String(el.text || '').trim();
  return text.length > 0 || String(el.href || '').length > 1;
}

/**
 * Dřív se do haystacku počítal i `goal` — uživatelský popis cíle, který skoro
 * vždy obsahuje "dokončení"/"complete" ("ověř, že se objednávka dokončí").
 * Stačilo tedy zadat takový cíl a agent vyhodnotil finish hned v prvním kroku
 * na libovolné stránce, takže test vůbec neproběhl.
 *
 * Rozhoduje se proto jen podle skutečného stavu stránky (URL a titulek).
 */
function isCompletionContext({ currentUrl, title }) {
  const haystack = `${currentUrl || ''} ${title || ''}`.toLowerCase();
  return /success|complete|completed|thank|thanks|done|saved|hotovo|dokon[cč]en|odesl[aá]n|potvrzen|ulo[zž]en/.test(haystack);
}

function isLoadingOrSavingContext({ currentUrl, title, goal, visibleState }) {
  const haystack = `${currentUrl || ''} ${title || ''} ${goal || ''} ${visibleState || ''}`.toLowerCase();
  return /loading|saving|spinner|na[cč][ií]t|ukl[aá]d|uklad|ček|cek/.test(haystack);
}

function shouldPreferRetryForRuntime(selected, interactiveElements) {
  if (!selected) return true;
  if (isRetryLikeElement(selected)) return false;
  if (selected.tagName !== 'A') return true;
  const hasRetryControl = interactiveElements.some(isRetryLikeElement);
  if (!hasRetryControl) return false;
  const text = String(selected.text || '').toLowerCase();
  if (/detail/.test(text)) return true;
  if (/vytvořit|vytvorit|nov[ýy]|novou|new|create|přidat|pridat|add/.test(text)) return true;
  if (/nastaven|settings|security|bezpe[cč]|z[aá]kazn[ií]k|zakaznik|clanek|článek|faktura|projekt/.test(text)) return false;
  return true;
}

function chooseFallbackAction(interactiveElements, steps, runtimeSignals = false, context = {}) {
  if (isCompletionContext(context) && !hasRuntimeSignals(context.consoleLogs, context.networkErrors)) {
    return {
      reasoning: 'Cíl testu je splněný a nejsou vidět chyby, proto test bezpečně ukončím.',
      action: 'finish',
      target: null,
      value: null,
      detected_bugs: []
    };
  }

  if (isLoadingOrSavingContext(context) && interactiveElements.some(isDisabledElement)) {
    return {
      reasoning: 'Stránka právě načítá nebo ukládá data a hlavní ovládací prvek je disabled, proto počkám.',
      action: 'wait',
      target: null,
      value: '2000',
      detected_bugs: []
    };
  }

  if (context.suggestedUrl && /^https?:\/\//i.test(context.suggestedUrl)) {
    return {
      reasoning: 'Opakovaná akce nepřinesla nové prvky, proto použiji doporučenou plnou URL pro další pokrytí.',
      action: 'navigate',
      target: context.suggestedUrl,
      value: null,
      detected_bugs: []
    };
  }

  if (interactiveElements.length === 0) {
    const lastScroll = [...(steps || [])].reverse().find((step) => step.action === 'scroll');
    return {
      reasoning: 'Nejsou viditelné žádné interaktivní prvky, proto posunu stránku pro další obsah.',
      action: 'scroll',
      target: null,
      value: lastScroll?.value === 'down' ? 'up' : 'down',
      detected_bugs: []
    };
  }

  if (runtimeSignals) {
    const retryControl = interactiveElements
      .filter(isRetryLikeElement)
      .find((el) => !wasActionTargetUsed(steps, 'click', el.id));
    if (retryControl) {
      return {
        reasoning: `Je zachycen runtime problém, proto nejdřív použiji ovládací prvek "${retryControl.text || retryControl.id}" pro ověření zotavení.`,
        action: 'click',
        target: retryControl.id,
        value: null,
        detected_bugs: []
      };
    }
  }

  const unusedInputs = interactiveElements
    .filter(isTextInputElement)
    .filter((el) => !hasElementValue(el))
    .filter((el) => !wasInputTyped(steps, el.id));
  if (unusedInputs.length > 0) {
    const el = unusedInputs[0];
    return {
      reasoning: `Vybírám neotestované vstupní pole "${el.placeholder || el.name || el.text || el.id}", protože formuláře mají přednost před opakováním akcí.`,
      action: 'type',
      target: el.id,
      value: testValueForElement(el),
      detected_bugs: []
    };
  }

  const unusedFileInput = interactiveElements
    .filter(isFileInputElement)
    .find((el) => !wasInputTyped(steps, el.id));
  if (unusedFileInput) {
    return {
      reasoning: `Vybírám neotestovaný souborový input "${unusedFileInput.placeholder || unusedFileInput.name || unusedFileInput.text || unusedFileInput.id}", aby import měl před odesláním data.`,
      action: 'type',
      target: unusedFileInput.id,
      value: testValueForElement(unusedFileInput),
      detected_bugs: []
    };
  }

  // Checkbox se pozná podle `checked`, ne podle `value`: <input type="checkbox">
  // bez atributu value má el.value === 'on' i když zaškrtnutý není, takže
  // hasElementValue() tu vracela vždy true a celá větev byla mrtvá.
  const uncheckedBox = interactiveElements
    .filter(isCheckboxElement)
    .find((el) => el.checked !== true && !wasClicked(steps, el.id));
  if (uncheckedBox) {
    return {
      reasoning: `Vybírám neotestovaný checkbox "${uncheckedBox.text || uncheckedBox.name || uncheckedBox.id}", protože může být povinný před odesláním formuláře.`,
      action: 'click',
      target: uncheckedBox.id,
      value: null,
      detected_bugs: []
    };
  }

  const submitControl = interactiveElements
    .filter(isSubmitLikeElement)
    .find((el) => !isDisabledElement(el) && !wasActionTargetUsed(steps, 'click', el.id));
  if (submitControl) {
    return {
      reasoning: `Všechna viditelná povinná pole už vypadají připravená, proto odešlu formulář přes "${submitControl.text || submitControl.id}".`,
      action: 'click',
      target: submitControl.id,
      value: null,
      detected_bugs: []
    };
  }

  const unusedLinks = interactiveElements
    .filter(isSpecificContentLink)
    .filter((el) => !wasActionTargetUsed(steps, 'click', el.id));
  if (unusedLinks.length > 0) {
    const el = unusedLinks[0];
    return {
      reasoning: `Vybírám neotestovaný konkrétní odkaz "${el.text || el.href}", aby test pokryl další část aplikace.`,
      action: 'click',
      target: el.id,
      value: null,
      detected_bugs: []
    };
  }

  const unusedControls = interactiveElements
    .filter((el) => !isTextInputElement(el))
    .filter((el) => !isFileInputElement(el))
    .filter((el) => !isCheckboxElement(el))
    .filter((el) => !isGenericHomeLink(el))
    .filter((el) => !wasActionTargetUsed(steps, 'click', el.id));
  if (unusedControls.length > 0) {
    const el = unusedControls[0];
    return {
      reasoning: `Vybírám další neotestovaný prvek "${el.text || el.placeholder || el.tagName}", aby test nepokračoval ve smyčce.`,
      action: 'click',
      target: el.id,
      value: null,
      detected_bugs: []
    };
  }

  const lastScroll = [...(steps || [])].reverse().find((step) => step.action === 'scroll');
  return {
    reasoning: 'Nevidím další vhodný neotestovaný prvek, proto posouvám stránku pro načtení dalšího obsahu.',
    action: 'scroll',
    target: null,
    value: lastScroll?.value === 'down' ? 'up' : 'down',
    detected_bugs: []
  };
}

function withSanitizedBugs(step, actionResponse, reasoning, consoleLogs, networkErrors) {
  return {
    ...step,
    detected_bugs: cleanDetectedBugs(actionResponse?.detected_bugs, reasoning || step.reasoning, consoleLogs, networkErrors)
  };
}

export function sanitizeActionResponse(actionResponse, context) {
  const { currentUrl, title, goal, visibleState, suggestedUrl, interactiveElements, consoleLogs, networkErrors, steps } = context;
  const sanitizerContext = { currentUrl, title, goal, visibleState, suggestedUrl, consoleLogs, networkErrors, steps };
  const validIds = new Set(interactiveElements.map((el) => el.id));
  const byId = new Map(interactiveElements.map((el) => [el.id, el]));
  let action = actionResponse?.action;
  let target = normalizeTargetValue(actionResponse?.target);
  let value = actionResponse?.value ?? null;
  let reasoning = typeof actionResponse?.reasoning === 'string' && actionResponse.reasoning.trim()
    ? actionResponse.reasoning.trim()
    : 'Model nevrátil použitelnou úvahu, proto volím bezpečný průzkumný krok.';

  if (!AGENT_ACTIONS.has(action)) {
    return withSanitizedBugs(chooseFallbackAction(interactiveElements, steps, hasRuntimeSignals(consoleLogs, networkErrors), sanitizerContext), actionResponse, reasoning, consoleLogs, networkErrors);
  }

  if ((action === 'click' || action === 'type') && typeof target !== 'number') {
    return withSanitizedBugs(chooseFallbackAction(interactiveElements, steps, hasRuntimeSignals(consoleLogs, networkErrors), sanitizerContext), actionResponse, reasoning, consoleLogs, networkErrors);
  }

  if ((action === 'click' || action === 'type') && !validIds.has(target)) {
    return withSanitizedBugs(chooseFallbackAction(interactiveElements, steps, hasRuntimeSignals(consoleLogs, networkErrors), sanitizerContext), actionResponse, reasoning, consoleLogs, networkErrors);
  }

  if (action === 'navigate') {
    if (interactiveElements.length === 0 && isGenericHomeLink({ tagName: 'A', text: 'home', href: target })) {
      return withSanitizedBugs(chooseFallbackAction(interactiveElements, steps, hasRuntimeSignals(consoleLogs, networkErrors), sanitizerContext), actionResponse, reasoning, consoleLogs, networkErrors);
    }

    if (typeof target !== 'string') {
      return withSanitizedBugs(chooseFallbackAction(interactiveElements, steps, hasRuntimeSignals(consoleLogs, networkErrors), sanitizerContext), actionResponse, reasoning, consoleLogs, networkErrors);
    }

    const matchingHref = interactiveElements.find((el) => el.href && el.href === target);
    if (matchingHref) {
      action = 'click';
      target = matchingHref.id;
      value = null;
      reasoning = `Navigaci na relativní odkaz provádím kliknutím na odpovídající prvek "${matchingHref.text || matchingHref.href}".`;
    } else if (!/^https?:\/\//i.test(target)) {
      try {
        const absolute = new URL(target, currentUrl).href;
        if (/^https?:\/\//i.test(absolute)) {
          target = absolute;
        } else {
          return withSanitizedBugs(chooseFallbackAction(interactiveElements, steps, hasRuntimeSignals(consoleLogs, networkErrors), sanitizerContext), actionResponse, reasoning, consoleLogs, networkErrors);
        }
      } catch (e) {
        return withSanitizedBugs(chooseFallbackAction(interactiveElements, steps, hasRuntimeSignals(consoleLogs, networkErrors), sanitizerContext), actionResponse, reasoning, consoleLogs, networkErrors);
      }
    }
    value = null;
  }

  if (interactiveElements.length === 0 && action !== 'scroll' && action !== 'wait' && action !== 'finish') {
    return withSanitizedBugs(chooseFallbackAction(interactiveElements, steps, hasRuntimeSignals(consoleLogs, networkErrors), sanitizerContext), actionResponse, reasoning, consoleLogs, networkErrors);
  }

  if (action === 'scroll') {
    target = null;
    value = value === 'up' ? 'up' : 'down';
  }

  if (action === 'wait' || action === 'finish') {
    target = null;
    value = action === 'wait' ? String(parseInt(value, 10) || 2000) : null;
  }

  let selected = byId.get(target);
  if (action === 'click' && hasRuntimeSignals(consoleLogs, networkErrors) && shouldPreferRetryForRuntime(selected, interactiveElements)) {
    const retryControl = interactiveElements
      .filter(isRetryLikeElement)
      .find((el) => !wasActionTargetUsed(steps, 'click', el.id));
    if (retryControl) {
      action = 'click';
      target = retryControl.id;
      selected = retryControl;
      value = null;
      reasoning = `Je zachycen runtime problém, proto místo další navigace použiji "${retryControl.text || retryControl.id}" pro ověření zotavení.`;
    }
  }

  if (action === 'click' && isLoadingOrSavingContext(sanitizerContext) && (isGenericHomeLink(selected) || isDisabledElement(selected))) {
    action = 'wait';
    target = null;
    value = '2000';
    reasoning = 'Stránka právě načítá nebo ukládá data, proto nebudu odcházet ani klikat disabled prvek a počkám.';
  }

  if (action === 'click' && isCompletionContext(sanitizerContext) && !hasRuntimeSignals(consoleLogs, networkErrors)) {
    action = 'finish';
    target = null;
    value = null;
    reasoning = 'Cíl testu je splněný na potvrzovací stránce a nejsou vidět chyby, proto test bezpečně ukončím.';
  }

  if (action === 'click' && isSubmitLikeElement(selected)) {
    const untypedInput = interactiveElements.find((el) => isTextInputElement(el) && !hasElementValue(el) && !wasInputTyped(steps, el.id));
    if (untypedInput) {
      action = 'type';
      target = untypedInput.id;
      value = testValueForElement(untypedInput);
      reasoning = `Před odesláním formuláře nejdřív vyplním neotestované pole "${untypedInput.placeholder || untypedInput.name || untypedInput.text || untypedInput.id}".`;
    } else {
      const untypedFileInput = interactiveElements.find((el) => isFileInputElement(el) && !wasInputTyped(steps, el.id));
      if (untypedFileInput) {
        action = 'type';
        target = untypedFileInput.id;
        value = testValueForElement(untypedFileInput);
        reasoning = `Před importem nejdřív nastavím testovací soubor v poli "${untypedFileInput.placeholder || untypedFileInput.name || untypedFileInput.text || untypedFileInput.id}".`;
      } else {
        const uncheckedBox = interactiveElements.find((el) => isCheckboxElement(el) && !hasElementValue(el) && !wasClicked(steps, el.id));
        if (uncheckedBox) {
          action = 'click';
          target = uncheckedBox.id;
          value = null;
          reasoning = `Před odesláním formuláře nejdřív zaškrtnu povinný checkbox "${uncheckedBox.text || uncheckedBox.name || uncheckedBox.id}".`;
        }
      }
    }
  }

  if (action === 'click' && (isTextInputElement(selected) || isFileInputElement(selected))) {
    action = 'type';
    value = testValueForElement(selected);
    reasoning = `Prvek "${selected.placeholder || selected.name || selected.text || selected.id}" je vstupní pole, proto ho vyplním místo kliknutí.`;
  }

  if (action === 'click' && isGenericHomeLink(selected)) {
    const betterLink = interactiveElements
      .filter(isSpecificContentLink)
      .find((el) => !wasActionTargetUsed(steps, 'click', el.id));
    if (betterLink) {
      action = 'click';
      target = betterLink.id;
      value = null;
      reasoning = `Místo obecného návratu zvolím konkrétní neotestovaný odkaz "${betterLink.text || betterLink.href}".`;
    } else {
      return withSanitizedBugs(chooseFallbackAction(interactiveElements, steps, hasRuntimeSignals(consoleLogs, networkErrors), sanitizerContext), actionResponse, reasoning, consoleLogs, networkErrors);
    }
  }

  if (wasActionTargetUsed(steps, action, target)) {
    const fallback = chooseFallbackAction(interactiveElements, steps, hasRuntimeSignals(consoleLogs, networkErrors), sanitizerContext);
    fallback.reasoning = `(Ochrana proti smyčce) ${fallback.reasoning}`;
    return withSanitizedBugs(fallback, actionResponse, reasoning, consoleLogs, networkErrors);
  }

  return {
    reasoning,
    action,
    target,
    value: value === undefined ? null : value,
    detected_bugs: cleanDetectedBugs(actionResponse?.detected_bugs, reasoning, consoleLogs, networkErrors)
  };
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

    // Selektor a výsledek getComputedStyle se pamatují podle rodiče.
    // U hlubokých stromů má jeden rodič desítky textových uzlů a bez cache
    // se pro každý z nich počítalo znovu totéž.
    const parentCache = new Map();
    let node;

    while ((node = treeWalker.nextNode())) {
      const text = node.nodeValue.trim();
      const parent = node.parentElement;

      if (!parent || nonVisualTags.has(parent.tagName)) continue;

      // `null` v cache znamená „tenhle rodič je neviditelný" — ať se
      // nezjišťuje znovu u každého jeho textového uzlu.
      const cached = parentCache.get(parent);
      if (cached !== undefined) {
        if (cached === null) continue;
        results.push({ text, selector: cached, tagName: parent.tagName });
        continue;
      }

      // Rychlá kontrola rozměrů PŘED pomalým getComputedStyle.
      if (parent.offsetWidth === 0 || parent.offsetHeight === 0) {
        parentCache.set(parent, null);
        continue;
      }

      const style = window.getComputedStyle(parent);
      if (style.display === 'none' || style.visibility === 'hidden') {
        parentCache.set(parent, null);
        continue;
      }

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
          // Bez `Array.from` — u prvků s mnoha třídami se tím ušetří
          // vytvoření pole na každý uzel.
          let cls = '';
          const classList = current.classList;
          const len = classList.length;
          for (let i = 0; i < len; i++) cls += `.${classList[i]}`;
          part += cls;
        }
        path = part + (path ? ' > ' + path : '');
        current = current.parentNode;
      }

      const selector = path || 'body';
      parentCache.set(parent, selector);

      results.push({
        text,
        selector,
        tagName: parent.tagName
      });
    }
    return results;
  });
}

/**
 * Runs an autonomous AI QA Test Session on a given URL.
 */
/**
 * Escapuje hodnotu do JS literálu. Dřív se `step.value` a `step.target`
 * interpolovaly přímo do apostrofů — jenže obojí pochází z LLM / obsahu
 * testované stránky, takže hodnota `'); require('child_process').exec(...); //`
 * vyrobila spustitelný .spec.ts. Ten se navíc zapisuje na disk a uživatel ho
 * pouští přes `npx playwright test` → RCE na jeho stroji nebo v CI.
 */
function jsLiteral(value) {
  return JSON.stringify(value === undefined || value === null ? '' : String(value));
}

/** Jednořádkový, bezpečný komentář — `\n` v reasoningu jinak rozbije syntaxi. */
function jsComment(value) {
  return String(value ?? '').replace(/\r?\n/g, ' ').replace(/\*\//g, '* /').slice(0, 200);
}

export function generatePlaywrightScript(steps, startUrl) {
  let script = `import { test, expect } from '@playwright/test';\n\n`;
  script += `test('Autonomously generated AI test', async ({ page }) => {\n`;
  script += `  await page.goto(${jsLiteral(startUrl)});\n\n`;

  for (const step of steps) {
    if (!step.action || step.action === 'finish') continue;
    script += `  // Step ${step.step}: ${jsComment(step.reasoning || step.action)}\n`;
    if (step.action === 'click' && step.target) {
      script += `  await page.click(${jsLiteral(`[data-qa-id="${step.target}"]`)});\n`;
    } else if (step.action === 'type' && step.target) {
      script += `  await page.fill(${jsLiteral(`[data-qa-id="${step.target}"]`)}, ${jsLiteral(step.value)});\n`;
    } else if (step.action === 'scroll') {
      script += `  await page.mouse.wheel(0, ${step.value === 'down' ? 500 : -500});\n`;
    } else if (step.action === 'navigate' && step.target) {
      script += `  await page.goto(${jsLiteral(step.target)});\n`;
    } else if (step.action === 'wait') {
      script += `  await page.waitForTimeout(2000);\n`;
    }
  }
  script += `\n  // Doplňte vlastní asserty (např. expect(page).toHaveTitle(...))\n});\n`;
  return script;
}

export async function extractInternalLinks(startUrl) {
  const browser = await chromium.launch(launchOptions());
  const context = await browser.newContext();
  await guardNavigation(context);
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
    // Dřív se sem vkládal login i heslo v plaintextu. Prompt se posílá na
    // llmConfig.host a hodnota kroku končí v DB, ve WebSocket broadcastu
    // i ve vygenerovaném .spec.ts na disku. Modelu proto dáváme jen
    // zástupné symboly a skutečné hodnoty dosadíme až v page.fill().
    credentialsInfo = `\nTEST CREDENTIALS (Use these placeholders verbatim when a login form needs filling — never invent real values):\n- Login/Email: ${CREDENTIAL_PLACEHOLDERS.login}\n- Password: ${CREDENTIAL_PLACEHOLDERS.password}\n`;
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
          } catch {
            // toto doplnění závorek nesedlo, zkus další
          }
        }
        if (!parsed) {
           throw new Error(`Nelze opravit utržený JSON: ${parseErr.message}`);
        }
      }
    } catch (err) {
      console.error('LLM parsing failed:', err);
      // Pozn.: dřív tu byl try/catch, který tuto zprávu bezpodmínečně přepsal
      // konstantou a zahodil tak err.message. Diagnostiku si ponecháváme —
      // při sloučení s master se ta vada vracela, tak znovu: bez ní se
      // ladí naslepo.
      const extractedReasoning = `(Záchranný krok) AI vygenerovalo nečitelný nebo utržený JSON: ${err.message}. Agent zkouší posunout stránku a pokračovat.`;

      actionResponse = {
        reasoning: extractedReasoning,
        action: 'scroll',
        target: null,
        value: 'down',
        detected_bugs: []
      };
    }
  }

  return sanitizeActionResponse(actionResponse, {
    currentUrl,
    title,
    goal,
    interactiveElements,
    consoleLogs,
    networkErrors,
    steps
  });
}

export async function runAutonomousTest(url, goal, llmConfig, onStepProgress, sessionId) {
  // sessionId je POVINNÉ, protože je součástí názvu artefaktů.
  //
  // Dřív tu stála výchozí hodnota 'session_default'. Volání z CI/CD ji
  // nepředávalo, takže se všechny takové běhy ukládaly pod jedno známé jméno.
  // Kdo si ve Firestore založil dokument `sessions/session_default` s vlastním
  // artifactToken, stáhl si screenshoty cizích CI běhů. Předvídatelné jméno
  // artefaktu je přístupový údaj, ne detail.
  if (!sessionId || typeof sessionId !== 'string') {
    throw new Error('runAutonomousTest: chybí sessionId (artefakty by dostaly předvídatelné jméno)');
  }
  let browser;
  try {
    browser = await chromium.launch(launchOptions({ headless: llmConfig.headless !== false }));
    const videosDir = ensureDir(VIDEOS_DIR);

    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      recordVideo: { dir: videosDir }
    });

    await guardNavigation(context);
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
    // Dřív šlo všechno s prefixem [AuraAuraGuard- do `bugs` a `success` se
    // počítalo jako bugs.length === 0. Long task > 100 ms nebo pomalé API tak
    // označilo prakticky každou reálnou aplikaci za neúspěch.
    const warnings = [];
    // Selhání NAŠEHO měření — timeout, pád prohlížeče, výpadek modelu.
    // Vědomě oddělené od `bugs`: co se nezměřilo, nesmí se objevit jako
    // zjištění o auditovaném webu.
    const runErrors = [];
    let currentStep = 1;
    const maxSteps = llmConfig.maxSteps || 10;
    let isFinished = false;
    let performanceMetrics = null;

  // Listen to console messages and errors
  const consoleLogs = [];
  // Sady pro O(1) deduplikaci — dřív se používalo bugs.includes() v handleru
  // volaném na každou console/response událost, tedy O(n²).
  const seenFindings = new Set();
  const addFinding = (collection, message) => {
    if (seenFindings.has(message)) return;
    seenFindings.add(message);
    collection.push(message);
  };
  // Výkonnostní signály nejsou chyby funkčnosti.
  const WARNING_PREFIXES = ['[AuraAuraGuard-Performance]', '[AuraAuraGuard-NetworkSlow]'];

  page.on('console', (msg) => {
    const type = msg.type();
    const text = msg.text();
    consoleLogs.push({ type, text, timestamp: new Date().toISOString() });

    if (text.startsWith('[AuraAuraGuard-')) {
      addFinding(WARNING_PREFIXES.some((p) => text.startsWith(p)) ? warnings : bugs, text);
    } else if (type === 'error') {
      addFinding(bugs, `Detekována chyba v konzoli: "${text}"`);
    }
  });

  // Listen to unhandled exceptions via Playwright
  if (trackExceptions) {
    page.on('pageerror', (exception) => {
      addFinding(bugs, `[AuraAuraGuard-Error] Neošetřená výjimka: ${exception.message}\nStack: ${exception.stack || 'Žádný stack trace'}`);
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
    // Přes addFinding, aby platila stejná deduplikace jako u ostatních
    // nálezů — přímý push ji obcházel. Metoda z requestu, ne natvrdo GET.
    addFinding(bugs, `Selhal síťový požadavek: ${request.method()} ${reqUrl} - ${errText}`);
  });

  // Měření síťové latence a zachycování HTTP chyb (AuraAuraGuard)
  if (trackNetworkErrors) {
    // WeakMap klíčovaná objektem requestu:
    //   • dřív se klíčovalo URL, takže dva paralelní požadavky na stejnou
    //     adresu se přepsaly a naměřená latence byla nesmyslná,
    //   • delete() se volalo jen při response, takže abortované a neúspěšné
    //     požadavky v mapě zůstávaly navždy (memory leak).
    const requestStartTimes = new WeakMap();
    page.on('request', (request) => {
      requestStartTimes.set(request, Date.now());
    });

    page.on('response', (response) => {
      const url = response.url();
      const request = response.request();
      const startTime = requestStartTimes.get(request);
      const status = response.status();
      const method = response.request().method();

      if (status >= 400) {
        const resourceType = response.request().resourceType();
        const isCritical = ['fetch', 'xhr', 'document', 'script'].includes(resourceType);
        if (isCritical) {
          addFinding(bugs, `[AuraAuraGuard-NetworkError] Selhání API: ${method} ${url} - HTTP ${status}`);
        }
      }

      if (startTime) {
        const duration = Date.now() - startTime;
        requestStartTimes.delete(request);

        const resourceType = response.request().resourceType();
        if (duration > slowApiThresholdMs && (resourceType === 'fetch' || resourceType === 'xhr')) {
          addFinding(warnings, `[AuraAuraGuard-NetworkSlow] Pomalá odpověď API: ${method} ${url} trvala ${duration}ms`);
        }
      }
    });
  }

  // Kolik položek už bylo odesláno v předchozích krocích (viz stepData níž).
  let emittedLogCount = 0;
  let emittedBugCount = 0;
  let emittedWarningCount = 0;

  try {
    if (onStepProgress) onStepProgress({ step: 0, action: 'Navigace', detail: `Otevírání ${url}` });
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });

    while (currentStep <= maxSteps && !isFinished) {
      // 1. Gather current state
      const currentUrl = page.url();
      // sessionId se u monitorů skládá z hodnot z DB — bez očištění by `../`
      // v něm zapsalo PNG mimo adresář screenshotů.
      const screenshotFileName = `${safeFileToken(sessionId)}_step_${currentStep}.png`;
      const screenshotPath = path.join(ensureDir(SCREENSHOTS_DIR), screenshotFileName);

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
        // Jen přírůstek od minulého kroku. Dřív se kopírovala kompletní
        // dosavadní historie do KAŽDÉHO kroku — kvadratická paměť, která se
        // navíc celá ukládala do Firestore a posílala po WebSocketu.
        logs: consoleLogs.slice(emittedLogCount),
        bugs: bugs.slice(emittedBugCount),
        warnings: warnings.slice(emittedWarningCount),
        timestamp: new Date().toISOString()
      };
      emittedLogCount = consoleLogs.length;
      emittedBugCount = bugs.length;
      emittedWarningCount = warnings.length;
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
          // Placeholder → skutečná hodnota se objeví jen tady, ne v promptu,
          // v uloženém kroku ani ve vygenerovaném skriptu.
          const typedValue = resolveCredentialPlaceholders(actionResponse.value || '', llmConfig);
          await page.fill(`[data-qa-id="${targetId}"]`, typedValue, { timeout: 5000 });
        } else if (actionResponse.action === 'scroll') {
          const direction = actionResponse.value === 'up' ? -500 : 500;
          await page.evaluate((y) => window.scrollBy(0, y), direction);
        } else if (actionResponse.action === 'navigate') {
          // LLM vybírá cíl navigace podle obsahu testované stránky, takže
          // prompt injection na cizím webu jinak agenta pošle na interní
          // adresu (např. cloud metadata) a obsah se vrátí do reportu.
          const navTarget = await assertNavigationAllowed(actionResponse.target, url, currentUrl);
          await page.goto(navTarget, { waitUntil: 'networkidle', timeout: 15000 });
        } else if (actionResponse.action === 'wait') {
          const waitTime = parseInt(actionResponse.value) || 2000;
          await page.waitForTimeout(waitTime);
        }
        
        // Wait for page to stabilize
        await page.waitForTimeout(1000);
      } catch (actionErr) {
        console.error(`Akce '${actionResponse.action}' na prvek [data-qa-id="${actionResponse.target}"] selhala:`, actionErr.message);

        // Vlastní bezpečnostní politika ani cizí překryvná vrstva nejsou
        // chybou testované aplikace — nesmí shodit `success` ani se hlásit
        // jako bug. Rozhodování je v `action-failure.js`, aby šlo testovat
        // bez tahání Playwrightu do testovacího procesu.
        const failure = classifyActionFailure(
          actionResponse.action,
          currentStep,
          actionErr.message
        );
        addFinding(failure.isAppFault ? bugs : warnings, failure.message);
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
      // NEPATŘÍ do `bugs`.
      //
      // Timeout sítě, pád prohlížeče nebo výpadek jazykového modelu je chyba
      // NAŠEHO měření, ne vada zákazníkova webu. Dokud se zapisovala mezi
      // nálezy, běh skončil jako `completed` s jedním „nálezem", uložil se do
      // neměnného záznamu a ve spisu se vytiskl jako doložená vada. Zákazník
      // by tak dostal černé na bílém obvinění z něčeho, co nikdo nezměřil.
      runErrors.push(`Měření se nedokončilo: ${err.message}`);
    }

    let videoUrl = null;
    try {
      const video = page && typeof page.video === 'function' ? page.video() : null;
      if (video) {
        // Playwright finalizuje video až při zavření kontextu. Spoléhat na
        // browser.close() ve finally dávalo useknuté nebo nulové soubory.
        await context.close();

        // Playwright pojmenovává video náhodným hashem, který se sessionId
        // nijak netýká. Server ale ověřuje capability token tak, že si
        // sessionId vytáhne z názvu souboru — s hashem tam nic nenajde
        // a video vracelo vždy 404. Proto ho přejmenujeme.
        const videoFileName = `${safeFileToken(sessionId)}_video.webm`;
        const targetPath = path.join(ensureDir(VIDEOS_DIR), videoFileName);
        await video.saveAs(targetPath);
        await video.delete().catch(() => {});
        videoUrl = `/api/videos/${videoFileName}`;
      }
    } catch (e) {
      console.log("Mohlo selhat získání cesty k videu", e.message);
    }

    // --- FÁZE 2: Generování Playwright kódu ---
    const generatedScript = generatePlaywrightScript(steps, url);
    const scriptsDir = ensureDir(GENERATED_SCRIPTS_DIR);
    const scriptPath = path.join(scriptsDir, `test-${Date.now()}.spec.ts`);
    fs.writeFileSync(scriptPath, generatedScript, 'utf8');

    const measured = runErrors.length === 0;
    return {
      // Výkonnostní varování (long tasks, pomalé API) nejsou chyby funkčnosti
      // a do success se nezapočítávají.
      success: measured && bugs.length === 0,
      // Proběhlo měření vůbec? Volající z toho odvozuje stav běhu: běh
      // s chybou měření nesmí skončit jako `completed`, protože takový stav
      // znamená „výsledek platí".
      measured,
      steps,
      bugs: [...new Set(bugs)],
      warnings: [...new Set(warnings)],
      // Chyby měření drženy odděleně od nálezů. Report i spis je smí ukázat,
      // ale nikdy jako zjištění o auditovaném webu.
      runErrors: [...new Set(runErrors)],
      summary: !measured
        ? `Měření se nedokončilo: ${runErrors[0]}`
        : isFinished
          ? 'Test úspěšně dokončen.'
          : 'Test dosáhl limitu maximálního počtu kroků.',
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
    browser = await chromium.launch(launchOptions());
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    await guardNavigation(context);
    
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
const TRANSLATION_AUDIT_MAX_TEXTS = parseInt(process.env.TRANSLATION_AUDIT_MAX_TEXTS, 10) || 150;
const TRANSLATION_AUDIT_CONCURRENCY = parseInt(process.env.TRANSLATION_AUDIT_CONCURRENCY, 10) || 4;
const TRANSLATION_DICT_CONTEXT_ENTRIES = 20;

/** Zploští vnořený i18n JSON na "a.b.c" -> "text"; nestringy přeskočí. */
function flattenObjectForAudit(obj, prefix = '', out = {}) {
  if (!obj || typeof obj !== 'object') return out;
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      flattenObjectForAudit(value, path, out);
    } else if (typeof value === 'string') {
      out[path] = value;
    }
    // čísla, booleany a pole nejsou překlady — přeskakujeme
  }
  return out;
}

/** Jednoduchý limiter souběhu; zachovává pořadí výsledků. */
async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index], index);
    }
  });

  await Promise.all(runners);
  return results;
}

/**
 * Vybere podmnožinu slovníku relevantní k textu. Dřív platilo
 * `if (hasKeyword || currentDictSize < 20)`, takže když nic nematchovalo,
 * do promptu se dostalo prvních 20 klíčů podle pořadí v objektu — model
 * dostal nesouvisející kontext a halucinoval klíč. Teď skórujeme podle
 * počtu shodných slov a bereme jen nenulové skóre.
 */
function pickRelevantDictionary(pageText, processedDict) {
  const keywords = pageText.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
  if (keywords.length === 0) return {};

  const scored = [];
  for (const entry of processedDict) {
    let score = 0;
    for (const word of keywords) {
      if (entry.valLower.includes(word) || entry.kLower.includes(word)) score++;
    }
    if (score > 0) scored.push({ entry, score });
  }

  scored.sort((a, b) => b.score - a.score);
  const relevant = {};
  for (const { entry } of scored.slice(0, TRANSLATION_DICT_CONTEXT_ENTRIES)) {
    relevant[entry.k] = entry.val;
  }
  return relevant;
}

const TRANSLATION_SYSTEM_PROMPT = `You are AuraTest AI, a software localization specialist.
You will be given text found on a web page and a reference translation dictionary in JSON format.
You must evaluate whether the page text is a correct translation from the dictionary (which may be formatted differently), or if it's hardcoded text, or if a translation is missing.
Reply ONLY with a JSON object:
{
  "status": "matched_fuzzy" | "untranslated" | "typo" | "ignored",
  "key": "the localization key from the dictionary that matches this text, if any",
  "suggestion": "Recommendation for fixing or explanation"
}

CRITICAL: All JSON output values ('suggestion') MUST be written in the Czech language (Čeština).`;

async function evaluateTranslationWithLlm(pageText, item, processedDict, llmConfig) {
  const relevantDict = pickRelevantDictionary(pageText, processedDict);

  // Bez relevantního kontextu nemá smysl plýtvat dotazem — text prostě
  // ve slovníku není.
  if (Object.keys(relevantDict).length === 0) {
    return { status: 'untranslated', key: '', suggestion: 'Text nemá ve slovníku žádný podobný záznam.' };
  }

  const prompt = `Page Text: "${pageText}"
HTML Tag: <${item.tagName}>
Element Selector: ${item.selector}

Reference localization dictionary (subset):
${JSON.stringify(relevantDict, null, 2)}

Determine the status of this text. Reply ONLY with JSON.`;

  try {
    const responseText = await queryLLM(prompt, TRANSLATION_SYSTEM_PROMPT, llmConfig.provider, llmConfig.model, llmConfig.host);
    const parsed = JSON.parse(responseText.replace(/```json/g, '').replace(/```/g, '').trim());
    return {
      status: parsed.status || 'untranslated',
      key: parsed.key || '',
      suggestion: parsed.suggestion || ''
    };
  } catch (err) {
    console.warn('AI evaluation failed for text:', pageText, err.message);
    return { status: 'untranslated', key: '', suggestion: `Vyhodnocení modelem selhalo: ${err.message}` };
  }
}

export async function auditTranslations(url, dictionary, llmConfig) {
  let browser;
  let texts = [];
  let screenshot = '';

  try {
    browser = await chromium.launch(launchOptions());
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    await guardNavigation(context);
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
    const auditResults = [];

    // Slovník je typicky vnořený i18n JSON ({"login": {"title": "..."}}).
    // Dřív se volalo val.trim() rovnou na hodnotě, takže na vnořeném objektu
    // celý audit spadl na "val.trim is not a function".
    const flatDictionary = flattenObjectForAudit(dictionary);
    const dictEntries = Object.entries(flatDictionary);

    const valueToKeyMap = new Map();
    const processedDict = dictEntries.map(([k, val]) => {
      const normalizedVal = val.trim().toLowerCase();
      if (normalizedVal && !valueToKeyMap.has(normalizedVal)) {
        valueToKeyMap.set(normalizedVal, k);
      }
      return { k, val, kLower: k.toLowerCase(), valLower: val.toLowerCase() };
    });

    const candidates = [];

    for (const item of texts) {
      const pageText = item.text.trim();
      if (!pageText || pageText.length < 2) continue;

      const matchedKey = valueToKeyMap.get(pageText.toLowerCase());
      if (matchedKey !== undefined) {
        auditResults.push({
          text: pageText,
          selector: item.selector,
          tagName: item.tagName,
          status: 'matched',
          key: matchedKey
        });
      } else {
        candidates.push({ item, pageText });
      }
    }

    // Dřív šel na KAŽDÝ neshodující se text sekvenční LLM dotaz bez limitu,
    // takže stránka s 500 texty držela HTTP request desítky minut.
    // Teď: tvrdý strop, omezený souběh a celkový timeout.
    const analyzed = candidates.slice(0, TRANSLATION_AUDIT_MAX_TEXTS);
    const skippedForLimit = candidates.slice(TRANSLATION_AUDIT_MAX_TEXTS);

    const decisions = await mapWithConcurrency(
      analyzed,
      TRANSLATION_AUDIT_CONCURRENCY,
      ({ item, pageText }) => evaluateTranslationWithLlm(pageText, item, processedDict, llmConfig)
    );

    analyzed.forEach(({ item, pageText }, index) => {
      const decision = decisions[index];
      auditResults.push({
        text: pageText,
        selector: item.selector,
        tagName: item.tagName,
        status: decision.status,
        key: decision.key || 'Nenalezen',
        suggestion: decision.suggestion
      });
    });

    for (const { item, pageText } of skippedForLimit) {
      auditResults.push({
        text: pageText,
        selector: item.selector,
        tagName: item.tagName,
        status: 'skipped',
        key: 'Nenalezen',
        suggestion: `Přeskočeno: překročen limit ${TRANSLATION_AUDIT_MAX_TEXTS} analyzovaných textů na jeden běh.`
      });
    }

    const issues = auditResults.filter(r => r.status !== 'matched' && r.status !== 'ignored' && r.status !== 'skipped');

    return {
      success: true,
      screenshot,
      results: auditResults,
      issuesCount: issues.length,
      issues,
      dictionarySize: dictEntries.length,
      skippedCount: skippedForLimit.length
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
    browser = await chromium.launch(launchOptions());
    const context = await browser.newContext();
    await guardNavigation(context);
    const page = await context.newPage();
    
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });

    // Bez .withTags() běžela i best-practice a experimentální pravidla, jejichž
    // porušení NENÍ porušením WCAG 2.1 AA / EN 301 549 — v compliance reportu
    // to dělalo falešné poplachy.
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();

    const mapNodes = (v) => ({
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
    });

    return {
      success: true,
      url,
      violations: results.violations.map(mapNodes),
      // `incomplete` = položky, které axe neumí rozhodnout automaticky
      // (typicky kontrast na obrázkovém pozadí). Dřív se zahazovaly, což
      // vyrábělo false negatives — patří do reportu k ručnímu posouzení.
      incomplete: results.incomplete.map(mapNodes),
      passedCount: results.passes.length
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

/**
 * `Strict-Transport-Security: max-age=0` HSTS fakticky vypíná, ale dřívější
 * `!!header` ho hlásilo jako splněno. Vyžadujeme aspoň rok.
 */
// `hasStrongHsts` nahrazeno modulem `hsts-audit.js`.
//
// Původní podoba vracela `false` u všeho pod rokem, takže hlavička
// s půlroční platností se v reportu objevila mezi CHYBĚJÍCÍMI. To je totéž
// pochybení, které se u CSP muselo opravovat: tvrdit „chybí hlavička"
// o hlavičce, která existuje a chrání — jen kratší dobu — je nepravdivé.
// Nově je to nález nízké závažnosti s uvedenou hodnotou.


export async function auditNIS2AndPQC(url) {
  let browser;
  try {
    browser = await chromium.launch(launchOptions());
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    await guardNavigation(context);
    const page = await context.newPage();
    
    // Hlavičky i TLS bereme z návratové hodnoty page.goto().
    //
    // Dřív se odchytávaly v page.on('response') s podmínkou
    // `response.url() === url` — po jakémkoli přesměrování (http→https, www.)
    // se URL neshodla a `headers` zůstaly null, takže VŠECHNY NIS2 kontroly
    // hlásily false. A `response.securityDetails()` vrací Promise, která se
    // nikdy neawaitovala: `pqc.secure` tak bylo vždy true (i na čistém HTTP)
    // a `protocol` undefined → každý web včetně TLS 1.3 dostal hlášku
    // "Zastaralý protokol!".
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    if (!response) throw new Error('Server nevrátil žádnou odpověď.');

    const headers = response.headers();
    const securityDetails = await response.securityDetails();

    // Prohlížeč sleduje přesměrování sám, takže odpověď může pocházet
    // z úplně jiného originu, než jaký prošel SSRF kontrolou. Bez tohohle
    // ověření se do reportu dostaly hlavičky a údaje z certifikátu interní
    // služby (CN, vydavatel, protokol) — jen jinou cestou než přes TLS sondu.
    //
    // Ověřuje se dřív, než se z odpovědi cokoli přečte.
    await assertPublicHttpUrl(response.url());

    // Rozbor politiky se počítá jednou a používá se na obou místech:
    // pro souhrnný příznak `csp` i pro podrobné nálezy. Dva nezávislé
    // posuzovatelé si dřív protiřečili.
    const cspDetail = auditCsp(headers['content-security-policy']);

    // Obsah hlavičky HSTS, ne jen její přítomnost. Stejný vzor jako
    // `cspDetail` — jeden posuzovatel, jehož výsledek čte i verdikt.
    //
    // Protokol se bere z FINÁLNÍ adresy po přesměrováních: na http:// se
    // HSTS neposuzuje, protože ji tam prohlížeč ignoruje.
    const hstsDetail = auditHsts(headers['strict-transport-security'], {
      https: (() => {
        try {
          return new URL(response.url()).protocol === 'https:';
        } catch {
          return true;
        }
      })(),
    });

    const headerChecks = {
      hsts: hstsDetail.ok === true,
      // Jediný posuzovatel CSP.
      //
      // Dřív tu byla vlastní funkce `hasMeaningfulCsp`, která neznala nonce
      // ani strict-dynamic. Report pak u jedné politiky tvrdil dvě různé
      // věci: podrobný rozbor ji uznal, souhrn hlaviček ji označil za
      // nedostatečnou.
      csp: cspDetail.ok,
      xContentTypeOptions: (headers['x-content-type-options'] || '').toLowerCase() === 'nosniff',
      // Moderní ekvivalent X-Frame-Options je CSP frame-ancestors.
      // Hodnota musí něco zakazovat — `ALLOWALL` ochranu neposkytuje.
      xFrameOptions: /^\s*(deny|sameorigin)\s*$/i.test(headers['x-frame-options'] || '')
        || /frame-ancestors/i.test(headers['content-security-policy'] || ''),
      // `unsafe-url` a `no-referrer-when-downgrade` posílají referrer i na
      // cizí weby — hlavička existuje, ale nechrání. Dřív se počítala
      // pouhá přítomnost řetězce, takže „splněno" znamenalo jen „něco tam je".
      referrerPolicy: /(no-referrer|same-origin|strict-origin|origin-when-cross-origin)/i
        .test(headers['referrer-policy'] || '')
        && !/unsafe-url/i.test(headers['referrer-policy'] || ''),
      // Prázdná `Permissions-Policy:` nic neomezuje.
      permissionsPolicy: (headers['permissions-policy'] || '').trim().length > 0,
    };

    const HEADER_LABELS = {
      hsts: 'Strict-Transport-Security',
      csp: 'Content-Security-Policy',
      xContentTypeOptions: 'X-Content-Type-Options',
      xFrameOptions: 'X-Frame-Options / frame-ancestors',
      referrerPolicy: 'Referrer-Policy',
      permissionsPolicy: 'Permissions-Policy',
    };

    // Rozlišit „hlavička chybí" od „hlavička je, ale nechrání".
    //
    // Dřív spadlo obojí do `missingHeaders` a report o webu, který CSP MÁ,
    // tvrdil, že mu chybí. Verdikt je v obou případech stejný, ale tvrzení
    // ne — a nepravdivé tvrzení v compliance reportu je vada, i když vede
    // ke správnému závěru. Provozovatel navíc podle toho ví, jestli má
    // hlavičku doplnit, nebo opravit.
    const HEADER_SOURCES = {
      hsts: 'strict-transport-security',
      csp: 'content-security-policy',
      xContentTypeOptions: 'x-content-type-options',
      xFrameOptions: 'x-frame-options',
      referrerPolicy: 'referrer-policy',
      permissionsPolicy: 'permissions-policy',
    };

    const missingHeaders = [];
    const weakHeaders = [];

    for (const [key, ok] of Object.entries(headerChecks)) {
      if (ok) continue;
      const raw = headers[HEADER_SOURCES[key]];
      const present = typeof raw === 'string' && raw.trim().length > 0;

      // Zvláštní případ: ochranu proti rámování může zajišťovat
      // `frame-ancestors` v CSP, i když X-Frame-Options chybí.
      const alsoPresent = key === 'xFrameOptions'
        && /frame-ancestors/i.test(headers['content-security-policy'] || '');

      if (present || alsoPresent) weakHeaders.push(HEADER_LABELS[key]);
      else missingHeaders.push(HEADER_LABELS[key]);
    }


    const nis2 = {
      ...headerChecks,
      // CLI i UI tahle dvě pole čekaly, ale agent je nikdy nevracel:
      // `!undefined` je true, takže NIS2 audit v CLI VŽDY hlásil selhání
      // a vypisoval prázdný seznam chybějících hlaviček.
      missingHeaders,
      // Hlavičky, které existují, ale neposkytují ochranu (např.
      // `Referrer-Policy: unsafe-url` nebo CSP s `unsafe-inline`).
      weakHeaders,
      headersComplete: missingHeaders.length === 0 && weakHeaders.length === 0,
      isCompliant: missingHeaders.length === 0 && weakHeaders.length === 0,

      // Rozbor politiky pod VLASTNÍM klíčem, ze dvou důvodů.
      //
      // `csp` už v `headerChecks` je jako boolean a čtou ho CLI, UI
      // i tiskový report — přepsat ho objektem by je rozbilo.
      //
      // A do `missingHeaders` nálezy nepatří: to pole se vypisuje jako
      // „Chybí hlavička: X". Nález „chybí base-uri" by dal
      // „Chybí hlavička: chybí base-uri" — nesmysl, který u nálezů z TLS
      // jednou vznikl a musel se rozdělovat zpátky.
      cspDetail,
      hstsDetail,

      // Poctivé vymezení rozsahu. Zákon č. 264/2025 Sb. žádné konkrétní HTTP
      // hlavičky nepředepisuje — § 14 mluví o organizačních a technických
      // opatřeních (řízení rizik, aktiv, přístupů, kontinuita činností…).
      // Tohle je technický indikátor k opatření „aplikační bezpečnost",
      // ne posouzení shody s NIS2.
      scope: 'Kontrola bezpečnostních hlaviček a TLS. Nejde o posouzení shody s NIS2 jako celkem — zákon vyžaduje i organizační opatření, která externí sken ověřit nedokáže.',
    };

    const protocol = securityDetails?.protocol || '';

    // ── Skutečné měření TLS vrstvy ────────────────────────────────────────
    //
    // Tenhle modul se jmenoval „NIS2 & Post-Quantum Cryptography", ale
    // post-kvantová odolnost se neměřila vůbec — `isQuantumSafe` byla
    // natvrdo zapsaná `false`. Teď se navazují skutečné handshaky
    // (viz tls-audit.js) a výsledek je buď změřený, nebo označený jako
    // neprůkazný. Nikdy se netvrdí nic, co sonda neověřila.
    const finalUrl = new URL(response.url());
    let tls = null;
    if (finalUrl.protocol === 'https:') {
      try {
        // SSRF guard běžel jen na PŮVODNÍ URL. `response.url()` je adresa po
        // přesměrováních, kterou ovládá cizí strana — bez opětovného ověření
        // by šlo skener donutit otevřít TCP spojení na interní službu
        // a její certifikát vrátit uživateli v odpovědi.
        //
        // Ověřená adresa se PŘEDÁVÁ dál. Dřív se jen zahodila a `inspectTls`
        // si u každého z osmi spojení udělal vlastní překlad — tedy osm
        // příležitostí, kdy útočníkem řízený DNS záznam s krátkou platností
        // vrátí podruhé adresu z vnitřní sítě. Ověření platilo pro jinou
        // adresu, než na kterou se spojení nakonec otevřelo.
        const cil = await resolvePublicHttpTarget(finalUrl.href);
        tls = summarizeTls(
          await inspectTls(cil.hostname, cil.port, { address: cil.address })
        );
      } catch (tlsErr) {
        // Selhání sondy nesmí shodit celý audit — jen se to nedozvíme.
        console.warn('TLS sonda neproběhla:', tlsErr.message);
      }
    }

    // Prokázaná závada v TLS musí shodit i celkový verdikt.
    //
    // Dřív se `nis2.isCompliant` počítalo výhradně z hlaviček, takže server
    // přijímající TLS 1.0 se všemi šesti hlavičkami dostal „splněno" —
    // a CLI to propustilo do nasazení. Pole se přitom jmenuje `isCompliant`,
    // ne `headersComplete`.
    //
    // TLS nálezy mají VLASTNÍ pole. Přetížit jimi `missingHeaders` znamenalo,
    // že je CLI vypsalo jako „Chybí hlavička: Zastaralé verze TLS: TLSv1" —
    // nepravdivý popis i nepravdivý počet chybějících hlaviček.
    nis2.tlsFindings = [];
    if (tls?.protocols?.deprecated?.length) {
      nis2.isCompliant = false;
      nis2.tlsFindings.push(`Server přijímá zastaralé verze TLS: ${tls.protocols.deprecated.join(', ')}.`);
    }
    if (tls?.issues?.length) {
      nis2.isCompliant = false;
      nis2.tlsFindings.push(...tls.issues);
    }
    if (nis2.tlsFindings.length === 0 && nis2.isCompliant === true && (!tls || tls.ok === null)) {
      // Hlavičky sedí, ale TLS vrstvu se ověřit nepodařilo — na „splněno"
      // to nestačí.
      nis2.isCompliant = null;
    }

    const pqc = {
      // Podle schématu finální URL, ne podle securityDetails: ty vracejí null
      // i u https odpovědi obsloužené z cache, service workerem nebo 304.
      // Dřív se v takovém případě hlásilo „běží to po čistém HTTP" u webu,
      // jehož vlastní finalUrl začínala https://.
      secure: finalUrl.protocol === 'https:',
      protocol: protocol || 'None',
      subjectName: securityDetails?.subjectName || 'None',
      issuer: securityDetails?.issuer || 'None',
      // true / false / null — null znamená „sonda neproběhla", ne „nepodporuje".
      isQuantumSafe: tls?.pqc?.supported ?? null,
      pqcGroup: PQC_GROUP,
      pqcRationale: tls?.pqc?.rationale || null,
      // Změřené verze protokolu, ne odhad z názvu vyjednaného spojení.
      protocolsEnabled: tls?.protocols?.enabled || null,
      protocolsDeprecated: tls?.protocols?.deprecated || null,
      protocolsUntested: tls?.protocols?.untested || null,
      certificate: tls?.certificate || null,
      tlsIssues: tls?.issues || [],
      tlsNotes: tls?.notes || [],
      recommendation: ''
    };

    // Pozor na `tls.pqc`: při nedosažitelném serveru vrací summarizeTls
    // OBJEKT s `pqc: null`, takže `!tls` tenhle případ nezachytí. Bez
    // optional chainingu tu padal TypeError a celý NIS2 audit skončil
    // výjimkou místo výsledku „neprůkazné".
    if (finalUrl.protocol !== 'https:') {
      pqc.recommendation = 'Spojení neběží přes TLS (čisté HTTP). Nasaďte HTTPS — bez něj nelze NIS2 požadavky splnit.';
    } else if (!tls?.pqc) {
      // https, ale sonda neproběhla. Že Playwright stránku načetl a přímý
      // handshake selhal, o serveru nic nevypovídá — jen o naší sondě.
      pqc.recommendation = `Vyjednáno ${protocol || 'neznámý protokol'}, ale přímou TLS sondu se nepodařilo provést — hlubší rozbor (post-kvantová výměna klíčů, zastaralé verze, certifikát) chybí.`;
    } else if (tls.pqc.supported === true) {
      pqc.recommendation = `Server přijímá hybridní post-kvantovou výměnu klíčů ${PQC_GROUP}. Provoz je chráněný proti strategii „sesbírej teď, dešifruj později".`;
    } else if (tls.pqc.supported === false) {
      pqc.recommendation = `Server nepřijal ${PQC_GROUP}. Dnes zachycený provoz půjde zpětně dešifrovat, až bude k dispozici dostatečně silný kvantový počítač. Podpora je v OpenSSL 3.5+, BoringSSL i u velkých CDN. Pozn.: testovala se tahle jedna skupina — server může podporovat jinou post-kvantovou.`;
    } else {
      pqc.recommendation = tls.pqc.rationale;
    }

    if (tls?.protocols?.deprecated?.length) {
      pqc.recommendation += ` Server navíc stále přijímá ${tls.protocols.deprecated.join(' a ')} — to je samostatná závada.`;
    }

    return {
      success: true,
      url,
      finalUrl: response.url(),
      nis2,
      pqc,
      tls
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

// Anycast CDN a globální hostingy: geolokace jejich IP ukazuje na nejbližší
// PoP, ne na místo, kde jsou data uložená. Vyvozovat z toho porušení GDPR
// je metodicky nesprávné.
const ANYCAST_CDN_PATTERNS = [
  'cloudflare', 'cdn.cloudflare', 'fastly', 'akamai', 'akamaized', 'edgekey',
  'edgesuite', 'cloudfront', 'azureedge', 'azurefd', 'stackpathdns',
  'web.app', 'firebaseapp.com', 'firebasestorage', 'googleusercontent',
  'gstatic.com', 'googleapis.com', 'ggpht.com', 'jsdelivr', 'unpkg',
  'bunnycdn', 'b-cdn.net', 'vercel.app', 'netlify.app', 'pages.dev',
];

function isAnycastCdnHost(hostname) {
  const host = String(hostname).toLowerCase();
  return ANYCAST_CDN_PATTERNS.some((needle) => host.includes(needle));
}

/**
 * true = vše v EHP, false = prokazatelně mimo, null = neprůkazné.
 * Neprůkazné je poctivější než FAIL: geolokace CDN nevypovídá o rezidenci dat.
 */
function residencyVerdict(locations, nonEULocations, cdnDomains) {
  if (locations.length === 0) return null;
  if (nonEULocations.length > 0) return false;
  // Zbyly jen CDN domény — o skutečné rezidenci nic nevíme.
  if (cdnDomains.length > 0 && locations.length === cdnDomains.length) return null;
  return true;
}

function residencyWarning(locations, nonEULocations, cdnDomains) {
  if (locations.length === 0) return 'Nepodařilo se zjistit umístění serverů.';

  const cdnNote = cdnDomains.length > 0
    ? ` ${cdnDomains.length} z ${locations.length} domén běží na anycast CDN, kde geolokace ukazuje na PoP, ne na místo uložení dat — rezidenci u nich ověřte ve smlouvě s poskytovatelem.`
    : '';

  if (nonEULocations.length > 0) {
    return `${nonEULocations.length} z ${locations.length} serverů je mimo EU/EHP.${cdnNote}`;
  }
  if (cdnDomains.length === locations.length) {
    return `Všechny zjištěné domény běží na anycast CDN, takže rezidenci dat z IP určit nelze.${cdnNote}`;
  }
  return `Zjištěné servery mimo CDN jsou v EU/EHP.${cdnNote}`;
}

export async function auditGreenAndResidency(url) {
  let browser;
  try {
    browser = await chromium.launch(launchOptions());
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    await guardNavigation(context);
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
          } catch {
            // tělo odpovědi není dostupné (např. CORS) — velikost neznámá
          }
        }
        totalBytes += size;

        const serverAddr = await response.serverAddr();
        if (serverAddr && serverAddr.ipAddress) {
          ipAddresses.add(serverAddr.ipAddress);
          domainToIp.set(urlObj.hostname, serverAddr.ipAddress);
        }
      } catch {
        // jednotlivá odpověď se nepodařila změřit — ostatní měření pokračuje
      }
    });

    await page.goto(url, { waitUntil: 'networkidle' });

    const locations = [];
    const nonEULocations = [];
    let usesUSServers = false;

    // EHP = EU (27) + Island, Lichtenštejnsko, Norsko. Dřív tu bylo jen 27
    // zemí EU, přestože komentář mluvil o EEA — norský server tak vycházel
    // jako mimo EHP, ačkoli adekvátnost platí.
    const eeaCountries = [
      'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR',
      'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK',
      'SI', 'ES', 'SE',
      'IS', 'LI', 'NO',
    ];

    const cdnDomains = [];

    for (const [domain, ip] of domainToIp.entries()) {
      const geo = geoip.lookup(ip);
      if (!geo) continue;

      const isEU = eeaCountries.includes(geo.country);
      const onCdn = isAnycastCdnHost(domain);
      const locInfo = { domain, ip, country: geo.country, isEU, onCdn };
      locations.push(locInfo);

      if (onCdn) {
        // U anycast CDN ukazuje geolokace na nejbližší PoP, ne na místo
        // uložení dat. Označit to za porušení GDPR je falešný poplach —
        // živý test na Firebase Hostingu hlásil "3 ze 3 serverů mimo EU".
        cdnDomains.push(locInfo);
        continue;
      }

      if (!isEU) {
        nonEULocations.push(locInfo);
        if (geo.country === 'US') usesUSServers = true;
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
        usesUSServers,
        // UI i tiskový report tato dvě pole četly, ale agent je nikdy
        // nevracel — badge byl proto vždy červený a text prázdný,
        // i u čistě evropského hostingu.
        //
        // null = neprůkazné: geolokace podle IP je u anycast CDN
        // (Cloudflare, Fastly, Akamai) nespolehlivá, protože ukazuje na
        // PoP, ne na místo uložení dat.
        cdnDomains,
        isEUCompliant: residencyVerdict(locations, nonEULocations, cdnDomains),
        warning: residencyWarning(locations, nonEULocations, cdnDomains)
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

/** Kolik stažených skriptů se prohledává. Chrání to před stránkou se stovkami chunků. */
const MAX_SCRIPTS_SCANNED = 40;

export async function auditCRA_SBOM(url) {
  let browser;
  try {
    browser = await chromium.launch(launchOptions());
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    await guardNavigation(context);
    const page = await context.newPage();

    // Skripty se sbírají už při načítání stránky — po `goto` už jejich těla
    // z Playwrightu nedostaneme.
    const scriptResponses = [];
    page.on('response', (response) => {
      const type = response.request().resourceType();
      if (type === 'script' && scriptResponses.length < MAX_SCRIPTS_SCANNED) {
        scriptResponses.push(response);
      }
    });

    await page.goto(url, { waitUntil: 'networkidle' });

    // ── Zdroj 1: obsah stažených skriptů ───────────────────────────────────
    //
    // Tohle je ta část, která dřív chyběla. Detekce přes `window` u bundlované
    // aplikace nenajde nic, protože moderní bundler globály nevystavuje.
    const {
      findings: bundleFindings,
      sourceMapPackages,
      unreadable: scriptErrors,
    } = await collectBundleEvidence(scriptResponses, {
      // `redirect: 'manual'` je bezpečnostní požadavek, ne detail.
      // S výchozím 'follow' by cizí server odpověděl na same-origin URL
      // přesměrováním na 169.254.169.254 a obsah interní služby by skončil
      // v reportu. Kontrolní vlna to předvedla funkčním PoC.
      fetchMap: (mapUrl) => fetch(mapUrl, {
        redirect: 'manual',
        signal: AbortSignal.timeout(10000),
      }),
      assertUrlAllowed: assertPublicHttpUrl,
    });

    // ── Zdroj 2: runtime globály (původní detekce) ─────────────────────────
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

    // ── Sloučení ───────────────────────────────────────────────────────────
    const { libraries, conflicts } = mergeFindings([
      // Globály první: jejich verze je čtená přímo z běžícího objektu.
      {
        source: 'runtime-global',
        findings: detectedLibraries.map((lib) => ({
          ...lib,
          npm: NPM_PACKAGE_NAMES[lib.name] || lib.name.toLowerCase(),
          version: normalizeSemver(lib.version),
          confidence: normalizeSemver(lib.version) ? 'version-detected' : 'presence-only',
          evidence: `window.${lib.name}`,
        })),
      },
      { source: 'bundle-fingerprint', findings: bundleFindings },
      {
        source: 'source-map',
        findings: sourceMapPackages.map((pkg) => ({
          name: pkg.npm,
          npm: pkg.npm,
          type: 'Dependency',
          version: null, // Mapa udává balíček, ne verzi.
          confidence: 'presence-only',
          evidence: pkg.evidence,
        })),
      },
    ]);

    return {
      success: true,
      url,
      sbom: libraries,
      // Doložitelnost: z čeho SBOM vznikl a co se nepodařilo přečíst.
      evidence: {
        // `scriptsCaptured` = odchycené odpovědi, `scriptsScanned` = ty, jejichž
        // tělo se opravdu podařilo přečíst a prohledat. Dřív se to jmenovalo
        // stejně, takže číslo tvrdilo víc, než se stalo.
        scriptsCaptured: scriptResponses.length,
        scriptsScanned: scriptResponses.length - scriptErrors.length,
        scriptsUnreadable: scriptErrors.length,
        sourceMapPackages: sourceMapPackages.length,
        truncated: scriptResponses.length >= MAX_SCRIPTS_SCANNED,
      },
      conflicts,
      scope: 'SBOM sestavený zvenčí z běžících globálů, obsahu stažených skriptů a source map. Není to úplný kusovník podle nařízení (EU) 2024/2847 — ten sestavuje výrobce ze zdrojového kódu a musí obsahovat i závislosti, které se do prohlížeče nikdy nedostanou (backend, build nástroje, transitivní balíčky).',
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

/** Pravděpodobnosti injektáže. Vytažené ven, ať jsou v reportu doložitelné. */
export const CHAOS_ABORT_PROBABILITY = 0.1;
export const CHAOS_DELAY_PROBABILITY = 0.2;
export const CHAOS_DELAY_MS = 3000;
const CHAOS_RESOURCE_TYPES = ['script', 'fetch', 'xhr', 'image'];

/** Strop na záznam injektáží. Stránka může vystřelit statisíce požadavků. */
const MAX_CHAOS_INJECTIONS = 500;

/** Jak dlouho se po načtení DOMu čeká na dopady injektovaných poruch. */
export const CHAOS_OBSERVE_MS = CHAOS_DELAY_MS + 2000;

/**
 * @param {string} url
 * @param {{ seed?: string|number }} [options]  Stejný seed = stejný běh.
 */
export async function runChaosTest(url, options = {}) {
  let browser;
  // Bez seedu se stejný test nedá zopakovat — a co nejde zopakovat, nejde
  // doložit. Seed se vrací ve výsledku, takže i „náhodný" běh je opakovatelný.
  const seed = options.seed ?? generateRunSeed();

  // Rozhodnutí se odvozuje z hashe SEED + URL, ne ze sekvenčního generátoru.
  //
  // Sekvence by byla deterministická jen zdánlivě: `random()` se konzumuje
  // v pořadí, v jakém požadavky dorazí do handleru, a to pořadí prohlížeč mezi
  // běhy nedodrží (paralelní stahování, cache, HTTP/2). Stejný seed by tedy
  // zahodil jinou množinu URL. Hash z URL tuhle vazbu odstraní — každý
  // požadavek dostane svoje číslo bez ohledu na pořadí.
  const rollFor = (requestUrl) => createSeededRandom(`${seed}::${requestUrl}`)();

  try {
    browser = await chromium.launch(launchOptions());

    // ── Baseline: stejná stránka BEZ injektáže ─────────────────────────────
    //
    // Bez referenčního běhu nejde tvrdit, že chyby způsobil chaos. Stránka,
    // která hlásí chyby i za klidu, by jinak dostala „rozpadla se pod
    // injektovanými poruchami" — závěr o kauzalitě, která se neměřila.
    const baseline = { completed: false, consoleErrors: 0, pageCrashed: false, navigationFailed: false };
    try {
      const baseContext = await browser.newContext({ ignoreHTTPSErrors: true });
      await guardNavigation(baseContext);
      const basePage = await baseContext.newPage();
      basePage.on('console', (msg) => { if (msg.type() === 'error') baseline.consoleErrors++; });
      basePage.on('pageerror', () => { baseline.pageCrashed = true; });
      await basePage.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
        .catch(() => { baseline.navigationFailed = true; });
      await basePage.waitForTimeout(CHAOS_OBSERVE_MS).catch(() => {});
      baseline.completed = true;
      await baseContext.close();
    } catch (baselineErr) {
      // Selhání baseline nesmí shodit audit — jen se výsledek stane neprůkazným.
      console.warn('Baseline běh chaos testu selhal:', baselineErr.message);
    }

    const context = await browser.newContext({ ignoreHTTPSErrors: true });

    await guardNavigation(context);
    const page = await context.newPage();

    let abortedRequests = 0;
    let delayedRequests = 0;
    // Záznam pro report: co přesně bylo zahozeno nebo zdrženo.
    const injections = [];

    // Zapnutí request interception
    await page.route('**/*', async (route) => {
      const request = route.request();
      const resourceType = request.resourceType();

      // Simulace výpadků pro skripty, API (fetch/xhr) a obrázky
      if (CHAOS_RESOURCE_TYPES.includes(resourceType)) {
        const roll = rollFor(request.url());
        if (roll < CHAOS_ABORT_PROBABILITY) {
          abortedRequests++;
          abortedUrls.add(request.url());
          if (injections.length < MAX_CHAOS_INJECTIONS) {
            injections.push({ type: 'abort', resourceType, url: request.url() });
          }
          return route.abort('failed');
        }
        if (roll < CHAOS_ABORT_PROBABILITY + CHAOS_DELAY_PROBABILITY) {
          delayedRequests++;
          if (injections.length < MAX_CHAOS_INJECTIONS) {
            injections.push({ type: 'delay', resourceType, url: request.url(), ms: CHAOS_DELAY_MS });
          }
          await new Promise(r => setTimeout(r, CHAOS_DELAY_MS));
          return route.continue().catch(() => {}); // stránka se už mohla zavřít
        }
      }
      return route.continue().catch(() => {});
    });

    let pageCrashed = false;
    let consoleErrors = 0;
    // Chyby, které zalogoval sám prohlížeč kvůli našemu abortu — ne aplikace.
    let browserNetworkErrors = 0;

    // URL, které jsme zahodili. Prohlížeč na každou z nich zaloguje
    // „Failed to load resource: net::ERR_FAILED".
    const abortedUrls = new Set();

    page.on('console', (msg) => {
      if (msg.type() !== 'error') return;

      // Tohle je klíčové rozlišení. Prohlížeč hlásí síťovou chybu i tehdy,
      // když ji aplikace korektně odchytí a nahradí fallbackem. Počítat ji
      // jako selhání aplikace znamená trestat právě to chování, které
      // testujeme — a při 10% pravděpodobnosti abortu by se „odolná"
      // u webu s deseti podzdroji nedalo dosáhnout vůbec.
      const text = msg.text();
      const location = msg.location?.()?.url || '';
      const looksLikeNetworkError = /Failed to load resource|net::ERR_|ERR_FAILED/i.test(text);
      // Přiřazení ke konkrétnímu zahozenému požadavku: buď sedí `location`,
      // nebo je URL zmíněná v textu hlášky. Bez téhle vazby bychom odečítali
      // i síťové chyby, které s injektáží nesouvisí.
      const matchesAbortedRequest = abortedUrls.has(location)
        || [...abortedUrls].some((u) => text.includes(u));

      if (looksLikeNetworkError && matchesAbortedRequest) {
        browserNetworkErrors++;
        return;
      }
      consoleErrors++;
    });
    
    page.on('pageerror', () => {
      pageCrashed = true;
    });

    // Timeout nastavíme delší kvůli simulaci latence
    let navigationFailed = false;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {
      navigationFailed = true;
    });

    // Bez tohohle čekání se verdikt počítal DŘÍV, než injektované poruchy
    // stihly zapůsobit: `domcontentloaded` nastane před dokončením fetch/XHR
    // a před uplynutím 3s zdržení. Měřilo se tedy „při načítání DOMu se nic
    // nestalo", ne „aplikace přežila injektované poruchy".
    await page.waitForTimeout(CHAOS_OBSERVE_MS).catch(() => {});

    // ── Vyhodnocení ────────────────────────────────────────────────────────
    //
    // Verdikt se opírá o ROZDÍL proti baseline běhu, ne o absolutní čísla.
    // Bez baseline se stránka, která sama od sebe hlásí 10 chyb v konzoli,
    // označila za „rozpadla se pod injektovanými poruchami" — kauzalita se
    // nikdy neměřila. Opačně: práh „< 10" propustil až 9 chyb způsobených
    // právě injektáží jako „přežila bez pádu".
    const injected = abortedRequests + delayedRequests;
    const newConsoleErrors = Math.max(0, consoleErrors - baseline.consoleErrors);
    // Pád, který nastal už bez injektáže, injektáži připsat nelze.
    const newCrash = pageCrashed && !baseline.pageCrashed;
    const newNavigationFailure = navigationFailed && !baseline.navigationFailed;

    let isResilient;
    let rating;
    if (!baseline.completed) {
      isResilient = null;
      rating = 'NEPRŮKAZNÉ: baseline běh bez injektáže se nepodařilo provést, takže není proti čemu porovnávat.';
    } else if (baseline.navigationFailed) {
      isResilient = null;
      rating = 'NEPRŮKAZNÉ: stránka se nenačetla ani bez injektáže — problém není v odolnosti.';
    } else if (injected === 0) {
      // Když se nic nezahodilo ani nezdrželo, stránka žádnou poruchu nezažila.
      isResilient = null;
      rating = 'NEPRŮKAZNÉ: žádná porucha se neinjektovala, odolnost se netestovala.';
    } else if (newCrash || newNavigationFailure) {
      isResilient = false;
      rating = `Aplikace se pod ${injected} injektovanými poruchami rozpadla (oproti baseline běhu bez injektáže).`;
    } else if (newConsoleErrors > 0) {
      isResilient = false;
      rating = `Injektáž ${injected} poruch vyvolala ${newConsoleErrors} nových chyb v konzoli oproti baseline (nepočítaje ${browserNetworkErrors} síťových hlášek prohlížeče). Aplikace výpadky neošetřuje.`;
    } else {
      isResilient = true;
      rating = `Aplikace přežila ${injected} injektovaných poruch bez pádu a bez nových chyb oproti baseline. Síťové hlášky prohlížeče (${browserNetworkErrors}) se nezapočítávají — aplikace je zjevně ošetřila.`;
    }

    return {
      success: true,
      url,
      chaos: {
        // Se stejným seedem dostane stejná URL stejné rozhodnutí — roll se
        // počítá z hashe seed+URL, ne z pořadí požadavků.
        seed,
        // Referenční běh bez injektáže. Bez něj nejde odlišit chyby, které
        // stránka dělá sama, od těch, které způsobil chaos.
        baseline: {
          completed: baseline.completed,
          consoleErrors: baseline.consoleErrors,
          pageCrashed: baseline.pageCrashed,
          navigationFailed: baseline.navigationFailed,
        },
        newConsoleErrors,
        // Kolik chyb zalogoval prohlížeč kvůli našemu abortu. Nejsou to chyby
        // aplikace, ale v reportu musí být vidět, že se odečetly.
        browserNetworkErrors,
        navigationFailed,
        parameters: {
          abortProbability: CHAOS_ABORT_PROBABILITY,
          delayProbability: CHAOS_DELAY_PROBABILITY,
          delayMs: CHAOS_DELAY_MS,
          resourceTypes: CHAOS_RESOURCE_TYPES,
        },
        abortedRequests,
        delayedRequests,
        injections,
        consoleErrors,
        pageCrashed,
        isResilient,
        rating,
        // Poctivé vymezení: DORA (nařízení EU 2022/2554) požaduje program
        // testování digitální provozní odolnosti, ne jeden externí sken.
        scope: 'Injektáž síťových poruch do prohlížeče, porovnaná s baseline během bez injektáže. Nejde o test podle čl. 25 nařízení DORA — ten předpokládá zdokumentovaný program testování, scénáře hrozeb a nápravná opatření.',
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

/**
 * POZOR: jde o SIMULACI, ne o naměřená data.
 *
 * Dřív se `renewablePercentage` počítalo přes Math.random() a přes
 * /api/auraguard/grid-status se to podávalo jako fakt. V nástroji, který se
 * prodává jako compliance produkt, je to zavádějící. Výstup je proto
 * explicitně označený `simulated: true` a hodnota je deterministická podle
 * denní doby — náhoda budila dojem měření, které neprobíhá.
 *
 * TODO: napojit ENTSO-E Transparency Platform nebo Electricity Maps API
 *       a přepnout `simulated` na false.
 */
export function getGridEnergyStatus() {
  const hour = new Date().getHours();
  // Přes den (soláry) je v síti víc obnovitelné energie než v noci.
  const isHighCarbon = (hour < 8 || hour > 18);

  return {
    simulated: true,
    source: 'simulace podle denní doby (žádné reálné měření)',
    status: isHighCarbon ? 'HIGH_CARBON' : 'LOW_CARBON',
    renewablePercentage: isHighCarbon ? 20 : 65,
    disclaimer: 'Simulovaná hodnota. Pro auditní účely použijte data od provozovatele přenosové soustavy (ENTSO-E).',
    recommendation: isHighCarbon
      ? 'Doporučujeme odložit náročné výpočetní úlohy (ML, zálohování) na dobu s vyšším podílem zelené energie v síti.'
      : 'Síť má dostatek obnovitelné energie. Ideální čas pro spuštění náročných batch jobů.'
  };
}

export async function auditAIAct(url) {
  let browser;
  try {
    browser = await chromium.launch(launchOptions());
    const context = await browser.newContext();
    await guardNavigation(context);
    const page = await context.newPage();

    const aiApiCalls = [];
    const chatWidgets = new Set();

    page.on('request', (request) => {
      const reqUrl = request.url();
      if (isAiApiUrl(reqUrl)) aiApiCalls.push(reqUrl);
      if (isChatWidgetUrl(reqUrl)) {
        try {
          chatWidgets.add(new URL(reqUrl).hostname);
        } catch {
          // neparsovatelná URL — ignorujeme
        }
      }
    });

    // Selhání navigace se poznamená. Povinnosti čl. 50 sice vycházejí
    // neprůkazně i tak, ale report má říct PROČ — „nenašli jsme chat"
    // a „nepodařilo se otevřít stránku" nejsou totéž.
    let navigationError = null;
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 }).catch((err) => {
      navigationError = err.message;
    });
    // Chat widgety se často načítají opožděně, po `networkidle`.
    await page.waitForTimeout(3000);

    const dom = await collectAiActDomSignals(page);
    const pageText = await page.evaluate(() => document.body?.innerText || '');
    const hasDisclaimer = AI_DISCLAIMER_PATTERN.test(pageText);

    // Kde je upozornění umístěné, ne jen jestli text obsahuje slovo AI.
    //
    // Dosud stačil výskyt kdekoli na stránce — projde tím zmínka v patičce
    // i v marketingové větě, a z toho plynulo SPLNĚNO. Čl. 50 odst. 1 chce
    // informování „nejpozději při první interakci"; upozornění, které nikdo
    // neuvidí, tuhle podmínku nesplňuje, i když v HTML je.
    const disclosureOccurrences = await collectDisclosureOccurrences(page);

    const signals = {
      aiApiCalls,
      chatWidgets: [...chatWidgets],
      dom,
      hasDisclaimer,
      // Kontext rozhoduje o tom, jestli „nic jsme nenašli" znamená
      // „není tam", nebo „nedohlédli jsme tam".
      disclosure: assessDisclosurePlacement(disclosureOccurrences, {
        // Text stránky zmínku obsahuje, ale nenašel se prvek, který ji nese
        // — bývá rozdělená mezi víc značek.
        textMatched: hasDisclaimer,
        // Do iframu ani shadow DOM čtení nedohlédne, a upozornění bývá
        // umístěné právě u vloženého widgetu.
        hasEmbeddedWidget:
          chatWidgets.size > 0 || (dom.chatIndicators || []).some((i) => /iframe/i.test(i)),
      }),
    };

    const obligations = [
      evaluateInteractionObligation(signals),
      evaluateSyntheticMarkingObligation(signals),
      ...evaluateOutOfScopeObligations(signals),
    ];
    const summary = summarizeObligations(obligations);

    return {
      success: true,
      url,
      navigationError,
      aiAct: {
        // Čtyři povinnosti čl. 50 zvlášť. Dřív se slučovaly do jednoho
        // výsledku, takže report tvrdil víc, než uměl doložit.
        obligations,
        counts: summary.counts,
        isCompliant: summary.isCompliant,
        rating: summary.rating,

        // Zpětná kompatibilita se starším tvarem odpovědi.
        apisDetected: aiApiCalls,
        hasDisclaimer,
        status: summary.isCompliant === false
          ? 'fail'
          : (summary.isCompliant === true ? 'pass' : 'inconclusive'),
      }
    };
  } catch (err) {
    console.error('Chyba při AI Act auditu:', err);
    throw err;
  } finally {
    if (browser) await browser.close();
  }
}

/**
 * Signály z DOM pro AI Act.
 *
 * Dřív skener vycházel jen ze síťových volání, takže server-side AI zůstalo
 * neviditelné a drtivá většina výsledků skončila jako „neprůkazné". Konverzační
 * UI je přitom ze stránky poznat — a i když nedokazuje AI, posouvá výsledek
 * z „nic jsme nenašli" na „něco tu je, posuďte to".
 */
/**
 * Najde na stránce zmínky o AI a zjistí, KDE jsou vykreslené.
 *
 * Vrací surová pozorování; rozhodování o jejich kvalitě je
 * v `disclosure-placement.js`, aby šlo testovat bez prohlížeče.
 *
 * Prohledávají se listové prvky, ne celé podstromy: kdyby se bral <body>,
 * odpovídal by pokaždé a poloha by odpovídala celé stránce.
 */
async function collectDisclosureOccurrences(page) {
  try {
    return await page.evaluate((patternSource) => {
      const pattern = new RegExp(patternSource, 'i');
      const out = [];

      const CONVERSATION_HINT =
        '[role="log"], [id*="chat" i], [class*="chat" i], [id*="messenger" i], ' +
        '[data-testid*="chat" i], textarea, input[type="text"]';

      const elements = document.querySelectorAll('body *');
      for (const el of elements) {
        // Jen prvky, jejichž VLASTNÍ text odpovídá — ne rodiče, kteří ho
        // obsahují skrz potomky.
        const own = [...el.childNodes]
          .filter((n) => n.nodeType === 3)
          .map((n) => n.textContent)
          .join(' ')
          .trim();
        if (!own || !pattern.test(own)) continue;

        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();

        // Kromě display/visibility se hlídá i technika `sr-only`: prvek
        // o velikosti 1×1 s `clip: rect(0,0,0,0)` nebo odsunutý mimo plátno
        // je určený pro čtečky, ne pro oči. Bez téhle kontroly by report
        // tvrdil „uživatel ho uvidí" o textu, který vidět není.
        const clipped =
          /rect\(\s*0(px)?[,\s]+0(px)?[,\s]+0(px)?[,\s]+0(px)?\s*\)/.test(style.clip || '')
          || (style.clipPath || '').includes('inset(50%)')
          || (rect.width <= 1 && rect.height <= 1);

        const offscreen =
          rect.right < 0 || rect.bottom < 0 || rect.left + window.scrollX > 100000;

        const rendered =
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          Number(style.opacity) !== 0 &&
          el.getAttribute('aria-hidden') !== 'true' &&
          rect.width > 0 &&
          rect.height > 0 &&
          !clipped &&
          !offscreen;

        // Vůči dokumentu, ne vůči aktuálnímu posunu — sken může být
        // v okamžiku měření posunutý jinam než uživatel při načtení.
        const topInDocument = rect.top + window.scrollY;

        out.push({
          rendered,
          inViewport: rendered && topInDocument < window.innerHeight,
          inFooter: Boolean(el.closest('footer, [role="contentinfo"]')),
          nearConversation: Boolean(
            el.closest(CONVERSATION_HINT) || el.querySelector?.(CONVERSATION_HINT)
          ),
          text: own.slice(0, 120),
        });

        // Strop: na stránce plné zmínek o AI (blog o AI) by jich jinak byly
        // stovky a do reportu se stejně vejde jen ukázka.
        if (out.length >= 25) break;
      }

      return out;
    }, AI_DISCLAIMER_PATTERN.source);
  } catch (err) {
    // `null`, ne prázdné pole.
    //
    // Prázdné pole znamená „hledali jsme a nic nenašli" a vede k verdiktu
    // PORUŠENO. Selhání čtení znamená, že jsme neměřili — a vydávat jedno
    // za druhé je přesně to tvrzení bez měření, kterému se nástroj vyhýbá.
    console.warn('Zjištění umístění upozornění na AI selhalo:', err.message);
    return null;
  }
}

async function collectAiActDomSignals(page) {
  try {
    const domSignals = await page.evaluate(() => {
      const indicators = new Set();

      // 1. Přímé ARIA/role vzory konverzačního rozhraní
      if (document.querySelector('[role="log"]')) indicators.add('role="log"');
      if (document.querySelector('[aria-live="polite"] , [aria-live="assertive"]')) {
        // aria-live sám o sobě nestačí — musí být u něj vstupní pole
        if (document.querySelector('textarea, input[type="text"]')) {
          indicators.add('aria-live + vstupní pole');
        }
      }

      // 2. Známé identifikátory chatovacích widgetů v DOM
      const widgetSelectors = [
        '#intercom-container', '.intercom-launcher',
        '#drift-widget', '.drift-frame-controller',
        '#tidio-chat', '#crisp-chatbox',
        '#launcher[title*="essaging" i]',
        '#hubspot-messages-iframe-container',
        '#fc_frame', '#tawkchat-container',
        '#smartsupp-widget-container', '.chatra',
        '[id*="chatbot" i]', '[class*="chatbot" i]',
        '[data-testid*="chat" i]',
      ];
      for (const sel of widgetSelectors) {
        try {
          if (document.querySelector(sel)) indicators.add(sel);
        } catch {
          // neplatný selektor v tomto prohlížeči — přeskoč
        }
      }

      // 3. iframe s chatovacím původem
      for (const frame of document.querySelectorAll('iframe[src]')) {
        const src = (frame.getAttribute('src') || '').toLowerCase();
        if (/chat|messenger|intercom|drift|tidio|crisp|tawk|freshchat/.test(src)) {
          indicators.add(`iframe: ${src.slice(0, 60)}`);
        }
      }

      // 4. Prvky, které se tváří jako odeslání zprávy
      const sendLike = [...document.querySelectorAll('button, [role="button"]')]
        .filter((el) => /odeslat zprávu|send message|zeptejte se|ask (me|ai)/i.test(el.innerText || ''));
      if (sendLike.length) indicators.add('tlačítko pro odeslání zprávy');

      // 5. Náznaky biometrie / rozpoznávání emocí (pro povinnost 3)
      const biometricHints = [];
      if (document.querySelector('video[autoplay]') && /emo|face|obličej|biometr/i.test(document.body.innerHTML)) {
        biometricHints.push('video + zmínka o rozpoznávání');
      }
      if (/rozpoznávání\s+(obličej|emoc)|face\s+recognition|emotion\s+(detection|recognition)/i.test(document.body.innerText || '')) {
        biometricHints.push('text zmiňuje rozpoznávání obličeje nebo emocí');
      }

      // 6. Obrázky — kandidáti na kontrolu označení syntetického obsahu
      const imageUrls = [...document.querySelectorAll('img[src]')]
        .map((img) => img.src)
        .filter((src) => /^https?:/i.test(src));

      return {
        chatIndicators: [...indicators],
        biometricHints,
        imageUrls: imageUrls.slice(0, 20),
        imagesTotal: imageUrls.length,
      };
    });

    const images = await inspectImagesForC2pa(page, domSignals.imageUrls || []);

    return {
      chatIndicators: domSignals.chatIndicators || [],
      biometricHints: domSignals.biometricHints || [],
      images: {
        total: domSignals.imagesTotal || 0,
        sampled: images.sampled,
        withC2pa: images.withC2pa,
        // Rozbor manifestů: kolik obrázků se hlásí jako vytvořené AI,
        // kolik jako pořízené zařízením. Dřív se počítala jen přítomnost
        // pověření, takže se nedalo poznat, co vlastně tvrdí.
        c2pa: summarizeC2pa(images.inspected || [], domSignals.imagesTotal || 0),
      },
    };
  } catch (err) {
    console.warn('Detekce AI Act signálů z DOM selhala:', err.message);
    return { chatIndicators: [], biometricHints: [], images: { total: 0, sampled: 0, withC2pa: 0 } };
  }
}

/**
 * Hledá v obrázcích C2PA manifest (Content Credentials) — nejrozšířenější
 * kandidát na strojově čitelné označení podle čl. 50 odst. 2.
 *
 * Nestahuje celé soubory: C2PA manifest je v JPEG uložený v APP11 segmentu
 * a v PNG v `caBX` chunku, obojí poblíž začátku. Stačí prvních 64 kB.
 */
async function inspectImagesForC2pa(page, imageUrls) {
  const sample = imageUrls.slice(0, MAX_C2PA_SAMPLES);
  let withC2pa = 0;
  let sampled = 0;
  const inspected = [];

  for (const imageUrl of sample) {
    try {
      // Vrací se TEXT hlavičky, ne rovnou verdikt.
      //
      // Rozhodování patří do `c2pa.js`, aby šlo testovat proti ukázkovým
      // bajtům bez prohlížeče. Dřív tady byl regex, který uměl říct jen
      // „něco tam je" — ne jestli se obsah hlásí jako vytvořený AI.
      const header = await page.evaluate(async (src) => {
        const res = await fetch(src, { headers: { Range: 'bytes=0-65535' } });
        if (!res.ok && res.status !== 206) return null;

        // Ověřit, že jsme dostali obrázek.
        //
        // Ochrana proti hotlinkování, WAF i fallback jednostránkové aplikace
        // vrátí HTML se stavem 200. Článek o formátu C2PA by se pak
        // vyhodnotil jako obrázek s manifestem.
        const type = (res.headers.get('content-type') || '').toLowerCase();
        if (type && !type.startsWith('image/')) return null;

        const buf = new Uint8Array(await res.arrayBuffer());
        return new TextDecoder('latin1').decode(buf);
      }, imageUrl);

      if (header === null) continue;
      sampled += 1;

      const inspection = inspectImageBytes(header);
      inspected.push({ url: imageUrl, ...inspection });
      if (inspection.hasManifest) withC2pa += 1;
    } catch {
      // obrázek nešel načíst (CORS, 404) — do vzorku ho nepočítáme
    }
  }

  return { sampled, withC2pa, inspected };
}

// Prefixy názvů trackovacích cookies. Dřív byly jen tři (_ga, _fbp, _hj).
const TRACKER_COOKIE_NAMES = [
  '_ga', '_gid', '_gcl_au', '_gac_',        // Google Analytics / Ads
  '_fbp', '_fbc',                            // Meta Pixel
  '_hj',                                     // Hotjar
  '_uetsid', '_uetvid',                      // Microsoft/Bing UET
  '_clck', '_clsk',                          // Microsoft Clarity
  'IDE', 'test_cookie', 'DSID',              // DoubleClick
  'li_sugr', 'bcookie', 'lidc',              // LinkedIn
  '_pin_unauth', '_pinterest_',              // Pinterest
  '_ttp', 'ttclid',                          // TikTok
  '_scid', '_schn',                          // Snapchat
  'mp_', 'amplitude_', 'ajs_',               // Mixpanel / Amplitude / Segment
  '__hstc', '__hssrc', 'hubspotutk',         // HubSpot
  'intercom-',                               // Intercom
];

const TRACKER_STORAGE_KEYS = [
  'amplitude', 'mixpanel', 'ga:', '_ga', 'segment', 'ajs_', 'hotjar',
  'clarity', 'fullstory', 'heap', 'posthog', 'intercom', 'hubspot',
];

const TRACKER_HOSTS = [
  'google-analytics.com', 'googletagmanager.com', 'doubleclick.net',
  'facebook.net', 'facebook.com/tr', 'hotjar.com', 'clarity.ms',
  'amplitude.com', 'mixpanel.com', 'segment.io', 'segment.com',
  'fullstory.com', 'heap.io', 'posthog.com', 'bat.bing.com',
  'analytics.tiktok.com', 'sc-static.net', 'snapchat.com',
  'ads-twitter.com', 'linkedin.com/px', 'hs-analytics.net',
];

export async function auditStrictCookies(url) {
  let browser;
  try {
    browser = await chromium.launch(launchOptions());
    // Důležité: Nemažeme cookies, ale startujeme čistý kontext
    const context = await browser.newContext();
    await guardNavigation(context);
    const page = await context.newPage();
    
    // Odchozí požadavky na tracking domény jsou nejspolehlivější signál —
    // trackovat lze i bez cookie.
    const trackerRequestHosts = new Set();
    page.on('request', (request) => {
      try {
        const host = new URL(request.url()).hostname;
        if (TRACKER_HOSTS.some((needle) => host.includes(needle))) trackerRequestHosts.add(host);
      } catch {
        // neparsovatelná URL požadavku — ignorujeme
      }
    });

    // Načteme stránku a NIKAM neklikáme.
    //
    // Selhání navigace se NESMÍ spolknout. Když se stránka nenačte, sken
    // logicky nenajde žádnou cookie ani požadavek na tracking doménu —
    // a `isCompliant` z toho vyrobí `true`. Do neměnného záznamu by se
    // pak zapsalo „SPLNĚNO: trackery před souhlasem" o webu, který se
    // vůbec nepodařilo otevřít.
    let navigationError = null;
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 }).catch((err) => {
      navigationError = err.message;
    });
    
    // Počkáme 5 sekund pro jistotu (často se trackery načítají opožděně)
    await new Promise(r => setTimeout(r, 5000));
    
    const storageData = await page.evaluate(() => {
      const read = (store) => {
        const out = {};
        for (let i = 0; i < store.length; i++) {
          const key = store.key(i);
          out[key] = store.getItem(key);
        }
        return out;
      };
      return { localStorage: read(localStorage), sessionStorage: read(sessionStorage) };
    });

    // `document.cookie` nevidí HttpOnly cookies — tedy právě ty, které nastavuje
    // server-side tracking. context.cookies() je vidí.
    const cookies = await context.cookies();

    const suspiciousFound = [];

    for (const cookie of cookies) {
      // Dřív se testovalo `c.includes('_ga')` na celém řetězci "název=hodnota",
      // takže se matchovala i hodnota cookie → falešná pozitiva.
      if (TRACKER_COOKIE_NAMES.some((prefix) => cookie.name.startsWith(prefix))) {
        suspiciousFound.push(`Cookie: ${cookie.name} (${cookie.domain})`);
      }
    }

    for (const [store, entries] of [['LS', storageData.localStorage], ['SS', storageData.sessionStorage]]) {
      for (const key of Object.keys(entries)) {
        if (TRACKER_STORAGE_KEYS.some((needle) => key.toLowerCase().includes(needle))) {
          suspiciousFound.push(`${store}: ${key}`);
        }
      }
    }

    for (const host of trackerRequestHosts) {
      suspiciousFound.push(`Požadavek na tracking doménu: ${host}`);
    }

    // `null` = neprůkazné. Nenačtená stránka neznamená, že trackery nejsou;
    // znamená, že jsme se na ně nedokázali podívat.
    const isCompliant = navigationError ? null : suspiciousFound.length === 0;

    return {
      success: true,
      url,
      // Doložitelnost: report i záznam musí vidět, že měření neproběhlo.
      navigationError,
      // Příznaky cookies jsou samostatné zjištění, ne součást GDPR verdiktu.
      //
      // Trackery před souhlasem řeší ePrivacy; Secure, HttpOnly a SameSite
      // jsou aplikační bezpečnost podle § 14. Sloučit je by znamenalo, že
      // web bez trackerů, ale s relační cookie čitelnou ze skriptu, projde
      // jako bezvadný.
      cookieFlags: (() => {
        // Hostitel se předává, aby šlo odlišit vlastní cookies od těch,
        // které nastavil vložený obsah. Provozovatel cizí cookie neopraví,
        // takže hlásit mu ji jako vadu jeho aplikace nemá smysl.
        let parsed;
        try {
          parsed = new URL(page.url() || url);
        } catch {
          parsed = null;
        }
        return auditCookieFlags(cookies, {
          https: parsed ? parsed.protocol === 'https:' : true,
          host: parsed ? parsed.hostname : null,
        });
      })(),
      gdpr: {
        suspiciousItems: suspiciousFound,
        isCompliant,
        // Seznam trackerů je nutně neúplný, takže "nic nenalezeno" neznamená
        // prokazatelný soulad — formulace to musí odrážet.
        rating: navigationError
          ? `NEPRŮKAZNÉ: Stránku se nepodařilo načíst (${navigationError}), takže nebylo co posoudit. Z toho neplyne, že trackery nejsou.`
          : isCompliant
            ? 'BEZ NÁLEZU: Před udělením souhlasu nebyly nalezeny trackery ze sledovaného seznamu. Nejde o důkaz plného souladu — seznam není vyčerpávající.'
            : 'FAIL: ePrivacy Violation. Aplikace ukládá analytické/marketingové trackery před udělením souhlasu.'
      }
    };
  } catch (err) {
    console.error('Chyba při GDPR Cookie auditu:', err);
    throw err;
  } finally {
    if (browser) await browser.close();
  }
}

// Zobrazovaný název knihovny != název npm balíčku. 'vue.js' a 'next.js'
// v OSV neexistují, takže dotaz vždy vrátil prázdno.
const NPM_PACKAGE_NAMES = {
  'jQuery': 'jquery',
  'React': 'react',
  'Vue.js': 'vue',
  'Angular': '@angular/core',
  'Lodash': 'lodash',
  'Next.js': 'next',
};

export async function auditCRAVulnerabilities(url) {
  // 1. Získáme SBOM
  const sbomReport = await auditCRA_SBOM(url);
  const libraries = sbomReport.sbom;
  
  // Prázdný SBOM se dřív vracel jako `isCompliant: true`. To je nejhorší druh
  // false negative: "vše v pořádku", protože skener nic neviděl.
  if (!libraries || libraries.length === 0) {
    const ev = sbomReport.evidence || {};
    // Důvod prázdného SBOM se liší — a v reportu musí být ten skutečný,
    // ne obecná formulka.
    let reason;
    if (!ev.scriptsCaptured) {
      reason = 'stránka nenačetla žádný externí skript';
    } else if (ev.scriptsUnreadable >= ev.scriptsCaptured) {
      reason = `žádný z ${ev.scriptsScanned} skriptů se nepodařilo přečíst`;
    } else {
      // `scriptsScanned` už nepřečtené NEobsahuje — odečítat je podruhé
      // by číslo v reportu podhodnotilo.
      reason = `v ${ev.scriptsScanned} prohledaných skriptech neodpovídala žádná známá signatura`;
    }
    return {
      success: true,
      url,
      cra: {
        libraries: [],
        vulnerabilities: [],
        skipped: [],
        isCompliant: null, // null = neprůkazné, NE splněno
        rating: `NEPRŮKAZNÉ: SBOM se nepodařilo sestavit — ${reason}. Ověřte závislosti ze zdrojového package.json.`,
        evidence: sbomReport.evidence || null,
        conflicts: sbomReport.conflicts || [],
        scope: sbomReport.scope || null,
      }
    };
  }

  const vulnerabilities = [];
  const skipped = [];

  // 2. Pro každou knihovnu zkontrolujeme zranitelnosti přes OSV API
  //
  // Když si zdroje odporují ve verzi, ptáme se na VŠECHNY nalezené. Zeptat se
  // jen na první znamenalo, že zranitelná druhá kopie (stránka může načítat
  // dvě verze téže knihovny) prošla bez kontroly.
  const queue = libraries.flatMap((lib) => [
    lib,
    ...(lib.alternateVersions || []).map((version) => ({ ...lib, version })),
  ]);

  for (const lib of queue) {
    // `lib.npm` doplňuje fingerprinting i source mapa; tabulka je fallback
    // pro nálezy z runtime globálů.
    const pkgName = lib.npm || NPM_PACKAGE_NAMES[lib.name] || lib.name.toLowerCase();
    const version = normalizeSemver(lib.version);

    // Dřív se filtrovalo jen na přesnou rovnost s 'detekováno', takže React
    // s verzí 'detekováno (přes DevTools)' filtrem prošel a do OSV se poslal
    // prázdný řetězec. Vue '3.x' se očistilo na '3.' — taky neplatné.
    if (!version) {
      // Knihovna je prokazatelně na stránce, ale bez verze se na CVE zeptat
      // nejde. Do „prošlo" ji počítat nesmíme.
      const reason = lib.confidence === 'presence-only'
        ? `Knihovna detekována (${(lib.sources || []).join(', ') || 'neznámý zdroj'}), ale verzi se nepodařilo zjistit — bez ní nelze dotázat OSV.`
        : `Verze "${lib.version}" není použitelná pro dotaz do OSV.`;
      skipped.push({ library: lib.name, reason });
      continue;
    }

    try {
      const response = await fetch('https://api.osv.dev/v1/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(15000),
        body: JSON.stringify({ version, package: { name: pkgName, ecosystem: 'npm' } })
      });

      if (!response.ok) {
        // Dřív se selhání OSV tiše ignorovalo → výsledek "PASS".
        skipped.push({ library: lib.name, reason: `OSV vrátilo ${response.status}.` });
        continue;
      }

      const data = await response.json();
      for (const v of data.vulns || []) {
        vulnerabilities.push({
          library: lib.name,
          version: lib.version,
          cve: v.aliases?.find(a => a.startsWith('CVE-')) || v.id,
          details: v.details || v.summary || 'Bez popisu',
          severity: v.database_specific?.severity || 'HIGH'
        });
      }
    } catch (err) {
      console.error(`OSV API Error for ${lib.name}:`, err);
      skipped.push({ library: lib.name, reason: `Dotaz do OSV selhal: ${err.message}` });
    }
  }

  // Počítá se podle KNIHOVEN, ne podle dotazů: jedna knihovna se sporem verzí
  // vyvolá dva dotazy, ale pořád je to jedna položka SBOM.
  const skippedLibraries = new Set(skipped.map((s) => s.library));
  const checkedCount = libraries.filter((lib) => !skippedLibraries.has(lib.name)).length;

  // Slepá místa skenu. Bez nich by „PASS" tvrdil, že jsme viděli všechno —
  // i když se polovina skriptů nepřečetla nebo se narazilo na limit.
  const ev = sbomReport.evidence || {};
  const blindSpots = [];
  if (ev.scriptsUnreadable > 0) {
    // Jmenovatel je počet ODCHYCENÝCH skriptů, ne prohledaných.
    blindSpots.push(`${ev.scriptsUnreadable} z ${ev.scriptsCaptured} skriptů se nepodařilo přečíst`);
  }
  if (ev.truncated) {
    blindSpots.push('dosažen limit prohledávaných skriptů, další se neanalyzovaly');
  }
  if ((sbomReport.conflicts || []).length > 0) {
    blindSpots.push(`${sbomReport.conflicts.length}× si zdroje odporují ve verzi`);
  }

  let isCompliant;
  let rating;

  if (vulnerabilities.length > 0) {
    isCompliant = false;
    rating = `FAIL: Nalezeno ${vulnerabilities.length} zranitelností. Okamžitě aktualizujte závislosti!`;
  } else if (checkedCount === 0) {
    isCompliant = null;
    rating = `NEPRŮKAZNÉ: Žádnou z ${libraries.length} detekovaných knihoven nešlo ověřit proti OSV.`;
  } else if (skipped.length > 0) {
    // Část knihoven zůstala neověřená → celkový verdikt nemůže být „splněno".
    // Dřív to vycházelo jako PASS, takže nezkontrolovaná knihovna vypadala
    // stejně dobře jako zkontrolovaná.
    isCompliant = null;
    rating = `ČÁSTEČNÉ: ${checkedCount} z ${libraries.length} knihoven bez známých CVE, ${skippedLibraries.size} se ověřit nepodařilo. Na celkový závěr to nestačí.`;
  } else if (blindSpots.length > 0) {
    // Knihovny, které jsme našli, jsou v pořádku — ale nevíme, kolik jsme
    // jich neviděli. „PASS" by tvrdil úplnost, kterou sken nemá.
    isCompliant = null;
    rating = `ČÁSTEČNÉ: ${checkedCount} nalezených knihoven je bez známých CVE, ale sken nebyl úplný (${blindSpots.join('; ')}). Na celkový závěr to nestačí.`;
  } else {
    isCompliant = true;
    rating = `PASS: všech ${checkedCount} detekovaných knihoven je bez známých CVE v databázi OSV.`;
  }

  return {
    success: true,
    url,
    cra: {
      libraries,
      vulnerabilities,
      skipped,
      isCompliant,
      rating,
      // Doložitelnost: odkud SBOM pochází a co se nepodařilo přečíst.
      evidence: sbomReport.evidence || null,
      conflicts: sbomReport.conflicts || [],
      scope: sbomReport.scope || null,
    }
  };
}

/**
 * FÁZE 4: UPTIME & FORM MONITORING (Bez Playwrightu)
 */

/**
 * fetch, který sleduje přesměrování ručně a každý hop znovu prožene SSRF
 * guardem. Vestavěné `redirect: 'follow'` validuje jen první adresu.
 */
async function fetchFollowingSafeRedirects(rawUrl, options = {}, maxHops = 5) {
  let current = await assertPublicHttpUrl(rawUrl);

  for (let hop = 0; hop <= maxHops; hop++) {
    const res = await fetch(current, { ...options, redirect: 'manual' });
    const isRedirect = res.status >= 300 && res.status < 400;
    const location = res.headers.get('location');
    if (!isRedirect || !location) return res;

    if (hop === maxHops) throw new Error('Překročen limit přesměrování.');
    current = await assertPublicHttpUrl(new URL(location, current).href);
  }

  throw new Error('Překročen limit přesměrování.');
}

export async function checkPage(target) {
  const start = Date.now();
  const result = {
    type: 'page',
    name: target.name || 'Neznámá stránka',
    url: target.url,
    timestamp: new Date().toISOString(),
    ok: false,
    status: null,
    durationMs: null,
    error: null,
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), target.timeoutMs || 10000);

  try {
    // `redirect: 'follow'` obcházel SSRF kontrolu — stačilo veřejnou adresou
    // přesměrovat na interní. Přesměrování proto sledujeme ručně a každý hop
    // znovu ověřujeme. Guard tu voláme i na vstupní URL: funkce je
    // exportovaná, takže se nemůžeme spolehnout jen na middleware v server.js.
    const res = await fetchFollowingSafeRedirects(target.url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'auraguard-monitor/1.0' },
    });
    const body = await res.text();

    result.status = res.status;
    result.durationMs = Date.now() - start;

    const statusOk = res.status >= 200 && res.status < 400;
    const contentOk = target.expectedText ? body.includes(target.expectedText) : true;

    result.ok = statusOk && contentOk;
    if (!statusOk) {
      result.error = `Neočekávaný status ${res.status}`;
    } else if (!contentOk) {
      result.error = `Očekávaný text "${target.expectedText}" nebyl na stránce nalezen`;
    }
  } catch (err) {
    result.durationMs = Date.now() - start;
    result.error = err.name === 'AbortError' ? 'Timeout' : err.message;
  } finally {
    clearTimeout(timeout);
  }

  return result;
}

export async function checkForm(target) {
  const start = Date.now();
  const result = {
    type: 'form',
    name: target.name || 'Neznámý formulář',
    url: target.url,
    timestamp: new Date().toISOString(),
    ok: false,
    status: null,
    durationMs: null,
    error: null,
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), target.timeoutMs || 10000);

  try {
    const method = (target.method || 'POST').toUpperCase();
    const body = method === 'GET' ? undefined : new URLSearchParams(target.fields || {});

    const res = await fetch(await assertPublicHttpUrl(target.url), {
      method,
      signal: controller.signal,
      redirect: 'manual', // POST se nikam nepřesměrovává, cíl zůstává ověřený
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'auraguard-monitor/1.0',
      },
      body,
    });

    const isRedirect = res.status >= 300 && res.status < 400;
    const responseText = isRedirect ? '' : await res.text();

    result.status = res.status;
    result.durationMs = Date.now() - start;

    const statusOk = target.expectedStatus
      ? res.status === target.expectedStatus
      : res.status < 400;
    const contentOk = target.expectedText ? responseText.includes(target.expectedText) : true;

    result.ok = statusOk && contentOk;
    if (!statusOk) {
      result.error = `Neočekávaný status ${res.status}`;
    } else if (!contentOk) {
      result.error = `Očekávaný text "${target.expectedText}" nebyl v odpovědi nalezen`;
    }
  } catch (err) {
    result.durationMs = Date.now() - start;
    result.error = err.name === 'AbortError' ? 'Timeout' : err.message;
  } finally {
    clearTimeout(timeout);
  }

  return result;
}
