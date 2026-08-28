/**
 * Chování instalace bez jazykového modelu.
 *
 * Výchozí `LLM_HOST` je `http://localhost:11434`. Když se nástroj nasadí bez
 * Ollamy, každé volání agenta v AI režimu skončilo odmítnutým spojením
 * a uživatel dostal „fetch failed" — neměl šanci poznat, že jde o chybějící
 * konfiguraci, ne o chybu testovaného webu.
 *
 * Logika se testuje samostatně, aby test nemusel startovat celý server
 * (a s ním Playwright).
 */

const LLM_FREE_MODES = new Set(['monkey', 'smoke_test']);

/** Kopie logiky ze server.js — viz `isLlmConfigured` a `llmUnavailableFor`. */
function makeLlmGate(env) {
  const defaultHost = env.LLM_HOST || 'http://localhost:11434';
  // `??`, ne `||`: prázdný řetězec je platná hodnota se významem „vypnuto".
  const allowed = (env.ALLOWED_LLM_HOSTS ?? defaultHost)
    .split(',').map((s) => s.trim()).filter(Boolean);

  const isConfigured = () => allowed.length > 0;
  const unavailableFor = (mode) => {
    if (LLM_FREE_MODES.has(mode) || isConfigured()) return null;
    return 'Tahle instalace nemá nakonfigurovaný jazykový model';
  };
  return { isConfigured, unavailableFor, allowed };
}

describe('Rozpoznání, že LLM není nakonfigurované', () => {
  it('prázdné ALLOWED_LLM_HOSTS znamená vypnuto', () => {
    // Kdyby se použilo `||` místo `??`, prázdný řetězec by se přepsal
    // výchozím localhostem a vypnout LLM by nešlo.
    expect(makeLlmGate({ ALLOWED_LLM_HOSTS: '' }).isConfigured()).toBe(false);
  });

  it('nezadané ALLOWED_LLM_HOSTS znamená zapnuto přes LLM_HOST', () => {
    expect(makeLlmGate({}).isConfigured()).toBe(true);
    expect(makeLlmGate({}).allowed).toEqual(['http://localhost:11434']);
  });

  it('explicitní host znamená zapnuto', () => {
    const gate = makeLlmGate({ ALLOWED_LLM_HOSTS: 'http://ollama:11434' });
    expect(gate.isConfigured()).toBe(true);
    expect(gate.allowed).toEqual(['http://ollama:11434']);
  });

  it('samé čárky a mezery se neberou jako host', () => {
    expect(makeLlmGate({ ALLOWED_LLM_HOSTS: ' , , ' }).isConfigured()).toBe(false);
  });
});

describe('Které režimy bez LLM projdou', () => {
  const withoutLlm = makeLlmGate({ ALLOWED_LLM_HOSTS: '' });
  const withLlm = makeLlmGate({ ALLOWED_LLM_HOSTS: 'http://ollama:11434' });

  it('monkey a smoke_test běží i bez modelu', () => {
    expect(withoutLlm.unavailableFor('monkey')).toBeNull();
    expect(withoutLlm.unavailableFor('smoke_test')).toBeNull();
  });

  it('AI režimy se bez modelu odmítnou předem', () => {
    for (const mode of ['ai', 'smart_monkey', 'crawler']) {
      expect(withoutLlm.unavailableFor(mode)).toMatch(/nemá nakonfigurovaný/);
    }
  });

  it('s modelem projde všechno', () => {
    for (const mode of ['ai', 'smart_monkey', 'crawler', 'monkey', 'smoke_test']) {
      expect(withLlm.unavailableFor(mode)).toBeNull();
    }
  });

  it('odmítnutí přijde DŘÍV, než se spustí prohlížeč', () => {
    // Smysl kontroly je ušetřit uživateli čekání na test, který stejně
    // selže — a nenechat po sobě session ve stavu „running".
    expect(withoutLlm.unavailableFor('ai')).not.toBeNull();
  });
});

describe('BROWSER_ARGS', () => {
  // Kontejnery s malým /dev/shm (Cloud Run) potřebují
  // --disable-dev-shm-usage, jinak Chromium padá na „Target closed".
  const parse = (raw) => (raw || '').split(',').map((a) => a.trim()).filter(Boolean);

  it('prázdná hodnota nepřidá žádný argument', () => {
    expect(parse('')).toEqual([]);
    expect(parse(undefined)).toEqual([]);
  });

  it('rozdělí seznam a ořízne mezery', () => {
    expect(parse('--disable-dev-shm-usage, --no-zygote'))
      .toEqual(['--disable-dev-shm-usage', '--no-zygote']);
  });

  it('nevyrobí prázdné argumenty z přebytečných čárek', () => {
    // Prázdný argument by Chromium odmítlo spustit.
    expect(parse('--a,,--b,')).toEqual(['--a', '--b']);
  });
});

describe('kapacita souběžných skenů (regrese)', () => {
  /** Kopie logiky ze server.js — viz MAX_CONCURRENT_BROWSERS. */
  const limitFor = (env) => parseInt(env.MAX_CONCURRENT_BROWSERS, 10) || 3;

  test('klient se limit dozví, aby si dávkoval komplexní audit', () => {
    // Dokud se limit neposílal, pouštěl frontend všech deset skenů naráz.
    // Server jich přijal tolik, kolik měl slotů, a zbytek odmítl kódem 429 —
    // uživatel dostal chybovou hlášku místo výsledků, přestože se nic
    // nepokazilo a server se choval přesně podle nastavení.
    expect(limitFor({ MAX_CONCURRENT_BROWSERS: '2' })).toBe(2);
    expect(limitFor({ MAX_CONCURRENT_BROWSERS: '1' })).toBe(1);
  });

  test('bez nastavení platí výchozí hodnota, ne nula', () => {
    // Nula by znamenala, že neprojde žádný sken.
    expect(limitFor({})).toBe(3);
    expect(limitFor({ MAX_CONCURRENT_BROWSERS: 'nesmysl' })).toBe(3);
  });
});
