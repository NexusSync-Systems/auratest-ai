import { describe, test, expect, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import HistoryList from './HistoryList.jsx';

/**
 * Historie: rozkliknutím náhled, tlačítkem celý záznam.
 *
 * Náhled je nová plocha, na které se dá tvrdit něco, co měření
 * nedokládá — hlavně u prázdných polí. Testy jsou psané proti tomu.
 */

const bezy = [
  { id: 'a', url: 'https://test.example.cz/', goal: 'Průzkumné testování bez zadání (Monkey Mode - bez AI)', status: 'completed', bugsCount: 2, timestamp: '2026-09-11T09:00:00' },
  { id: 'b', url: 'https://test.example.cz/', goal: 'GDPR Striktní Cookies', status: 'completed', kind: 'compliance-scan', bugsCount: 0, verdict: false, timestamp: '2026-09-11T08:00:00' },
];

const odpoved = (data) => vi.fn(() => Promise.resolve({
  ok: true, status: 200, json: () => Promise.resolve(data),
}));

const vykresli = (props = {}) => render(
  <HistoryList
    sessions={bezy}
    authFetch={odpoved({})}
    onOpenDetail={() => {}}
    {...props}
  />
);

describe('seznam', () => {
  test('prázdná historie se nevydává za nic jiného', () => {
    render(<HistoryList sessions={[]} authFetch={vi.fn()} onOpenDetail={() => {}} />);
    expect(screen.getByText(/Zatím tu není žádný běh/)).toBeInTheDocument();
  });

  test('řádek nese čas, adresu, typ a stav', () => {
    vykresli();
    // Formát času závisí na locale prostředí, proto vzorem.
    expect(screen.getByText(/^0?9:00$/)).toBeInTheDocument();
    expect(screen.getAllByText('https://test.example.cz/')).toHaveLength(2);
    expect(screen.getByText('Monkey')).toBeInTheDocument();
    expect(screen.getByText('2 nálezy')).toBeInTheDocument();
    // Předpisový sken nese verdikt, ne počet nálezů.
    expect(screen.getByText('Porušení')).toBeInTheDocument();
  });

  test('náhled je zavřený, dokud se neklikne', () => {
    vykresli();
    for (const b of screen.getAllByRole('button')) {
      expect(b).toHaveAttribute('aria-expanded', 'false');
    }
  });
});

describe('náhled po rozkliknutí', () => {
  test('načte záznam a vypíše nálezy', async () => {
    const authFetch = odpoved({
      summary: 'Test dokončen.',
      url: 'https://test.example.cz/',
      goal: 'Monkey',
      status: 'completed',
      steps: [{ step: 1 }, { step: 2 }],
      bugs: ['Chyba v konzoli: něco selhalo', 'Selhal síťový požadavek'],
      warnings: ['x'],
      runErrors: [],
    });
    vykresli({ authFetch });

    await userEvent.click(screen.getAllByRole('button')[0]);
    await waitFor(() => expect(screen.getByText('Test dokončen.')).toBeInTheDocument());
    expect(screen.getByText(/Chyba v konzoli/)).toBeInTheDocument();
    expect(authFetch).toHaveBeenCalledWith('/api/sessions/a');
  });

  test('běh bez nálezu se nevydává za doklad, že je aplikace v pořádku', async () => {
    const authFetch = odpoved({
      summary: 'Hotovo.', status: 'completed', bugs: [], steps: [],
    });
    vykresli({ authFetch });

    await userEvent.click(screen.getAllByRole('button')[0]);
    await waitFor(() => expect(screen.getByText(/nenarazil/)).toBeInTheDocument());
    expect(screen.getByText(/z absence nálezu neplyne/)).toBeInTheDocument();
  });

  test('chybějící seznam nálezů se přizná, nedopočítává se', async () => {
    // `bugs: undefined` neznamená nula. Napsat „nenarazil" o záznamu,
    // který seznam nálezů nenese, by bylo tvrzení bez opory.
    const authFetch = odpoved({ summary: 'Hotovo.', status: 'completed' });
    vykresli({ authFetch });

    await userEvent.click(screen.getAllByRole('button')[0]);
    await waitFor(() => expect(screen.getByText(/neobsahuje seznam nálezů/)).toBeInTheDocument());
    expect(screen.queryByText(/nenarazil/)).not.toBeInTheDocument();
  });

  test('předpisový sken ukazuje verdikty pravidel, ne nálezy', async () => {
    const authFetch = odpoved({
      kind: 'compliance-scan',
      status: 'completed',
      bugs: [],
      checks: [
        { key: 'gdpr.trackery', ok: false, rationale: 'Trackery před souhlasem' },
        { key: 'gdpr.flags', ok: null, rationale: 'Příznaky cookies neurčeny' },
      ],
    });
    vykresli({ authFetch });

    await userEvent.click(screen.getAllByRole('button')[1]);
    await waitFor(() => expect(screen.getByText(/Trackery před souhlasem/)).toBeInTheDocument());
    const nahled = screen.getByText(/Trackery před souhlasem/).closest('.history-nahled');
    expect(within(nahled).getByText('Porušeno')).toBeInTheDocument();
    expect(within(nahled).getByText('Neprůkazné')).toBeInTheDocument();
    // U skenu nemá smysl mluvit o „nenarazil" — bugs se u něj nepoužívá.
    expect(screen.queryByText(/nenarazil/)).not.toBeInTheDocument();
  });

  test('neúspěšné načtení náhled nedopočítá ze seznamu', async () => {
    // Počet nálezů v seznamu a verdikt jsou dvě různé věci podle druhu
    // běhu. Vyrobit z toho náhled by znamenalo tvrdit, co se nenačetlo.
    const authFetch = vi.fn(() => Promise.resolve({ ok: false, status: 500 }));
    vykresli({ authFetch });

    await userEvent.click(screen.getAllByRole('button')[0]);
    await waitFor(() => expect(screen.getByText(/nepodařilo načíst/)).toBeInTheDocument());
    expect(screen.queryByText(/nenarazil/)).not.toBeInTheDocument();
    expect(screen.queryByText(/neobsahuje seznam nálezů/)).not.toBeInTheDocument();
  });

  test('druhé kliknutí náhled zavře', async () => {
    vykresli({ authFetch: odpoved({ summary: 'Test dokončen.' }) });
    const radek = screen.getAllByRole('button')[0];

    await userEvent.click(radek);
    await waitFor(() => expect(radek).toHaveAttribute('aria-expanded', 'true'));
    await userEvent.click(radek);
    expect(radek).toHaveAttribute('aria-expanded', 'false');
  });

  test('znovuotevření nesahá na server podruhé', async () => {
    const authFetch = odpoved({ summary: 'Test dokončen.' });
    vykresli({ authFetch });
    const radek = screen.getAllByRole('button')[0];

    await userEvent.click(radek);
    await waitFor(() => expect(screen.getByText('Test dokončen.')).toBeInTheDocument());
    await userEvent.click(radek);
    await userEvent.click(radek);
    await waitFor(() => expect(screen.getByText('Test dokončen.')).toBeInTheDocument());
    expect(authFetch).toHaveBeenCalledTimes(1);
  });

  test('tlačítko otevře celý záznam', async () => {
    const onOpenDetail = vi.fn();
    vykresli({ authFetch: odpoved({ summary: 'Hotovo.' }), onOpenDetail });

    await userEvent.click(screen.getAllByRole('button')[0]);
    await waitFor(() => expect(screen.getByText(/Otevřít celý záznam/)).toBeInTheDocument());
    await userEvent.click(screen.getByText(/Otevřít celý záznam/));
    expect(onOpenDetail).toHaveBeenCalledWith('a');
  });
});
