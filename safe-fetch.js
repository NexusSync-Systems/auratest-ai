/**
 * HTTP požadavek na PŘEDEM OVĚŘENOU adresu.
 *
 * PROČ TENHLE SOUBOR VZNIKL
 * Monitory dělaly tohle:
 *
 *     const res = await fetch(await assertPublicHttpUrl(target.url), …);
 *
 * Vypadá to jako ošetřený případ, ale je v tom mezera. `assertPublicHttpUrl`
 * přeloží doménu přes DNS, ověří všechny vrácené IP a vrátí — ŘETĚZEC S URL.
 * `fetch` pak tu doménu přeloží ZNOVU, vlastním dotazem. Mezi ověřením
 * a spojením je okno a útočník ho umí otevřít: stačí DNS záznam s platností
 * jednu sekundu, který napoprvé vrátí veřejnou adresu a napodruhé
 * `169.254.169.254`. Ověřili jsme jednu adresu, připojili se na jinou.
 *
 * Útok se jmenuje DNS rebinding a je to standardní způsob, jak obejít
 * kontrolu adresy udělanou zvlášť od spojení. Nástroj přitom chodí na
 * adresy, které mu zadá uživatel, a odpověď mu vrací — takže úspěšný
 * obchvat znamená čtení z vnitřní sítě serveru.
 *
 * Stejnou díru měl dřív TLS skener a vyřešila se tam tím, že se ověřená
 * adresa PŘEDÁVÁ dál (`agent.js`, `resolvePublicHttpTarget` →
 * `inspectTls(…, { address })`). Monitory na to zapomněly.
 *
 * JAK SE TO ŘEŠÍ TADY
 * Vlastní `lookup`. Node ho předává přes `https.request` → `tls.connect`
 * → `net.connect`, takže:
 *   • spojení jde na IP, kterou jsme ověřili,
 *   • hlavička `Host` i SNI zůstávají doménou, takže virtuální hosting
 *     i ověření certifikátu fungují dál.
 *
 * KEEP-ALIVE SE VYPÍNÁ, A JE TO SOUČÁST OCHRANY
 * `http.globalAgent` má od Node 19 `keepAlive: true` a klíč do poolu je
 * `host:port:localAddress` — připnutá adresa v něm NENÍ. Druhý požadavek
 * na tutéž doménu by tedy sáhl po spojení navázaném dřív, bez ohledu na
 * to, kam je připnutý. Kontrolní vlna to předvedla na dvou serverech
 * (127.0.0.1 a 127.0.0.2 na stejném portu): druhý požadavek s pinem na
 * .0.2 odpověděl ze serveru na .0.1.
 *
 * Obchvat SSRF to není — znovupoužité spojení vede vždy na adresu, která
 * kontrolou prošla. Ale monitor by pak hlásil stav jiného stroje, než
 * který ověřil, a věta „spojení jde na IP, kterou jsme ověřili" by
 * přestala platit doslova. Vlastní agent bez keep-alive to řeší.
 *
 * PROČ NE `fetch` S DISPATCHEREM
 * Připnout adresu u globálního `fetch` by chtělo `undici.Agent`, a `undici`
 * mezi závislostmi projektu není. Přidávat kvůli jednomu `lookup` další
 * balík do nástroje, který sám kontroluje SBOM, by bylo zvláštní.
 * `node:http`/`node:https` umí totéž a jsou ve standardní knihovně.
 */
import http from 'http';
import https from 'https';
import net from 'net';
import zlib from 'zlib';
import { pipeline } from 'stream';

/**
 * `lookup`, který se nikdy nikoho neptá.
 *
 * Node volá `lookup(hostname, options, callback)` a čeká
 * `callback(err, address, family)`. My máme adresu už ověřenou, takže ji
 * jen vrátíme.
 *
 * `options.all` NENÍ okrajový případ: od zapnutí `autoSelectFamily`
 * volá Node `lookup(hostname, { hints: 32, all: true }, cb)` prakticky
 * vždy, takže větev s polem je ta hlavní. Kdyby chyběla, spojení by
 * selhalo na nesrozumitelné chybě.
 */
function pripnutyLookup(address) {
  const family = net.isIP(address);
  return (_hostname, options, callback) => {
    const cb = typeof options === 'function' ? options : callback;
    const vse = typeof options === 'object' && options !== null && options.all;
    if (vse) return cb(null, [{ address, family }]);
    return cb(null, address, family);
  };
}

