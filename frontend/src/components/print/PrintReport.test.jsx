import { describe, test, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import PrintReport from './PrintReport.jsx';

/**
 * Tiskový report je dokument, který zákazník odevzdává úřadu — a přesto
 * neměl jediný test.
 *
 * Kontrolní vlna v něm našla dvě místa, kde se trojstav ztrácel: sekce
 * přístupnosti byla binární (zelená/červená) a položky k ručnímu posouzení
 * se netiskly vůbec. Web s desítkami takových položek tedy dostal do
 * dokumentu zelený odznak „Nalezeno porušení: 0" a nic dalšího.
 */

const zaklad = {
  user: { email: 'test@example.com' },
  agentUrl: 'https://example.com',
  liveLogs: [],
};

const vykresli = (props) => render(<PrintReport {...zaklad} {...props} />);

describe('sekce přístupnosti — tři stavy', () => {
  test('položky k ručnímu posouzení nedovolí tvrdit splnění', () => {
    vykresli({
      a11yResult: {
        violations: [],
        incomplete: [
          { id: 'color-contrast', description: 'Kontrast na obrázkovém pozadí' },
          { id: 'video-caption', description: 'Titulky u videa' },
        ],
      },
    });

    expect(screen.getByText(/Neprůkazné/i)).toBeInTheDocument();
    expect(screen.getByText(/k ručnímu posouzení: 2/i)).toBeInTheDocument();
    // Musí být vidět, CO se má posoudit — ne jen počet.
    expect(screen.getByText(/Kontrast na obrázkovém pozadí/)).toBeInTheDocument();
    expect(screen.getByText(/Titulky u videa/)).toBeInTheDocument();
  });

  test('čistý výsledek bez ručních položek je splněno', () => {
    vykresli({ a11yResult: { violations: [], incomplete: [] } });
    expect(screen.getByText(/Splněno/i)).toBeInTheDocument();
  });

  test('porušení je nález', () => {
    vykresli({
      a11yResult: {
        violations: [{ id: 'image-alt', impact: 'critical', description: 'Chybí alt' }],
        incomplete: [],
      },
    });
    expect(screen.getByText(/Nesplněno/i)).toBeInTheDocument();
  });

  test('nenačtená stránka se přizná, ne vydává za bez závad', () => {
    // Chybová stránka WAFu nemá žádná porušení. Bez tohohle rozlišení by
    // dostala zelený odznak.
    vykresli({
      a11yResult: {
        violations: [],
        incomplete: [],
        navigationError: 'Server odpověděl 403.',
      },
    });
    expect(screen.getByText(/Neprůkazné/i)).toBeInTheDocument();
    expect(screen.getByText(/neplyne, že je bez závad/i)).toBeInTheDocument();
  });
});

describe('sekce cookies — neprůkazné není nesplněno', () => {
  test('null dostane neutrální odznak, ne červený', () => {
    const { container } = vykresli({
      cookieResult: {
        gdpr: {
          isCompliant: null,
          rating: 'NEPRŮKAZNÉ: Stránku se nepodařilo načíst.',
          suspiciousItems: [],
        },
      },
    });
    // `null` je falsy, takže se dřív vybírala třída `error`.
    const badge = container.querySelector('.print-badge');
    expect(badge.className).not.toMatch(/error/);
  });
});
