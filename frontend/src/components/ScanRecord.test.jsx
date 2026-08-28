import { render, screen } from '@testing-library/react';
import ScanRecord from './ScanRecord.jsx';

/**
 * Doložitelnost u konkrétního skenu.
 *
 * Uživatel musí poznat, jestli má v ruce jen obrazovku, nebo něco, co při
 * kontrole obstojí — a hlavně se musí dozvědět, když se zápis nezdařil.
 */

const record = (over = {}) => ({
  sessionId: 'session_scan_abc',
  recorded: true,
  recordHash: 'a'.repeat(64),
  ruleRefs: ['nis2.headers.csp.v3'],
  checks: [],
  verdict: null,
  ...over,
});

test('bez záznamu se nevykreslí nic', () => {
  const { container } = render(<ScanRecord record={null} />);
  expect(container).toBeEmptyDOMElement();
});

test('nezdařený zápis se přizná, nemlčí se o něm', () => {
  // Tichý neúspěch je u důkazního nástroje horší než hlasitý: uživatel by
  // se o něm dozvěděl až podle chybějící položky ve spisu.
  render(<ScanRecord record={record({ recorded: false })} />);
  expect(screen.getByText(/Nezaznamenáno/)).toBeInTheDocument();
  expect(screen.getByText(/nepůjde doložit ve spisu/)).toBeInTheDocument();
});

test('zaznamenaný sken uvádí, podle kterých pravidel se měřilo', () => {
  render(<ScanRecord record={record()} />);
  expect(screen.getByText(/Zaznamenáno pro doložení/)).toBeInTheDocument();
  expect(screen.getByText(/nis2\.headers\.csp\.v3/)).toBeInTheDocument();
});

test('neprůkazná kontrola se neukazuje jako splněná', () => {
  // Tři stavy musí být rozlišitelné na první pohled. Sloučit „neprůkazné"
  // s „splněno" je přesně ta chyba, které se celý nástroj vyhýbá.
  render(
    <ScanRecord
      record={record({
        checks: [
          { key: 'a', label: 'Hlavičky', ok: true, rationale: 'Vše sedí.' },
          { key: 'b', label: 'TLS sonda', ok: null, rationale: 'Neproběhla.' },
          { key: 'c', label: 'Cookies', ok: false, rationale: 'Chybí HttpOnly.' },
        ],
      })}
    />
  );
  // „BEZ NÁLEZU", ne „SPLNĚNO": absence nálezu není důkaz shody a slovník
  // se nesmí rozcházet s verdiktem ve spisu.
  expect(screen.getByText('BEZ NÁLEZU')).toBeInTheDocument();
  expect(screen.getByText('NEPRŮKAZNÉ')).toBeInTheDocument();
  expect(screen.getByText('NÁLEZ')).toBeInTheDocument();
  expect(screen.getByText('Neproběhla.')).toBeInTheDocument();
});

test('neznámý stav se bere jako neprůkazný, ne jako splněný', () => {
  render(<ScanRecord record={record({ checks: [{ key: 'x', label: 'X', ok: 'nesmysl' }] })} />);
  expect(screen.getByText('NEPRŮKAZNÉ')).toBeInTheDocument();
});


test('pozorování se neoznačuje jako splnění ani porušení', () => {
  // Post-kvantová výměna klíčů: žádný předpis ji nevyžaduje, takže
  // „nepodporuje" není vada. Sloučit ji s nálezem by znamenalo vytknout
  // zákazníkovi něco, co po něm nikdo nechce.
  render(
    <ScanRecord
      record={record({
        checks: [{ key: 'tls.pqc', label: 'PQC', ok: false, advisory: true, rationale: 'Nenabízí.' }],
      })}
    />
  );
  expect(screen.getByText('NEZJIŠTĚNO')).toBeInTheDocument();
  expect(screen.queryByText('NÁLEZ')).not.toBeInTheDocument();
});
