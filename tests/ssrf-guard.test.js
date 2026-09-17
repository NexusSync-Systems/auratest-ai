import { assertPublicHttpUrl, resolvePublicHttpTarget, guardNavigation } from '../ssrf-guard.js';

describe('ssrf-guard — blokace neveřejných/nebezpečných cílů', () => {
  const blocked = [
    ['cloud metadata', 'http://169.254.169.254/latest/meta-data/'],
    ['loopback IP', 'http://127.0.0.1/'],
    ['loopback jméno', 'http://localhost:11434'],
    ['privátní 10/8', 'http://10.0.0.5/admin'],
    ['privátní 192.168', 'http://192.168.1.1/'],
    ['privátní 172.16/12', 'http://172.16.5.5/'],
    ['CGNAT 100.64/10', 'http://100.64.0.1/'],
    ['IPv6 loopback', 'https://[::1]/'],
    ['IPv4-mapped IPv6', 'http://[::ffff:127.0.0.1]/'],
    ['.local hostname', 'http://server.local/'],
    ['jiné schéma', 'ftp://example.com/'],
    ['nevalidní URL', 'not-a-url'],
    ['prázdné', ''],
  ];

  test.each(blocked)('blokuje %s', async (_label, url) => {
    await expect(assertPublicHttpUrl(url)).rejects.toThrow();
  });
});

describe('ssrf-guard — povolení veřejných cílů', () => {
  test('veřejná IP literál projde a vrátí normalizovanou URL', async () => {
    const out = await assertPublicHttpUrl('http://8.8.8.8/path');
    expect(out).toBe('http://8.8.8.8/path');
  });

  test('https veřejná IP projde', async () => {
    await expect(assertPublicHttpUrl('https://1.1.1.1/')).resolves.toBeTruthy();
  });
});

/**
 * IPv6 literály.
 *
 * WHATWG URL vrací IPv6 hostname včetně hranatých závorek, takže `net.isIP()`
 * na něj vracelo 0 a literál spadl do DNS větve — celá logika `isBlockedV6`
 * byla pro přímé literály mrtvá. Selhávalo to bezpečně, ale náhodou:
 * `dns.lookup('[::1]')` vždy skončí chybou.
 *
 * Po opravě se závorky odstraňují. Tím se ale odkryla druhá past:
 * `http://[::ffff:127.0.0.1]/` si URL znormalizuje na `[::ffff:7f00:1]`,
 * tedy do hexa tvaru. Porovnání jen tečkového zápisu by loopback propustilo.
 */
describe('assertPublicHttpUrl — IPv6', () => {
  const blocked = [
    ['http://[::1]/', 'loopback'],
    ['http://[::]/', 'unspecified'],
    ['http://[::ffff:127.0.0.1]/', 'IPv4-mapped loopback, tečkový zápis'],
    ['http://[::ffff:7f00:1]/', 'IPv4-mapped loopback, hexa zápis'],
    ['http://[::ffff:169.254.169.254]/', 'IPv4-mapped cloud metadata'],
    ['http://[::ffff:10.0.0.1]/', 'IPv4-mapped privátní rozsah'],
    ['http://[::127.0.0.1]/', 'IPv4-compatible loopback'],
    ['http://[fe80::1]/', 'link-local'],
    ['http://[fc00::1]/', 'unique local'],
    ['http://[fd00::1]/', 'unique local'],
    ['http://[ff02::1]/', 'multicast'],
    ['http://[64:ff9b::7f00:1]/', 'NAT64 na loopback'],
    ['http://[gggg::1]/', 'nerozluštitelná adresa'],
  ];

  for (const [url, why] of blocked) {
    it(`blokuje ${url} (${why})`, async () => {
      await expect(assertPublicHttpUrl(url)).rejects.toThrow();
    });
  }

  it('veřejnou IPv6 adresu propustí', async () => {
    // Jinak by oprava blokovala legitimní cíle.
    await expect(assertPublicHttpUrl('http://[2606:4700:4700::1111]/')).resolves.toBeTruthy();
  });
});

describe('assertPublicHttpUrl — doplněné rozsahy', () => {
  it('blokuje 192.88.99.0/24 (6to4 relay, RFC 7526)', async () => {
    await expect(assertPublicHttpUrl('http://192.88.99.1/')).rejects.toThrow();
  });
});

