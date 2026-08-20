import { describe, it, expect, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useAudits, AUDIT_IDS } from './useAudits.js';

describe('useAudits', () => {
  it('začíná se všemi audity ve stavu idle', () => {
    const { result } = renderHook(() => useAudits());

    for (const id of AUDIT_IDS) {
      expect(result.current.audits[id]).toEqual({ status: 'idle', data: null, error: null });
    }
    expect(result.current.isAnyLoading).toBe(false);
    expect(result.current.hasAnyResult).toBe(false);
  });

  it('run() zapne loading a po úspěchu uloží data', async () => {
    const { result } = renderHook(() => useAudits());

    let resolve;
    const pending = new Promise((r) => { resolve = r; });

    act(() => { result.current.run('a11y', () => pending); });

    // Loading se musí zapnout SÁM — dřív ho pět handlerů jen vypínalo.
    expect(result.current.audits.a11y.status).toBe('loading');
    expect(result.current.isAnyLoading).toBe(true);

    await act(async () => {
      resolve({ violations: [] });
      await pending;
    });

    await waitFor(() => expect(result.current.audits.a11y.status).toBe('done'));
    expect(result.current.audits.a11y.data).toEqual({ violations: [] });
    expect(result.current.isAnyLoading).toBe(false);
    expect(result.current.hasAnyResult).toBe(true);
  });

  it('run() zachytí chybu a vypne loading', async () => {
    const { result } = renderHook(() => useAudits());

    await act(async () => {
      await result.current.run('nis2', async () => {
        throw new Error('audit selhal');
      }).catch(() => {});
    });

    expect(result.current.audits.nis2.status).toBe('error');
    expect(result.current.audits.nis2.error).toBe('audit selhal');
    expect(result.current.isAnyLoading).toBe(false);
  });

  it('isAnyLoading pokrývá KAŽDÝ audit, ne jen ručně vyjmenované', async () => {
    // Regrese: aiAct a chaos v isAnyAuditLoading chyběly, takže se
    // při jejich samostatném spuštění nezobrazil spinner.
    for (const id of AUDIT_IDS) {
      const { result, unmount } = renderHook(() => useAudits());
      act(() => { result.current.start(id); });
      expect(result.current.isAnyLoading).toBe(true);
      unmount();
    }
  });

  it('resetAll vyčistí KAŽDÝ audit', async () => {
    // Regrese: clearAllResults nečistil aiActResult ani chaosResult,
    // takže staré výsledky visely přes nové běhy.
    const { result } = renderHook(() => useAudits());

    await act(async () => {
      for (const id of AUDIT_IDS) {
        await result.current.run(id, async () => ({ id }));
      }
    });

    expect(result.current.hasAnyResult).toBe(true);

    act(() => { result.current.resetAll(); });

    for (const id of AUDIT_IDS) {
      expect(result.current.audits[id].status).toBe('idle');
      expect(result.current.audits[id].data).toBeNull();
    }
    expect(result.current.hasAnyResult).toBe(false);
  });

  it('audity se navzájem neovlivňují', async () => {
    const { result } = renderHook(() => useAudits());

    await act(async () => {
      await result.current.run('cookie', async () => ({ gdpr: {} }));
    });
    act(() => { result.current.start('chaos'); });

    expect(result.current.audits.cookie.status).toBe('done');
    expect(result.current.audits.chaos.status).toBe('loading');
    expect(result.current.audits.a11y.status).toBe('idle');
  });

  it('run vrátí data volajícímu', async () => {
    const { result } = renderHook(() => useAudits());
    const fn = vi.fn(async () => ({ ok: true }));

    let returned;
    await act(async () => {
      returned = await result.current.run('green', fn);
    });

    expect(returned).toEqual({ ok: true });
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
