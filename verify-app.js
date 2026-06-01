import path from 'path';
import { runAutonomousTest, comparePages, auditTranslations } from './agent.js';
import { fetchTranslations } from './db-connector.js';

const __dirname = path.resolve();

async function runVerification() {
  console.log('--- AuraTest AI: Zahájení ověřovacích testů ---');

  const prodUrl = `file://${path.join(__dirname, 'test-sites', 'prod.html')}`;
  const previewUrl = `file://${path.join(__dirname, 'test-sites', 'preview.html')}`;

  console.log('1. Testování srovnávače stránek (Prod vs Preview Diff)...');
  try {
    const diffResult = await comparePages(prodUrl, previewUrl);
    
    if (!diffResult.success) {
      throw new Error(`Porovnání selhalo: ${diffResult.error}`);
    }

    console.log('   ✓ Úspěšně získána data o srovnání.');
    console.log(`   ✓ Nalezeno změn: ${diffResult.diffs.length}`);

    // Print out the differences found to verify correctness
    diffResult.diffs.forEach((d) => {
      console.log(`     - [Změna: ${d.type.toUpperCase()}] na '${d.selector}':`);
      if (d.type === 'modified') {
        console.log(`       Původní: "${d.oldText}"`);
        console.log(`       Nový:    "${d.newText}"`);
      } else if (d.type === 'added') {
        console.log(`       Přidáno:  "${d.newText}"`);
      } else if (d.type === 'removed') {
        console.log(`       Smazáno:  "${d.oldText}"`);
      }
    });

    if (diffResult.diffs.length === 0) {
      throw new Error('Chyba: Nebyly nalezeny žádné změny v textu, i když by tam měly být!');
    }

  } catch (err) {
    console.error('   ✗ Test srovnávače selhal:', err);
    process.exit(1);
  }

  console.log('\n2. Testování připojení k SQLite a načítání překladů...');
  let dictionary = {};
  try {
    const sqliteConfig = {
      type: 'sqlite',
      sqlitePath: path.join(__dirname, 'locales.sqlite'),
      dbQuery: 'SELECT key_name as key, translation_value as value FROM translations'
    };

    dictionary = await fetchTranslations(sqliteConfig);
    console.log(`   ✓ Úspěšně načteno ${Object.keys(dictionary).length} překladů z SQLite.`);
    console.log('     Obsah:', JSON.stringify(dictionary, null, 2));

    if (!dictionary['app.title']) {
      throw new Error('Chyba: V databázi chybí klíč "app.title"!');
    }
  } catch (err) {
    console.error('   ✗ Test SQLite selhal:', err);
    process.exit(1);
  }

  console.log('\n3. Testování lokalizačního auditu (bez AI hodnocení pro 100% shody)...');
  try {
    const llmConfig = { model: 'llama3', host: 'http://localhost:11434' };
    const auditResult = await auditTranslations(prodUrl, dictionary, llmConfig);

    if (!auditResult.success) {
      throw new Error(`Audit selhal: ${auditResult.error}`);
    }

    console.log(`   ✓ Úspěšně zkontrolováno ${auditResult.results.length} textů.`);
    
    // Find matched elements
    const matched = auditResult.results.filter(r => r.status === 'matched');
    console.log(`   ✓ Počet přesně spárovaných prvků: ${matched.length}`);
    matched.forEach(m => {
      console.log(`     - Spárováno: "${m.text}" -> Klíč: ${m.key}`);
    });

    if (matched.length === 0) {
      throw new Error('Chyba: Nebyly nalezeny žádné shody v překladech na produkční stránce!');
    }

  } catch (err) {
    console.error('   ✗ Test lokalizačního auditu selhal:', err);
    process.exit(1);
  }

  console.log('\n4. Testování lokálního průzkumného monkey testování (Monkey Mode)...');
  try {
    const monkeyConfig = {
      mode: 'monkey',
      headless: true,
      maxSteps: 3
    };
    const monkeyResult = await runAutonomousTest(prodUrl, 'Průzkumný test', monkeyConfig, (stepInfo) => {
      console.log(`     - [Monkey Krok ${stepInfo.step}] ${stepInfo.action} (Úvaha: ${stepInfo.reasoning})`);
    });

    if (monkeyResult.steps.length === 0) {
      throw new Error('Chyba: Monkey test neprovedl žádné kroky!');
    }

    console.log(`   ✓ Monkey test úspěšně proběhl (kroků: ${monkeyResult.steps.length}).`);
  } catch (err) {
    console.error('   ✗ Test Monkey režimu selhal:', err);
    process.exit(1);
  }

  console.log('\n--- Všechny lokální ověřovací testy byly úspěšně dokončeny! ---');
}

runVerification();
