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

/** Volby pro `chromium.launch()`. */
export function launchOptions(extra = {}) {
  return { headless: true, ...extra, args: [...browserArgs(), ...(extra.args || [])] };
}