/**
 * Odpověď v tvaru, který se podobá `Response` z `fetch` — jen tolik, kolik
 * volající potřebují. Záměrně NEUMÍ následovat přesměrování: o tom musí
 * rozhodnout volající, protože každý další skok se musí znovu ověřit.
 */
function odpoved(res, telo, url) {
  return {
    url,
    status: res.statusCode,
    ok: res.statusCode >= 200 && res.statusCode < 300,
    headers: {
      get: (jmeno) => {
        const h = res.headers[String(jmeno).toLowerCase()];
        // `set-cookie` je jediná hlavička, kterou Node vrací jako pole.
        // Slepit ji čárkou je rozbití — hodnoty cookie čárky obsahují.
        // `fetch` na to má `getSetCookie()`; my ji nečteme, takže místo
        // tichého zmrzačení vrátíme pole tak, jak přišlo.
        if (Array.isArray(h)) return String(jmeno).toLowerCase() === 'set-cookie' ? h : h.join(', ');
        return h ?? null;
      },
      raw: res.headers,
    },
    text: async () => telo,
  };
}

/**
 * Strop na velikost odpovědi.
 *
 * Monitor čte tělo, aby v něm hledal očekávaný text. Bez stropu stačí, aby
 * sledovaná adresa začala posílat nekonečný proud, a proces si vyčerpá
 * paměť. 5 MB je nad rámec čehokoli, co dává smysl kontrolovat na výskyt
 * řetězce.
 *
 * Strop se uplatňuje na ROZBALENÁ data — jinak by ho obešla zip bomba.
 */
export const MAX_TELO_BAJTU = 5 * 1024 * 1024;

/**
 * Rozbalí tělo podle `content-encoding`.
 *
 * `fetch` tohle dělá samo, `http.request` ne. Když se na to zapomene
 * a server odpoví gzipem, dostane monitor binární data a `expectedText`
 * v nich nikdy nenajde — nahlásí tedy výpadek na webu, který funguje.
 * To je přesně ta druhá polovina řídící zásady: nález na webu, který je
 * v pořádku.
 *
 * `Accept-Encoding` posíláme výslovně. Bez něj `http.request` nepožádá
 * o kompresi vůbec a každý tik monitoru přenese násobně víc dat než dřív.
 */
function rozbal(res) {
  const kodovani = String(res.headers['content-encoding'] || '').toLowerCase().trim();
  if (kodovani === 'gzip' || kodovani === 'x-gzip') return zlib.createGunzip();
  if (kodovani === 'deflate') return zlib.createInflate();
  if (kodovani === 'br') return zlib.createBrotliDecompress();
  return null;
}

/**
 * @param {{url: string, hostname: string, port: number, address: string, addresses?: string[]}} cil
 *   výsledek `resolvePublicHttpTarget` — NE syrová URL od uživatele
 * @param {object} [opts]
 */
