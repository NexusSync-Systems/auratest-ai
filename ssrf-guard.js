/**
 * SSRF guard — validace uživatelem zadané cílové URL před tím, než na ni server
 * pošle prohlížeč / HTTP požadavek.
 *
 * Blokuje:
 *   • jiné schéma než http/https
 *   • hostname, který se resolvuje na privátní / loopback / link-local /
 *     reserved IP rozsahy (ochrana proti přístupu na interní služby a cloud
 *     metadata endpoint 169.254.169.254)
 *
 * Použití:
 *   import { assertPublicHttpUrl } from './ssrf-guard.js';
 *   const safeUrl = await assertPublicHttpUrl(req.body.url);
 */
import dns from 'node:dns/promises';
import net from 'node:net';

function ipToLong(ip) {
  return ip.split('.').reduce((acc, oct) => (acc << 8) + parseInt(oct, 10), 0) >>> 0;
}

function inRange(ip, cidr) {
  const [range, bits] = cidr.split('/');
  const mask = bits === '0' ? 0 : (~0 << (32 - parseInt(bits, 10))) >>> 0;
  return (ipToLong(ip) & mask) === (ipToLong(range) & mask);
}

// Neveřejné / nebezpečné IPv4 rozsahy.
const BLOCKED_V4 = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',   // CGNAT
  '127.0.0.0/8',     // loopback
  '169.254.0.0/16',  // link-local (cloud metadata)
  '172.16.0.0/12',   // private
  '192.0.0.0/24',
  '192.0.2.0/24',
  '192.168.0.0/16',  // private
  '198.18.0.0/15',
  '192.88.99.0/24',  // 6to4 anycast relay (RFC 7526, vyřazeno)
  '198.51.100.0/24',
  '203.0.113.0/24',
  '224.0.0.0/4',     // multicast
  '240.0.0.0/4',     // reserved
];

function isBlockedV4(ip) {
  return BLOCKED_V4.some((cidr) => inRange(ip, cidr));
}

/**
 * Rozvine IPv6 adresu na osm skupin. Vrací null, když to není platná adresa.
 *
 * Potřebujeme to kvůli IPv4-mapped adresám: `http://[::ffff:127.0.0.1]/`
 * si WHATWG URL znormalizuje na `[::ffff:7f00:1]`, tedy do HEXA tvaru.
 * Porovnávat jen tečkový zápis by loopback propustilo.
 */
function expandV6(ip) {
  let v = ip.toLowerCase();

  // Koncový IPv4 zápis (::ffff:1.2.3.4) přepíšeme na dvě hexa skupiny.
  const tail = v.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (tail) {
    const octets = tail[1].split('.').map(Number);
    if (octets.some((o) => o > 255)) return null;
    const hex = [
      ((octets[0] << 8) | octets[1]).toString(16),
      ((octets[2] << 8) | octets[3]).toString(16),
    ];
    v = v.slice(0, -tail[1].length) + hex.join(':');
  }

  const [head, rest, extra] = v.split('::');
  if (extra !== undefined) return null; // '::' smí být jen jednou

  const left = head ? head.split(':').filter(Boolean) : [];
  const right = rest ? rest.split(':').filter(Boolean) : [];

  let groups;
  if (rest === undefined) {
    groups = left;
  } else {
    const fill = 8 - left.length - right.length;
    if (fill < 0) return null;
    groups = [...left, ...new Array(fill).fill('0'), ...right];
  }
  if (groups.length !== 8) return null;
  return groups.map((g) => parseInt(g, 16));
}

