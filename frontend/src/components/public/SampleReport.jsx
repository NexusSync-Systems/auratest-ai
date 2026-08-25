import { useEffect, useState } from 'react';
import { ArrowLeft, Shield, AlertTriangle } from 'lucide-react';
import {
  complianceColor,
  complianceLabel,
  obligationColor,
  obligationLabel,
  pqcColor,
  pqcLabel,
} from '../../lib/compliance.js';

/**
 * Veřejná ukázka skutečného výstupu.
 *
 * Data se načítají z `/sample-report.json`, který vzniká skriptem
 * `scripts/export-sample-report.mjs` — tedy opravdovým během skenerů, ne
 * ručním sepsáním. Kdyby se čísla vymyslela, byla by to marketingová atrapa
 * nástroje, jehož celý smysl je netvrdit nic, co nezměřil.
 *
 * Popisky a barvy si komponenta bere ze stejného `lib/compliance.js` jako
 * aplikace, takže neprůkazný výsledek je jantarový i tady. Kdyby si ukázka
 * vedla vlastní škálu, mohla by tvrdit něco jiného než nástroj sám.
 */

const SECTION_TITLES = {
  nis2: 'NIS2 a post-kvantová kryptografie',
  aiAct: 'AI Act, článek 50',
  cra: 'Kybernetická odolnost (CRA)',
  green: 'Rezidence dat a energetická náročnost',
  a11y: 'Přístupnost (EAA)',
  cookies: 'Cookies a trackery (GDPR)',
  monitor: 'Dostupnost',
};

function Badge({ color, children }) {
  return (
    <span className="sample-badge" style={{ backgroundColor: color }}>
      {children}
    </span>
  );
}

/** Sekce, která se nezměřila, se nezobrazí vůbec — radši nic než výmysl. */
function Section({ id, section }) {
  if (!section || section.error || !section.data) return null;
  const { data } = section;

  return (
    <article className="sample-section">
      <h3>{SECTION_TITLES[id] ?? id}</h3>

      {'isCompliant' in data && (
        <Badge color={complianceColor(data.isCompliant)}>
          {complianceLabel(data.isCompliant)}
        </Badge>
      )}

      {id === 'nis2' && data.tls && (
        <>
          {'pqc' in data.tls && (
            <p>
              Post-kvantová výměna klíčů:{' '}
              <Badge color={pqcColor(data.tls.pqc?.supported)}>
                {pqcLabel(data.tls.pqc?.supported)}
              </Badge>
            </p>
          )}
          {data.tls.protocol && <p>Protokol: {data.tls.protocol}</p>}
        </>
      )}

      {id === 'aiAct' && Array.isArray(data.obligations) && (
        <ul className="sample-obligations">
          {data.obligations.map((o) => (
            <li key={o.id ?? o.title}>
              <Badge color={obligationColor(o.status)}>{obligationLabel(o.status)}</Badge>
              <span>{o.title ?? o.id}</span>
              {o.rationale && <em>{o.rationale}</em>}
            </li>
          ))}
        </ul>
      )}

      {data.summary && <p className="sample-summary">{data.summary}</p>}
      {data.warning && <p className="sample-summary">{data.warning}</p>}
    </article>
  );
}

export default function SampleReport({ onBack }) {
  const [report, setReport] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/sample-report.json')
      .then(async (r) => {
        // Kontrola typu obsahu, ne jen stavového kódu.
        //
        // Server u chybějícího souboru dřív vracel index.html se stavem 200
        // (catch-all pro cesty SPA). `r.ok` bylo true a spadl až
        // `JSON.parse` hláškou „The string did not match the expected
        // pattern", která ukazuje na frontend, ačkoli chyběl soubor.
        // Serverová strana je opravená, tahle pojistka zůstává —
        // před stejným zmatením u jiné instalace.
        const type = r.headers.get('content-type') || '';
        if (r.status === 404 || !type.includes('json')) {
          throw new Error('ukázka zatím nebyla vygenerována');
        }
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data) => !cancelled && setReport(data))
      .catch((err) => !cancelled && setError(err.message));
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="public-page">
      <button type="button" className="btn btn-secondary sample-back" onClick={onBack}>
        <ArrowLeft size={16} aria-hidden="true" /> Zpět na úvod
      </button>

      <header className="public-hero">
        <div className="public-logo">
          <Shield size={28} />
          <span>Ukázkový report</span>
        </div>

        {report && (
          <p className="public-lead">
            Cíl: <code>{report.target}</code>
            <br />
            Naměřeno:{' '}
            {new Date(report.measuredAt).toLocaleString('cs-CZ', {
              dateStyle: 'long',
              timeStyle: 'short',
            })}
          </p>
        )}
      </header>

      {/* Datum a původ dat nejsou dekorace: stav cizího webu se mění a report
          starý půl roku tvrdí něco o minulosti. */}
      <p className="sample-provenance">
        <AlertTriangle size={16} aria-hidden="true" /> Tohle je výstup skutečného
        běhu nástroje, ne ukázka sestavená ručně. Nálezy popisují stav cílového
        webu v uvedený čas a od té doby se mohl změnit.
      </p>

      {error && (
        <p className="sample-error">
          Ukázku se nepodařilo načíst: {error}. Prázdná stránka je záměr —
          vymyšlená čísla by u nástroje, který stojí na tom, že netvrdí nic
          neověřeného, byla horší než chybějící ukázka.
        </p>
      )}

      {!report && !error && <p>Načítám…</p>}

      {report &&
        Object.entries(report.sections).map(([id, section]) => (
          <Section key={id} id={id} section={section} />
        ))}
    </div>
  );
}
