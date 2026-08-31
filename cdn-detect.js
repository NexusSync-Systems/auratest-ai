/**
 * Poznávání CDN a sítí typu anycast.
 *
 * PROČ TO NEJDE POZNAT PODLE JMÉNA
 * Dosud se CDN hledala v hostname — `*.cloudfront.net`, `*.web.app` a
 * podobně. To ale zachytí jen případ, kdy zákazník používá adresu
 * poskytovatele. Nejběžnější nasazení Cloudflare jméno NEMĚNÍ: doména
 * `www.klient.cz` zůstane `www.klient.cz` a jen se přeloží na anycast
 * adresu.
 *
 * Následek byl vážný. Geolokace takové adresy ukáže nejbližší PoP, což
 * z Frankfurtu bývá Německo, ale ze Singapuru Singapur. Web hostovaný
 * v Praze tak dostal do reportu „prokazatelně mimo EU/EHP" a zákazník
 * měl v ruce doklad, že vozí data do třetí země. Přesně ta chyba, která
 * stojí důvěru: nástroj hlásí nález na webu, který je v pořádku.
 *
 * JAK TO JDE POZNAT
 * Podle hlaviček odpovědi. CDN se samy hlásí, protože to potřebují pro
 * ladění a cache. Jsou to tytéž hlavičky, které vidí každý v konzoli
 * prohlížeče, takže na tom není nic domyšleného.
 *
 * CO Z TOHO PLYNE PRO VERDIKT
 * Poznaná CDN NENÍ nález. Je to zjištění, že se rezidence dat z IP
 * určit nedá — a to se musí říct, ne obejít. Umístění dat u takového
 * webu doloží smlouva s poskytovatelem, ne naše měření.
 */

/**
 * Otisky CDN v hlavičkách odpovědi.
 *
 * `header` se hledá vždy; `value` je nepovinné zpřesnění, protože
 * některé hlavičky (`via`, `server`) používá kdekdo.
 */
const HEADER_SIGNATURES = [
  { name: 'Cloudflare', header: 'cf-ray' },
  { name: 'Cloudflare', header: 'server', value: /cloudflare/i },
  { name: 'Amazon CloudFront', header: 'x-amz-cf-id' },
  { name: 'Amazon CloudFront', header: 'via', value: /cloudfront/i },
  { name: 'Fastly', header: 'x-served-by', value: /cache-/i },
  { name: 'Fastly', header: 'x-fastly-request-id' },
  { name: 'Akamai', header: 'x-akamai-transformed' },
  { name: 'Akamai', header: 'server', value: /akamai/i },
  { name: 'Google', header: 'server', value: /^(?:gse|gws|esf)$/i },
  { name: 'Microsoft Azure', header: 'x-azure-ref' },
  { name: 'Microsoft Azure', header: 'x-ms-ref' },
  { name: 'Vercel', header: 'x-vercel-id' },
  { name: 'Netlify', header: 'x-nf-request-id' },
  { name: 'Bunny', header: 'server', value: /bunnycdn/i },
  { name: 'Sucuri', header: 'x-sucuri-id' },
  { name: 'Imperva', header: 'x-iinfo' },
  { name: 'Varnish/neurčeno', header: 'x-varnish' },
];

/**
 * Jména, která CDN prozradí sama.
 *
 * Zůstávají jako druhý signál: u požadavků, jejichž hlavičky se nepodařilo
 * přečíst (CORS, přerušená odpověď), je jméno pořád lepší než nic.
 */
export const ANYCAST_CDN_PATTERNS = [
  'cloudflare', 'cdn.cloudflare', 'fastly', 'akamai', 'akamaized', 'edgekey',
  'edgesuite', 'cloudfront', 'azureedge', 'azurefd', 'stackpathdns',
  'web.app', 'firebaseapp.com', 'firebasestorage', 'googleusercontent',
  'gstatic.com', 'googleapis.com', 'ggpht.com', 'jsdelivr', 'unpkg',
  'bunnycdn', 'b-cdn.net', 'vercel.app', 'netlify.app', 'pages.dev',
];

/** Poznává CDN podle jména hostitele. Slabší signál — viz hlavička modulu. */
export function cdnFromHostname(hostname) {
  const host = String(hostname || '').toLowerCase();
  const hit = ANYCAST_CDN_PATTERNS.find((needle) => host.includes(needle));
  return hit ? { provider: hit, evidence: `hostname obsahuje „${hit}"` } : null;
}

/**
 * Poznává CDN podle hlaviček odpovědi.
 *
 * @param {Record<string,string>} headers  názvy malými písmeny, jak je vrací Playwright
 * @returns {{provider: string, evidence: string}|null}
 */
export function cdnFromHeaders(headers) {
  if (!headers || typeof headers !== 'object') return null;
  // Playwright vrací názvy malými písmeny, ale spoléhat na to by znamenalo,
  // že se detekce tiše rozbije, až se sem data dostanou odjinud.
  const lower = {};
  for (const [k, v] of Object.entries(headers)) lower[String(k).toLowerCase()] = v;

  for (const sig of HEADER_SIGNATURES) {
    const raw = lower[sig.header];
    if (raw === undefined || raw === null || raw === '') continue;
    if (sig.value && !sig.value.test(String(raw))) continue;
    return { provider: sig.name, evidence: `hlavička ${sig.header}` };
  }
  return null;
}

/**
 * Souhrnné rozhodnutí pro jednu doménu.
 *
 * Hlavičky mají přednost: jsou to údaje z konkrétní odpovědi, kdežto jméno
 * je jen domněnka o poskytovateli.
 */
export function detectCdn(hostname, headers) {
  return cdnFromHeaders(headers) || cdnFromHostname(hostname);
}
