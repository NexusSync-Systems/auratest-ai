/**
 * Ověření vygenerovaného Playwright testu v sandboxu.
 *
 * Agent ukládá do `generated-scripts/` spustitelný `.spec.ts`. Dosud ho
 * spouštěl jen uživatel u sebe (`npx playwright test`), tedy kód z LLM
 * a z obsahu cizí stránky na jeho stroji. Tady ho pouštíme v sandboxu
 * a vracíme, jestli test prošel.
 *
 * CO TO MĚŘÍ A CO NE
 * „Splněno" znamená: vygenerovaný test proti cílové stránce doběhl bez
 * chyby. Neznamená to, že je web v pořádku — test jen opakuje kroky,
 * které agent udělal. „Nesplněno" znamená, že test selhal (změněná stránka,
 * nestabilní selektor, chyba webu); důvod je ve výstupu.
 *
 * Cíl musí být veřejně dosažitelný. Sandbox běží v cloudu, takže
 * `localhost` nebo vnitřní adresa by v něm znamenala něco jiného než
 * u agenta — výsledek by měřil jiný stroj. Takový cíl je „neprůkazné".
 */

import { spustVSandboxu, sandboxConfig, SANDBOX_STAV } from './sandbox.js';
import { assertPublicHttpUrl } from './ssrf-guard.js';

export const NAZEV_SPEC = 'overeni.spec.ts';

/** První `page.goto(...)` ve vygenerovaném skriptu. Generátor ho píše jako JSON literál. */
export function cilSkriptu(spec) {
  const m = /page\.goto\(\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')\s*\)/.exec(String(spec || ''));
  if (!m) return null;
  const lit = m[1];
  try {
    return lit.startsWith('"') ? JSON.parse(lit) : lit.slice(1, -1).replace(/\\'/g, "'");
  } catch {
    return null;
  }
}

/** Verze Playwrightu bez prefixu `^`/`~`, aby sandbox jel na stejné jako projekt. */
export function verzePlaywright(rozsah) {
  const m = /(\d+\.\d+\.\d+)/.exec(String(rozsah || ''));
  return m ? m[1] : 'latest';
}

/**
 * Příkaz pro sandbox. Na šabloně „base" se Playwright i Chromium instalují
 * při každém běhu (minuta až dvě navíc, platí se). Šablona postavená
 * z obrazu `mcr.microsoft.com/playwright` je má předinstalované.
 */
export function prikazOvereni({ template, verze }) {
  const test = `npx playwright test ${NAZEV_SPEC} --reporter=line --workers=1`;
  if (template && template !== 'base') {
    return test;
  }
  return [
    'npm init -y >/dev/null',
    `npm install --no-audit --no-fund @playwright/test@${verze} >/dev/null`,
    'npx playwright install --with-deps chromium >/dev/null',
    test,
  ].join(' && ');
}

/**
 * @param {string} spec  obsah vygenerovaného .spec.ts
 * @param {object} [opts] `verzePlaywright`, `timeoutMs`
 * @param {object} [deps] pro testy: `env`, `loadSdk`, `assertPublic`
 */
export async function overSkriptVSandboxu(spec, opts = {}, deps = {}) {
  const env = deps.env || process.env;
  const cil = cilSkriptu(spec);
  if (!cil) {
    return { stav: SANDBOX_STAV.NEPRUKAZNE, cil: null, duvod: 'Ve skriptu chybí page.goto s cílovou adresou.' };
  }
  try {
    await (deps.assertPublic || assertPublicHttpUrl)(cil);
  } catch (e) {
    return {
      stav: SANDBOX_STAV.NEPRUKAZNE,
      cil,
      duvod: `Cíl není veřejně dosažitelný, ze sandboxu by se měřil jiný stroj: ${e.message}`,
    };
  }

  const cfg = sandboxConfig(env);
  const vysledek = await spustVSandboxu(
    {
      soubory: [{ cesta: NAZEV_SPEC, obsah: spec }],
      prikaz: prikazOvereni({ template: cfg.template, verze: verzePlaywright(opts.verzePlaywright) }),
      timeoutMs: opts.timeoutMs,
      envs: { CI: '1' },
    },
    { env, loadSdk: deps.loadSdk, now: deps.now },
  );
  return { ...vysledek, cil };
}
