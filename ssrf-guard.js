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
  '198.51.100.0/24',
  '203.0.113.0/24',
  '224.0.0.0/4',     // multicast
  '240.0.0.0/4',     // reserved
];

function isBlockedV4(ip) {
  return BLOCKED_V4.some((cidr) => inRange(ip, cidr));
}

function isBlockedV6(ip) {
  const v = ip.toLowerCase();
  if (v === '::1' || v === '::') return true;            // loopback / unspecified
  if (v.startsWith('fe80')) return true;                 // link-local
  if (v.startsWith('fc') || v.startsWith('fd')) return true; // unique local (fc00::/7)
  // IPv4-mapped (::ffff:a.b.c.d) → ověř jako IPv4
  const mapped = v.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isBlockedV4(mapped[1]);
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
export async function assertPublicHttpUrl(rawUrl) {
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

  const hostname = parsed.hostname;

  // Když je hostname přímo IP, ověř ji rovnou.
  if (net.isIP(hostname)) {
    if (isBlockedIp(hostname)) {
      throw new Error('Cílová adresa míří na neveřejný/interní rozsah IP.');
    }
    return parsed.toString();
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

  return parsed.toString();
}
