/**
 * Sandbox pro spouštění kódu (E2B).
 *
 * PROČ TENHLE TEST EXISTUJE
 * Hlavní slib modulu je negativní: když sandbox není k dispozici, NIC se
 * nespustí lokálně a výsledek je „neprůkazné". Tichý fallback na
 * `child_process` by vrátil přesně to riziko, kvůli kterému sandbox
 * existuje. Druhý slib: do sandboxu neodchází `process.env` ani API klíč.
 *
 * Skutečné E2B se tu nevolá — SDK je podvržené přes `loadSdk`.
 */
import {
  spustVSandboxu,
  sandboxConfig,
  bezpecnaCesta,
  omezTimeout,
  SANDBOX_STAV,
  VYCHOZI_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
  MAX_VYSTUP,
  PRACOVNI_ADRESAR,
} from '../sandbox.js';
import {
  overSkriptVSandboxu,
  cilSkriptu,
  verzePlaywright,
  prikazOvereni,
  NAZEV_SPEC,
} from '../sandbox-overeni.js';

const KLIC = 'e2b_tajny_klic_123';
const ENV_E2B = { SANDBOX_PROVIDER: 'e2b', E2B_API_KEY: KLIC };

function falesneSdk({ run, create } = {}) {
  const zaznam = { create: null, zapisy: [], run: null, killed: 0 };
  const sandbox = {
    sandboxId: 'sbx_1',
    files: { write: async (cesta, obsah) => { zaznam.zapisy.push({ cesta, obsah }); } },
    commands: {
      run: async (prikaz, opts) => {
        zaznam.run = { prikaz, opts };
        return run ? run(prikaz, opts) : { exitCode: 0, stdout: 'ok', stderr: '' };
      },
    },
    kill: async () => { zaznam.killed += 1; },
  };
  const sdk = {
    Sandbox: {
      create: async (template, opts) => {
        zaznam.create = { template, opts };
        if (create) return create(template, opts);
        return sandbox;
      },
    },
  };
  return { sdk, zaznam, loadSdk: async () => sdk };
}

describe('sandboxConfig', () => {
  test('výchozí je vypnuto, šablona base, 10 minut, internet ano', () => {
    const c = sandboxConfig({});
    expect(c.provider).toBe('off');
    expect(c.template).toBe('base');
    expect(c.timeoutMs).toBe(VYCHOZI_TIMEOUT_MS);
    expect(c.internet).toBe(true);
    expect(c.klicNastaven).toBe(false);
  });

  test('klíč se v konfiguraci nevrací, jen příznak', () => {
    const c = sandboxConfig(ENV_E2B);
    expect(JSON.stringify(c)).not.toContain(KLIC);
    expect(c.klicNastaven).toBe(true);
  });

  test('SANDBOX_INTERNET=0 vypne internet', () => {
    expect(sandboxConfig({ SANDBOX_INTERNET: '0' }).internet).toBe(false);
  });
});

describe('omezTimeout', () => {
  test('nesmysl padne na výchozí, extrémy se usekají', () => {
    expect(omezTimeout(undefined)).toBe(VYCHOZI_TIMEOUT_MS);
    expect(omezTimeout('spousta')).toBe(VYCHOZI_TIMEOUT_MS);
    expect(omezTimeout(-5)).toBe(VYCHOZI_TIMEOUT_MS);
    expect(omezTimeout(1)).toBe(MIN_TIMEOUT_MS);
    expect(omezTimeout(10 * 60 * 60 * 1000)).toBe(MAX_TIMEOUT_MS);
  });
});

describe('bezpecnaCesta', () => {
  test('relativní cesta skončí v pracovním adresáři', () => {
    expect(bezpecnaCesta('a/b.ts')).toBe(`${PRACOVNI_ADRESAR}/a/b.ts`);
  });

  test.each(['/etc/passwd', '../x', 'a/../../x', '', 'a//b', '..\\x'])('odmítne „%s"', (c) => {
    expect(() => bezpecnaCesta(c)).toThrow();
  });
});

