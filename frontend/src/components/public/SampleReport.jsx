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
 *
 * Každý skener vrací výsledek pod vlastním klíčem (`data.nis2`, `data.cra`,
 * `data.gdpr`, …), ne v jednotném tvaru. Renderer je proto pro každou sekci
 * zvlášť; společné zobecnění by muselo hádat, co která hodnota znamená.
 */

function Badge({ color, children }) {
  return (
    <span className="sample-badge" style={{ backgroundColor: color }}>
      {children}
    </span>
  );
}

function Card({ title, badge, children }) {
  return (
    <article className="sample-section">
      <h3>
        {title}
        {badge}
      </h3>
      {children}
    </article>
  );
}

/** Krátká věta pod nadpisem, typicky `rating` nebo `warning` ze skeneru. */
function Note({ children }) {
  if (!children) return null;
  return <p className="sample-summary">{children}</p>;
}

function Nis2({ data }) {
  const { nis2, pqc } = data;
  return (
    <Card
      title="NIS2 — bezpečnostní hlavičky a TLS"
      badge={<Badge color={complianceColor(nis2.isCompliant)}>{complianceLabel(nis2.isCompliant)}</Badge>}
    >
      <p>
        Post-kvantová výměna klíčů:{' '}
        <Badge color={pqcColor(pqc.isQuantumSafe)}>{pqcLabel(pqc.isQuantumSafe)}</Badge>{' '}
        <span className="sample-dim">{pqc.pqcGroup}</span>
      </p>
      <Note>{pqc.pqcRationale}</Note>

      <dl className="sample-facts">
        <dt>Protokol</dt>
        <dd>{pqc.protocol}</dd>
        <dt>Povolené verze</dt>
        <dd>{(pqc.protocolsEnabled || []).join(', ') || '—'}</dd>
        <dt>Certifikát</dt>
        <dd>
          {pqc.subjectName} <span className="sample-dim">({pqc.issuer})</span>
        </dd>
      </dl>

      {nis2.missingHeaders?.length > 0 && (
        <>
          <p className="sample-label">Chybějící hlavičky</p>
          <ul className="sample-list">
            {nis2.missingHeaders.map((h) => (
              <li key={h}>{h}</li>
            ))}
          </ul>
        </>
      )}

      {/* `scope` říká, co kontrola NEpokrývá. Bez toho by čtenář zelenou
          fajfku četl jako „splňujeme NIS2", což skener tvrdit nemůže. */}
      <Note>{nis2.scope}</Note>
    </Card>
  );
}

function AiAct({ data }) {
  const { aiAct } = data;
  return (
    <Card
      title="AI Act, článek 50"
      badge={<Badge color={complianceColor(aiAct.isCompliant)}>{complianceLabel(aiAct.isCompliant)}</Badge>}
    >
      <ul className="sample-obligations">
        {aiAct.obligations.map((o) => (
          <li key={o.id}>
            <Badge color={obligationColor(o.status)}>{obligationLabel(o.status)}</Badge>
            <span>{o.title}</span>
            {o.rationale && <em>{o.rationale}</em>}
          </li>
        ))}
      </ul>
      <Note>{aiAct.rating}</Note>
    </Card>
  );
}

