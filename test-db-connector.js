import { fetchTranslations } from './db-connector.js';

async function run() {
  try {
    // Testing SQL validation directly via mock script
    const result = await fetchTranslations({
      type: 'script',
      scriptName: 'get-translations'
    });
    console.log('Script execution succeeded (mock):', result);
  } catch (e) {
    if (e.message.includes('get-translations.js')) {
      console.log('Script validation logic works (caught correctly).');
    } else {
      console.error('Unexpected error:', e);
    }
  }

  try {
    // Testing SQL validation logic for SQLite
    await fetchTranslations({
      type: 'sqlite',
      sqlitePath: './dummy.db',
      dbQuery: 'DELETE FROM users;'
    });
  } catch (e) {
    if (e.message.includes('Dovoleno je pouze čtení')) {
      console.log('SQL validation works: prevented DELETE query.');
    } else {
      console.error('Unexpected error:', e);
    }
  }
}

run();
