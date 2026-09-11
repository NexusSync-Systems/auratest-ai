import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import VersionBadge from './VersionBadge.jsx';

/**
 * Verze nasazení.
 *
 * Vznikla z konkrétního zádrhele: na snímku obrazovky chyběla nová část
 * UI a nedalo se rozhodnout, jestli je to nenasazený commit, nebo chyba
 * v kódu. Číslo verze ale musí platit stejné pravidlo jako všechno
 * ostatní — raději „nevím" než vymyšlená hodnota, protože podle něj se
 * rozhoduje, jestli nasadit znovu.
 */

const puvodniFetch = global.fetch;

const serverVraci = (data) => {
  global.fetch = vi.fn(() => Promise.resolve({
    ok: true, json: () => Promise.resolve(data),
  }));
};

beforeEach(() => {
  import.meta.env.VITE_GIT_COMMIT = '';
  import.meta.env.VITE_BUILD_TIME = '';
});

afterEach(() => {
  global.fetch = puvodniFetch;
  vi.restoreAllMocks();
});

describe('zobrazení verze', () => {
  test('bez zapečené verze se napíše, že není známá', async () => {
    // Vymyšlené číslo by bylo horší než žádné.
    serverVraci({ commit: null, buildTime: null });
    render(<VersionBadge />);
    expect(screen.getByText(/verze neznámá/i)).toBeInTheDocument();
  });

  test('commit a datum se vypíšou', () => {
    import.meta.env.VITE_GIT_COMMIT = '3488793abcdef';
    import.meta.env.VITE_BUILD_TIME = '2026-09-11T16:10:00Z';
    serverVraci({ commit: '3488793', buildTime: '2026-09-11T16:10:00Z' });

    render(<VersionBadge />);
    expect(screen.getByText(/3488793 · 2026-09-11/)).toBeInTheDocument();
  });
});

describe('neshoda verzí', () => {
  test('starý bundle v prohlížeči se řekne nahlas', async () => {
    // Přesně ten stav, kvůli kterému vznikl `lazy-with-reload.js`:
    // prohlížeč drží bundle z doby před nasazením.
    import.meta.env.VITE_GIT_COMMIT = 'aaaaaaa';
    serverVraci({ commit: 'bbbbbbb', buildTime: null });

    render(<VersionBadge />);
    await waitFor(() => {
      expect(screen.getByText(/Starší verze v prohlížeči/)).toBeInTheDocument();
    });
  });

  test('shodné verze nic nehlásí', async () => {
    import.meta.env.VITE_GIT_COMMIT = 'aaaaaaa';
    serverVraci({ commit: 'aaaaaaa', buildTime: null });

    render(<VersionBadge />);
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    expect(screen.queryByText(/Starší verze/)).not.toBeInTheDocument();
  });

  test('nedostupná verze serveru NENÍ neshoda', async () => {
    // Tvrdit „máte starou verzi" jen proto, že se server neozval, by
    // bylo tvrzení z chybějícího údaje.
    import.meta.env.VITE_GIT_COMMIT = 'aaaaaaa';
    global.fetch = vi.fn(() => Promise.reject(new Error('offline')));

    render(<VersionBadge />);
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    expect(screen.queryByText(/Starší verze/)).not.toBeInTheDocument();
  });

  test('neznámá verze frontendu taky není neshoda', async () => {
    serverVraci({ commit: 'bbbbbbb', buildTime: null });
    render(<VersionBadge />);
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    expect(screen.queryByText(/Starší verze/)).not.toBeInTheDocument();
  });
});
