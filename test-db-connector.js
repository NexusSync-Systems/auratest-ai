import { fetchTranslations } from './db-connector.js';

// Pozn.: dřív skript končil kódem 0 i když ochrana proti zápisovým dotazům
// selhala — nic se nevypsalo a nic nesignalizovalo problém. Sada validací
// z db-connector.js je řádně pokrytá v tests/utils.test.js; tenhle skript
// je jen ruční smoke check.
async function run() {
  let failures = 0;

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
      failures++;
    }
  }

  try {
    // Testing SQL validation logic for SQLite
    await fetchTranslations({
      type: 'sqlite',
      sqlitePath: './dummy.db',
      dbQuery: 'DELETE FROM users;'
    });
    // Sem se nesmíme dostat: znamenalo by to, že DELETE prošel validací.
    console.error('SELHÁNÍ: DELETE dotaz nebyl zamítnut!');
    failures++;
  } catch (e) {
    if (e.message.includes('Dovoleno je pouze čtení')) {
      console.log('SQL validation works: prevented DELETE query.');
    } else {
      console.error('Unexpected error:', e);
      failures++;
    }
  }

  if (failures > 0) {
    console.error(`\nSELHALO ${failures} kontrol.`);
    process.exit(1);
  }
  console.log('\nVšechny kontroly prošly.');
}

run().catch((err) => {
  console.error('Neošetřená chyba:', err);
  process.exit(1);
});