describe('spustVSandboxu — bez sandboxu se nic nespustí', () => {
  test('vypnuto → neprůkazné, SDK se ani nenačte', async () => {
    const loadSdk = jest.fn();
    const v = await spustVSandboxu({ prikaz: 'echo x' }, { env: {}, loadSdk });
    expect(v.stav).toBe(SANDBOX_STAV.NEPRUKAZNE);
    expect(loadSdk).not.toHaveBeenCalled();
  });

  test('neznámý provider (třeba „local") se nebere jako lokální běh', async () => {
    const loadSdk = jest.fn();
    const v = await spustVSandboxu({ prikaz: 'echo x' }, { env: { SANDBOX_PROVIDER: 'local' }, loadSdk });
    expect(v.stav).toBe(SANDBOX_STAV.NEPRUKAZNE);
    expect(v.duvod).toContain('local');
    expect(loadSdk).not.toHaveBeenCalled();
  });

  test('chybí klíč → neprůkazné', async () => {
    const v = await spustVSandboxu({ prikaz: 'echo x' }, { env: { SANDBOX_PROVIDER: 'e2b' } });
    expect(v.stav).toBe(SANDBOX_STAV.NEPRUKAZNE);
    expect(v.duvod).toContain('E2B_API_KEY');
  });

  test('chybí balíček e2b → neprůkazné s návodem', async () => {
    const v = await spustVSandboxu({ prikaz: 'echo x' }, {
      env: ENV_E2B,
      loadSdk: async () => { throw new Error("Cannot find package 'e2b'"); },
    });
    expect(v.stav).toBe(SANDBOX_STAV.NEPRUKAZNE);
    expect(v.duvod).toContain('npm install e2b');
  });

  test('cesta mimo pracovní adresář → neprůkazné, sandbox se nevytvoří', async () => {
    const { loadSdk, zaznam } = falesneSdk();
    const v = await spustVSandboxu(
      { prikaz: 'echo x', soubory: [{ cesta: '../../.bashrc', obsah: 'x' }] },
      { env: ENV_E2B, loadSdk },
    );
    expect(v.stav).toBe(SANDBOX_STAV.NEPRUKAZNE);
    expect(zaznam.create).toBeNull();
  });
});

describe('spustVSandboxu — běh v E2B', () => {
  test('exit 0 → splněno; soubory, cwd a šablona sedí; sandbox se zabije', async () => {
    const { loadSdk, zaznam } = falesneSdk();
    const v = await spustVSandboxu(
      { prikaz: 'npx playwright test', soubory: [{ cesta: 't.spec.ts', obsah: 'X' }] },
      { env: { ...ENV_E2B, SANDBOX_TEMPLATE: 'auraguard-playwright' }, loadSdk },
    );
    expect(v.stav).toBe(SANDBOX_STAV.SPLNENO);
    expect(v.exitCode).toBe(0);
    expect(v.sandboxId).toBe('sbx_1');
    expect(zaznam.create.template).toBe('auraguard-playwright');
    expect(zaznam.zapisy).toEqual([{ cesta: `${PRACOVNI_ADRESAR}/t.spec.ts`, obsah: 'X' }]);
    expect(zaznam.run.opts.cwd).toBe(PRACOVNI_ADRESAR);
    expect(zaznam.killed).toBe(1);
  });

  test('do sandboxu jde jen výslovné envs, ne process.env ani klíč', async () => {
    const { loadSdk, zaznam } = falesneSdk();
    await spustVSandboxu({ prikaz: 'env', envs: { CI: '1' } }, { env: { ...ENV_E2B, TAJNE: 'x' }, loadSdk });
    expect(zaznam.run.opts.envs).toEqual({ CI: '1' });
    expect(zaznam.create.opts.envs).toBeUndefined();
    // Klíč jde jen do autentizace SDK, ne do prostředí sandboxu.
    expect(JSON.stringify(zaznam.run)).not.toContain(KLIC);
  });

  test('nenulový kód (CommandExitError) → nesplněno s výstupem, ne selhání běhu', async () => {
    const chyba = Object.assign(new Error('exit status 1'), { exitCode: 1, stdout: '1 failed', stderr: 'Timeout 30000ms' });
    const { loadSdk, zaznam } = falesneSdk({ run: () => { throw chyba; } });
    const v = await spustVSandboxu({ prikaz: 'x' }, { env: ENV_E2B, loadSdk });
    expect(v.stav).toBe(SANDBOX_STAV.NESPLNENO);
    expect(v.exitCode).toBe(1);
    expect(v.stdout).toBe('1 failed');
    expect(zaznam.killed).toBe(1);
  });

  test('timeout → neprůkazné a sandbox se přesto zabije', async () => {
    const chyba = Object.assign(new Error('deadline exceeded'), { name: 'TimeoutError' });
    const { loadSdk, zaznam } = falesneSdk({ run: () => { throw chyba; } });
    const v = await spustVSandboxu({ prikaz: 'x' }, { env: ENV_E2B, loadSdk });
    expect(v.stav).toBe(SANDBOX_STAV.NEPRUKAZNE);
    expect(v.duvod).toContain('vypršel');
    expect(zaznam.killed).toBe(1);
  });

  test('klíč z chybové hlášky SDK se zamaskuje', async () => {
    const { loadSdk } = falesneSdk({ create: () => { throw new Error(`401 invalid key ${KLIC}`); } });
    const v = await spustVSandboxu({ prikaz: 'x' }, { env: ENV_E2B, loadSdk });
    expect(v.stav).toBe(SANDBOX_STAV.NEPRUKAZNE);
    expect(v.duvod).not.toContain(KLIC);
    expect(v.duvod).toContain('[E2B_API_KEY]');
  });

  test('dlouhý výstup se ořízne', async () => {
    const { loadSdk } = falesneSdk({ run: () => ({ exitCode: 0, stdout: 'a'.repeat(MAX_VYSTUP + 500), stderr: '' }) });
    const v = await spustVSandboxu({ prikaz: 'x' }, { env: ENV_E2B, loadSdk });
    expect(v.stdout.length).toBeLessThan(MAX_VYSTUP + 100);
    expect(v.stdout).toContain('oříznuto');
  });

  test('timeout příkazu se omezí a sandbox žije o minutu déle', async () => {
    const { loadSdk, zaznam } = falesneSdk();
    await spustVSandboxu({ prikaz: 'x', timeoutMs: 99 * 60 * 60 * 1000 }, { env: ENV_E2B, loadSdk });
    expect(zaznam.run.opts.timeoutMs).toBe(MAX_TIMEOUT_MS);
    expect(zaznam.create.opts.timeoutMs).toBe(MAX_TIMEOUT_MS + 60 * 1000);
  });
});

