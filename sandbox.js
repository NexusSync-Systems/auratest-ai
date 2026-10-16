/**
 * Spouštění kódu v izolovaném sandboxu (E2B, microVM Firecracker).
 *
 * PROČ
 * Agent vyrábí Playwright skripty (`generated-scripts/*.spec.ts`), jejichž
 * obsah pochází z LLM a z testované stránky. Spustit je na serveru nebo
 * u uživatele znamená pustit cizí kód k disku, `.env` i k vnitřní síti.
 * Sandbox běží mimo náš stroj, žije jen po dobu běhu a pak se zahodí.
 *
 * ZÁSADY
 *  • Bez sandboxu se NIC NESPOUŠTÍ LOKÁLNĚ. Chybějící konfigurace, klíč,
 *    SDK nebo výpadek služby = výsledek „neprůkazné", nikdy tichý fallback
 *    na `child_process`. Fallback by vrátil přesně to riziko, kvůli
 *    kterému sandbox existuje.
 *  • Do sandboxu nejde `process.env`. Proměnné prostředí se předávají jen
 *    výslovně (`envs`), takže se tam nedostane API klíč ani tajemství
 *    serveru.
 *  • Tři stavy jako všude v nástroji: příkaz doběhl s kódem 0 = splněno,
 *    nenulový kód = nesplněno, cokoli, co běh znemožnilo (timeout, výpadek,
 *    chybějící konfigurace) = neprůkazné.
 *  • Sandbox se vždy zabije ve `finally`, i když běh spadne — jinak se platí
 *    za každou sekundu do vypršení timeoutu.
 *
 * Konfigurace (jen z prostředí, nikdy z requestu):
 *   SANDBOX_PROVIDER     off (výchozí) | e2b
 *   E2B_API_KEY          klíč z console.e2b.dev
 *   E2B_DOMAIN           doména API; region (EU cluster) nastavuje podpora E2B
 *   SANDBOX_TEMPLATE     šablona sandboxu (výchozí „base")
 *   SANDBOX_TIMEOUT_MS   strop jednoho příkazu (výchozí 10 min, max 55 min)
 *   SANDBOX_INTERNET     1 (výchozí) | 0 — odchozí přístup na internet
 */

export const SANDBOX_STAV = Object.freeze({
  SPLNENO: 'splneno',
  NESPLNENO: 'nesplneno',
  NEPRUKAZNE: 'neprukazne',
});

export const VYCHOZI_TIMEOUT_MS = 10 * 60 * 1000;
// Hobby plán drží sandbox nejvýš hodinu; necháváme rezervu na vytvoření
// sandboxu a zápis souborů, aby příkaz neuřízl až limit platformy.
export const MAX_TIMEOUT_MS = 55 * 60 * 1000;
export const MIN_TIMEOUT_MS = 10 * 1000;
// Kolik výstupu vracíme. Zbytek se ořízne, aby log ze `npm install`
// nenafoukl report a databázi.
export const MAX_VYSTUP = 64 * 1024;
export const PRACOVNI_ADRESAR = '/home/user/auraguard-run';

const PROVIDERI = new Set(['off', 'e2b']);

export function omezTimeout(hodnota) {
  const n = Math.trunc(Number(hodnota));
  if (!Number.isFinite(n) || n <= 0) return VYCHOZI_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, n));
}

/** Konfigurace z prostředí. Klíč se nevrací, jen informace, že je nastavený. */
export function sandboxConfig(env = process.env) {
  const raw = String(env.SANDBOX_PROVIDER || 'off').trim().toLowerCase();
  const provider = PROVIDERI.has(raw) ? raw : 'off';
  return {
    provider,
    neznamyProvider: PROVIDERI.has(raw) ? null : raw,
    klicNastaven: Boolean(String(env.E2B_API_KEY || '').trim()),
    domain: String(env.E2B_DOMAIN || '').trim() || undefined,
    template: String(env.SANDBOX_TEMPLATE || '').trim() || 'base',
    timeoutMs: omezTimeout(env.SANDBOX_TIMEOUT_MS),
    internet: String(env.SANDBOX_INTERNET ?? '1').trim() !== '0',
  };
}

/**
 * Relativní cesta souboru uvnitř pracovního adresáře. Absolutní cesta
 * nebo `..` by zapisovaly mimo něj (třeba přes `~/.bashrc` sandboxu).
 */
export function bezpecnaCesta(cesta) {
  const s = String(cesta || '').replace(/\\/g, '/');
  if (!s || s.startsWith('/') || s.split('/').some((c) => c === '..' || c === '')) {
    throw new Error(`Neplatná cesta souboru pro sandbox: "${cesta}"`);
  }
  return `${PRACOVNI_ADRESAR}/${s}`;
}

function oriznout(text) {
  const s = String(text ?? '');
  if (s.length <= MAX_VYSTUP) return s;
  return `${s.slice(0, MAX_VYSTUP)}\n… [oříznuto, celkem ${s.length} znaků]`;
}