export function fetchPripnute(cil, opts = {}) {
  const {
    method = 'GET',
    headers = {},
    body,
    timeoutMs = 10_000,
  } = opts;

  // CHYBA VSTUPU JE ODMÍTNUTÍ, NIKDY SYNCHRONNÍ VÝJIMKA.
  //
  // Nejdřív tu byla obojí cesta: chybějící cíl vracel odmítnutý Promise,
  // ale neplatná IP vyhazovala synchronně. Vlastní test na to narazil —
  // odmítnutí z jednoho případu nikdo nepřevzal a prosáklo jako chyba
  // do NÁSLEDUJÍCÍHO testu. Funkce vracející Promise musí selhávat
  // jedním způsobem, jinak ji volající neumí ošetřit.
  if (!cil?.url || !cil?.address) {
    return Promise.reject(new Error(
      'fetchPripnute čeká ověřený cíl z resolvePublicHttpTarget, ne URL.'
    ));
  }
  const rodina = net.isIP(cil.address);
  if (rodina !== 4 && rodina !== 6) {
    return Promise.reject(new Error(`Připnutá adresa není platná IP: ${cil.address}`));
  }

  // Cíl musí být VNITŘNĚ KONZISTENTNÍ.
  //
  // Kontrolní vlna našla, že ručně sestavený `{url: cizíAdresa, address:
  // '1.2.3.4'}` projde bez jediného ověření — komentář přitom sliboval,
  // že podstrčený vstup ochranu neobejde. Kontrola nenahrazuje
  // `resolvePublicHttpTarget`, ale zachytí případ, kdy někdo objekt
  // poskládá ručně a nechtěně rozpojí adresu od URL.
  let parsed;
  try {
    parsed = new URL(cil.url);
  } catch {
    return Promise.reject(new Error(`Cíl nemá platnou URL: ${cil.url}`));
  }
  const hostZUrl = parsed.hostname.replace(/^\[|\]$/g, '');
  if (cil.hostname && cil.hostname !== hostZUrl) {
    return Promise.reject(new Error(
      `Cíl je nekonzistentní: url má host ${hostZUrl}, ale hostname je ${cil.hostname}.`
    ));
  }
  if (Array.isArray(cil.addresses) && !cil.addresses.includes(cil.address)) {
    return Promise.reject(new Error(
      'Připnutá adresa není mezi ověřenými adresami cíle.'
    ));
  }

  const jeHttps = parsed.protocol === 'https:';
  const modul = jeHttps ? https : http;

  return new Promise((resolve, reject) => {
    let hotovo = false;
    const dokonci = (fn) => (arg) => {
      if (hotovo) return;
      hotovo = true;
      fn(arg);
    };
    const uspech = dokonci(resolve);
    const selhani = dokonci(reject);

    const vlastniHlavicky = {
      // Bez toho `http.request` o kompresi nepožádá vůbec a monitor
      // přenese násobně víc dat, než je potřeba.
      'Accept-Encoding': 'gzip, deflate, br',
      ...headers,
    };
    // `Content-Length` musí být uvedený.
    //
    // Bez něj Node zvolí `Transfer-Encoding: chunked`. Dřív tudy šel
    // `fetch`, který délku dopočítal; po převodu na `http.request` se
    // POST monitoru formulářů začal posílat chunked — a chunked tělo
    // odmítá dost produkčních endpointů (411 Length Required, řada WAF
    // a starších upstreamů). Monitor by nahlásil „formulář nešel
    // odeslat" o formuláři, který funguje.
    const telo = (body === undefined || body === null) ? null : String(body);
    if (telo !== null && vlastniHlavicky['Content-Length'] === undefined) {
      vlastniHlavicky['Content-Length'] = Buffer.byteLength(telo);
    }

    // Vlastní agent BEZ keep-alive — viz komentář v hlavičce souboru.
    // Znovupoužité spojení ignoruje připnutí, protože se v klíči poolu
    // neobjevuje.
    const agent = new modul.Agent({ keepAlive: false, maxSockets: 1 });

    const req = modul.request(
      cil.url,
      {
        method,
        headers: vlastniHlavicky,
        agent,
        lookup: pripnutyLookup(cil.address),
        // `servername` se nechává odvodit z URL, takže SNI sedí na doménu
        // i při připnuté IP. Kdyby se sem dosadila adresa, certifikát by
        // přestal odpovídat a každý https cíl by hlásil chybu.
      },
      (res) => {
        const kusy = [];
        let velikost = 0;
        const prijmi = (kus) => {
          velikost += kus.length;
          if (velikost > MAX_TELO_BAJTU) {
            req.destroy();
            selhani(new Error(`Odpověď přesáhla ${MAX_TELO_BAJTU} B.`));
            return false;
          }
          kusy.push(kus);
          return true;
        };

        const rozbalovac = rozbal(res);
        const zdroj = rozbalovac
          ? pipeline(res, rozbalovac, (err) => { if (err) selhani(err); })
          : res;

        zdroj.on('data', prijmi);
        zdroj.on('end', () => uspech(odpoved(res, Buffer.concat(kusy).toString('utf8'), cil.url)));
        zdroj.on('error', (err) => selhani(err));
        res.on('error', (err) => selhani(err));
      }
    );

    // `setTimeout` u požadavku hlídá NEČINNOST socketu, ne celkovou dobu.
    // Pomalý server posílající bajt za bajt by ho nikdy nespustil, proto
    // je tu ještě druhý, tvrdý.
    req.setTimeout(timeoutMs, () => req.destroy(new Error('Timeout')));
    const tvrdy = setTimeout(() => req.destroy(new Error('Timeout')), timeoutMs);
    if (typeof tvrdy.unref === 'function') tvrdy.unref();
    req.on('close', () => { clearTimeout(tvrdy); agent.destroy(); });

    req.on('error', (err) => selhani(
      err.message === 'Timeout' ? Object.assign(new Error('Timeout'), { name: 'AbortError' }) : err
    ));

    if (telo !== null) req.write(telo);
    req.end();
  });
}
