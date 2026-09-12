import { chromium } from 'playwright';
import { diffWords } from 'diff';
import path from 'path';
import fs from 'fs';
import AxeBuilder from '@axe-core/playwright';
import geoip from 'geoip-lite';
import { assertPublicHttpUrl, resolvePublicHttpTarget, guardNavigation } from './ssrf-guard.js';
import { vyhodnotFinish, UKONCENI, popisUkonceni } from './finish-policy.js';
import { bezpecnePrvky, zamlcenychPrvku, vytvorZnacku, obalDataZeStranky, obalStavStranky, pokynKDatumZeStranky } from './prompt-safety.js';
import { SCREENSHOTS_DIR, VIDEOS_DIR, GENERATED_SCRIPTS_DIR, ensureDir, safeFileToken } from './paths.js';
import { inspectTls, summarizeTls, PQC_GROUP } from './tls-audit.js';
import { createSeededRandom, generateRunSeed } from './seeded-random.js';
import { collectBundleEvidence, mergeFindings } from './sbom-fingerprint.js';
import { normalizeSemver } from './semver.js';
// Poznávání CDN je ve vlastním modulu, protože se dělá z hlaviček odpovědi
// a musí jít otestovat bez prohlížeče. Dokud se hledalo jen v hostname,
// proxovaný origin (Cloudflare bez změny jména) se nepoznal vůbec.
import { detectCdn } from './cdn-detect.js';
// Porovnávání názvů trackerů je ve vlastním modulu ze stejného důvodu:
// podřetězcové hledání nad krátkými jehlami vyrábělo nálezy na klíčích
// jako `userSegment` nebo `image_gallery` a nikdo to netestoval.
import { isTrackerStorageKey, isTrackerCookieName } from './tracker-match.js';
import {
  dismissCookieBanner, popisOdkliknuti, popisPredSouhlasem,
} from './cookie-banner.js';
// Geolokační databáze u neznámé adresy vrací výplňový záznam, který
// vypadá jako plnohodnotný výsledek. Bez tohohle rozlišení z něj vznikalo
// „prokazatelně mimo EU/EHP".
import { geoQuality, geoipDatabaseDate } from './geoip-quality.js';
// Závažnost se dřív při absenci pole doplňovala konstantou 'HIGH' —
// tedy údajem, který nikdo neměřil, vytištěným v dokumentu pro úřad.
import { severityOf } from './osv-severity.js';
// Rozsahy zveřejněné poskytovatelem cloudu. Silnější podklad než
// geolokační databáze třetí strany: údaj pochází od toho, kdo o umístění
// serveru rozhoduje.
import { lookupCloudIp, rangesSnapshot } from './cloud-ranges.js';
// Čtení hlaviček je ve vlastním modulu, aby šlo testovat bez prohlížeče.
// Dokud to byly regulární výrazy uvnitř `analyzeNis2`, nešlo je otestovat
// samostatně — a tak se netestovaly vůbec.
import { hasNosniff, framingProtected, referrerProtected } from './header-values.js';
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
    // `null`, ne `[]`.
    //
    // Prázdné pole říká „na stránce není co ovládat" — a to je změřený
    // fakt, ze kterého `vyhodnotFinish` odvozuje, že běh smí skončit.
    // Odpojený frame, pád `page.evaluate()` nebo navigace uprostřed čtení
    // ale znamenají, že nevíme nic. Ověřeno: dokud se vracelo `[]`, běh
    // po selhání extrakce skončil v prvním kroku jako „vyčerpáno",
    // `measured: true`, a vytiskl se jako doložený čistý výsledek.
    return null;
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

/**
 * Jednotné znění nálezu z konzole.
 *
 * Musí ho použít KAŽDÁ cesta, která chybu z konzole zapisuje — jinak
 * `addFinding` (deduplikace podle celého řetězce) tutéž chybu započítá
 * tolikrát, kolik je formulací.
 */
function consoleFinding(text) {
  const t = String(text ?? 'neznámá chyba');
  return `Detekována chyba v konzoli: "${t.length > 300 ? `${t.slice(0, 297)}…` : t}"`;
}

/**
 * Je tento záznam z konzole runtime chybou?
 *
 * Rozhoduje POUZE `type`, a to přesně tak, jak ho plní jediný zapisovatel
 * `consoleLogs` — posluchač `page.on('console')`. Dřív se sem počítal
 * i jakýkoli text obsahující slovo „error", takže
 * `[analytics] error reporting enabled` — log o tom, že hlášení chyb je
 * zapnuté — vyrobil nález o chybě webu. Zákazník by dostal obvinění za
 * vlastní diagnostiku.
 *
 * `pageerror` tu schválně NENÍ: posluchač `page.on('pageerror')` zapisuje
 * přímo do `bugs` vlastním zněním a do `consoleLogs` nic nedává. Přidat
 * ho sem by znamenalo druhé znění pro tentýž fakt, a `addFinding`
 * deduplikuje podle celého řetězce — jedna výjimka by se započítala
 * dvakrát. Počet nálezů v dokumentu pro úřad je tvrzení jako každé jiné.
 */
function jeChybovyLog(log) {
  return String(log?.type || '').toLowerCase() === 'error';
}

function hasRuntimeSignals(consoleLogs, networkErrors) {
  return (consoleLogs || []).some(jeChybovyLog) || (networkErrors || []).length > 0;
}

function summarizeRuntimeSignal(consoleLogs, networkErrors) {
  const consoleError = (consoleLogs || []).find(jeChybovyLog);
  if (consoleError) {
    // TOTOŽNÉ znění jako v posluchači `page.on('console')`.
    //
    // Dřív tu stálo „V konzoli je chyba: …" a v posluchači „Detekována
    // chyba v konzoli: …" — dva různé prefixy pro TÝŽ řádek konzole.
    // `addFinding` deduplikuje podle celého řetězce, takže se jedna
    // chyba započítala dvakrát a report tvrdil „nalezeny 4 problémy"
    // tam, kde byly dva různé fakty. Počet v dokumentu pro úřad je
    // tvrzení jako každé jiné.
    return consoleFinding(consoleError.text || consoleError.message || 'neznámá chyba');
  }
  const networkError = (networkErrors || [])[0];
  if (networkError) {
    return `Selhal síťový požadavek: ${String(networkError.url || networkError.error || networkError.message || networkError).slice(0, 160)}`;
  }
  return null;
}

/**
 * Nálezy kroku. VÝHRADNĚ z měření, nikdy z textu modelu.
 *
 * PROČ TO TU JE
 * Dřív se sem propouštěl obsah `detected_bugs` od modelu. Ověřeno: věta
 * „Web nemá platné prohlášení o přístupnosti podle EAA." se dostala do
 * `bugs`, do reportu i do spisu — aniž by kdokoli cokoli takového měřil.
 * Model přitom rozhoduje podle obsahu auditované stránky, takže tou cestou
 * si web může diktovat vlastní nálezy (v obou směrech).
 *
 * Nález o webu proto smí vzniknout jen z naměřeného signálu. Text modelu
 * se nezahazuje, ale putuje do `model_notes` jako nepotvrzený postřeh —
 * viditelný v průběhu běhu, nikdy ve verdiktu.
 */
