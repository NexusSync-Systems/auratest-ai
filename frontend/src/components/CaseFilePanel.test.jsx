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

/**
 * Odpověď `/api/ledger/verify`.
 *
 * `fullChainOk` a `ownRecordsOk` mají výchozí hodnoty odvozené od `ok`,
 * aby starší fixtury dál dávaly smysl — endpoint je vrací vždy.
 */
const chainResponse = (payload) => ({
  ok: true,
  status: 200,
  headers: { get: () => 'application/json' },
  json: async () => ({
    fullChainOk: payload.ok,
    ownRecordsOk: payload.ok,
    ...payload,
  }),
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
    expect(await screen.findByText(/12 vašich položek/)).toBeInTheDocument();
  });

  test('zelený stav nesvádí k závěru, že je záznam neprůstřelný', async () => {
    // Bez téhle věty by uživatel odevzdal spis s vírou, že dokazuje víc,
    // než dokazuje.
    global.fetch = vi.fn(async () => chainResponse({ ok: true, count: 1, problems: [] }));
    render(<CaseFilePanel getToken={getToken} />);
    expect(await screen.findByText(/[Nn]edokazuje nemožnost podvrhu/)).toBeInTheDocument();
  });

  test('tvrzení o řetězu se omezuje na střed historie', async () => {
    // Odmazání nejnovějších položek je bez vnějšího ukotvení nedetekovatelné,
    // a právě konec je to, co by útočník mazal. Konec řetězu proto pokrývá
    // ukotvení (D6), ne tahle věta.
    global.fetch = vi.fn(async () => chainResponse({ ok: true, count: 1, problems: [] }));
    render(<CaseFilePanel getToken={getToken} />);
    expect(await screen.findByText(/z prostřed historie/)).toBeInTheDocument();
  });

  test('porušený řetěz vypíše, kde k zásahu došlo', async () => {
    global.fetch = vi.fn(async () =>
      chainResponse({
        ok: false,
        // Celý řetěz navazuje; porušený je konkrétní záznam uživatele.
        fullChainOk: true,
        ownRecordsOk: false,
        count: 5,
        problems: [{ index: 2, problem: 'Otisk nesedí s obsahem' }],
      })
    );
    render(<CaseFilePanel getToken={getToken} />);
    expect(await screen.findByText(/[Vv]aše záznamy jsou porušené/)).toBeInTheDocument();
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
    await screen.findByText(/v pořádku/);

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
    await screen.findByText(/v pořádku/);

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


describe('ukotvení otisku (D6)', () => {
  test('bez kotvy se zelený stav nevydává za neprůstřelný', async () => {
    // Řetěz může být „neporušený" a přesto mu chybět konec. Uživatel se to
    // musí dozvědět dřív, než spis odevzdá.
    global.fetch = vi.fn(async () =>
      chainResponse({
        ok: true,
        count: 3,
        problems: [],
        anchor: {
          state: 'none',
          anchoredAt: null,
          rationale: 'Otisk řetězu nebyl dosud ukotven mimo tento systém.',
        },
      })
    );
    render(<CaseFilePanel getToken={getToken} />);
    expect(await screen.findByText(/nebyl ukotven mimo tenhle systém/)).toBeInTheDocument();
  });

  test('chybějící ukotvený otisk se hlásí jako problém', async () => {
    global.fetch = vi.fn(async () =>
      chainResponse({
        ok: true,
        count: 3,
        problems: [],
        anchor: {
          state: 'broken',
          anchoredAt: '2026-08-20T06:00:00.000Z',
          rationale: 'Dříve ukotvený otisk se v řetězu nenachází.',
        },
      })
    );
    render(<CaseFilePanel getToken={getToken} />);
    // Výstraha nahoře, odůvodnění pod ní — hledá se ta výstraha.
    expect(await screen.findByText(/Pozor: dříve ukotvený otisk/)).toBeInTheDocument();
  });

  test('ukotvení vrátí text určený k uložení mimo systém', async () => {
    // Kopie vedle záznamu důkazní hodnotu nemá — uživateli to musí být
    // řečeno přímo u textu, ne jen v dokumentaci.
    global.fetch = vi.fn(async (url, opts) => {
      if (String(url).includes('/api/ledger/anchor') && opts?.method === 'POST') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            anchoredAt: '2026-08-27T06:00:00.000Z',
            headHash: 'a'.repeat(64),
            message: 'AuraGuard — ukotvení otisku\nOtisk hlavy: ' + 'a'.repeat(64),
          }),
        };
      }
      return chainResponse({
        ok: true,
        count: 1,
        problems: [],
        anchor: { state: 'none', anchoredAt: null, rationale: 'Neukotveno.' },
      });
    });

    render(<CaseFilePanel getToken={getToken} />);
    await screen.findByText(/v pořádku/);
    await userEvent.click(screen.getByRole('button', { name: /Ukotvit otisk nyní/ }));

    expect(await screen.findByText(/MIMO tenhle server/)).toBeInTheDocument();
    expect(screen.getByText(new RegExp('a'.repeat(20)))).toBeInTheDocument();
  });
});
