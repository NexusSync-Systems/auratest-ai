import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import CaseFilePanel from './CaseFilePanel.jsx';

/**
 * Sekce Doložitelnost.
 *
 * Spis je to, co zákazník při kontrole odevzdává. Funkce, ke které se
 * nedá dostat, je stejně dobrá jako neexistující — proto tenhle panel.
 */

const getToken = async () => 'tok';

const chainResponse = (payload) => ({
  ok: true,
  status: 200,
  headers: { get: () => 'application/json' },
  json: async () => payload,
});

beforeEach(() => {
  global.URL.createObjectURL = vi.fn(() => 'blob:test');
  global.URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('stav řetězu', () => {
  test('neporušený řetěz se ohlásí i s počtem položek', async () => {
    global.fetch = vi.fn(async () => chainResponse({ ok: true, count: 12, problems: [] }));
    render(<CaseFilePanel getToken={getToken} />);
    expect(await screen.findByText(/Řetěz je neporušený — 12 položek/)).toBeInTheDocument();
  });

  test('zelený stav nesvádí k závěru, že je záznam neprůstřelný', async () => {
    // Bez téhle věty by uživatel odevzdal spis s vírou, že dokazuje víc,
    // než dokazuje.
    global.fetch = vi.fn(async () => chainResponse({ ok: true, count: 1, problems: [] }));
    render(<CaseFilePanel getToken={getToken} />);
    expect(await screen.findByText(/nedokazuje\s+to nemožnost podvrhu/i)).toBeInTheDocument();
  });

  test('zelený stav nevylučuje useknutí konce řetězu', async () => {
    // Odmazání nejnovějších položek je bez vnějšího ukotvení nedetekovatelné,
    // a právě konec je to, co by útočník mazal. Věta „žádný záznam nebyl
    // odstraněn" bez téhle výhrady tvrdí víc, než ověření dokládá.
    global.fetch = vi.fn(async () => chainResponse({ ok: true, count: 1, problems: [] }));
    render(<CaseFilePanel getToken={getToken} />);
    expect(await screen.findByText(/[Uu]seknutí konce/)).toBeInTheDocument();
  });

  test('porušený řetěz vypíše, kde k zásahu došlo', async () => {
    global.fetch = vi.fn(async () =>
      chainResponse({
        ok: false,
        count: 5,
        problems: [{ index: 2, problem: 'Otisk nesedí s obsahem' }],
      })
    );
    render(<CaseFilePanel getToken={getToken} />);
    expect(await screen.findByText(/Řetěz je porušený/)).toBeInTheDocument();
    // sessionId se ve výpisu NEUVÁDÍ: ověření běží nad podmnožinou vlastníka,
    // ale identifikátory do hlášky o porušení stejně nepatří.
    expect(screen.getByText(/položka 2/)).toBeInTheDocument();
  });

  test('nedostupné ověření se přizná, nevydává se za pořádek', async () => {
    global.fetch = vi.fn(async () => ({ ok: false, status: 500, headers: { get: () => null } }));
    render(<CaseFilePanel getToken={getToken} />);
    expect(await screen.findByText(/Ověření se nepodařilo načíst/)).toBeInTheDocument();
    expect(screen.queryByText(/neporušený/)).toBeNull();
  });
});

describe('export spisu', () => {
  test('do dotazu jde celý poslední den období', async () => {
    // Bez posunu na konec dne by poslední den vypadl a uživatel by to
    // nepoznal — ve spisu by prostě chyběl jeden den měření.
    global.fetch = vi.fn(async (url) => {
      if (String(url).includes('/api/ledger/verify')) {
        return chainResponse({ ok: true, count: 0, problems: [] });
      }
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        blob: async () => new Blob(['pdf']),
      };
    });

    render(<CaseFilePanel getToken={getToken} />);
    await screen.findByText(/neporušený/);

    await userEvent.click(screen.getByRole('button', { name: /Stáhnout PDF/ }));

    await waitFor(() => {
      const call = global.fetch.mock.calls.find((c) => String(c[0]).includes('/api/case-file'));
      expect(call).toBeTruthy();
      // Datum se posílá tak, jak ho uživatel zadal. Konec období na celý den
      // řeší server — obcházet to tady znamenalo, že to platilo jen pro tenhle
      // formulář a přímé volání API o poslední den měření tiše přišlo.
      const query = decodeURIComponent(String(call[0]));
      expect(query).not.toContain('T23:59:59.999Z');
      expect(query).toMatch(/to=\d{4}-\d{2}-\d{2}/);
    });
  });

  test('selhání exportu se ukáže uživateli', async () => {
    global.fetch = vi.fn(async (url) => {
      if (String(url).includes('/api/ledger/verify')) {
        return chainResponse({ ok: true, count: 0, problems: [] });
      }
      return {
        ok: false,
        status: 400,
        headers: { get: () => null },
        json: async () => ({ error: 'Neplatné datum v parametru from.' }),
      };
    });

    render(<CaseFilePanel getToken={getToken} />);
    await screen.findByText(/neporušený/);

    await userEvent.click(screen.getByRole('button', { name: /Stáhnout JSON/ }));

    expect(await screen.findByText(/Neplatné datum v parametru from/)).toBeInTheDocument();
  });

  test('obě pole období mají popisky', async () => {
    // Nástroj audituje WCAG u cizích webů; vlastní formulář bez popisků
    // by byl trapný.
    global.fetch = vi.fn(async () => chainResponse({ ok: true, count: 0, problems: [] }));
    render(<CaseFilePanel getToken={getToken} />);
    expect(await screen.findByLabelText('Od')).toBeInTheDocument();
    expect(screen.getByLabelText('Do')).toBeInTheDocument();
  });
});
