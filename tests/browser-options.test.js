import { browserArgs, launchOptions } from '../browser-options.js';

/**
 * Volby pro spouštění Chromia.
 *
 * Třiatřicet řádků, které leží pod KAŽDÝM měřením — a neměly test.
 * Chybná volba nemění výsledek nápadně; mění prostředí, ve kterém se
 * měří, a to se v reportu nikde neprojeví.
 */
const puvodni = { ...process.env };
afterEach(() => {
  process.env = { ...puvodni };
});

describe('argumenty z prostředí', () => {
  test('prázdné prostředí nedá prázdný řetězec jako argument', () => {
    // `''.split(',')` vrací `['']` — bez filtru by Chromium dostalo
    // prázdný argument a odmítlo start.
    delete process.env.BROWSER_ARGS;
    expect(browserArgs()).toEqual([]);
    process.env.BROWSER_ARGS = '';
    expect(browserArgs()).toEqual([]);
    process.env.BROWSER_ARGS = ',,  ,';
    expect(browserArgs()).toEqual([]);
  });

  test('mezery kolem argumentů se ořežou', () => {
    process.env.BROWSER_ARGS = ' --disable-dev-shm-usage , --no-zygote ';
    expect(browserArgs()).toEqual(['--disable-dev-shm-usage', '--no-zygote']);
  });

  test('argumenty se berou z PROSTŘEDÍ, ne odjinud', () => {
    // Argumenty prohlížeče umí vypnout sandbox, takže je klient
    // ovlivňovat nesmí. Funkce nemá parametr — a to je záměr.
    expect(browserArgs.length).toBe(0);
  });
});

describe('headless se v produkci vynucuje', () => {
  test('produkce přebije i výslovné headless: false', () => {
    // `runAutonomousTest` je exportovaná: zavolat ji jde i mimo
    // server.js, který `vynutHeadless` používá. Pravidlo proto musí
    // stát tady, kudy prochází KAŽDÉ spuštění prohlížeče.
    process.env.NODE_ENV = 'production';
    expect(launchOptions({ headless: false }).headless).toBe(true);
    expect(launchOptions().headless).toBe(true);
  });

  test('mimo produkci se headless: false respektuje', () => {
    // Ladit s viditelným oknem je legitimní.
    process.env.NODE_ENV = 'development';
    expect(launchOptions({ headless: false }).headless).toBe(false);
    expect(launchOptions({ headless: true }).headless).toBe(true);
    expect(launchOptions().headless).toBe(true);
  });

  test('bez NODE_ENV se výslovné headless: false respektuje', () => {
    // NENÍ to fail-closed, a je to tak správně: vývojář, který si pustí
    // skript lokálně, `NODE_ENV` běžně nastavené nemá, a ladit
    // s viditelným oknem má smět. Produkci pokrývá `docker-compose.yml`,
    // který `NODE_ENV=production` nastavuje výslovně — na tom to stojí.
    delete process.env.NODE_ENV;
    expect(launchOptions({ headless: false }).headless).toBe(false);
    // Nevyžádané zůstává headless i tak.
    expect(launchOptions().headless).toBe(true);
  });
});

describe('skládání voleb', () => {
  test('argumenty volajícího se PŘIDAJÍ, nepřepíšou ty z prostředí', () => {
    process.env.BROWSER_ARGS = '--disable-dev-shm-usage';
    const o = launchOptions({ args: ['--mute-audio'] });
    expect(o.args).toEqual(['--disable-dev-shm-usage', '--mute-audio']);
  });

  test('ostatní volby projdou beze změny', () => {
    process.env.NODE_ENV = 'development';
    const o = launchOptions({ slowMo: 50, timeout: 1234 });
    expect(o.slowMo).toBe(50);
    expect(o.timeout).toBe(1234);
  });

  test('volání bez parametru nespadne', () => {
    expect(() => launchOptions()).not.toThrow();
    expect(Array.isArray(launchOptions().args)).toBe(true);
  });
});