/**
 * Přechodové mechanismy IPv6→IPv4.
 *
 * Adresa vypadá jako veřejná IPv6, ale nese v sobě IPv4 cíl. Bez rozbalení
 * by `2002:7f00:1::` propašovalo loopback.
 */
describe('assertPublicHttpUrl — přechodové IPv6 mechanismy', () => {
  it('blokuje 6to4 s vnořeným loopbackem', async () => {
    await expect(assertPublicHttpUrl('http://[2002:7f00:1::]/')).rejects.toThrow();
  });

  it('blokuje 6to4 s vnořenou adresou cloud metadat', async () => {
    await expect(assertPublicHttpUrl('http://[2002:a9fe:a9fe::]/')).rejects.toThrow();
  });

  it('blokuje IPv4-translated ::ffff:0:0:0/96', async () => {
    await expect(assertPublicHttpUrl('http://[::ffff:0:127.0.0.1]/')).rejects.toThrow();
  });

  it('6to4 s veřejnou IPv4 uvnitř propustí', async () => {
    // Blokovat celý 2002::/16 by zablokovalo i legitimní cíle.
    await expect(assertPublicHttpUrl('http://[2002:0808:0808::]/')).resolves.toBeTruthy();
  });
});

describe('guardNavigation — hlídá i přesměrování (regrese kontrolní vlny)', () => {
  /**
   * Napodobenina kontextu Playwrightu. Skutečný prohlížeč tu nepotřebujeme —
   * testuje se rozhodnutí, ne síť.
   */
  const fakeContext = () => {
    const ctx = { handler: null };
    ctx.route = async (_pattern, handler) => {
      ctx.handler = handler;
    };
    return ctx;
  };

  /**
   * `frameThrows` napodobuje skutečné chování Playwrightu.
   *
   * `Request.frame()` vyhazuje u požadavků, které vznikly dřív než rámec,
   * a u požadavků ze Service Workeru. Původní napodobenina to neuměla —
   * `frame()` vracela vždycky objekt — takže test potvrzoval moji
   * představu, ne skutečnost. Naostro to shodilo celý smoke test:
   * „Frame for this navigation request is not available".
   */
  const request = (url, { navigation = true, topLevel = true, frameThrows = false } = {}) => ({
    url: () => url,
    isNavigationRequest: () => navigation,
    frame: () => {
      if (frameThrows) {
        throw new Error('Frame for this navigation request is not available, '
          + 'because the request was issued before the frame is created.');
      }
      return { parentFrame: () => (topLevel ? null : {}) };
    },
  });

  const run = async (url, options) => {
    const ctx = fakeContext();
    await guardNavigation(ctx, () => {});
    const calls = [];
    await ctx.handler(
      { continue: () => calls.push('continue'), abort: () => calls.push('abort') },
      request(url, options)
    );
    return calls[0];
  };

  test('přesměrování na metadata endpoint se zablokuje', async () => {
    // Útočníkovi stačí veřejná adresa vracející 302 na 169.254.169.254.
    // Kontrola před spuštěním posoudí jen tu první; prohlížeč jde dál sám
    // a co uvidí, pošle zpátky ve screenshotu i v textu stránky.
    expect(await run('http://169.254.169.254/latest/meta-data/')).toBe('abort');
  });

  test('přesměrování na loopback a privátní rozsah se zablokuje', async () => {
    expect(await run('http://127.0.0.1:8080/admin')).toBe('abort');
    expect(await run('http://10.0.0.5/')).toBe('abort');
  });

  test('veřejný cíl projde', async () => {
    // Literál veřejné IP, ne doména: test nesmí záviset na DNS prostředí,
    // ve kterém běží.
    expect(await run('https://93.184.216.34/')).toBe('continue');
  });

  test('podřízené zdroje se nefiltrují', async () => {
    // Web načte stovky adres; ověřovat každou přes DNS by sken položilo
    // a obsah takového požadavku se do reportu stejně nedostane.
    expect(await run('http://127.0.0.1/obrazek.png', { navigation: false })).toBe('continue');
  });

  test('navigace uvnitř iframu se nefiltruje', async () => {
    expect(await run('http://127.0.0.1/', { topLevel: false })).toBe('continue');
  });

  test('kontext bez route() hlídač nezapne, ale nespadne', async () => {
    await expect(guardNavigation({})).resolves.toBeUndefined();
  });

  /**
   * Hlídač, který při chybě položí běh, je horší než žádný.
   *
   * Handler je async, takže výjimka z něj je neodchycené odmítnutí Promise
   * a Node na to shodí proces. Naostro se to stalo: `frame()` vyhodilo
   * a smoke test spadl uprostřed prvního skeneru.
   */
  test('nedostupný rámec hlídač nepoloží', async () => {
    await expect(
      run('https://93.184.216.34/', { frameThrows: true })
    ).resolves.toBeDefined();
  });

  test('u nedostupného rámce se adresa PROVĚŘÍ, ne propustí', async () => {
    // Opačná volba by z požadavků bez rámce (Service Worker, navigace
    // vzniklá dřív než rámec) udělala obchvat hlídače.
    expect(await run('http://169.254.169.254/latest/meta-data/', { frameThrows: true }))
      .toBe('abort');
    expect(await run('https://93.184.216.34/', { frameThrows: true })).toBe('continue');
  });

  test('chyba u podřízeného zdroje sken nerozsype', async () => {
    // U neNavigačního požadavku se pokračuje — chyba uvnitř hlídače
    // nesmí zabít načítání obrázků a skriptů.
    const ctx = fakeContext();
    await guardNavigation(ctx, () => {});
    const calls = [];
    await ctx.handler(
      { continue: () => calls.push('continue'), abort: () => calls.push('abort') },
      { url: () => 'https://example.com/a.png',
        isNavigationRequest: () => false,
        frame: () => { throw new Error('nedostupný'); } }
    );
    expect(calls[0]).toBe('continue');
  });

  test('výjimka z route.continue() neuteče ven', async () => {
    // Stránka se mezitím zavřela. Bez obalu by tohle shodilo proces
    // stejně jako chyba z `frame()`.
    const ctx = fakeContext();
    await guardNavigation(ctx, () => {});
    await expect(ctx.handler(
      { continue: () => { throw new Error('Target page closed'); },
        abort: async () => {} },
      request('https://93.184.216.34/')
    )).resolves.not.toThrow();
  });
});