function isBlockedV6(ip) {
  const g = expandV6(ip);
  if (!g) return true; // nerozluštitelné → raději blokovat

  // ::1 loopback, :: unspecified
  const allZeroButLast = g.slice(0, 7).every((x) => x === 0);
  if (allZeroButLast && (g[7] === 1 || g[7] === 0)) return true;

  // IPv4-mapped ::ffff:0:0/96 a IPv4-compatible ::/96 → posuď jako IPv4.
  const isMapped = g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff;
  const isCompat = g.slice(0, 6).every((x) => x === 0);
  // IPv4-translated ::ffff:0:0:0/96 (RFC 6052/SIIT) — jiný tvar téhož.
  const isTranslated = g.slice(0, 4).every((x) => x === 0) && g[4] === 0xffff && g[5] === 0;
  if (isMapped || isCompat || isTranslated) {
    const v4 = [g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff].join('.');
    return isBlockedV4(v4);
  }

  // 6to4 (2002::/16) nese cílovou IPv4 ve druhé a třetí skupině. Bez tohohle
  // by `2002:7f00:1::` propašovalo loopback.
  if (g[0] === 0x2002) {
    const v4 = [g[1] >> 8, g[1] & 0xff, g[2] >> 8, g[2] & 0xff].join('.');
    return isBlockedV4(v4);
  }

  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g[0] & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  // 64:ff9b::/96 NAT64 — překládá se na libovolnou IPv4, včetně interní.
  if (g[0] === 0x64 && g[1] === 0xff9b) return true;
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // dokumentační 2001:db8::/32

  return false;
}

function isBlockedIp(ip) {
  const type = net.isIP(ip);
  if (type === 4) return isBlockedV4(ip);
  if (type === 6) return isBlockedV6(ip);
  return true; // neznámý formát → raději blokovat
}

/**
 * Ověří, že URL je veřejná http(s) adresa. Vrací normalizovaný URL string,
 * jinak vyhodí Error se srozumitelnou zprávou.
 */
/**
 * Porty, na které smí nástroj sáhnout.
 *
 * PROČ VŮBEC OMEZOVAT
 * Bez omezení stačilo přesměrování na `https://cizi-host.example:25/` a
 * skener poslal ručně sestavený ClientHello na poštovní port libovolného
 * veřejného stroje — a výsledek („na tomhle portu něco běží a je/není to
 * TLS") vrátil zadavateli. Z auditního nástroje se tím stane pomalý, ale
 * funkční skener portů, který běží pod naší adresou a naší pověstí.
 *
 * Allowlist, ne blocklist: seznam portů, kde běží web, je krátký a známý,
 * kdežto seznam všeho, co jinde poslouchat může, nikdy úplný nebude.
 */
export const ALLOWED_TARGET_PORTS = new Set([80, 443, 8000, 8080, 8443, 8888]);

/**
 * Ověří URL a vrátí i adresy, na které se přeložila.
 *
 * PROČ NESTAČÍ VRÁTIT JEN ŘETĚZEC
 * `assertPublicHttpUrl` adresy ověřila a zahodila. Volající pak předal
 * hostname dál a `tls.connect` i `net.connect` si udělaly VLASTNÍ překlad —
 * u jedné TLS sondy osmkrát. Mezi kontrolou a spojením tak byla díra, do
 * které se vejde záznam s TTL 0, který napoprvé vrátí veřejnou adresu a
 * podruhé `169.254.169.254`. Ověření se dá obejít prostě tím, že se počká
 * na druhý dotaz.
 *
 * Vrácená adresa se proto předává až do místa, kde se otevírá socket, a
 * jméno se používá jen pro SNI a ověření certifikátu.
 *
 * @returns {Promise<{url: string, hostname: string, port: number, address: string, addresses: string[]}>}
 */
export async function resolvePublicHttpTarget(rawUrl) {
  const url = await assertPublicHttpUrl(rawUrl, { returnDetails: true });
  return url;
}

