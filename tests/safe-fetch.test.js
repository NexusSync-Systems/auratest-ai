/**
 * Připnutá adresa a DNS rebinding.
 *
 * PROČ TENHLE TEST NENÍ NAPODOBENINA
 * Třikrát za sebou v tomhle projektu platilo, že napodobenina zakódovala
 * moji představu o API a test pak potvrdil ji, ne skutečnost
 * (`preactAttr`, `transferSize`, `frame()`, které nikdy nevyhodí).
 * U ochrany proti rebindingu by to bylo nejhorší možné místo na takovou
 * chybu: test by svítil zeleně a díra by zůstala otevřená.
 *
 * Testuje se proto proti SKUTEČNÉMU HTTP serveru na loopbacku a se
 * SKUTEČNÝM `lookup`, který se při druhém dotazu rozhodne jinak. Přesně
 * to dělá útočník: DNS záznam s jednosekundovou platností, napoprvé
 * veřejná adresa, napodruhé vnitřní.
 */
import http from 'http';
import dns from 'dns';
import zlib from 'zlib';
import { fetchPripnute, MAX_TELO_BAJTU } from '../safe-fetch.js';

/** Spustí server na loopbacku a vrátí jeho port. */
function server(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

const zavri = (srv) => new Promise((r) => srv.close(r));

describe('fetchPripnute', () => {
  test('připojí se na připnutou adresu a doménu pošle v Host', async () => {
    let videnyHost = null;
    const { srv, port } = await server((req, res) => {
      videnyHost = req.headers.host;
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ahoj');
    });
    try {
      // URL nese doménu, která by se přeložila jinam (nebo vůbec).
      // Spojení přesto jde na 127.0.0.1, protože je připnuté.
      const res = await fetchPripnute({
        url: `http://muj-web.example:${port}/`,
        hostname: 'muj-web.example',
        port,
        address: '127.0.0.1',
      });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('ahoj');
      // Virtuální hosting musí fungovat dál — Host je doména, ne IP.
      expect(videnyHost).toBe(`muj-web.example:${port}`);
    } finally {
      await zavri(srv);
    }
  });

  /**
   * JÁDRO CELÉ OPRAVY — A TEST, KTERÝ SE DÁ PROLOMIT.
   *
   * První verze tohohle testu počítala, kolikrát byl zavolán NÁŠ VLASTNÍ
   * `lookup` hook, a tvrdila `toBeLessThanOrEqual(1)`. Kontrolní vlna ho
   * prolomila mutací: když se připnutí úplně vyřadí a `lookup` se nahradí
   * obyčejným `dns.lookup`, počet je pořád 1 — test projde nad rozbitou
   * ochranou. Měřil moji představu, ne skutečnost. Přesně před tím
   * varuje komentář v hlavičce tohoto souboru; napsal jsem to znovu.
   *
   * Tohle měří, KAM SPOJENÍ DOOPRAVDY ŠLO.
   *
   * Scéna je útok: doména `rebind.example` projde kontrolou (ověřená IP
   * je „veřejný" server), ale DNS je přepsané tak, aby při jakémkoli
   * dalším překladu vrátilo adresu „vnitřní služby". Kdyby se připnutí
   * neuplatnilo, odpověď přijde z vnitřní služby — a to se pozná na těle.
   *
   * Dva servery musí být na STEJNÉM portu a lišit se jen adresou,
   * jinak by test procházel i z jiného důvodu.
   */
  test('rebind neprojde: odpověď přijde z ověřené adresy, ne z přepsaného DNS', async () => {
    const verejny = http.createServer((_q, r) => r.end('VEREJNY-SERVER'));
    const vnitrni = http.createServer((_q, r) => r.end('VNITRNI-SLUZBA'));
    await new Promise((r) => verejny.listen(0, '127.0.0.1', r));
    const port = verejny.address().port;
    await new Promise((r) => vnitrni.listen(port, '127.0.0.2', r));

    const puvodniLookup = dns.lookup;
    // DNS lže: každý překlad `rebind.example` míří na vnitřní službu.
    dns.lookup = (hostname, options, cb) => {
      if (hostname === 'rebind.example') {
        const callback = typeof options === 'function' ? options : cb;
        const vse = typeof options === 'object' && options !== null && options.all;
        return callback(null, vse ? [{ address: '127.0.0.2', family: 4 }] : '127.0.0.2', 4);
      }
      return puvodniLookup(hostname, options, cb);
    };

    try {
      const res = await fetchPripnute({
        url: `http://rebind.example:${port}/`,
        hostname: 'rebind.example',
        port,
        address: '127.0.0.1', // adresa, která prošla kontrolou
        addresses: ['127.0.0.1'],
      }, { timeoutMs: 3000 });
      // Kdyby se připnutí neuplatnilo, stálo by tu 'VNITRNI-SLUZBA'.
      expect(await res.text()).toBe('VEREJNY-SERVER');
    } finally {
      dns.lookup = puvodniLookup;
      await new Promise((r) => verejny.close(r));
      await new Promise((r) => vnitrni.close(r));
    }
  });

  /**
   * Totéž pro keep-alive. Znovupoužité spojení připnutí ignoruje,
   * protože v klíči poolu adresa není — kontrolní vlna to předvedla.
   * Dva požadavky za sebou na stejnou doménu a port, různé piny.
   */
  test('druhý požadavek nesáhne po spojení navázaném na jinou adresu', async () => {
    const a = http.createServer((_q, r) => r.end('SERVER-A'));
    const b = http.createServer((_q, r) => r.end('SERVER-B'));
    await new Promise((r) => a.listen(0, '127.0.0.1', r));
    const port = a.address().port;
    await new Promise((r) => b.listen(port, '127.0.0.2', r));

    const cil = (address) => ({
      url: `http://shodny-host.example:${port}/`,
      hostname: 'shodny-host.example', port, address,
    });
    try {
      expect(await (await fetchPripnute(cil('127.0.0.1'))).text()).toBe('SERVER-A');
      expect(await (await fetchPripnute(cil('127.0.0.2'))).text()).toBe('SERVER-B');
    } finally {
      await new Promise((r) => a.close(r));
      await new Promise((r) => b.close(r));
    }
  });

  test('doména, která by se přeložila na 8.8.8.8, skončí na připnuté IP', async () => {
    // Kdyby se `lookup` ignoroval, spojení by odešlo mimo stroj a test
    // by vytuhl na timeoutu. Že doběhne proti našemu serveru, je důkaz,
    // že se připnutí uplatnilo.
    const { srv, port } = await server((_req, res) => res.end('z loopbacku'));
    try {
      const res = await fetchPripnute({
        url: `http://dns.google:${port}/`,
        hostname: 'dns.google',
        port,
        address: '127.0.0.1',
      }, { timeoutMs: 3000 });
      expect(await res.text()).toBe('z loopbacku');
    } finally {
      await zavri(srv);
    }
  });

  test('syrová URL místo ověřeného cíle se odmítne', async () => {
    // Kdyby sem někdo podstrčil řetězec, ochrana by tiše zmizela.
    await expect(fetchPripnute('http://example.com/')).rejects.toThrow(/ověřený cíl/);
    await expect(fetchPripnute({ url: 'http://example.com/' })).rejects.toThrow(/ověřený cíl/);
  });

  test('neplatná připnutá adresa se odmítne, a to stejnou cestou jako ostatní', async () => {
    // Jeden způsob selhání. Dřív tenhle případ vyhazoval SYNCHRONNĚ,
    // zatímco chybějící cíl vracel odmítnutý Promise — odmítnutí pak nikdo
    // nepřevzal a prosáklo jako chyba do následujícího testu. Našel to
    // tenhle soubor sám na sobě.
    await expect(fetchPripnute({ url: 'http://a.example/', address: 'není-ip' }))
      .rejects.toThrow(/není platná IP/);
  });

  test('přesměrování se NEsleduje — rozhodnutí patří volajícímu', async () => {
    const { srv, port } = await server((_req, res) => {
      res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' });
      res.end();
    });
    try {
      const res = await fetchPripnute({
        url: `http://a.example:${port}/`, hostname: 'a.example', port, address: '127.0.0.1',
      });
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('http://169.254.169.254/latest/meta-data/');
    } finally {
      await zavri(srv);
    }
  });

  test('POST odešle tělo a hlavičky', async () => {
    let telo = '';
    let typ = null;
    const { srv, port } = await server((req, res) => {
      typ = req.headers['content-type'];
      req.on('data', (c) => { telo += c; });
      req.on('end', () => res.end('přijato'));
    });
    try {
      await fetchPripnute(
        { url: `http://a.example:${port}/`, hostname: 'a.example', port, address: '127.0.0.1' },
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'jmeno=Zden%C4%9Bk',
        }
      );
      expect(telo).toBe('jmeno=Zden%C4%9Bk');
      expect(typ).toBe('application/x-www-form-urlencoded');
    } finally {
      await zavri(srv);
    }
  });

  test('timeout se ohlásí jako Timeout, ne jako pád', async () => {
    const { srv, port } = await server(() => { /* nikdy neodpoví */ });
    try {
      await expect(fetchPripnute(
        { url: `http://a.example:${port}/`, hostname: 'a.example', port, address: '127.0.0.1' },
        { timeoutMs: 150 }
      )).rejects.toThrow(/Timeout/);
    } finally {
      await zavri(srv);
    }
  });

  test('nekonečná odpověď se utne, ať nesežere paměť', async () => {
    // Sledovaná adresa začne posílat proud bez konce. Bez stropu si proces
    // vyčerpá paměť — monitor přitom tělo čte jen kvůli hledání řetězce.
    const { srv, port } = await server((_req, res) => {
      res.writeHead(200);
      const kus = Buffer.alloc(256 * 1024, 'x');
      const posli = () => { if (res.write(kus)) setImmediate(posli); else res.once('drain', posli); };
      posli();
    });
    try {
      await expect(fetchPripnute(
        { url: `http://a.example:${port}/`, hostname: 'a.example', port, address: '127.0.0.1' },
        { timeoutMs: 15_000 }
      )).rejects.toThrow(new RegExp(String(MAX_TELO_BAJTU)));
    } finally {
      await zavri(srv);
    }
  }, 20_000);

  test('hlavičky se čtou bez ohledu na velikost písmen', async () => {
    const { srv, port } = await server((_req, res) => {
      res.writeHead(200, { 'X-Vlastni': 'hodnota' });
      res.end();
    });
    try {
      const res = await fetchPripnute({
        url: `http://a.example:${port}/`, hostname: 'a.example', port, address: '127.0.0.1',
      });
      expect(res.headers.get('X-Vlastni')).toBe('hodnota');
      expect(res.headers.get('x-vlastni')).toBe('hodnota');
      expect(res.headers.get('chybi')).toBeNull();
    } finally {
      await zavri(srv);
    }
  });

  /**
   * Komprese. `fetch` rozbaluje sám, `http.request` ne.
   *
   * Kdyby se na to zapomnělo, dostane monitor binární data, `expectedText`
   * v nich nenajde a nahlásí výpadek na webu, který funguje — druhá
   * polovina řídící zásady: nález na webu, který je v pořádku.
   */
  test('gzip se rozbalí, ne že se text hledá v binárních datech', async () => {
    const telo = zlib.gzipSync(Buffer.from('<html>Vítejte na AuraGuard</html>', 'utf8'));
    const { srv, port } = await server((_req, res) => {
      res.writeHead(200, { 'content-encoding': 'gzip', 'content-type': 'text/html' });
      res.end(telo);
    });
    try {
      const res = await fetchPripnute({
        url: `http://a.example:${port}/`, hostname: 'a.example', port, address: '127.0.0.1',
      });
      expect(await res.text()).toBe('<html>Vítejte na AuraGuard</html>');
    } finally {
      await zavri(srv);
    }
  });

  test('brotli se rozbalí taky', async () => {
    const telo = zlib.brotliCompressSync(Buffer.from('ahoj z brotli', 'utf8'));
    const { srv, port } = await server((_req, res) => {
      res.writeHead(200, { 'content-encoding': 'br' });
      res.end(telo);
    });
    try {
      const res = await fetchPripnute({
        url: `http://a.example:${port}/`, hostname: 'a.example', port, address: '127.0.0.1',
      });
      expect(await res.text()).toBe('ahoj z brotli');
    } finally {
      await zavri(srv);
    }
  });

  test('o kompresi se výslovně žádá', async () => {
    // Bez `Accept-Encoding` přenese každý tik monitoru násobně víc dat.
    let hlavicka = null;
    const { srv, port } = await server((req, res) => {
      hlavicka = req.headers['accept-encoding'];
      res.end('ok');
    });
    try {
      await fetchPripnute({
        url: `http://a.example:${port}/`, hostname: 'a.example', port, address: '127.0.0.1',
      });
      expect(hlavicka).toMatch(/gzip/);
    } finally {
      await zavri(srv);
    }
  });

  /**
   * POST musí nést `Content-Length`.
   *
   * Bez něj Node zvolí `Transfer-Encoding: chunked` a chunked tělo odmítá
   * dost produkčních endpointů (411 Length Required, WAF, starší
   * upstreamy). Monitor formuláře by hlásil „formulář nešel odeslat"
   * o formuláři, který funguje. Našla to kontrolní vlna.
   */
  test('POST nese Content-Length, ne chunked', async () => {
    let hlavicky = null;
    const { srv, port } = await server((req, res) => {
      hlavicky = req.headers;
      req.on('data', () => {});
      req.on('end', () => res.end('ok'));
    });
    try {
      await fetchPripnute(
        { url: `http://a.example:${port}/`, hostname: 'a.example', port, address: '127.0.0.1' },
        { method: 'POST', body: 'a=1&b=2' }
      );
      expect(hlavicky['content-length']).toBe('7');
      expect(hlavicky['transfer-encoding']).toBeUndefined();
    } finally {
      await zavri(srv);
    }
  });

  test('délka se počítá v bajtech, ne ve znacích', async () => {
    // „Zdeněk" má 6 znaků, ale 7 bajtů v UTF-8 (`ě` je dvoubajtové).
    // Kdyby se délka počítala ze `String.length`, tělo by se useklo.
    let delka = null;
    let prijato = '';
    const { srv, port } = await server((req, res) => {
      delka = req.headers['content-length'];
      req.on('data', (c) => { prijato += c; });
      req.on('end', () => res.end('ok'));
    });
    try {
      await fetchPripnute(
        { url: `http://a.example:${port}/`, hostname: 'a.example', port, address: '127.0.0.1' },
        { method: 'POST', body: 'Zdeněk' }
      );
      expect(delka).toBe('7');
      expect(prijato).toBe('Zdeněk');
    } finally {
      await zavri(srv);
    }
  });

  /**
   * Ručně poskládaný cíl nesmí ochranu obejít.
   *
   * Komentář v modulu sliboval, že podstrčený vstup neprojde, a přitom se
   * kontrolovala jen přítomnost dvou polí. `{url: cizíAdresa, address:
   * '1.2.3.4'}` prošlo bez jediného ověření. Našla to kontrolní vlna.
   */
  test('nekonzistentní cíl se odmítne', async () => {
    await expect(fetchPripnute({
      url: 'http://opravdovy-cil.example/', hostname: 'neco-jineho.example', address: '127.0.0.1',
    })).rejects.toThrow(/nekonzistentní/);

    await expect(fetchPripnute({
      url: 'http://a.example/', hostname: 'a.example',
      address: '10.0.0.1', addresses: ['93.184.216.34'],
    })).rejects.toThrow(/není mezi ověřenými/);
  });
});