describe('ověření vygenerovaného skriptu', () => {
  const SPEC = `import { test } from '@playwright/test';\ntest('x', async ({ page }) => {\n  await page.goto("https://example.com/a?b=\\"c\\"");\n});\n`;

  test('cilSkriptu vytáhne URL z JSON literálu i z apostrofů', () => {
    expect(cilSkriptu(SPEC)).toBe('https://example.com/a?b="c"');
    expect(cilSkriptu("await page.goto('http://localhost:3005/');")).toBe('http://localhost:3005/');
    expect(cilSkriptu('bez navigace')).toBeNull();
  });

  test('verzePlaywright vezme číslo z rozsahu', () => {
    expect(verzePlaywright('^1.60.0')).toBe('1.60.0');
    expect(verzePlaywright(undefined)).toBe('latest');
  });

  test('na šabloně base se Playwright instaluje, na vlastní šabloně ne', () => {
    expect(prikazOvereni({ template: 'base', verze: '1.60.0' })).toContain('@playwright/test@1.60.0');
    const vlastni = prikazOvereni({ template: 'auraguard-playwright', verze: '1.60.0' });
    expect(vlastni).not.toContain('npm install');
    expect(vlastni).toContain(NAZEV_SPEC);
  });

  test('neveřejný cíl (localhost) → neprůkazné, sandbox se nevytvoří', async () => {
    const { loadSdk, zaznam } = falesneSdk();
    const v = await overSkriptVSandboxu("await page.goto('http://localhost:3005/');", {}, {
      env: ENV_E2B,
      loadSdk,
      assertPublic: async () => { throw new Error('Interní adresa'); },
    });
    expect(v.stav).toBe(SANDBOX_STAV.NEPRUKAZNE);
    expect(v.duvod).toContain('jiný stroj');
    expect(zaznam.create).toBeNull();
  });

  test('veřejný cíl → spec se zapíše a spustí', async () => {
    const { loadSdk, zaznam } = falesneSdk();
    const v = await overSkriptVSandboxu(SPEC, { verzePlaywright: '^1.60.0' }, {
      env: ENV_E2B,
      loadSdk,
      assertPublic: async () => {},
    });
    expect(v.stav).toBe(SANDBOX_STAV.SPLNENO);
    expect(v.cil).toBe('https://example.com/a?b="c"');
    expect(zaznam.zapisy[0].cesta).toBe(`${PRACOVNI_ADRESAR}/${NAZEV_SPEC}`);
    expect(zaznam.run.prikaz).toContain('@playwright/test@1.60.0');
    expect(zaznam.run.opts.envs).toEqual({ CI: '1' });
  });
});
