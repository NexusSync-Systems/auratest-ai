import fs from 'fs';
import path from 'path';

const DATASET_CLEANED_PATH = path.join(process.cwd(), 'auratest_dataset_cleaned.jsonl');
const DATASET_RAW_PATH = path.join(process.cwd(), 'auratest_dataset.jsonl');

const SYSTEM_PROMPT = `You are AuraTest AI, an expert QA testing agent performing a Smart Monkey Test.
Your goal: Explore EVERY part of the application. Click nav links to discover new pages. Fill forms. Try to break the app.
Prioritize: 1) Unvisited navigation links (A tags) to new pages, 2) Input fields with edge-case data, 3) Buttons you haven't clicked.
You must reply ONLY with a JSON object in this format:
{
  "reasoning": "Detailní vysvětlení, proč tento prvek vybíráš a co očekáváš.",
  "action": "click" | "type" | "scroll" | "navigate" | "wait" | "finish",
  "target": 123,
  "value": "text to type, or 'down'/'up' for scroll, or URL for navigate, else null",
  "detected_bugs": ["Konkrétní popis chyby: Co se stalo, co bylo očekáváno, kde (prvek/stránka)."]
}`;

// Definice expertních QA scénářů
const expertScenarios = [
  // 1. Zotavení z chyby validace (Typo recovery)
  {
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: 'Test Type: Smart AI Monkey Test\nCurrent URL: http://localhost:3000/login\nPage Title: Přihlášení\nInteractive elements:\n[{"id":1,"tag":"INPUT","type":"email","placeholder":"Váš e-mail"},{"id":2,"tag":"BUTTON","text":"Přihlásit se"}]\nRecent console logs: No errors.' },
      { role: 'assistant', content: '{\n  "reasoning": "Vyzkouším zadat e-mail ve špatném formátu (chybějící doména), abych otestoval, zda formulář správně validuje vstupy a zobrazí varování.",\n  "action": "type",\n  "target": 1,\n  "value": "neplatny-email@",\n  "detected_bugs": []\n}' }
    ]
  },
  {
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: 'Test Type: Smart AI Monkey Test\nCurrent URL: http://localhost:3000/login\nPage Title: Přihlášení\nInteractive elements:\n[{"id":1,"tag":"INPUT","type":"email","placeholder":"Váš e-mail"},{"id":2,"tag":"BUTTON","text":"Přihlásit se"},{"id":3,"tag":"SPAN","text":"Neplatný formát e-mailu"}]\nRecent console logs: No errors.\nHistory: Step 1: type target=1 value="neplatny-email@"' },
      { role: 'assistant', content: '{\n  "reasoning": "Formulář správně zobrazil validační chybovou hlášku \"Neplatný formát e-mailu\". Nyní zadám správný e-mail, abych mohl pokračovat v přihlašovacím procesu.",\n  "action": "type",\n  "target": 1,\n  "value": "test@example.com",\n  "detected_bugs": []\n}' }
    ]
  },
  // 2. Detekce a nahlášení kritického pádu (API 500 error)
  {
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: 'Test Type: Smart AI Monkey Test\nCurrent URL: http://localhost:3000/profile\nPage Title: Můj profil\nInteractive elements:\n[{"id":1,"tag":"BUTTON","text":"Uložit změny"}]\nRecent console logs: No errors.' },
      { role: 'assistant', content: '{\n  "reasoning": "Kliknu na tlačítko Uložit změny a ověřím, zda se profil úspěšně uloží na backendu.",\n  "action": "click",\n  "target": 1,\n  "value": null,\n  "detected_bugs": []\n}' }
    ]
  },
  {
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: 'Test Type: Smart AI Monkey Test\nCurrent URL: http://localhost:3000/profile\nPage Title: Můj profil\nInteractive elements:\n[{"id":1,"tag":"BUTTON","text":"Uložit změny"}]\nRecent network errors:\n[error] POST http://localhost:3000/api/profile 500 (Internal Server Error)\nRecent console logs:\n[error] Failed to update profile: Internal Server Error\nHistory: Step 1: click target=1' },
      { role: 'assistant', content: '{\n  "reasoning": "Při ukládání profilu došlo k chybě serveru 500. Zaznamenávám toto selhání jako bug do zprávy.",\n  "action": "finish",\n  "target": null,\n  "value": null,\n  "detected_bugs": ["Při pokusu o uložení profilu kliknutím na tlačítko Uložit změny (ID 1) vrátil server chybu 500 (Internal Server Error) na endpointu /api/profile."]\n}' }
    ]
  },
  // 3. Procházení skrytého obsahu pomocí scrollu
  {
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: 'Test Type: Smart AI Monkey Test\nCurrent URL: http://localhost:3000/articles\nPage Title: Články\nInteractive elements:\n[{"id":1,"tag":"A","text":"Přejít na hlavní stránku"}]\nRecent console logs: No errors.\nHistory: Step 1: click target=1 (failed/already tested)' },
      { role: 'assistant', content: '{\n  "reasoning": "Všechny viditelné prvky na této výšce stránky byly otestovány. Provedu scroll dolů (down), abych načetl další články přes lazy loading.",\n  "action": "scroll",\n  "target": null,\n  "value": "down",\n  "detected_bugs": []\n}' }
    ]
  },
  {
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: 'Test Type: Smart AI Monkey Test\nCurrent URL: http://localhost:3000/articles\nPage Title: Články\nInteractive elements:\n[{"id":1,"tag":"A","text":"Přejít na hlavní stránku"},{"id":2,"tag":"A","text":"Článek: Jak testovat s AI","href":"/articles/1"}]\nRecent console logs: No errors.\nHistory: Step 1: scroll value="down"' },
      { role: 'assistant', content: '{\n  "reasoning": "Scrollování úspěšně načetlo nový odkaz na článek. Kliknu na něj, abych otestoval detail článku.",\n  "action": "click",\n  "target": 2,\n  "value": null,\n  "detected_bugs": []\n}' }
    ]
  },
  // 4. Bezpečné vyplnění vícekrokového formuláře (E-shop objednávka)
  {
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: 'Test Type: Smart AI Monkey Test\nCurrent URL: http://localhost:3000/cart/checkout\nPage Title: Pokladna\nInteractive elements:\n[{"id":1,"tag":"INPUT","type":"text","placeholder":"Jméno a příjmení"},{"id":2,"tag":"INPUT","type":"text","placeholder":"Ulice a č.p."},{"id":3,"tag":"INPUT","type":"text","placeholder":"Město"},{"id":4,"tag":"INPUT","type":"text","placeholder":"PSČ"},{"id":5,"tag":"BUTTON","text":"Odeslat objednávku"}]\nRecent console logs: No errors.' },
      { role: 'assistant', content: '{\n  "reasoning": "Vyplním pole pro Jméno a příjmení standardní validní hodnotou pro test průchodu.",\n  "action": "type",\n  "target": 1,\n  "value": "Jan Novák",\n  "detected_bugs": []\n}' }
    ]
  },
  {
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: 'Test Type: Smart AI Monkey Test\nCurrent URL: http://localhost:3000/cart/checkout\nPage Title: Pokladna\nInteractive elements:\n[{"id":1,"tag":"INPUT","type":"text","placeholder":"Jméno a příjmení"},{"id":2,"tag":"INPUT","type":"text","placeholder":"Ulice a č.p."},{"id":3,"tag":"INPUT","type":"text","placeholder":"Město"},{"id":4,"tag":"INPUT","type":"text","placeholder":"PSČ"},{"id":5,"tag":"BUTTON","text":"Odeslat objednávku"}]\nHistory: Step 1: type target=1 value="Jan Novák"' },
      { role: 'assistant', content: '{\n  "reasoning": "Jméno je vyplněno. Nyní zadám fakturační ulici.",\n  "action": "type",\n  "target": 2,\n  "value": "Dlouhá 15",\n  "detected_bugs": []\n}' }
    ]
  },
  {
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: 'Test Type: Smart AI Monkey Test\nCurrent URL: http://localhost:3000/cart/checkout\nPage Title: Pokladna\nInteractive elements:\n[{"id":1,"tag":"INPUT","type":"text","placeholder":"Jméno a příjmení"},{"id":2,"tag":"INPUT","type":"text","placeholder":"Ulice a č.p."},{"id":3,"tag":"INPUT","type":"text","placeholder":"Město"},{"id":4,"tag":"INPUT","type":"text","placeholder":"PSČ"},{"id":5,"tag":"BUTTON","text":"Odeslat objednávku"}]\nHistory: Step 1: type target=1, Step 2: type target=2 value="Dlouhá 15"' },
      { role: 'assistant', content: '{\n  "reasoning": "Adresa ulice je vyplněna. Doplním město.",\n  "action": "type",\n  "target": 3,\n  "value": "Brno",\n  "detected_bugs": []\n}' }
    ]
  },
  {
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: 'Test Type: Smart AI Monkey Test\nCurrent URL: http://localhost:3000/cart/checkout\nPage Title: Pokladna\nInteractive elements:\n[{"id":1,"tag":"INPUT","type":"text","placeholder":"Jméno a příjmení"},{"id":2,"tag":"INPUT","type":"text","placeholder":"Ulice a č.p."},{"id":3,"tag":"INPUT","type":"text","placeholder":"Město"},{"id":4,"tag":"INPUT","type":"text","placeholder":"PSČ"},{"id":5,"tag":"BUTTON","text":"Odeslat objednávku"}]\nHistory: Step 1-2, Step 3: type target=3 value="Brno"' },
      { role: 'assistant', content: '{\n  "reasoning": "Město je vyplněno. Doplním PSČ.",\n  "action": "type",\n  "target": 4,\n  "value": "60200",\n  "detected_bugs": []\n}' }
    ]
  },
  {
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: 'Test Type: Smart AI Monkey Test\nCurrent URL: http://localhost:3000/cart/checkout\nPage Title: Pokladna\nInteractive elements:\n[{"id":1,"tag":"INPUT","type":"text","placeholder":"Jméno a příjmení"},{"id":2,"tag":"INPUT","type":"text","placeholder":"Ulice a č.p."},{"id":3,"tag":"INPUT","type":"text","placeholder":"Město"},{"id":4,"tag":"INPUT","type":"text","placeholder":"PSČ"},{"id":5,"tag":"BUTTON","text":"Odeslat objednávku"}]\nHistory: Step 1-3, Step 4: type target=4 value="60200"' },
      { role: 'assistant', content: '{\n  "reasoning": "Všechny údaje objednávky byly vyplněny. Kliknutím na tlačítko odešlu objednávku a dokončím nákup.",\n  "action": "click",\n  "target": 5,\n  "value": null,\n  "detected_bugs": []\n}' }
    ]
  },
  // 5. Výběr hodnoty z dropdownu (SELECT tag)
  {
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: 'Test Type: Smart AI Monkey Test\nCurrent URL: http://localhost:3000/cart/shipping\nPage Title: Doprava\nInteractive elements:\n[{"id":1,"tag":"SELECT","text":"Česká pošta (100 Kč) Zásilkovna (70 Kč)"},{"id":2,"tag":"BUTTON","text":"Pokračovat"}]\nRecent console logs: No errors.' },
      { role: 'assistant', content: '{\n  "reasoning": "Změním typ dopravy na Zásilkovnu, abych otestoval, zda se správně změní cena za dopravu v košíku.",\n  "action": "type",\n  "target": 1,\n  "value": "Zásilkovna (70 Kč)",\n  "detected_bugs": []\n}' }
    ]
  },
  // 6. Potvrzení dialogového okna (Confirmation alert)
  {
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: 'Test Type: Smart AI Monkey Test\nCurrent URL: http://localhost:3000/admin/users\nPage Title: Správa uživatelů\nInteractive elements:\n[{"id":1,"tag":"BUTTON","text":"Smazat účet test@example.com"}]\nRecent console logs: No errors.' },
      { role: 'assistant', content: '{\n  "reasoning": "Kliknu na tlačítko pro smazání účtu, což by mělo vyvolat potvrzovací dialogové okno.",\n  "action": "click",\n  "target": 1,\n  "value": null,\n  "detected_bugs": []\n}' }
    ]
  },
  {
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: 'Test Type: Smart AI Monkey Test\nCurrent URL: http://localhost:3000/admin/users\nPage Title: Správa uživatelů\nInteractive elements:\n[{"id":1,"tag":"BUTTON","text":"Smazat účet test@example.com"},{"id":2,"tag":"BUTTON","text":"Ano, opravdu smazat"}]\nRecent console logs: No errors.\nHistory: Step 1: click target=1' },
      { role: 'assistant', content: '{\n  "reasoning": "Stránka zobrazila potvrzovací dialogové okno. Kliknu na potvrzovací tlačítko, abych dokončil akci smazání.",\n  "action": "click",\n  "target": 2,\n  "value": null,\n  "detected_bugs": []\n}' }
    ]
  },
  // 7. Úspěšný přihlašovací průchod do dashboardu
  {
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: 'Test Type: Smart AI Monkey Test\nCurrent URL: http://localhost:3000/login\nPage Title: Přihlášení\nInteractive elements:\n[{"id":1,"tag":"INPUT","type":"text","placeholder":"Uživatelské jméno"},{"id":2,"tag":"INPUT","type":"password","placeholder":"Heslo"},{"id":3,"tag":"BUTTON","text":"Vstoupit"}]\nRecent console logs: No errors.' },
      { role: 'assistant', content: '{\n  "reasoning": "Zadám uživatelské jméno pro přihlášení do chráněné administrace.",\n  "action": "type",\n  "target": 1,\n  "value": "admin",\n  "detected_bugs": []\n}' }
    ]
  },
  {
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: 'Test Type: Smart AI Monkey Test\nCurrent URL: http://localhost:3000/login\nPage Title: Přihlášení\nInteractive elements:\n[{"id":1,"tag":"INPUT","type":"text","placeholder":"Uživatelské jméno"},{"id":2,"tag":"INPUT","type":"password","placeholder":"Heslo"},{"id":3,"tag":"BUTTON","text":"Vstoupit"}]\nRecent console logs: No errors.\nHistory: Step 1: type target=1 value="admin"' },
      { role: 'assistant', content: '{\n  "reasoning": "Uživatelské jméno je zadané, nyní zadám heslo.",\n  "action": "type",\n  "target": 2,\n  "value": "admin123",\n  "detected_bugs": []\n}' }
    ]
  },
  {
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: 'Test Type: Smart AI Monkey Test\nCurrent URL: http://localhost:3000/login\nPage Title: Přihlášení\nInteractive elements:\n[{"id":1,"tag":"INPUT","type":"text","placeholder":"Uživatelské jméno"},{"id":2,"tag":"INPUT","type":"password","placeholder":"Heslo"},{"id":3,"tag":"BUTTON","text":"Vstoupit"}]\nRecent console logs: No errors.\nHistory: Step 1: type target=1, Step 2: type target=2 value="admin123"' },
      { role: 'assistant', content: '{\n  "reasoning": "Kliknu na tlačítko Vstoupit pro odeslání přihlašovacího formuláře.",\n  "action": "click",\n  "target": 3,\n  "value": null,\n  "detected_bugs": []\n}' }
    ]
  },
  {
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: 'Test Type: Smart AI Monkey Test\nCurrent URL: http://localhost:3000/admin/dashboard\nPage Title: Administrační panel\nInteractive elements:\n[{"id":1,"tag":"BUTTON","text":"Odhlásit se"}]\nRecent console logs: No errors.\nHistory: Step 1-2, Step 3: click target=3' },
      { role: 'assistant', content: '{\n  "reasoning": "Přihlášení proběhlo úspěšně, vidím odhlašovací tlačítko. Přihlašovací proces byl plně otestován.",\n  "action": "finish",\n  "target": null,\n  "value": null,\n  "detected_bugs": []\n}' }
    ]
  }
];

