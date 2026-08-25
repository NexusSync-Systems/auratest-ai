import { resolveSpaFallback } from '../spa-fallback.js';

/**
 * Kdy vrátit index.html a kdy 404.
 *
 * Motivace: veřejná stránka s ukázkovým reportem hlásila
 * „The string did not match the expected pattern". Vypadalo to jako chyba
 * v parsování, ve skutečnosti chyběl `sample-report.json` — server na něj
 * odpověděl index.html se stavem 200, takže `response.ok` bylo true
 * a spadl až `JSON.parse`.
 */

describe('resolveSpaFallback', () => {
  test('cesty aplikace dostanou index.html', () => {
    for (const p of ['/', '/hub', '/agent', '/audit-prekladu', '/nastaveni', '/ukazka', '/prihlaseni']) {
      expect(resolveSpaFallback(p)).toMatchObject({ serveIndex: true, status: 200 });
    }
  });

  test('chybějící .json nedostane HTML, ale 404', () => {
    const r = resolveSpaFallback('/sample-report.json');
    expect(r.serveIndex).toBe(false);
    expect(r.status).toBe(404);
  });

  test('ostatní statické soubory taky', () => {
    for (const p of [
      '/assets/index-abc123.js',
      '/assets/index-abc123.css',
      '/favicon.svg',
      '/assets/font.woff2',
      '/assets/index.js.map',
    ]) {
      expect(resolveSpaFallback(p).serveIndex).toBe(false);
    }
  });

  test('neexistující API endpoint vrací 404, ne stránku', () => {
    // Jinak by monitoring viděl zdravý stav u endpointu, který neexistuje.
    const r = resolveSpaFallback('/api/neexistuje');
    expect(r.serveIndex).toBe(false);
    expect(r.status).toBe(404);
    expect(r.reason).toMatch(/endpoint/i);
  });

  test('API a soubor mají rozdílné hlášky', () => {
    // Ať je z odpovědi poznat, co vlastně chybí.
    const api = resolveSpaFallback('/api/x');
    const file = resolveSpaFallback('/x.json');
    expect(api.reason).not.toBe(file.reason);
  });

  test('cesta s tečkou, která není příponou souboru, zůstane cestou aplikace', () => {
    // Osmiznakový strop v regexu má bránit tomu, aby se kus cesty
    // vyhodnotil jako přípona.
    expect(resolveSpaFallback('/verze/1.2.3-kandidat').serveIndex).toBe(true);
  });

  test('prázdná nebo chybějící cesta nespadne', () => {
    for (const value of [undefined, null, '']) {
      expect(resolveSpaFallback(value).serveIndex).toBe(true);
    }
  });
});
