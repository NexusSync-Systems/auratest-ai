/**
 * Sjednocené volby pro spouštění Chromia.
 *
 * Vytaženo z `agent.js`, protože prohlížeč potřebuje i generátor PDF spisu.
 * Duplikovat tuhle logiku by znamenalo, že se jednou opraví na jednom místě
 * a na druhém zůstane — a rozdíl by se projevil až v produkci pádem
 * „Target closed" jen u jedné z obou cest.
 *
 * Importovat kvůli tomu `agent.js` nejde: tahá Playwright a celý řetěz
 * skenerů do každého procesu, který by chtěl jen vytisknout stránku.
 */

import { vynutHeadless } from './agent-limits.js';

/**
 * Argumenty navíc pro Chromium, z konfigurace serveru.
 *
 * Potřeba hlavně pro kontejnerová prostředí s malým /dev/shm (Cloud Run,
 * některé CI runnery), kde Chromium jinak padá na „Target closed" —
 * tam se nastavuje `BROWSER_ARGS=--disable-dev-shm-usage`.
 *
 * Bere se z prostředí, nikdy z requestu: argumenty prohlížeče umí vypnout
 * sandbox, takže je klient ovlivňovat nesmí.
 */
export function browserArgs() {
  return (process.env.BROWSER_ARGS || '')
    .split(',')
    .map((a) => a.trim())
    .filter(Boolean);
}

/**
 * Volby pro `chromium.launch()`.
 *
 * HEADLESS SE V PRODUKCI VYNUCUJE TADY, NE JEN U VOLAJÍCÍCH.
 *
 * Dřív stačilo `{ headless: true, ...extra }` — tedy `extra` přebilo
 * výchozí hodnotu a `headless: false` prošlo i v produkci. `server.js`
 * to na obou svých vstupech ošetřuje (`vynutHeadless`), jenže
 * `runAutonomousTest` je exportovaná: zavolat ji jde i mimo ně, třeba
 * ze skriptu nebo z CLI. Pak by se na serveru bez obrazovky spustil
 * prohlížeč s hlavou a běh by spadl na nesrozumitelné chybě — nebo,
 * hůř, doběhl v prostředí, o kterém report nic neříká.
 *
 * Je to stejná mezera jako ta, kterou měl tisk spisu u hlídače
 * navigace: ošetřeno všude kromě jednoho místa. Pravidlo proto stojí
 * tam, kudy prochází KAŽDÉ spuštění prohlížeče.
 *
 * Mimo produkci se `headless: false` respektuje — ladit s viditelným
 * oknem je legitimní.
 */
export function launchOptions(extra = {}) {
  return {
    ...extra,
    headless: vynutHeadless(extra.headless),
    args: [...browserArgs(), ...(extra.args || [])],
  };
}
