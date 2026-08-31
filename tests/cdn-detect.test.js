import { cdnFromHeaders, cdnFromHostname, detectCdn } from '../cdn-detect.js';

/**
 * Poznávání CDN z hlaviček.
 *
 * Dokud se hledalo jen v hostname, proxovaná doména se nepoznala vůbec —
 * `www.klient.cz` za Cloudflare si jméno nechává. Geolokace jeho anycast
 * adresy pak ukázala na nejbližší PoP a report tvrdil „prokazatelně mimo
 * EU/EHP" o webu hostovaném v Praze.
 */

describe('CDN podle hlaviček', () => {
  const pripady = [
    ['Cloudflare přes cf-ray', { 'cf-ray': '8a1b2c3d4e5f-PRG' }, 'Cloudflare'],
    ['Cloudflare přes server', { server: 'cloudflare' }, 'Cloudflare'],
    ['CloudFront přes x-amz-cf-id', { 'x-amz-cf-id': 'abc123' }, 'Amazon CloudFront'],
    ['CloudFront přes via', { via: '1.1 abc.cloudfront.net (CloudFront)' }, 'Amazon CloudFront'],
    ['Fastly', { 'x-served-by': 'cache-prg-1234' }, 'Fastly'],
    ['Akamai', { server: 'AkamaiGHost' }, 'Akamai'],
    ['Azure', { 'x-azure-ref': '0abc' }, 'Microsoft Azure'],
    ['Vercel', { 'x-vercel-id': 'prg1::abc' }, 'Vercel'],
    ['Netlify', { 'x-nf-request-id': 'abc' }, 'Netlify'],
  ];

  for (const [popis, headers, provider] of pripady) {
    it(popis, () => {
      expect(cdnFromHeaders(headers)?.provider).toBe(provider);
    });
  }

  it('velikost písmen v názvu hlavičky nerozhoduje', () => {
    expect(cdnFromHeaders({ 'CF-Ray': 'abc' })?.provider).toBe('Cloudflare');
  });

  it('běžný server bez CDN se nepozná jako CDN', () => {
    expect(cdnFromHeaders({ server: 'nginx/1.24.0', 'content-type': 'text/html' })).toBeNull();
    expect(cdnFromHeaders({ server: 'Apache' })).toBeNull();
    expect(cdnFromHeaders({})).toBeNull();
    expect(cdnFromHeaders(null)).toBeNull();
  });

  it('prázdná hodnota hlavičky se nepočítá', () => {
    // Jinak by stačilo, aby proxy hlavičku vytvořila prázdnou.
    expect(cdnFromHeaders({ 'cf-ray': '' })).toBeNull();
  });
});

describe('CDN podle jména — druhý signál', () => {
  it('pozná adresu poskytovatele', () => {
    expect(cdnFromHostname('d111.cloudfront.net')?.provider).toBe('cloudfront');
    expect(cdnFromHostname('www.gstatic.com')?.provider).toBe('gstatic.com');
  });

  it('vlastní doménu za CDN podle jména nepozná — proto ty hlavičky', () => {
    expect(cdnFromHostname('www.klient.cz')).toBeNull();
  });
});

describe('detectCdn — hlavičky mají přednost', () => {
  it('proxovaná vlastní doména se pozná z hlaviček', () => {
    // Přesně scénář, kvůli kterému oprava vznikla.
    const r = detectCdn('www.klient.cz', { 'cf-ray': '8a1b-PRG', server: 'cloudflare' });
    expect(r?.provider).toBe('Cloudflare');
    expect(r?.evidence).toMatch(/hlavička/);
  });

  it('bez hlaviček se sáhne po jménu', () => {
    const r = detectCdn('d111.cloudfront.net', {});
    expect(r?.provider).toBe('cloudfront');
    expect(r?.evidence).toMatch(/hostname/);
  });

  it('vlastní hosting není CDN ani jednou cestou', () => {
    expect(detectCdn('www.klient.cz', { server: 'nginx' })).toBeNull();
  });
});
