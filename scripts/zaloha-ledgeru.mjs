#!/usr/bin/env node
/**
 * Spouštěč zálohy řetězu důkazů. Rozhodování je v `ledger-zaloha.js`,
 * aby šlo otestovat — `import.meta` v testech babel nepřeloží, takže
 * cokoli v tomhle souboru je mimo dosah testů a musí zůstat triviální.
 *
 * Viz hlavička `ledger-zaloha.js` pro použití a návratové kódy.
 */
import { rozborArgumentu, zalohuj, overSnimek } from '../ledger-zaloha.js';

const volby = rozborArgumentu(process.argv.slice(2));
try {
  if (volby.overit) {
    const v = overSnimek(volby.overit);
    console.log(`Snímek z ${v.manifest.porizeno}, hlava ${v.manifest.hlava}, `
      + `${v.manifest.zaznamu} záznamů.`);
    if (v.ok) { console.log('✅ Otisky souhlasí a řetěz v kopii drží.'); process.exit(0); }
    console.error('❌ Snímek neprošel:');
    v.rozpory.forEach((r) => console.error(`  • ${r}`));
    process.exit(2);
  }

  const v = zalohuj(volby);
  if (v.suchy) {
    console.log(`[suchý běh] Zapsal bych ${v.cilovy} (${v.zaznamu} záznamů).`);
    process.exit(0);
  }
  console.log(`Záloha: ${v.cilovy} (${v.zaznamu} záznamů).`);
  if (v.smazano.length) console.log(`Smazáno starých snímků: ${v.smazano.length}.`);
  if (!v.chainOk) {
    console.error('⚠️  ŘETĚZ NEPROŠEL KONTROLOU. Záloha je pořízená (důkaz o stavu '
      + 'se nesmí zahodit), ale stav vyžaduje pozornost — viz manifest.json.');
    process.exit(2);
  }
  console.log('✅ Řetěz neporušený.');
  process.exit(0);
} catch (err) {
  console.error(`Záloha selhala: ${err.message}`);
  process.exit(1);
}
