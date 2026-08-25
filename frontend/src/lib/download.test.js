import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { downloadAuthenticated, filenameFromDisposition } from './download.js';

/**
 * Stahování z endpointu za přihlášením.
 *
 * Obvyklé „řešení" je propašovat token do query — jenže ten pak zůstane
 * v historii prohlížeče, v logu proxy i v hlavičce Referer. U nástroje,
 * který cizím webům vytýká úniky přes URL, obzvlášť nešťastné.
 */

describe('filenameFromDisposition', () => {
  test('vytáhne jméno z běžné hlavičky', () => {
    expect(filenameFromDisposition('attachment; filename="spis.pdf"', 'z.pdf')).toBe('spis.pdf');
  });

  test('dá přednost UTF-8 variantě', () => {
    const header = "attachment; filename=\"spis.pdf\"; filename*=UTF-8''spis-audit%C5%AF.pdf";
    expect(filenameFromDisposition(header, 'z.pdf')).toBe('spis-auditů.pdf');
  });

  test('vadné kódování stahování neshodí', () => {
    const header = "attachment; filename*=UTF-8''%E0%A4%A";
    expect(filenameFromDisposition(header, 'zaloha.pdf')).toBe('zaloha.pdf');
  });

  test('bez hlavičky použije záložní jméno', () => {
    // Soubor bez jména je pro uživatele horší než jméno obecné.
    expect(filenameFromDisposition(null, 'zaloha.pdf')).toBe('zaloha.pdf');
  });
});

describe('downloadAuthenticated', () => {
  let clicked;

  beforeEach(() => {
    clicked = [];
    global.URL.createObjectURL = vi.fn(() => 'blob:test');
    global.URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function spy() {
      clicked.push({ href: this.href, download: this.download });
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const okResponse = (headers = {}) => ({
    ok: true,
    status: 200,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    blob: async () => new Blob(['data']),
  });

  test('posílá token v hlavičce, ne v URL', () => {
    global.fetch = vi.fn(async () => okResponse());
    return downloadAuthenticated('/api/case-file?format=pdf', 'tajny-token', 'z.pdf').then(() => {
      const [url, init] = global.fetch.mock.calls[0];
      expect(url).not.toContain('tajny-token');
      expect(init.headers.Authorization).toBe('Bearer tajny-token');
    });
  });

  test('vrátí jméno souboru ze serveru', async () => {
    global.fetch = vi.fn(async () =>
      okResponse({ 'content-disposition': 'attachment; filename="spis-2026-08.pdf"' })
    );
    const name = await downloadAuthenticated('/api/case-file', 'tok', 'z.pdf');
    expect(name).toBe('spis-2026-08.pdf');
    expect(clicked[0].download).toBe('spis-2026-08.pdf');
  });

  test('uvolní objectURL i po úspěchu', async () => {
    // Bez toho drží blob paměť až do zavření záložky; při opakovaném
    // exportu spisu to nasčítá desítky MB.
    global.fetch = vi.fn(async () => okResponse());
    await downloadAuthenticated('/api/case-file', 'tok', 'z.pdf');
    expect(global.URL.revokeObjectURL).toHaveBeenCalledWith('blob:test');
  });

  test('chybovou hlášku vytáhne z odpovědi, nevrátí holé HTTP 400', async () => {
    global.fetch = vi.fn(async () => ({
      ok: false,
      status: 400,
      headers: { get: () => null },
      json: async () => ({ error: 'Neplatné datum v parametru from.' }),
    }));

    await expect(downloadAuthenticated('/api/case-file', 'tok', 'z.pdf')).rejects.toThrow(
      /Neplatné datum/
    );
  });

  test('když chybová odpověď není JSON, zůstane stavový kód', async () => {
    global.fetch = vi.fn(async () => ({
      ok: false,
      status: 502,
      headers: { get: () => null },
      json: async () => {
        throw new Error('není JSON');
      },
    }));

    await expect(downloadAuthenticated('/api/case-file', 'tok', 'z.pdf')).rejects.toThrow(
      /502/
    );
  });

  test('při chybě se nic nestáhne', async () => {
    global.fetch = vi.fn(async () => ({
      ok: false,
      status: 500,
      headers: { get: () => null },
      json: async () => ({ error: 'rozbito' }),
    }));

    await expect(downloadAuthenticated('/api/case-file', 'tok', 'z.pdf')).rejects.toThrow();
    expect(clicked).toHaveLength(0);
  });
});