function Cra({ data }) {
  const { cra } = data;
  return (
    <Card
      title="Kybernetická odolnost (CRA)"
      badge={<Badge color={complianceColor(cra.isCompliant)}>{complianceLabel(cra.isCompliant)}</Badge>}
    >
      {cra.libraries?.length > 0 && (
        <>
          <p className="sample-label">Nalezené komponenty</p>
          <ul className="sample-list">
            {cra.libraries.map((lib) => (
              <li key={lib.name}>
                {lib.name}{' '}
                <span className="sample-dim">
                  {lib.version ? `v${lib.version}` : 'verze nezjištěna'} · {(lib.sources || []).join(', ')}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
      <Note>{cra.rating}</Note>
      <Note>{cra.scope}</Note>
    </Card>
  );
}

function Green({ data }) {
  const { green, residency } = data;
  return (
    <Card
      title="Rezidence dat a energetická náročnost"
      badge={
        <Badge color={complianceColor(residency.isEUCompliant)}>
          {complianceLabel(residency.isEUCompliant)}
        </Badge>
      }
    >
      <dl className="sample-facts">
        <dt>Přenesená data</dt>
        <dd>{green.totalMb} MB</dd>
        <dt>Odhad emisí</dt>
        <dd>
          {green.co2Grams} g CO₂ <span className="sample-dim">({green.rating})</span>
        </dd>
        <dt>Servery mimo EU/EHP</dt>
        <dd>
          {residency.nonEULocations?.length ?? 0} z {residency.totalDomains}
        </dd>
      </dl>
      <Note>{residency.warning}</Note>
    </Card>
  );
}

function A11y({ data }) {
  const violations = data.violations || [];
  const incomplete = data.incomplete || [];
  return (
    <Card
      title="Přístupnost (EAA / WCAG 2.1 AA)"
      badge={
        <Badge color={complianceColor(violations.length === 0 ? null : false)}>
          {violations.length === 0 ? 'Neprůkazné' : `${violations.length} porušení`}
        </Badge>
      }
    >
      <ul className="sample-list">
        {violations.map((v) => (
          <li key={v.id}>
            <strong>{v.impact}</strong> — {v.help}
            {v.nodeCount > 0 && (
              <span className="sample-dim"> · {v.nodeCount} prvků</span>
            )}
          </li>
        ))}
      </ul>

      {/* Položky k ručnímu posouzení jsou samostatná kategorie, ne „prošlo".
          Automat u nich nedokáže rozhodnout a mlčet o nich by znamenalo
          tvrdit víc, než se změřilo. */}
      {incomplete.length > 0 && (
        <>
          <p className="sample-label">Vyžaduje ruční posouzení</p>
          <ul className="sample-list">
            {incomplete.map((v) => (
              <li key={v.id}>
                {v.help}
                {v.nodeCount > 0 && (
                  <span className="sample-dim"> · {v.nodeCount} prvků</span>
                )}
              </li>
            ))}
          </ul>
        </>
      )}

      <Note>{`Automaticky prošlo ${data.passedCount} pravidel.`}</Note>
    </Card>
  );
}

function Cookies({ data }) {
  const { gdpr } = data;
  return (
    <Card
      title="Cookies a trackery (GDPR / ePrivacy)"
      badge={<Badge color={complianceColor(gdpr.isCompliant)}>{complianceLabel(gdpr.isCompliant)}</Badge>}
    >
      <ul className="sample-list">
        {(gdpr.suspiciousItems || []).map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
      <Note>{gdpr.rating}</Note>
    </Card>
  );
}

function Monitor({ data }) {
  return (
    <Card
      title="Dostupnost"
      badge={<Badge color={complianceColor(data.ok)}>{data.ok ? 'Odpovídá' : 'Neodpovídá'}</Badge>}
    >
      <dl className="sample-facts">
        <dt>Stavový kód</dt>
        <dd>{data.status ?? '—'}</dd>
        <dt>Doba odezvy</dt>
        <dd>{data.durationMs != null ? `${data.durationMs} ms` : '—'}</dd>
      </dl>
      <Note>{data.error}</Note>
    </Card>
  );
}

const RENDERERS = {
  nis2: Nis2,
  aiAct: AiAct,
  cra: Cra,
  green: Green,
  a11y: A11y,
  cookies: Cookies,
  monitor: Monitor,
};

export default function SampleReport({ onBack }) {
  const [report, setReport] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/sample-report.json')
      .then((r) => {
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
        <h1>Výstup skutečného skenu</h1>

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
        <AlertTriangle size={16} aria-hidden="true" /> Nálezy popisují stav
        cílového webu v uvedený čas a od té doby se mohl změnit. Nejde
        o hodnocení jeho provozovatele — Cloudflare je zvolený proto, že má
        post-kvantovou výměnu klíčů skutečně nasazenou, takže je na něm vidět,
        že sonda měří a nehádá.
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
        Object.entries(report.sections).map(([id, section]) => {
          // Sekce, která se nezměřila, se nezobrazí — radši nic než výmysl.
          if (!section?.data || section.error) return null;
          const Renderer = RENDERERS[id];
          if (!Renderer) return null;
          return <Renderer key={id} data={section.data} />;
        })}
    </div>
  );
}
