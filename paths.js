/**
 * Sdílené cesty k adresářům s artefakty.
 *
 * Dřív zapisoval agent.js do `process.cwd()/{screenshots,videos,generated-scripts}`,
 * ale server.js servíroval `path.resolve()/{screenshots,videos}`. Při spuštění
 * serveru z jiného adresáře (systemd WorkingDirectory, `node /cesta/k/server.js`,
 * testy) to byla dvě různá místa a `/api/screenshots/...` vracelo 404.
 *
 * Kořen se hledá vyhledáním package.json směrem nahoru od aktuálního adresáře.
 * `import.meta.url` by bylo přímočařejší, ale jest transpiluje ESM na CJS přes
 * babel a `import.meta` v něm není dostupné — tohle řešení funguje v obou
 * režimech bez další závislosti.
 *
 * Kořen jde vynutit proměnnou AURAGUARD_ROOT.
 */
import path from 'path';
import fs from 'fs';

function findProjectRoot() {
  if (process.env.AURAGUARD_ROOT) {
    return path.resolve(process.env.AURAGUARD_ROOT);
  }

  let dir = process.cwd();
  for (let depth = 0; depth < 10; depth++) {
    const candidate = path.join(dir, 'package.json');
    if (fs.existsSync(candidate)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(candidate, 'utf8'));
        // Vyhneme se package.json frontendu nebo náhodného balíčku výš.
        if (pkg.name === 'auratest-ai') return dir;
      } catch {
        // nečitelný package.json — pokračuj výš
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // Fallback: i tak jsou všechny cesty odvozené ze stejného kořene, takže
  // zapisující a servírující strana zůstává konzistentní.
  return process.cwd();
}

export const PROJECT_ROOT = findProjectRoot();

export const SCREENSHOTS_DIR = path.join(PROJECT_ROOT, 'screenshots');
export const VIDEOS_DIR = path.join(PROJECT_ROOT, 'videos');
export const GENERATED_SCRIPTS_DIR = path.join(PROJECT_ROOT, 'generated-scripts');
export const SDK_DIR = path.join(PROJECT_ROOT, 'public', 'sdk');
export const FRONTEND_DIST_DIR = path.join(PROJECT_ROOT, 'frontend', 'dist');

/** Vytvoří adresář, pokud neexistuje, a vrátí jeho cestu. */
export function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * Očistí identifikátor použitý v názvu souboru. `sessionId` se u monitorů
 * skládá z hodnot uložených v DB, takže `../` v něm by zapsal PNG mimo
 * určený adresář.
 */
export function safeFileToken(value) {
  return String(value ?? '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 120) || 'unknown';
}
