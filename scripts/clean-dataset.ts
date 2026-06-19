import fs from 'fs';
import path from 'path';

const datasetPath = path.join(process.cwd(), 'auratest_dataset.jsonl');
const outputPath = path.join(process.cwd(), 'auratest_dataset_cleaned.jsonl');

if (!fs.existsSync(datasetPath)) {
  console.error(`Chyba: Soubor datasetu nebyl nalezen na cestě: ${datasetPath}`);
  process.exit(1);
}

const content = fs.readFileSync(datasetPath, 'utf8');
const lines = content.split('\n').filter(l => l.trim() !== '');

console.log(`=== AuraTest Dataset Validator & Cleaner ===`);
console.log(`Načítám: ${datasetPath}`);
console.log(`Počet nalezených řádků: ${lines.length}`);

let cleanCount = 0;
let jsonErrorCount = 0;
let schemaErrorCount = 0;
let loopErrorCount = 0;

const actionStats: Record<string, number> = {
  click: 0,
  type: 0,
  scroll: 0,
  navigate: 0,
  wait: 0,
  finish: 0,
  unknown: 0
};

const cleanedLines: string[] = [];

lines.forEach((line, index) => {
  try {
    const row = JSON.parse(line);
    
    // Validace základní struktury zpráv
    if (!row.messages || !Array.isArray(row.messages)) {
      throw new Error(`Řádek ${index + 1}: Chybí nebo je neplatné pole 'messages'.`);
    }
    
    const systemMsg = row.messages.find((m: any) => m.role === 'system');
    const userMsg = row.messages.find((m: any) => m.role === 'user');
    const assistantMsg = row.messages.find((m: any) => m.role === 'assistant');
    
    if (!systemMsg || !userMsg || !assistantMsg) {
      throw new Error(`Řádek ${index + 1}: Chybí role system, user nebo assistant.`);
    }
    
    // Vyčištění a validace odpovědi asistenta (JSON)
    let cleanResponse = assistantMsg.content.trim();
    if (cleanResponse.startsWith('```')) {
      cleanResponse = cleanResponse.replace(/```json/g, '').replace(/```/g, '').trim();
    }
    
    let actionObj;
    try {
      actionObj = JSON.parse(cleanResponse);
    } catch (err: any) {
      jsonErrorCount++;
      console.warn(`[Řádek ${index + 1} - Chyba JSON]: Odpověď asistenta není validní JSON. Obsah: "${assistantMsg.content}"`);
      return; // Přeskočit neplatný řádek
    }
    
    // Validace schématu
    const requiredKeys = ['reasoning', 'action', 'target'];
    const hasRequired = requiredKeys.every(k => k in actionObj);
    if (!hasRequired) {
      schemaErrorCount++;
      console.warn(`[Řádek ${index + 1} - Chyba Schématu]: Chybí povinné klíče v JSONu: ${JSON.stringify(actionObj)}`);
      return; // Přeskočit neplatný řádek
    }
    
    const validActions = ['click', 'type', 'scroll', 'navigate', 'wait', 'finish'];
    if (!validActions.includes(actionObj.action)) {
      schemaErrorCount++;
      console.warn(`[Řádek ${index + 1} - Chyba Akce]: Neplatná akce "${actionObj.action}".`);
      return; // Přeskočit neplatný řádek
    }
    
    // Kontrola zacyklení (pokud model doporučil akci, která byla v promptu označena jako FAILED)
    const promptContent = userMsg.content;
    const actionSignature = `Action: ${actionObj.action}, Target: ${actionObj.target}`;
    if (promptContent.includes('FAILED ACTIONS MEMORY') && promptContent.includes(actionSignature)) {
      loopErrorCount++;
      console.warn(`[Řádek ${index + 1} - Chyba Zacyklení]: Model se pokusil o zakázanou akci z historie: "${actionSignature}"`);
      return; // Přeskočit zacyklenou akci
    }
    
    // Aktualizace statistik
    const act = actionObj.action || 'unknown';
    actionStats[act] = (actionStats[act] || 0) + 1;
    
    // Uložit zpět vyčištěný JSON bez markdown ohraničení
    assistantMsg.content = JSON.stringify(actionObj);
    cleanedLines.push(JSON.stringify(row));
    cleanCount++;
    
  } catch (err: any) {
    console.error(`[Řádek ${index + 1} - Chyba parsování]: ${err.message}`);
  }
});

fs.writeFileSync(outputPath, cleanedLines.join('\n') + '\n', 'utf8');

console.log(`\n=== Výsledky čištění ===`);
console.log(`Vyčištěné řádky zapsány: ${cleanCount} / ${lines.length} (${Math.round((cleanCount / lines.length) * 100)}%)`);
console.log(`JSON chyby (odstraněno): ${jsonErrorCount}`);
console.log(`Chyby schématu (odstraněno): ${schemaErrorCount}`);
console.log(`Zacyklené kroky (odstraněno): ${loopErrorCount}`);
console.log(`\n=== Distribuce akcí (Vyčištěno) ===`);
Object.entries(actionStats).forEach(([action, count]) => {
  if (count > 0) {
    console.log(`- ${action}: ${count}`);
  }
});
console.log(`\nVyčištěný dataset uložen do: ${outputPath}`);