function measuredFindings(consoleLogs, networkErrors) {
  if (!hasRuntimeSignals(consoleLogs, networkErrors)) return [];
  const summary = summarizeRuntimeSignal(consoleLogs, networkErrors);
  return summary ? [summary] : [];
}

/**
 * Nepotvrzené postřehy modelu. Zkrácené a bez duplikátů; `reasoning`
 * přepsané do `detected_bugs` se zahazuje (model si tak jen opakoval
 * vlastní úvahu a vznikal z ní „nález").
 */
export function modelNotes(detectedBugs, reasoning) {
  if (!Array.isArray(detectedBugs)) return [];
  const normalizedReasoning = String(reasoning || '').trim().replace(/\s+/g, ' ');
  return [...new Set(detectedBugs
    .filter((bug) => typeof bug === 'string')
    .map((bug) => bug.trim().replace(/\s+/g, ' '))
    .filter(Boolean)
    .filter((bug) => bug !== normalizedReasoning)
    .map((bug) => (bug.length > 300 ? `${bug.slice(0, 297)}…` : bug))
  )];
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

/**
 * Kolik kroků bylo skutečnou interakcí se stránkou.
 *
 * Tvrzení stránky „hotovo" (URL, titulek) se přijímá jen tehdy, když
 * agent předtím aspoň jednou klikl nebo vyplnil. Bez téhle podmínky
 * stačilo webu poslat `<title>Objednávka dokončena</title>` a běh skončil
 * v prvním kroku bez jediné provedené akce — ověřeno.
 *
 * Počítají se PROVEDENÉ kroky z historie, ne návrhy modelu.
 */
/**
 * Hlásí stránka dokončení ZPŮSOBEM, který jde přijmout?
 *
 * Sjednocená podmínka pro všechna tři místa, kde se `finish` propouštělo:
 * fallback, převod `click` → `finish` i vlastní hradba. Dřív měla každá
 * cesta podmínku vlastní a `chooseFallbackAction` i převod kliknutí se
 * spokojily s pouhým regexem nad titulkem, tedy s textem, který nastavuje
 * auditovaný web.
 */
function dokonceniDolozeno(context) {
  return isCompletionContext(context) && pocetInterakci(context?.steps) > 0;
}

function pocetInterakci(steps) {
  return (steps || []).filter((step) => {
    if (step?.action !== 'click' && step?.action !== 'type') return false;
    // `provedeno === false` znamená, že akce spadla. Chybějící příznak
    // (starší uložený běh, krok zaznamenaný jinou cestou) se bere jako
    // provedený — jinak by se změnilo chování u dat, o kterých nic nevíme.
    return step.provedeno !== false;
  }).length;
}

function chooseFallbackAction(interactiveElements, steps, runtimeSignals = false, context = {}) {
  // Selhané čtení prvků nesmí nic dokládat ani tady. Jinak hradba
  // `vyhodnotFinish` zamítne ukončení a fallback ho hned nato propustí —
  // s reasoningem, který si sám protiřečí.
  if (!context.extrakceSelhala
      && dokonceniDolozeno(context)
      && !hasRuntimeSignals(context.consoleLogs, context.networkErrors)) {
    return {
      reasoning: 'Stránka po provedené interakci hlásí dokončení a nejsou vidět chyby, proto test ukončím.',
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
    detected_bugs: measuredFindings(consoleLogs, networkErrors),
    model_notes: modelNotes(actionResponse?.detected_bugs, reasoning || step.reasoning),
    // Fallback vrací `finish` jedině na potvrzovací stránce — jiná cesta
    // k ukončení v `chooseFallbackAction` není.
    ukonceni: step.action === 'finish' ? UKONCENI.POTVRZENO : null
  };
}

export function sanitizeActionResponse(actionResponse, context) {
  const { currentUrl, title, goal, visibleState, suggestedUrl, interactiveElements, consoleLogs, networkErrors, steps } = context;
  const extrakceSelhala = Boolean(context.extrakceSelhala);
  const sanitizerContext = { currentUrl, title, goal, visibleState, suggestedUrl, consoleLogs, networkErrors, steps, extrakceSelhala };
  const validIds = new Set(interactiveElements.map((el) => el.id));
  const byId = new Map(interactiveElements.map((el) => [el.id, el]));
  let action = actionResponse?.action;
  let target = normalizeTargetValue(actionResponse?.target);
  let value = actionResponse?.value ?? null;
  let reasoning = typeof actionResponse?.reasoning === 'string' && actionResponse.reasoning.trim()
    ? actionResponse.reasoning.trim()
    : 'Model nevrátil použitelnou úvahu, proto volím bezpečný průzkumný krok.';
  // Proč běh skončil. Zapisuje se do spisu: „ukončeno na návrh modelu"
  // a „stránka sama hlásí hotovo" nejsou totéž.
  let ukonceni = null;

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

  // Ukončení musí mít oporu v naměřeném stavu, ne v tvrzení modelu.
  // Model rozhoduje podle obsahu auditované stránky, takže bez téhle
  // podmínky si web dokáže objednat čistý výsledek — ověřeno.
  if (action === 'finish') {
    const verdikt = vyhodnotFinish({
      completionContext: isCompletionContext(sanitizerContext),
      interakci: pocetInterakci(steps),
      prvkuNaStrance: Array.isArray(interactiveElements) ? interactiveElements.length : undefined,
      extrakceSelhala,
    });
    if (verdikt.povoleno) {
      ukonceni = verdikt.duvod;
    } else {
      const fallback = chooseFallbackAction(interactiveElements, steps, hasRuntimeSignals(consoleLogs, networkErrors), sanitizerContext);
      // Kdyby fallback sám navrhl finish, propustí ho `chooseFallbackAction`
      // jen na potvrzovací stránce — tedy tam, kde by prošel i výše.
      fallback.reasoning = `(Ukončení bez opory v měření zamítnuto) ${fallback.reasoning}`;
      return withSanitizedBugs(fallback, actionResponse, reasoning, consoleLogs, networkErrors);
    }
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

  if (action === 'click' && !extrakceSelhala && dokonceniDolozeno(sanitizerContext) && !hasRuntimeSignals(consoleLogs, networkErrors)) {
    action = 'finish';
    target = null;
    value = null;
    reasoning = 'Stránka po provedené interakci hlásí dokončení a nejsou vidět chyby, proto test ukončím.';
    ukonceni = UKONCENI.POTVRZENO;
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
    detected_bugs: measuredFindings(consoleLogs, networkErrors),
    model_notes: modelNotes(actionResponse?.detected_bugs, reasoning),
    ukonceni: action === 'finish' ? (ukonceni || UKONCENI.VYCERPANO) : null
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


/**
 * `query` je vstřikovatelný schválně.
 *
 * Bez toho se prompt nedal v testu přečíst a právě ve složení promptu byla
 * ta nejdražší vada: obsah auditované stránky tam stál vedle našich pokynů
 * jako rovnocenný text. Kontrolní vlny opakovaně potvrdily, že nejhorší
 * nálezy leží tam, kam se nikdo nepodíval — tak se tam dá podívat.
 */
async function determineNextAction(llmConfig, currentUrl, title, interactiveElements, consoleLogs, networkErrors, steps, goal, { query = queryLLM, extrakceSelhala = false } = {}) {
  let actionResponse;
  // Krok, o kterém nerozhodlo měření ani model, ale záchranný fallback.
  // Dřív to spadlo pod stůl: při úplném výpadku jazykového modelu proběhlo
  // deset „scroll down" a běh skončil jako `completed`, `measured: true`,
  // tedy „výsledek platí". Neplatil — nikdo nic nerozhodl.
  let decisionError = null;
  const recentLogs = consoleLogs.slice(-10).map(l => `[${l.type}] ${l.text}`).join('\n');
  const recentNet = networkErrors.slice(-10).map(n => `FAIL: ${n.url} - ${n.error}`).join('\n');

  // Značka bloků s daty z auditované stránky. Nová pro každý krok, aby ji
  // stránka nemohla uhodnout z předchozí odpovědi.
  const znacka = vytvorZnacku();
  // Zkrácená pole a zahozené hodnoty tajných vstupů. Do rozhodovací logiky
  // (`sanitizeActionResponse`) jdou dál skutečné prvky — ta potřebuje
  // `value` u běžných polí a `checked` u checkboxů.
  const prvkyDoPromptu = bezpecnePrvky(interactiveElements);
  const nevesloSe = zamlcenychPrvku(interactiveElements);
  const popisPrvku = nevesloSe > 0
    ? `${JSON.stringify(prvkyDoPromptu, null, 2)}\n[POZNÁMKA MĚŘENÍ: dalších ${nevesloSe} prvků se do seznamu nevešlo.]`
    : JSON.stringify(prvkyDoPromptu, null, 2);
  // Adresa a titulek patří do ohraničeného bloku stejně jako prvky —
  // `document.title` nastavuje auditovaný web, novými řádky včetně.
  const stavStranky = obalStavStranky(currentUrl, title, znacka);

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
- CRITICAL: All JSON output values ('reasoning', 'detected_bugs') MUST be written in the Czech language (Čeština). Důvod (reasoning) MUSÍ být smysluplná věta popisující tvůj záměr.

${pokynKDatumZeStranky(znacka)}`;

      prompt = `Test Type: Smart AI Monkey Test
${stavStranky}

Interactive elements on page:
${obalDataZeStranky('interaktivní prvky auditované stránky', popisPrvku, znacka)}

Recent console logs:
${obalDataZeStranky('konzole auditované stránky', recentLogs || 'No console errors.', znacka)}

Recent network errors:
${obalDataZeStranky('síťové chyby auditované stránky', recentNet || 'No network errors.', znacka)}

History of previous steps:
${obalDataZeStranky('historie kroků', steps.map(s => `Step ${s.step}: ${s.action} on ${s.target || 'page'} (Reason: ${s.reasoning})`).join('\n') || 'No previous steps.', znacka)}

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
- CRITICAL: All JSON output values ('reasoning', 'detected_bugs') MUST be written in the Czech language (Čeština). Důvod (reasoning) MUSÍ být smysluplná věta popisující tvůj záměr.

${pokynKDatumZeStranky(znacka)}`;

      prompt = `Test Goal: ${goal}
${stavStranky}

Interactive elements on page:
${obalDataZeStranky('interaktivní prvky auditované stránky', popisPrvku, znacka)}

Recent console logs:
${obalDataZeStranky('konzole auditované stránky', recentLogs || 'No console errors.', znacka)}

Recent network errors:
${obalDataZeStranky('síťové chyby auditované stránky', recentNet || 'No network errors.', znacka)}

History of previous steps:
${obalDataZeStranky('historie kroků', steps.map(s => `Step ${s.step}: ${s.action} on ${s.target || 'page'} (Reason: ${s.reasoning})`).join('\n') || 'No previous steps.', znacka)}

CRITICAL ANTI-LOOP RULE: Review the history of previous steps. You must NOT repeat the exact same action and target as the last step. If you just scrolled down, do NOT scroll down again right away. If you are stuck, choose a different action, click a different element, or output "finish".

Decide your next step to achieve the goal. Reply ONLY with valid JSON.`;
    }

    try {
      const responseText = await query(prompt, systemPrompt, llmConfig.provider, llmConfig.model, llmConfig.host);
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
      decisionError = `Krok nerozhodl model: ${err.message}`;

      actionResponse = {
        reasoning: extractedReasoning,
        action: 'scroll',
        target: null,
        value: 'down',
        detected_bugs: []
      };
    }
  }

  return {
    ...sanitizeActionResponse(actionResponse, {
      currentUrl,
      title,
      goal,
      interactiveElements,
      consoleLogs,
      networkErrors,
      steps,
      extrakceSelhala,
    }),
    decisionError,
  };
}

/**
 * Co je uložené PŘED tím, než kdokoli cokoli odsouhlasil.
 *
 * Snímá se hned po načtení stránky a před odkliknutím cookie lišty.
 * Po odkliknutí by už nešlo poznat, co si web uložil sám od sebe.
 *
 * `context.cookies()` se používá schválně místo `document.cookie` —
 * ten nevidí HttpOnly cookies, tedy právě ty, které nastavuje
 * serverové trackování.
 */
async function snapshotPredSouhlasem(context, page, { cekaniMs = 5000 } = {}) {
  // Stejná prodleva jako v `auditGDPRCookies`, a ze stejného důvodu:
  // trackery se často načítají opožděně, z `setTimeout` po `networkidle`.
  // Bez čekání by snímek hlásil prázdno u webu, který se za sekundu
  // uloží — a v jednom dokumentu by pak stály dvě věty, které si
  // odporují.
  await new Promise((r) => setTimeout(r, cekaniMs));

  // `null` znamená NEZMĚŘENO, prázdné pole ZMĚŘENO A PRÁZDNO.
  // Tiché `.catch(() => [])` z neúspěchu dělalo větu „nic nebylo
  // uloženo" — přesně ta chyba, kvůli které vznikl úkol #49.
  let cookies = null;
  let chyba = null;
  try {
    cookies = (await context.cookies())
      .filter((c) => isTrackerCookieName(c.name))
      .map((c) => `${c.name} (${c.domain})`);
  } catch (err) {
    chyba = `cookies: ${err.message}`;
  }

  let storage = null;
  try {
    const klice = await page.evaluate(() => {
      const vysledek = [];
      // Přístup k `window.localStorage` sám o sobě vyhazuje, když je
      // úložiště zakázané — proto je uvnitř try, ne mimo něj.
      for (const jmeno of ['localStorage', 'sessionStorage']) {
        try {
          const uloziste = window[jmeno];
          for (let i = 0; i < uloziste.length; i++) vysledek.push(uloziste.key(i));
        } catch { /* zakázané úložiště */ }
      }
      return vysledek;
    });
    storage = klice.filter((k) => isTrackerStorageKey(k));
  } catch (err) {
    chyba = chyba ? `${chyba}; úložiště: ${err.message}` : `úložiště: ${err.message}`;
  }

  return { cookies, storage, chyba, cekaniMs };
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

    // Adresy, které jsme zablokovali SAMI. Prohlížeč je pak ohlásí jako
    // `requestfailed` s net::ERR_BLOCKED_BY_CLIENT a posluchač z nich dělal
    // nález „Selhal síťový požadavek" — tedy obvinění webu z toho, že mu
    // náš vlastní hlídač zakázal spojení. Ověřeno.
    const blokovaneNami = new Set();
    const blokaceHlidacem = [];
    await guardNavigation(context, (blokovanaUrl, duvod) => {
      blokovaneNami.add(blokovanaUrl);
      const zaznam = `Navigaci na ${blokovanaUrl} zablokoval bezpečnostní hlídač AuraGuard: ${duvod}`;
      if (!blokaceHlidacem.includes(zaznam)) blokaceHlidacem.push(zaznam);
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
    // Dřív šlo všechno s prefixem [AuraAuraGuard- do `bugs` a `success` se
    // počítalo jako bugs.length === 0. Long task > 100 ms nebo pomalé API tak
    // označilo prakticky každou reálnou aplikaci za neúspěch.
    const warnings = [];
    // Selhání NAŠEHO měření — timeout, pád prohlížeče, výpadek modelu.
    // Vědomě oddělené od `bugs`: co se nezměřilo, nesmí se objevit jako
    // zjištění o auditovaném webu.
    const runErrors = [];
    // Okolnosti běhu, které NEJSOU nálezem o webu ani chybou měření:
    // nepotvrzené postřehy modelu a kroky, o kterých model nerozhodl.
    const modelObservations = [];
    const runNotes = [];
    let modelDecisions = 0;
    let decisionFailures = 0;
    let currentStep = 1;
    const maxSteps = llmConfig.maxSteps || 10;
    let isFinished = false;
    let ukonceniBehu = null;
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
      addFinding(bugs, consoleFinding(text));
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
    // Vlastní blokace není vada webu ani runtime signál. Nesmí se dostat
    // ani do `networkErrors` — podle nich se řídí `hasRuntimeSignals`,
    // takže by naše blokace navíc přepnula výběr další akce na „zkus to
    // znovu" a v každém dalším kroku vyrobila nález.
    // Podle MNOŽINY, ne podle textu chyby. `net::ERR_BLOCKED_BY_CLIENT`
    // hlásí prohlížeč i u blokací, které nejsou naše (rozšíření v profilu,
    // politika prohlížeče) — plošný filtr na text by je zamlčel, a to jsou
    // okolnosti běhu, které čtenář reportu vidět má.
    if (blokovaneNami.has(reqUrl)) {
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

  // Stav před souhlasem a výsledek odkliknutí lišty. Obojí se vrací
  // volajícímu, aby to mohlo do záznamu běhu i do reportu.
  let preConsent = null;
  let cookieBanner = null;

  // Kolik položek už bylo odesláno v předchozích krocích (viz stepData níž).
  let emittedLogCount = 0;
  let emittedBugCount = 0;
  let emittedWarningCount = 0;

  try {
    if (onStepProgress) onStepProgress({ step: 0, action: 'Navigace', detail: `Otevírání ${url}` });
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });

    // --- Cookie lišta ---
    //
    // POŘADÍ NENÍ NÁHODNÉ. Nejdřív se zaznamená stav PŘED souhlasem,
    // teprve pak se lišta odklikne. Kdyby zmizela dřív, přišli bychom
    // o vlastní důkaz: co se uložilo dřív, než návštěvník cokoli
    // odsouhlasil, je ta nejzajímavější věc na celém běhu.
    //
    // Lišta se přitom odkliknout MUSÍ — překrývá stránku a chytá
    // kliknutí, takže agent bez toho utrácel kroky za proklikávání
    // něčeho, co je pod překryvem, a část běhů se k testované aplikaci
    // vůbec nedostala.
    if (llmConfig.dismissCookieBanner !== false) {
      // `consoleLogs` je pole OBJEKTŮ `{type, text, timestamp}` — čte
      // je `determineNextAction` i UI. Vkládat sem holý řetězec
      // znamenalo `[undefined] undefined` v promptu modelu a prázdný
      // řádek v záznamu běhu.
      const poznamka = (text) => consoleLogs.push({
        type: 'auraguard', text, timestamp: new Date().toISOString(),
      });

      try {
        preConsent = await snapshotPredSouhlasem(context, page, {
          // Prodleva před snímkem je konfigurovatelná hlavně kvůli
          // testům; v provozu se drží na 5 s jako v GDPR skeneru.
          cekaniMs: llmConfig.preConsentWaitMs ?? 5000,
        });
        for (const veta of popisPredSouhlasem(preConsent)) poznamka(veta);

        const vysledek = await dismissCookieBanner(page);
        cookieBanner = vysledek;
        poznamka(popisOdkliknuti(vysledek));
        if (onStepProgress) {
          onStepProgress({
            step: 0, action: 'Cookie lišta', detail: popisOdkliknuti(vysledek),
          });
        }
        if (vysledek.clicked) {
          // Lišta mizí s animací; bez toho by první screenshot zachytil
          // půlku překryvu a agent by se rozhodoval podle něj.
          await page.waitForTimeout(500);
        }
      } catch (err) {
        // Chyba obsluhy lišty NENÍ zjištění o webu. Do `runErrors`
        // proto taky ne — běh kvůli ní neztrácí platnost, jen mohl
        // proběhnout pod překryvem.
        cookieBanner = { clicked: false, label: null, reason: `chyba: ${err.message}` };
        consoleLogs.push({
          type: 'auraguard',
          text: popisOdkliknuti(cookieBanner),
          timestamp: new Date().toISOString(),
        });
      }
    }

    while (currentStep <= maxSteps && !isFinished) {
      // 1. Gather current state
      const currentUrl = page.url();
      // sessionId se u monitorů skládá z hodnot z DB — bez očištění by `../`
      // v něm zapsalo PNG mimo adresář screenshotů.
      const screenshotFileName = `${safeFileToken(sessionId)}_step_${currentStep}.png`;
      const screenshotPath = path.join(ensureDir(SCREENSHOTS_DIR), screenshotFileName);

      // ⚡ Bolt: Paralelizace CDP Playwright příkazů pro rychlé získání title, stavu a screenshotu
      const [title, prvkyNeboNull] = await Promise.all([
        page.title(),
        extractInteractiveElements(page),
        page.screenshot({ path: screenshotPath }).catch(err => {
           console.warn('Nepodařilo se uložit screenshot na disk:', err.message);
        })
      ]);

      // `null` = čtení prvků selhalo. Prázdný seznam by znamenal změřené
      // „na stránce není co ovládat" a z toho se odvozuje, že běh smí
      // skončit — takže se to nesmí slít. Ověřeno: dokud se tyhle dva
      // stavy pletly, běh po selhání extrakce skončil v prvním kroku
      // s `measured: true` a vytiskl se jako čistý výsledek.
      const extrakceSelhala = prvkyNeboNull === null;
      const interactiveElements = prvkyNeboNull || [];
      if (extrakceSelhala) {
        runErrors.push(`Krok ${currentStep}: nepodařilo se přečíst interaktivní prvky stránky ${currentUrl}.`);
      }

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
        goal,
        { extrakceSelhala }
      );

      // 3. Nálezy z měření (posluchače konzole a sítě je už zapsaly samy,
      //    `addFinding` zajistí deduplikaci). Text modelu se sem NEDOSTANE
      //    — je jen nepotvrzený postřeh.
      if (Array.isArray(actionResponse.detected_bugs)) {
        actionResponse.detected_bugs.forEach((b) => addFinding(bugs, b));
      }
      if (Array.isArray(actionResponse.model_notes)) {
        actionResponse.model_notes.forEach((n) => {
          if (!modelObservations.includes(n)) modelObservations.push(n);
        });
      }
      if (actionResponse.decisionError) {
        decisionFailures++;
        if (!runNotes.includes(actionResponse.decisionError)) runNotes.push(actionResponse.decisionError);
      } else {
        modelDecisions++;
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
        // Odděleně od `bugs`: co model tvrdí, není měření.
        modelNotes: actionResponse.model_notes || [],
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
        stepData.provedeno = true;
        isFinished = true;
        ukonceniBehu = actionResponse.ukonceni || UKONCENI.VYCERPANO;
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
        // Krok se OPRAVDU provedl.
        //
        // `steps.push(stepData)` je nutně před provedením akce (UI má krok
        // vidět hned), takže historie sama nerozliší návrh od provedení.
        // `pocetInterakci` přitom rozhoduje, jestli se přijme tvrzení
        // stránky „hotovo" — bez tohohle příznaku by stačilo, že klik
        // někdo NAVRHL, i kdyby spadl.
        stepData.provedeno = true;
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
        stepData.provedeno = false;
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

    // Úplný výpadek rozhodování = nic se nerozhodlo. Deset záchranných
    // „scroll down" není měření a `completed` by znamenalo „výsledek platí".
    if (decisionFailures > 0 && modelDecisions === 0) {
      runErrors.push(`Rozhodovací model neodpověděl ani jednou (${decisionFailures}× záchranný krok): ${runNotes[0] || 'bez podrobností'}`);
    }
    // Zablokovaná navigace hlavního rámce = stránka, kterou nikdo neviděl.
    // `guardNavigation` propouští jen navigace hlavního rámce, takže každý
    // takový záznam znamená neproběhlé měření. Dřív z toho byl falešný
    // nález na webu; zapsat to jen jako okolnost běhu by ale bylo druhé
    // přestřelení — verdikt „Bez nálezu" by pokrýval stránku, která se
    // nezměřila.
    // Zneplatnit kvůli tomu CELÝ běh by bylo přestřelení do druhé strany:
    // hlídač zastaví i navigaci na veřejný host na nestandardním portu nebo
    // odkaz s nepřeložitelným DNS, tedy věci, které se na nezávadném webu
    // stávají. Dotčené stránky se ale nezměřily, takže verdikt je nesmí
    // pokrývat — jde to do `runNotes` a zvlášť do počtu, ze kterého spis
    // i report sestaví výhradu o pokrytí.
    const nezmerenoBlokaci = blokaceHlidacem.length;
    // Chyba měření přebíjí všechno ostatní. Bez tohohle zůstalo
    // `ukonceni: 'potvrzeno-strankou'` i u běhu se zapsanou chybou měření
    // a report tiskl „stránka sama hlásí dokončení" nad nedokončeným
    // měřením.
    if (runErrors.length > 0) {
      ukonceniBehu = UKONCENI.CHYBA;
    } else if (!ukonceniBehu) {
      ukonceniBehu = UKONCENI.LIMIT;
    }

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
      // Nepotvrzené postřehy modelu. Drženy odděleně od `bugs` i od
      // `runErrors`: nejsou to nálezy o webu ani chyby měření, ale text,
      // který model napsal. Do verdiktu ani do spisu se nepočítají.
      modelObservations: [...new Set(modelObservations)],
      // Okolnosti běhu: kroky bez rozhodnutí modelu a blokace hlídačem.
      runNotes: [...new Set([...runNotes, ...blokaceHlidacem])],
      // Kolik kroků NEROZHODL model, ale záchranný fallback. Nenulová
      // hodnota znamená, že běh prošel méně, než se zdá — proto se to
      // musí dostat do reportu i do spisu, ne jen do logu.
      nerozhodnutychKroku: decisionFailures,
      // Kolik navigací zastavil vlastní bezpečnostní hlídač. Dotčené
      // stránky se nezměřily; verdikt je proto nesmí pokrývat.
      nezmerenoBlokaci,
      // Jak běh skončil. „Ukončeno na návrh modelu" a „stránka sama hlásí
      // hotovo" nejsou totéž a ve spisu se to nesmí slít.
      ukonceni: ukonceniBehu,
      ukonceniPopis: popisUkonceni(ukonceniBehu),
      summary: !measured
        ? `Měření se nedokončilo: ${runErrors[0]}`
        : isFinished
          ? `Test dokončen. ${popisUkonceni(ukonceniBehu)}`
          : 'Test dosáhl limitu maximálního počtu kroků.',
      performanceMetrics,
      generatedScript,
      videoUrl,
      // Stav před souhlasem a co se na liště zmáčklo. Do `bugs` to
      // nepatří — je to popis okolností běhu, ne verdikt o webu.
      preConsent,
      cookieBanner,
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

    // Selhání navigace ani chybová odpověď se NESMÍ spolknout.
    //
    // `page.goto` u 404, 403 nebo interstitialu bot ochrany nevyhazuje —
    // navigace uspěje. axe pak prohlédne stránku „Access Denied", nenajde
    // na ní žádné porušení a do neměnného záznamu se zapsalo
    // „BEZ NÁLEZU" pro WCAG 2.1 AA o webu, který se vůbec nezobrazil.
    //
    // Konvence existovala už v `auditNIS2AndPQC`, jen se sem nepřevzala.
    let navigationError = null;
    const response = await page
      .goto(url, { waitUntil: 'networkidle', timeout: 30000 })
      .catch((err) => { navigationError = err.message; return null; });

    if (!navigationError) {
      if (!response) {
        navigationError = 'Server neodpověděl.';
      } else if (!response.ok()) {
        navigationError = `Server odpověděl ${response.status()}.`;
      }
    }

    if (navigationError) {
      // Vrací se výsledek, ne výjimka: neprůkazné měření je legitimní
      // zjištění a spis ho musí umět vykázat.
      return {
        success: true,
        url,
        navigationError,
        violations: [],
        incomplete: [],
        passedCount: 0,
      };
    }

    // Bez .withTags() běžela i best-practice a experimentální pravidla, jejichž
    // porušení NENÍ porušením WCAG 2.1 AA / EN 301 549 — v compliance reportu
    // to dělalo falešné poplachy.
    const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];
    const results = await new AxeBuilder({ page })
      .withTags(AXE_TAGS)
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
      // Adresa PO přesměrováních. Dřív se vracela ta požadovaná, takže
      // spis tvrdil, že se měřilo jinde, než se skutečně měřilo.
      url: page.url() || url,
      navigationError: null,
      // Čím se měřilo.
      //
      // Registr slibuje, že stejné id a verze pravidla znamenají stejný
      // způsob posouzení. U přístupnosti to ale neurčuje naše pravidlo,
      // nýbrž axe-core, který se přes `^4.12.1` může posunout na libovolné
      // 4.x, aniž by se verze pravidla zvedla. `results.testEngine` se
      // přitom zahazoval, takže rok starý záznam ve spisu nešlo
      // reprodukovat ani obhájit — a doložitelnost je to hlavní, čím se
      // tenhle nástroj liší.
      engine: {
        name: results.testEngine?.name || 'axe-core',
        version: results.testEngine?.version || null,
        tags: AXE_TAGS,
      },
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
      // Trojstav se PROPISUJE, nezplošťuje. `null` znamená, že se hlavička
      // posoudit nedala — na http:// ji prohlížeč ignoruje, takže její
      // absence není volba provozovatele a nálezem být nemůže.
      hsts: hstsDetail.ok,
      // Jediný posuzovatel CSP.
      //
      // Dřív tu byla vlastní funkce `hasMeaningfulCsp`, která neznala nonce
      // ani strict-dynamic. Report pak u jedné politiky tvrdil dvě různé
      // věci: podrobný rozbor ji uznal, souhrn hlaviček ji označil za
      // nedostatečnou.
      csp: cspDetail.ok,
      // Hlavička nastavená dvakrát dorazí sloučená čárkou (`nosniff,
      // nosniff`). Fetch Standard („determine nosniff") ji rozdělí podle
      // čárky a posuzuje první hodnotu, takže ochrana funguje. Porovnání
      // celého řetězce z toho dělalo nález na webu, který je v pořádku.
      xContentTypeOptions: hasNosniff(headers['x-content-type-options']),
      // Moderní ekvivalent X-Frame-Options je CSP frame-ancestors.
      // Hodnota musí něco zakazovat — `ALLOWALL` ochranu neposkytuje.
      //
      // U `frame-ancestors` se dřív hledala jen přítomnost názvu direktivy,
      // takže `frame-ancestors *` — což nezakazuje nic — procházelo jako
      // ochrana. Hvězdička se proto vylučuje výslovně.
      xFrameOptions: /^\s*(deny|sameorigin)\s*$/i.test(headers['x-frame-options'] || '')
        || framingProtected(headers['content-security-policy']),
      // Posuzuje se HODNOTA, kterou prohlížeč skutečně použije.
      //
      // Dřív se hledal podřetězec, což selhávalo v obou směrech:
      // `no-referrer-when-downgrade` prošlo (obsahuje „no-referrer"),
      // ačkoli komentář sám tvrdil, že je nedostatečné, a naopak
      // `unsafe-url, strict-origin-when-cross-origin` dostalo nález,
      // přestože prohlížeč z takového seznamu vezme poslední hodnotu,
      // které rozumí — tedy tu bezpečnou.
      referrerPolicy: referrerProtected(headers['referrer-policy']),
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
    // Hlavičky, o kterých sken nemá co říct. Nesmí splynout s chybějícími.
    const inconclusiveHeaders = [];

    for (const [key, ok] of Object.entries(headerChecks)) {
      if (ok === true) continue;

      // Neprůkazné se nesmí vydávat za chybějící.
      //
      // `auditHsts` na nešifrovaném spojení vrací `null` a výslovně říká,
      // že absence hlavičky tam není volba provozovatele — prohlížeč ji na
      // http:// ignoruje. Porovnání `=== true` z toho dělalo `false` a
      // report i CLI hlásily „Chybí hlavička: Strict-Transport-Security".
      // Spis přitom u téhož běhu tiskl znění pravidla, které tvrdí opak,
      // takže si doklad protiřečil sám se sebou na jedné straně.
      if (ok === null) {
        inconclusiveHeaders.push(HEADER_LABELS[key]);
        continue;
      }

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
      // Hlavičky, které se posoudit nedaly. Prázdné pole u drtivé většiny
      // běhů; naplní se hlavně u webů běžících po http://.
      inconclusiveHeaders,
      headersComplete: missingHeaders.length === 0 && weakHeaders.length === 0,
      // Neprůkazné brání tvrdit splnění, ale není to porušení.
      //
      // `false` znamená prokázané porušení a takové tvrzení nesmí vzniknout
      // z toho, že se něco nepodařilo posoudit. Zároveň se z neprůkazného
      // nesmí stát „splněno" — proto `null`.
      isCompliant: (missingHeaders.length > 0 || weakHeaders.length > 0)
        ? false
        : (inconclusiveHeaders.length > 0 ? null : true),

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

/**
 * true = změřené servery jsou v EHP, false = prokazatelně mimo, null = neprůkazné.
 *
 * POSUZUJÍ SE JEN MĚŘITELNÉ DOMÉNY
 * Doména za anycast CDN a doména, jejíž adresu geolokační databáze nezná,
 * se z verdiktu VYŘAZUJÍ. U první z nich ukazuje geolokace na nejbližší
 * PoP, ne na místo uložení dat; u druhé nemáme čím měřit. Počítat je jako
 * neúspěch by znamenalo, že verdikt nemůže vyjít kladně skoro nikdy —
 * běžný web načítá písma nebo skripty z nějaké CDN vždycky.
 *
 * Vyřazení není zamlčení: report obě skupiny vypisuje i s počty a
 * `residencyWarning` říká, kolik domén se posoudit dalo.
 *
 * Dřív se domény bez záznamu v databázi zahazovaly úplně — nedostaly se
 * ani do `locations`. Verdikt pak vyšel „splněno" i tehdy, když se
 * z osmi domén posoudila jedna, a nikde to nebylo vidět.
 */
function residencyVerdict(measured, nonEULocations, originMeasured) {
  if (nonEULocations.length > 0) return false;
  // Kladný verdikt smí stát JEN na doméně auditovaného webu.
  //
  // Bez téhle podmínky by stačilo, aby se nepodařilo umístit vlastní
  // server a zároveň se povedlo umístit nějakou cizí evropskou doménu —
  // třeba widget nebo písmo — a sken by prohlásil rezidenci za v pořádku.
  // Tvrzení o umístění dat provozovatele opřené o cizí server je přesně
  // ten druh závěru, který tenhle nástroj dělat nesmí.
  if (!originMeasured) return null;
  if (measured.length === 0) return null;
  return true;
}

/**
 * Skloňování počtu serverů.
 *
 * Text jde do dokumentu předkládaného úřadu. „Všech 1 posouzených serverů"
 * tam působí nedbale a nedbalost v tom, co jde ověřit na první pohled,
 * podrývá důvěru i v to, co ověřit nejde.
 */
function serveru(n) {
  if (n === 1) return 'jediný posouzený server je';
  if (n >= 2 && n <= 4) return `všechny ${n} posouzené servery jsou`;
  return `všech ${n} posouzených serverů je`;
}

function residencyWarning(totalDomains, measured, nonEULocations, cdnDomains, unlocatedDomains) {
  const vyrazeno = [];
  if (cdnDomains.length > 0) {
    vyrazeno.push(
      `${cdnDomains.length} běží za CDN, kde geolokace ukazuje na nejbližší PoP, `
      + 'ne na místo uložení dat — rezidenci u nich doloží smlouva s poskytovatelem, '
      + 'ne tohle měření'
    );
  }
  if (unlocatedDomains.length > 0) {
    vyrazeno.push(
      `u ${unlocatedDomains.length} nenašla geolokační databáze záznam k adrese`
    );
  }
  const poznamka = vyrazeno.length
    ? ` Z verdiktu vyřazeno: ${vyrazeno.join('; ')}.`
    : '';

  if (measured.length === 0) {
    return 'Umístění serverů se nepodařilo posoudit u žádné domény.' + poznamka;
  }
  if (nonEULocations.length > 0) {
    return `${nonEULocations.length} z ${measured.length} posouzených serverů je mimo EU/EHP `
      + `(celkem domén: ${totalDomains}).${poznamka}`;
  }
  const veta = serveru(measured.length);
  return `${veta.charAt(0).toUpperCase()}${veta.slice(1)} v EU/EHP `
    + `(celkem domén: ${totalDomains}).${poznamka}`;
}

/** Doplňková věta, když se nepodařilo umístit doménu auditovaného webu. */
function originNote(originMeasured, originHost, snapshot) {
  const chybiSnimek = !snapshot?.generatedAt
    ? ' Snímek IP rozsahů poskytovatelů cloudu není k dispozici, takže se '
      + 'vycházelo jen z geolokační databáze; ta u cloudových adres často '
      + 'neurčí nic. Obnovit ho lze příkazem `npm run update:cloud-ranges`.'
    : '';
  if (originMeasured) return chybiSnimek;
  return ` Doménu auditovaného webu (${originHost || 'neznámá'}) se umístit `
    + 'nepodařilo, takže o rezidenci dat provozovatele tenhle sken neříká nic '
    + '— posouzené domény patří jiným službám.' + chybiSnimek;
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
    const domainToCdn = new Map();

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

        // CDN se poznává z hlaviček TÉHLE odpovědi. Podle jména to nešlo:
        // proxovaná doména si svoje jméno nechává, takže se nepoznala.
        const cdn = detectCdn(urlObj.hostname, headers);
        if (cdn && !domainToCdn.has(urlObj.hostname)) {
          domainToCdn.set(urlObj.hostname, cdn);
        }

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

    // Doména auditovaného webu — na ní verdikt stojí.
    let originHost = null;
    try { originHost = new URL(page.url() || url).hostname; } catch { originHost = null; }
    let originMeasured = false;

    const cdnDomains = [];
    // Domény, ke kterým geolokační databáze nezná adresu. Dřív se tiše
    // zahazovaly, takže z osmi domén mohla být posouzená jedna a verdikt
    // přesto vyšel „splněno".
    const unlocatedDomains = [];
    // Domény, ze kterých se verdikt skutečně skládá.
    const measured = [];

    for (const [domain, ip] of domainToIp.entries()) {
      const cdn = domainToCdn.get(domain) || null;
      const geo = geoip.lookup(ip);
      // Nejdřív rozsahy poskytovatele: říká je ten, kdo datové centrum
      // provozuje, kdežto geolokační databáze jen odhaduje podle
      // registrace adresního bloku — a u cloudových rozsahů se plete.
      const cloud = lookupCloudIp(ip);

      // Anycast poznaný z rozsahů se řeší stejně jako CDN z hlaviček:
      // adresa odpovídá z nejbližšího uzlu, takže o umístění dat nic
      // neříká. Bez tohohle by CloudFront vyšel jako server v regionu.
      if (!cdn && cloud?.anycast) {
        const info = {
          domain, ip, country: null, onCdn: true,
          cdnProvider: `${cloud.provider} ${cloud.service || 'anycast'}`,
          cdnEvidence: `rozsah ${cloud.prefix} poskytovatele`,
        };
        cdnDomains.push(info);
        locations.push({ ...info, isEU: null });
        continue;
      }

      if (cdn) {
        // Za CDN se rezidence z IP určit nedá — ani kladně, ani záporně.
        // Zapisuje se i tak, aby bylo v reportu vidět, čeho se to týká.
        const info = { domain, ip, country: geo?.country ?? null, onCdn: true,
          cdnProvider: cdn.provider, cdnEvidence: cdn.evidence };
        cdnDomains.push(info);
        locations.push({ ...info, isEU: null });
        continue;
      }

      // Rozsah poskytovatele s určenou zemí přebíjí geolokaci.
      if (cloud?.country) {
        const isEU = eeaCountries.includes(cloud.country);
        const jeOrigin = domain === originHost;
        const locInfo = {
          domain, ip, country: cloud.country, isEU, onCdn: false, isOrigin: jeOrigin,
          source: 'rozsah poskytovatele',
          cloudProvider: cloud.provider,
          cloudRegion: cloud.region,
        };
        locations.push(locInfo);
        measured.push(locInfo);
        if (jeOrigin && isEU) originMeasured = true;
        if (!isEU) {
          nonEULocations.push(locInfo);
          if (cloud.country === 'US') usesUSServers = true;
        }
        continue;
      }

      // Adresa JE v rozsazích poskytovatele, ale region neumíme převést.
      //
      // Propadnout tady na geolokační databázi by bylo to nejhorší možné:
      // sáhli bychom po zdroji, jehož nespolehlivost u cloudových adres je
      // důvodem existence celého tohohle modulu. Ověřeno nad skutečným
      // snímkem — adresa 5.60.32.1 leží v aws ap-southeast-6, tedy podle
      // dokumentace AWS na Novém Zélandu, a geolokační databáze ji řadí do
      // Polska „s jistotou". Sken by z toho vydal kladné potvrzení
      // rezidence v EHP o serveru na druhé straně planety.
      //
      // Když poskytovatel adresu zná a my jeho region neumíme přeložit, je
      // to mezera v naší tabulce — a ta se řeší doplněním, ne odhadem.
      if (cloud) {
        unlocatedDomains.push({
          domain,
          ip,
          reason: cloud.anycast
            ? `rozsah ${cloud.prefix} je globální (${cloud.provider}), umístění dat z něj neplyne`
            : `${cloud.provider} uvádí region ${cloud.region || 'neuvedený'}, který neumíme převést na zemi`,
        });
        locations.push({ domain, ip, country: null, isEU: null, onCdn: false });
        continue;
      }

      // Nejen „záznam chybí", ale i „záznam nic neurčuje".
      //
      // Ověřeno na vlastní infrastruktuře: 4.223.166.194 je server v Azure
      // Sweden Central a databáze u něj vrací country US se souřadnicí
      // 37.751/-97.822, což je geografický střed USA, a poloměrem nejistoty
      // 1000 km. Sken z toho udělal doložené porušení GDPR u vlastního
      // provozovatele — a totéž by potkalo každého zákazníka na Azure.
      const kvalita = geoQuality(geo);
      if (!kvalita.usable) {
        unlocatedDomains.push({ domain, ip, reason: kvalita.reason });
        locations.push({ domain, ip, country: null, isEU: null, onCdn: false });
        continue;
      }

      const isEU = eeaCountries.includes(geo.country);
      const jeOrigin = domain === originHost;
      const locInfo = {
        domain, ip, country: geo.country, isEU, onCdn: false, isOrigin: jeOrigin,
        source: 'geolokační databáze',
      };
      locations.push(locInfo);
      measured.push(locInfo);
      if (jeOrigin && isEU) originMeasured = true;

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
        //
        // `cdnDomains` a `unlocatedDomains` říkají, co se z verdiktu
        // vyřadilo a proč. Bez nich by čtenář viděl jen výsledek a neměl
        // jak poznat, z kolika domén vznikl.
        cdnDomains,
        unlocatedDomains,
        measuredDomains: measured.length,
        // Stáří databáze patří do reportu. Bez něj je tvrzení o umístění
        // serveru nepřezkoumatelné: proti námitce „ten rozsah byl mezitím
        // přeregistrován" není čím argumentovat.
        geoipDatabaseDate: geoipDatabaseDate(),
        // Datum snímku rozsahů. Stejný důvod jako u geolokační databáze:
        // bez něj je tvrzení o umístění serveru nepřezkoumatelné.
        cloudRangesSnapshot: rangesSnapshot(),
        originHost,
        originMeasured,
        isEUCompliant: residencyVerdict(measured, nonEULocations, originMeasured),
        warning: residencyWarning(
          domainToIp.size, measured, nonEULocations, cdnDomains, unlocatedDomains
        ) + originNote(originMeasured, originHost, rangesSnapshot())
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

    // Stavový kód se posuzuje ze stejného důvodu jako u přístupnosti:
    // SBOM chybové stránky není SBOM webu. Následek je tu mírnější —
    // prázdný soupis dá neprůkazné — ale report by uváděl nepravdivý
    // důvod („stránka nenačetla žádný externí skript") místo skutečného.
    const navResponse = await page
      .goto(url, { waitUntil: 'networkidle' })
      .catch(() => null);
    const httpError = !navResponse
      ? 'Server neodpověděl.'
      : (!navResponse.ok() ? `Server odpověděl ${navResponse.status()}.` : null);

    // ── Zdroj 1: obsah stažených skriptů ───────────────────────────────────
    //
    // Tohle je ta část, která dřív chyběla. Detekce přes `window` u bundlované
    // aplikace nenajde nic, protože moderní bundler globály nevystavuje.
    const {
      findings: bundleFindings,
      sourceMapPackages,
      unreadable: scriptErrors,
      limits: bundleLimits,
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
        // Stropy, o kterých se dřív nikdo nedozvěděl.
        //
        // Skript nad 3 MB se prohledal jen zčásti a přesto se započítal
        // jako prohledaný; balíčky nad rozpočet ze source map se zahodily
        // beze stopy. Obojí posouvalo výsledek směrem k „bez nálezu",
        // protože ztracené položky by jinak skončily mezi neověřenými.
        truncatedScripts: bundleLimits?.truncatedScripts ?? [],
        droppedSourceMapPackages: bundleLimits?.droppedPackages ?? 0,
        // Bez tohohle pole by prázdný soupis dostal jako důvod „stránka
        // nenačetla žádný externí skript", i když stránka vrátila 403.
        httpError,
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

    // Nálezy se drží ODDĚLENĚ podle toho, co je doložilo.
    //
    // Uložená cookie nebo položka ve storage dokládá, že se něco uložilo.
    // Odchozí požadavek dokládá jen to, že se něco stáhlo — u webu se
    // správně nastaveným Consent Mode se kontejner načte, ale identifikátor
    // neodejde a nic se neuloží. Slévat obojí do jedné věty „aplikace
    // ukládá trackery" znamená tvrdit víc, než měření dokládá, a trestat
    // právě ty provozovatele, kteří souhlas řeší pečlivě.
    const storedItems = [];
    const requestItems = [];

    for (const cookie of cookies) {
      // Dřív se testovalo `c.includes('_ga')` na celém řetězci "název=hodnota",
      // takže se matchovala i hodnota cookie → falešná pozitiva.
      if (isTrackerCookieName(cookie.name)) {
        storedItems.push(`Cookie: ${cookie.name} (${cookie.domain})`);
      }
    }

    for (const [store, entries] of [['LS', storageData.localStorage], ['SS', storageData.sessionStorage]]) {
      for (const key of Object.keys(entries)) {
        if (isTrackerStorageKey(key)) {
          storedItems.push(`${store}: ${key}`);
        }
      }
    }

    for (const host of trackerRequestHosts) {
      requestItems.push(`Požadavek na tracking doménu: ${host}`);
    }

    const suspiciousFound = [...storedItems, ...requestItems];

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
        // Oddělené seznamy, aby report i spis ukázaly, čím je co doložené.
        storedItems,
        requestItems,
        isCompliant,
        // Seznam trackerů je nutně neúplný, takže "nic nenalezeno" neznamená
        // prokazatelný soulad — formulace to musí odrážet.
        rating: navigationError
          ? `NEPRŮKAZNÉ: Stránku se nepodařilo načíst (${navigationError}), takže nebylo co posoudit. Z toho neplyne, že trackery nejsou.`
          : isCompliant
            ? 'BEZ NÁLEZU: Před udělením souhlasu nebyly nalezeny trackery ze sledovaného seznamu. Nejde o důkaz plného souladu — seznam není vyčerpávající.'
            : storedItems.length > 0
              // Uložení je doložené: cookie nebo položka ve storage tam je.
              ? `NÁLEZ: Před udělením souhlasu jsou uložené trackery (${storedItems.length}).`
                + (requestItems.length > 0
                  ? ` Kromě toho odešly požadavky na ${requestItems.length} sledovaných domén.`
                  : '')
              // Doložený je jen odchozí požadavek. To NENÍ totéž co uložení:
              // web s Consent Mode kontejner načte, ale nic neuloží. Verdikt
              // proto zní jinak a mluví o tom, co se skutečně změřilo.
              : `NÁLEZ: Před udělením souhlasu odešly požadavky na ${requestItems.length} `
                + 'sledovaných domén. Neuložila se přitom žádná cookie ani položka '
                + 'do úložiště prohlížeče — samotné načtení skriptu porušením být '
                + 'nemusí, pokud nedošlo k předání identifikátoru. Posuďte, co ty '
                + 'požadavky nesly.'
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
    if (ev.httpError) {
      // Nejsilnější důvod jde první. Bez něj by report u stránky, která
      // vrátila 403, tvrdil, že web prostě nemá externí skripty.
      reason = ev.httpError.replace(/\.$/, '').toLowerCase();
    } else if (!ev.scriptsCaptured) {
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
        // `withdrawn` = záznam byl stažen (duplicita, omyl). Hlásit ho
        // jako platnou zranitelnost by byl nález bez podkladu.
        if (v.withdrawn) continue;

        const zavaznost = severityOf(v);
        vulnerabilities.push({
          library: lib.name,
          version: lib.version,
          cve: v.aliases?.find(a => a.startsWith('CVE-')) || v.id,
          details: v.details || v.summary || 'Bez popisu',
          // `null` znamená, že záznam závažnost neuvádí. Report to napíše
          // slovy; dřív se z toho stalo „HIGH".
          severity: zavaznost.label,
          severitySource: zavaznost.source,
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

/** Jen pro testy. */
export const __test__ = { determineNextAction };
