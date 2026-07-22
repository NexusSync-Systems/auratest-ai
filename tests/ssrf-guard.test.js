import { assertPublicHttpUrl } from '../ssrf-guard.js';

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