function seed() {
  console.log('🌱 Načítám stávající dataset...');
  let existingLines: string[] = [];
  
  if (fs.existsSync(DATASET_CLEANED_PATH)) {
    existingLines = fs.readFileSync(DATASET_CLEANED_PATH, 'utf8')
      .split('\n')
      .filter(line => line.trim().length > 0);
  } else if (fs.existsSync(DATASET_RAW_PATH)) {
    existingLines = fs.readFileSync(DATASET_RAW_PATH, 'utf8')
      .split('\n')
      .filter(line => line.trim().length > 0);
  }

  console.log(`📊 Nalezeno ${existingLines.length} stávajících řádků.`);
  
  // Přidáme expertní scénáře na začátek nebo konec
  const newLines = [...existingLines];
  
  for (const scenario of expertScenarios) {
    const serialized = JSON.stringify(scenario);
    // Zamezíme duplikátům
    if (!newLines.includes(serialized)) {
      newLines.push(serialized);
    }
  }

  // Uložíme zaktualizovaný vyčištěný dataset
  fs.writeFileSync(DATASET_CLEANED_PATH, newLines.join('\n') + '\n', 'utf8');
  console.log(`✅ Vyčištěný dataset byl úspěšně obohacen o expertní QA scénáře! Nyní obsahuje ${newLines.length} položek.`);
}

seed();
