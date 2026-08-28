import { describe, test, expect, beforeEach, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useArtifact } from './useArtifact.js';

/**
 * Načítání artefaktů.
 *
 * Token se dřív propašoval do query stringu, protože <img src> neumí
 * posílat hlavičky. Caddy ale zapisuje celé URI do access logu s retencí
 * 720 h — kdo se dostal k logům, dostal se ke všem screenshotům.
 */

const getToken = () => Promise.resolve('token-abc');

beforeEach(() => {
  global.URL.createObjectURL = vi.fn(() => 'blob:vytvoreno');
  global.URL.revokeObjectURL = vi.fn();
});

test('token jde v hlavičce, ne v adrese', async () => {
  global.fetch = vi.fn(async () => ({ ok: true, blob: async () => new Blob(['x']) }));

  const { result } = renderHook(() => useArtifact('/api/screenshots/a.png', getToken));
  await waitFor(() => expect(result.current.objectUrl).toBe('blob:vytvoreno'));

  const [url, opts] = global.fetch.mock.calls[0];
  expect(url).toBe('/api/screenshots/a.png');
  expect(url).not.toMatch(/[?&]t=/);
  expect(opts.headers.Authorization).toBe('Bearer token-abc');
});

test('chybová odpověď se ukáže s hláškou ze serveru', async () => {
  global.fetch = vi.fn(async () => ({
    ok: false,
    status: 404,
    json: async () => ({ error: 'Artefakt nenalezen.' }),
  }));

  const { result } = renderHook(() => useArtifact('/api/screenshots/a.png', getToken));
  await waitFor(() => expect(result.current.error).toBe('Artefakt nenalezen.'));
  expect(result.current.objectUrl).toBeNull();
});

test('bez adresy se nic nenačítá', () => {
  global.fetch = vi.fn();
  const { result } = renderHook(() => useArtifact(null, getToken));
  expect(global.fetch).not.toHaveBeenCalled();
  expect(result.current.loading).toBe(false);
});

test('blob se uvolní při odpojení', async () => {
  // Bez uvolnění drží paměť až do zavření záložky. Při proklikávání kroků
  // testu by se to nasčítalo do stovek megabajtů.
  global.fetch = vi.fn(async () => ({ ok: true, blob: async () => new Blob(['x']) }));

  const { result, unmount } = renderHook(() => useArtifact('/api/screenshots/a.png', getToken));
  await waitFor(() => expect(result.current.objectUrl).toBe('blob:vytvoreno'));

  unmount();
  expect(global.URL.revokeObjectURL).toHaveBeenCalledWith('blob:vytvoreno');
});

test('selhání sítě nespadne, jen se ohlásí', async () => {
  global.fetch = vi.fn(async () => {
    throw new Error('síť');
  });

  const { result } = renderHook(() => useArtifact('/api/screenshots/a.png', getToken));
  await waitFor(() => expect(result.current.error).toBe('síť'));
});