export async function assertPublicHttpUrl(rawUrl, { returnDetails = false } = {}) {
  if (!rawUrl || typeof rawUrl !== 'string') {
    throw new Error('Chybí nebo neplatná URL.');
  }

  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('Neplatný formát URL.');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Povoleno je pouze schéma http nebo https.');
  }

  // WHATWG URL vrací IPv6 hostname VČETNĚ hranatých závorek
  // (`http://[::1]/` → `[::1]`). `net.isIP()` na to vrací 0, takže literál
  // spadl do DNS větve a celá logika isBlockedV6 byla pro přímé literály mrtvá.
  // Prakticky to selhávalo bezpečně (dns.lookup('[::1]') vždy skončí chybou),
  // ale náhodou, ne záměrem — a legitimní IPv6 cíle to blokovalo taky.
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');

  const port = parsed.port ? Number(parsed.port) : (parsed.protocol === 'https:' ? 443 : 80);
  if (!ALLOWED_TARGET_PORTS.has(port)) {
    throw new Error(
      `Port ${port} není mezi povolenými (${[...ALLOWED_TARGET_PORTS].join(', ')}). ` +
        'Nástroj audituje weby, takže na jiné porty nesahá — jinak by z něj ' +
        'šlo udělat skener portů.'
    );
  }

  const vysledek = (address, addresses) =>
    returnDetails
      ? { url: parsed.toString(), hostname, port, address, addresses }
      : parsed.toString();

  // Když je hostname přímo IP, ověř ji rovnou.
  if (net.isIP(hostname)) {
    if (isBlockedIp(hostname)) {
      throw new Error('Cílová adresa míří na neveřejný/interní rozsah IP.');
    }
    return vysledek(hostname, [hostname]);
  }

  // Zablokuj zjevné lokální názvy.
  const lower = hostname.toLowerCase();
  if (lower === 'localhost' || lower.endsWith('.localhost') || lower.endsWith('.local') || lower.endsWith('.internal')) {
    throw new Error('Cílová adresa míří na lokální/interní hostname.');
  }

  // Resolvuj hostname a ověř VŠECHNY vrácené IP.
  let addresses;
  try {
    addresses = await dns.lookup(hostname, { all: true });
  } catch {
    throw new Error('Hostname se nepodařilo přeložit (DNS).');
  }
  if (!addresses.length) {
    throw new Error('Hostname nemá žádnou IP adresu.');
  }
  for (const { address } of addresses) {
    if (isBlockedIp(address)) {
      throw new Error('Cílová adresa se resolvuje na neveřejný/interní rozsah IP.');
    }
  }

  // První ověřená adresa je ta, na kterou se smí připojit. Ostatní se vracejí
  // jen pro úplnost; kdyby se volající rozhodl zkusit jinou, musí být taky
  // z tohohle seznamu, ne z nového překladu.
  return vysledek(addresses[0].address, addresses.map((a) => a.address));
}

/**
 * Hlídá navigaci prohlížeče, ne jen zadanou URL.
 *
 * PROČ TO NESTAČÍ OVĚŘIT PŘED SPUŠTĚNÍM
 * `assertPublicHttpUrl` posoudí adresu, kterou poslal klient. Prohlížeč pak
 * přesměrování následuje sám. Útočníkovi stačí veřejná adresa vracející
 * `302 → http://169.254.169.254/…` a sken skončí na vnitřní síti — a co tam
 * uvidí, pošle zpátky: ve screenshotu, v `document.body.innerText`, nebo
 * v `violations[].nodes[].html`.
 *
 * Kontrola tady byla dosud jen v jednom skeneru z osmi. Spoléhat na to, že si
 * ji každý nový skener připíše, je otázka času; proto se zapíná na kontextu.
 *
 * CO SE HLÍDÁ
 * Jen navigační požadavky hlavního rámce. Podřízené zdroje (obrázky, skripty)
 * se nefiltrují záměrně: web běžně načítá stovky adres, ověřovat každou přes
 * DNS by sken zpomalilo na neúnosnou míru a přínos je malý — obsah takového
 * požadavku se do reportu nedostane.
 *
 * @param {import('playwright').BrowserContext} context
 * @param {(url: string, reason: string) => void} [onBlocked] volitelné hlášení
 */
export async function guardNavigation(context, onBlocked) {
  // Napodobenina kontextu v testech `route` nemá. Chybějící hlídač je vážná
  // věc a nesmí projít tiše, ale shodit kvůli tomu běh by bylo horší.
  if (typeof context?.route !== 'function') {
    console.warn('[SSRF] Kontext neumí route() — hlídač navigace se nezapnul.');
    return;
  }
  await context.route('**/*', async (route, request) => {
    // Jen navigace hlavního rámce: `parentFrame() === null` ho odliší
    // od iframu, jehož obsah se do reportu nedostane.
    if (!request.isNavigationRequest() || request.frame().parentFrame() !== null) {
      return route.continue();
    }
    try {
      await assertPublicHttpUrl(request.url());
      return route.continue();
    } catch (err) {
      // `abort` je záměr: prohlížeč dostane síťovou chybu, sken pokračuje
      // s tím, co má, a do reportu se nedostane nic z vnitřní sítě.
      if (onBlocked) onBlocked(request.url(), err.message);
      else console.warn(`[SSRF] Navigace zablokována: ${request.url()} — ${err.message}`);
      return route.abort('blockedbyclient');
    }
  });
}