/** Klíč nesmí odejít v chybové hlášce do reportu ani do logu. */
function bezKlice(text, env) {
  const klic = String(env.E2B_API_KEY || '').trim();
  const s = String(text ?? '');
  return klic ? s.split(klic).join('[E2B_API_KEY]') : s;
}

function neprukazne(provider, duvod, extra = {}) {
  return {
    stav: SANDBOX_STAV.NEPRUKAZNE,
    provider,
    exitCode: null,
    stdout: '',
    stderr: '',
    trvaniMs: 0,
    duvod,
    ...extra,
  };
}

async function nactiE2bSdk() {
  const mod = await import('e2b');
  return mod.Sandbox ? mod : mod.default;
}

/**
 * Spustí příkaz v čerstvém sandboxu.
 *
 * @param {object} uloha
 * @param {{cesta: string, obsah: string}[]} [uloha.soubory]  zapíšou se do pracovního adresáře
 * @param {string} uloha.prikaz      shellový příkaz, běží v pracovním adresáři
 * @param {number} [uloha.timeoutMs] strop příkazu (omezí se na MIN–MAX)
 * @param {Record<string,string>} [uloha.envs] proměnné jen pro tento běh
 * @param {object} [deps] pro testy: `env`, `loadSdk`, `now`
 */
export async function spustVSandboxu(uloha, deps = {}) {
  const env = deps.env || process.env;
  const now = deps.now || Date.now;
  const cfg = sandboxConfig(env);

  if (cfg.neznamyProvider) {
    return neprukazne('off', `Neznámý SANDBOX_PROVIDER "${cfg.neznamyProvider}" — povolené jsou off a e2b. Nic se nespustilo.`);
  }
  if (cfg.provider === 'off') {
    return neprukazne('off', 'Sandbox je vypnutý (SANDBOX_PROVIDER=off). Kód se lokálně nespouští.');
  }
  if (!cfg.klicNastaven) {
    return neprukazne('e2b', 'Chybí E2B_API_KEY. Nic se nespustilo.');
  }
  const prikaz = String(uloha?.prikaz || '').trim();
  if (!prikaz) throw new Error('Chybí příkaz pro sandbox.');

  let soubory;
  try {
    soubory = (uloha.soubory || []).map((f) => ({ cesta: bezpecnaCesta(f.cesta), obsah: String(f.obsah ?? '') }));
  } catch (e) {
    return neprukazne('e2b', e.message);
  }

  let sdk;
  try {
    sdk = await (deps.loadSdk || nactiE2bSdk)();
  } catch (e) {
    return neprukazne('e2b', `Balíček e2b není nainstalovaný (npm install e2b): ${e.message}`);
  }

  const timeoutMs = uloha.timeoutMs ? omezTimeout(uloha.timeoutMs) : cfg.timeoutMs;
  const start = now();
  let sandbox;
  try {
    sandbox = await sdk.Sandbox.create(cfg.template, {
      apiKey: String(env.E2B_API_KEY).trim(),
      domain: cfg.domain,
      // Sandbox přežije příkaz o minutu, aby šel výstup dočíst; zabíjí
      // se ale ve `finally` hned po doběhnutí.
      timeoutMs: timeoutMs + 60 * 1000,
      allowInternetAccess: cfg.internet,
      metadata: { app: 'auraguard' },
    });

    for (const f of soubory) {
      await sandbox.files.write(f.cesta, f.obsah);
    }

    let vysledek;
    try {
      vysledek = await sandbox.commands.run(prikaz, {
        cwd: PRACOVNI_ADRESAR,
        timeoutMs,
        envs: { ...(uloha.envs || {}) },
      });
    } catch (e) {
      // SDK hází CommandExitError při nenulovém kódu. Ten má výsledek
      // v sobě — je to „nesplněno", ne selhání běhu.
      if (e && typeof e.exitCode === 'number') {
        vysledek = { exitCode: e.exitCode, stdout: e.stdout, stderr: e.stderr };
      } else {
        throw e;
      }
    }

    const exitCode = Number(vysledek.exitCode);
    return {
      stav: exitCode === 0 ? SANDBOX_STAV.SPLNENO : SANDBOX_STAV.NESPLNENO,
      provider: 'e2b',
      exitCode,
      stdout: oriznout(vysledek.stdout),
      stderr: oriznout(vysledek.stderr),
      trvaniMs: now() - start,
      sandboxId: sandbox.sandboxId || null,
      duvod: null,
    };
  } catch (e) {
    const timeout = e?.name === 'TimeoutError' || /timeout|deadline/i.test(String(e?.message));
    return neprukazne(
      'e2b',
      bezKlice(`${timeout ? 'Běh v sandboxu vypršel' : 'Sandbox selhal'}: ${e?.message || e}`, env),
      { trvaniMs: now() - start, sandboxId: sandbox?.sandboxId || null },
    );
  } finally {
    if (sandbox) {
      await sandbox.kill().catch(() => {});
    }
  }
}
