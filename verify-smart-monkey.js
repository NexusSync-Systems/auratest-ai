import path from 'path';
import { runAutonomousTest } from './agent.js';

const __dirname = path.resolve();

// Mock fetch globally to simulate the apfel/Ollama API
const originalFetch = globalThis.fetch;

let queryCount = 0;

globalThis.fetch = async (url, options) => {
  // Check if this is an AI completion request
  if (url.includes('/v1/chat/completions') || url.includes('/api/chat')) {
    queryCount++;
    console.log(`\n     [Mock LLM Server] Přijat požadavek na completion #${queryCount}`);
    
    const body = JSON.parse(options.body);
    const messages = body.messages || [];
    const systemPrompt = messages.find(m => m.role === 'system')?.content || '';
    const userPrompt = messages.find(m => m.role === 'user')?.content || '';

    console.log(`     [Mock LLM Server] Poskytovatel: apfel (OpenAI-compatible)`);
    console.log(`     [Mock LLM Server] Model: ${body.model}`);
    console.log(`     [Mock LLM Server] Režim zjištěn z promptu: ${systemPrompt.includes('Chytrý Monkey Test') ? 'SMART MONKEY' : 'STANDARD AI'}`);
    
    // Validate that the system prompt contains instructions for Smart Monkey Mode
    if (!systemPrompt.includes('Smart Monkey Test') || !systemPrompt.includes('chytrým způsobem prozkoumat')) {
      console.error('     [CHYBA] Systémový prompt neobsahuje instrukce pro Smart Monkey Test!');
      process.exit(1);
    }
    
    // Simulate smart decisions based on the current step
    let action = 'click';
    let target = 1; // click on label or input
    let value = null;
    let reasoning = 'Klikám na první interaktivní prvek pro zahájení průzkumu.';
    let detected_bugs = [];

    if (queryCount === 1) {
      reasoning = 'Vidím úvodní formulář. Kliknu na první pole (Jméno) a zkusím zadat vstup.';
      action = 'click';
      target = 2; // input field data-qa-id="2"
    } else if (queryCount === 2) {
      reasoning = 'Nyní napíšu do pole "Jméno" speciální znaky, abych otestoval validaci vstupu.';
      action = 'type';
      target = 2;
      value = 'Tester_@!#$Monkey';
    } else if (queryCount === 3) {
      reasoning = 'Odešlu formulář kliknutím na tlačítko "Odeslat data".';
      action = 'click';
      target = 3; // submit button data-qa-id="3"
      detected_bugs = ['Tlačítko odeslání vypadá vizuálně posunuté mimo formulář'];
    } else {
      reasoning = 'Formulář byl odeslán, průzkum je dokončen.';
      action = 'finish';
      target = null;
    }

    const mockResponse = {
      choices: [{
        message: {
          role: 'assistant',
          content: JSON.stringify({
            reasoning,
            action,
            target,
            value,
            detected_bugs
          })
        }
      }]
    };

    return {
      ok: true,
      status: 200,
      json: async () => mockResponse,
      text: async () => JSON.stringify(mockResponse)
    };
  }

  // Fallback to original fetch for any other URLs
  return originalFetch(url, options);
};

async function testSmartMonkey() {
  console.log('--- AuraTest AI: Zahájení testu Smart Monkey Mode ---');
  
  const testUrl = `file://${path.join(__dirname, 'test-sites', 'prod.html')}`;
  
  const config = {
    provider: 'apfel',
    model: 'apple-foundationmodel',
    host: 'http://localhost:11434/v1/chat/completions',
    headless: true,
    maxSteps: 4,
    mode: 'smart_monkey'
  };

  try {
    const result = await runAutonomousTest(testUrl, 'Chytré prohledávání', config, (stepInfo) => {
      console.log(`     - [Smart Monkey Krok ${stepInfo.step}] ${stepInfo.action} na prvek ${stepInfo.target} (Hodnota: ${stepInfo.value})`);
      console.log(`       Úvaha: ${stepInfo.reasoning}`);
    });

    console.log('\n--- Výsledky testu ---');
    console.log(`Úspěch: ${result.success ? 'ANO' : 'NE'}`);
    console.log(`Celkem kroků: ${result.steps.length}`);
    console.log(`Nalezené chyby (Bugs):`, result.bugs);

    if (result.steps.length !== 4) {
      throw new Error(`Očekávaly se 4 kroky, ale proběhlo ${result.steps.length}`);
    }

    if (result.bugs.length === 0 || !result.bugs[0].includes('posunuté mimo formulář')) {
      throw new Error('Chyba: Nepodařilo se zachytit očekávanou chybu nahlášenou AI.');
    }

    console.log('\n✓ Smart Monkey test s AI úspěšně prošel a ověřil integraci promtů, akcí i logování chyb!');
    process.exit(0);
  } catch (err) {
    console.error('✗ Smart Monkey test selhal:', err);
    process.exit(1);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

testSmartMonkey();
