import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const DATASET_CLEANED_PATH = path.join(process.cwd(), 'auratest_dataset_cleaned.jsonl');
const DATASET_RAW_PATH = path.join(process.cwd(), 'auratest_dataset.jsonl');
const MODELFILE_PATH = path.join(process.cwd(), 'auratest-gemma2.Modelfile');

const SYSTEM_PROMPT = `You are AuraTest AI — a JSON-only QA testing agent. You analyze web pages and output a single JSON action object.

CRITICAL RULES (follow EXACTLY or the test will fail):
1. Reply ONLY with a single valid JSON object. No markdown, no explanation text outside JSON.
2. JSON format MUST be exactly:
   {"reasoning": "string", "action": "click|type|scroll|navigate|wait|finish", "target": NUMBER_or_NULL, "value": "string_or_null", "detected_bugs": ["string"]}
3. "action" MUST be one of: click, type, scroll, navigate, wait, finish
4. "target" for click/type MUST be a number (data-qa-id) from the elements list. NEVER a string.
5. "target" for navigate MUST be a full URL string starting with "http". NEVER a number.
6. "target" for scroll/wait/finish MUST be null.
7. "value" for scroll MUST be "down" or "up".
8. NEVER repeat an action+target combination you already used.
9. If you see INPUT or TEXTAREA elements, use "type" action with test data.
10. All "reasoning" and "detected_bugs" text MUST be in Czech (Čeština).
11. If there are no errors, console logs, or network failures on the page, the "detected_bugs" array MUST be empty []. Never copy your reasoning or description into it.

EXPLORATION STRATEGY:
- Priority 1: Click navigation links (A tags) to visit new pages
- Priority 2: Fill input fields with edge-case data (empty, very long, special chars)  
- Priority 3: Click buttons not yet tested
- Use "finish" only when you've tested all visible elements`;

interface ChatMLMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface DatasetItem {
  messages: ChatMLMessage[];
}

function loadDataset(): DatasetItem[] {
  let filePath = DATASET_CLEANED_PATH;
  if (!fs.existsSync(filePath)) {
    filePath = DATASET_RAW_PATH;
  }
  if (!fs.existsSync(filePath)) {
    return [];
  }

  const fileContent = fs.readFileSync(filePath, 'utf8');
  return fileContent
    .split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => {
      try {
        return JSON.parse(line) as DatasetItem;
      } catch (e) {
        return null;
      }
    })
    .filter((item): item is DatasetItem => item !== null);
}