describe('port a připnutá adresa (kontrolní vlna)', () => {
  // Veřejná IP jako literál: kontrola pak neprochází přes DNS, takže test
  // nezávisí na tom, jestli má běhové prostředí překlad jmen. Na obou
  // vlastnostech, které se tu ověřují, to nic nemění.
  const VEREJNA_IP = '93.184.216.34';

  it('odmítne port, na kterém web neběží', async () => {
    // Bez omezení stačilo přesměrování na :25 a z auditního nástroje byl
    // skener portů běžící pod naší adresou a naší pověstí.
    await expect(assertPublicHttpUrl(`https://${VEREJNA_IP}:25/`)).rejects.toThrow(/Port 25/);
  });

  it('povolí běžné webové porty', async () => {
    for (const port of [443, 8443, 8080]) {
      await expect(assertPublicHttpUrl(`https://${VEREJNA_IP}:${port}/`)).resolves.toBeTruthy();
    }
  });

  it('vrátí ověřenou adresu, aby se spojení neotevřelo jinam', async () => {
    // Jádro opravy: ověření a spojení musí platit pro TUTÉŽ adresu.
    // Dokud se adresa zahazovala, měl útočník mezi kontrolou a spojením
    // osm příležitostí podstrčit jinou odpověď z DNS.
    const cil = await resolvePublicHttpTarget(`https://${VEREJNA_IP}:8443/`);
    expect(cil.hostname).toBe(VEREJNA_IP);
    expect(cil.port).toBe(8443);
    expect(cil.address).toBe(VEREJNA_IP);
    expect(cil.addresses).toContain(VEREJNA_IP);
  });

  it('neveřejnou adresu odmítne i na povoleném portu', async () => {
    await expect(assertPublicHttpUrl('https://127.0.0.1:8443/')).rejects.toThrow(/neveřejn/);
  });
});
