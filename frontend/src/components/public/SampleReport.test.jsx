import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import SampleReport from './SampleReport.jsx';
import sampleReport from '../../../public/sample-report.json';

/**
 * Ukázkový report se renderuje proti SKUTEČNÝM datům.
 *
 * Motivace: první verze komponenty četla `data.tls.pqc.supported`, ale
 * skener vrací `data.pqc.isQuantumSafe`. Nic nespadlo — stránka jen tiše
 * zobrazila prázdné karty. Test proto pracuje s tímtéž souborem, který
 * se nasazuje, takže změna tvaru výstupu skenerů se ozve tady.
 */

function mockFetchOk(payload) {
  global.fetch = vi.fn(async () => ({
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    json: async () => payload,
  }));
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('SampleReport', () => {
  test('vykreslí naměřený cíl a datum', async () => {
    mockFetchOk(sampleReport);
    render(<SampleReport onBack={() => {}} />);
    expect(await screen.findByText(sampleReport.target)).toBeInTheDocument();
  });

  test('zobrazí výsledek post-kvantové sondy, ne prázdno', async () => {
    mockFetchOk(sampleReport);
    render(<SampleReport onBack={() => {}} />);

    const pqc = sampleReport.sections.nis2.data.pqc;
    // Právě tohle první verze komponenty minula: četla jiné pole.
    expect(await screen.findByText(pqc.pqcGroup)).toBeInTheDocument();

    // Doména se v reportu objevuje víckrát (cíl skenu, subjekt certifikátu),
    // takže hledáme konkrétně tu v tabulce faktů.
    const facts = document.querySelector('.sample-facts');
    expect(facts.textContent).toContain(pqc.subjectName);
    expect(facts.textContent).toContain(pqc.protocol);
  });

  test('vypíše všechny čtyři povinnosti čl. 50 i s odůvodněním', async () => {
    mockFetchOk(sampleReport);
    render(<SampleReport onBack={() => {}} />);

    const obligations = sampleReport.sections.aiAct.data.aiAct.obligations;
    expect(obligations).toHaveLength(4);
    for (const o of obligations) {
      expect(await screen.findByText(o.title)).toBeInTheDocument();
    }
  });

  test('u knihovny bez verze to řekne, místo aby verzi vynechala', async () => {
    mockFetchOk(sampleReport);
    render(<SampleReport onBack={() => {}} />);

    const libs = sampleReport.sections.cra.data.cra.libraries;
    const withoutVersion = libs.filter((l) => !l.version);
    if (withoutVersion.length > 0) {
      const labels = await screen.findAllByText(/verze nezjištěna/);
      expect(labels.length).toBe(withoutVersion.length);
    }
  });

  test('každá změřená sekce má vlastní kartu', async () => {
    mockFetchOk(sampleReport);
    const { container } = render(<SampleReport onBack={() => {}} />);

    const measured = Object.values(sampleReport.sections).filter((s) => s.data && !s.error);
    await waitFor(() =>
      expect(container.querySelectorAll('.sample-section').length).toBe(measured.length)
    );
  });

  test('u přístupnosti se uvádí počet dotčených prvků', async () => {
    // Výpis DOM uzlů se z ukázky vyhazuje (60 z 66 kB cizího HTML, které se
    // stejně nezobrazuje), ale počet nést musí — jinak by se z „89 prvků
    // k posouzení" stalo jen „něco k posouzení".
    mockFetchOk(sampleReport);
    render(<SampleReport onBack={() => {}} />);

    const items = [
      ...sampleReport.sections.a11y.data.violations,
      ...sampleReport.sections.a11y.data.incomplete,
    ];
    for (const item of items) {
      expect(item.nodes).toBeUndefined();
      expect(typeof item.nodeCount).toBe('number');
    }
    expect(await screen.findAllByText(/prvků/)).not.toHaveLength(0);
  });

  test('chybějící ukázka se nevydává za prázdný výsledek', async () => {
    // Server u chybějícího souboru vracel index.html se stavem 200.
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => 'text/html' },
      json: async () => {
        throw new Error('neměl by se volat');
      },
    }));

    render(<SampleReport onBack={() => {}} />);
    expect(await screen.findByText(/nebyla vygenerována/)).toBeInTheDocument();
  });

  test('404 se ohlásí srozumitelně, ne technickou hláškou', async () => {
    global.fetch = vi.fn(async () => ({
      ok: false,
      status: 404,
      headers: { get: () => 'application/json' },
      json: async () => ({}),
    }));

    render(<SampleReport onBack={() => {}} />);
    expect(await screen.findByText(/nebyla vygenerována/)).toBeInTheDocument();
  });
});

/**
 * Trojstav hlaviček ve veřejné ukázce.
 *
 * Ukázka dlouho zobrazovala jen chybějící hlavičky. Sken přitom rozlišuje
 * i hlavičku, která je přítomná ale nechrání, a takovou, kterou nešlo
 * posoudit — a právě to rozlišení je jádro produktu. Návštěvník, který se
 * nepřihlásí, vidí jen tuhle stránku.
 */
describe('SampleReport — hlavičky ve třech stavech', () => {
  const render3 = async (nis2Over) => {
    const payload = structuredClone(sampleReport);
    Object.assign(payload.sections.nis2.data.nis2, nis2Over);
    mockFetchOk(payload);
    render(<SampleReport onBack={() => {}} />);
    await screen.findByText(payload.target);
    return payload;
  };

  test('slabá hlavička se neschová mezi chybějící', async () => {
    await render3({
      missingHeaders: [],
      weakHeaders: ['Referrer-Policy'],
      inconclusiveHeaders: [],
    });
    expect(await screen.findByText(/nechrání/i)).toBeInTheDocument();
    expect(screen.getByText('Referrer-Policy')).toBeInTheDocument();
    expect(screen.queryByText('Chybějící hlavičky')).not.toBeInTheDocument();
  });

  test('neprůkazná hlavička se hlásí jako neposouzená, ne jako nález', async () => {
    // Na http:// vrací modul HSTS `null` a výslovně říká, že absence není
    // volba provozovatele. Vydávat to za chybějící hlavičku by znamenalo
    // hlásit nález na základě něčeho, co se nezměřilo.
    await render3({
      missingHeaders: [],
      weakHeaders: [],
      inconclusiveHeaders: ['Strict-Transport-Security'],
    });
    expect(await screen.findByText('Nepodařilo se posoudit')).toBeInTheDocument();
    expect(screen.queryByText('Chybějící hlavičky')).not.toBeInTheDocument();
  });

  test('bez nálezů se nezobrazí žádný ze seznamů', async () => {
    await render3({ missingHeaders: [], weakHeaders: [], inconclusiveHeaders: [] });
    await waitFor(() => {
      expect(screen.queryByText('Chybějící hlavičky')).not.toBeInTheDocument();
    });
    expect(screen.queryByText('Nepodařilo se posoudit')).not.toBeInTheDocument();
  });
});