function buildModelfile() {
  console.log('🔄 Načítám nahraný tréninkový dataset...');
  const items = loadDataset();
  console.log(`📊 Celkem nalezeno ${items.length} konverzací v datasetu.`);

  // Pokud nemáme žádná data, použijeme výchozí fixní příklady
  let fewShotMessages = '';

  if (items.length > 0) {
    console.log('🧠 Klasifikuji a vybírám nejlepší příklady pro few-shot učení...');

    // Skupiny pro vyvážený výběr
    const categories: Record<string, DatasetItem[]> = {
      click_link: [],
      click_button: [],
      type: [],
      scroll: [],
      navigate: [],
      bug: []
    };

    for (const item of items) {
      const userMsg = item.messages.find(m => m.role === 'user');
      const assistantMsg = item.messages.find(m => m.role === 'assistant');

      if (!userMsg || !assistantMsg) continue;

      try {
        const reply = JSON.parse(assistantMsg.content);
        const action = reply.action;
        const target = reply.target;
        const detectedBugs = reply.detected_bugs || [];

        if (detectedBugs.length > 0) {
          categories.bug.push(item);
          continue;
        }

        if (action === 'type') {
          categories.type.push(item);
        } else if (action === 'scroll') {
          categories.scroll.push(item);
        } else if (action === 'navigate') {
          categories.navigate.push(item);
        } else if (action === 'click') {
          // Zkusíme zjistit, zda šlo o odkaz nebo tlačítko
          const userText = userMsg.content;
          const isButton = userText.includes(`"id":${target},"tag":"BUTTON"`) || 
                         userText.includes(`"id":${target},"tagName":"BUTTON"`) ||
                         userText.toLowerCase().includes('tlačítko') ||
                         userText.toLowerCase().includes('button');
          if (isButton) {
            categories.click_button.push(item);
          } else {
            categories.click_link.push(item);
          }
        }
      } catch (e) {
        // Ignorujeme nevalidní JSONy v datasetu
      }
    }

    // Vybereme z každé kategorie maximálně 2 reprezentativní příklady
    const selectedItems: DatasetItem[] = [];
    const maxPerCategory = 2;

    for (const cat of Object.keys(categories)) {
      const catItems = categories[cat];
      console.log(`  - Kategorie "${cat}": ${catItems.length} příkladů`);
      // Vezmeme první maxPerCategory příklady
      selectedItems.push(...catItems.slice(0, maxPerCategory));
    }

    // Pokud nemáme dostatek vyvážených dat, doplníme cokoli zbývá
    if (selectedItems.length < 4 && items.length > 0) {
      for (const item of items) {
        if (!selectedItems.includes(item)) {
          selectedItems.push(item);
          if (selectedItems.length >= 6) break;
        }
      }
    }

    console.log(`🎯 Vybráno ${selectedItems.length} vzorových interakcí do Modelfilu.`);

    // Zformátujeme vybrané příklady do Modelfile syntaxe
    for (const item of selectedItems) {
      const userMsg = item.messages.find(m => m.role === 'user');
      const assistantMsg = item.messages.find(m => m.role === 'assistant');
      if (userMsg && assistantMsg) {
        fewShotMessages += `\n# Příklad z nahraných dat\n`;
        fewShotMessages += `MESSAGE user """${userMsg.content.replace(/"{3}/g, '\\"\\"\\""')}"""\n`;
        fewShotMessages += `MESSAGE assistant """${assistantMsg.content.replace(/"{3}/g, '\\"\\"\\""')}"""\n`;
      }
    }
  } else {
    console.log('⚠️ Dataset je prázdný. Budou použity výchozí statické příklady.');
    // Výchozí few-shot příklad pro případ, že nemáme nahraná žádná data
    fewShotMessages = `
# Příklad 1: kliknutí na tlačítko
MESSAGE user """Current URL: http://localhost:3000
Page Title: Dashboard

Elements: [{"id":1,"tagName":"A","text":"Dashboard","href":"/dashboard"},{"id":2,"tagName":"A","text":"Settings","href":"/settings"},{"id":3,"tagName":"BUTTON","text":"New Item","type":"button"}]

Console logs: No errors.
History: No previous steps.
FAILED: None."""

MESSAGE assistant """{"reasoning": "Začínám průzkum. Vidím navigační odkaz 'Settings' na nové stránce. Kliknu na něj jako první, protože průzkum nových stránek má nejvyšší prioritu.", "action": "click", "target": 2, "value": null, "detected_bugs": []}"""

# Příklad 2: type do inputu
MESSAGE user """Current URL: http://localhost:3000/settings
Page Title: Settings

Elements: [{"id":1,"tagName":"INPUT","text":"","type":"text","placeholder":"Zadejte jméno"},{"id":2,"tagName":"INPUT","text":"","type":"email","placeholder":"Email"},{"id":3,"tagName":"BUTTON","text":"Uložit","type":"submit"}]

Console logs: No errors.
History: Step 1 [/]: click target=2
FAILED: None."""

MESSAGE assistant """{"reasoning": "Vidím vstupní pole pro jméno. Otestuji ho s prázdnou hodnotou a poté s velmi dlouhým textem, abych zjistil, zda aplikace správně validuje vstupy.", "action": "type", "target": 1, "value": "", "detected_bugs": []}"""
`;
  }

  // Sestavení kompletního Modelfile
  const modelfileContent = `FROM gemma2:2b

# Nízká teplota = konzistentní, deterministické JSON výstupy
PARAMETER temperature 0.05
PARAMETER top_p 0.9
PARAMETER top_k 20
PARAMETER num_predict 512
PARAMETER repeat_penalty 1.2
PARAMETER num_ctx 8192

SYSTEM """${SYSTEM_PROMPT}"""
${fewShotMessages}
`;

  fs.writeFileSync(MODELFILE_PATH, modelfileContent, 'utf8');
  console.log(`💾 Modelfile byl úspěšně zapsán do: ${MODELFILE_PATH}`);
}

function runOllamaCreate() {
  console.log('🚀 Spouštím kompilaci modelu v Ollamě: "ollama create auratest-gemma2 -f ./auratest-gemma2.Modelfile"...');
  try {
    const stdout = execSync(`ollama create auratest-gemma2 -f "${MODELFILE_PATH}"`, { encoding: 'utf8' });
    console.log('✅ Model byl úspěšně sestaven a nahrán do Ollamy!');
    console.log(stdout);
  } catch (err: any) {
    console.error('❌ Chyba při kompilaci v Ollamě:', err.message);
    if (err.stdout) console.log(err.stdout);
    if (err.stderr) console.error(err.stderr);
    process.exit(1);
  }
}

// Spuštění
buildModelfile();
runOllamaCreate();
