import { useState, useEffect, useCallback } from 'react';
import { FileText, ShieldCheck, ShieldAlert, Download, RefreshCw } from 'lucide-react';
import { downloadAuthenticated } from '../lib/download.js';

/**
 * Doložitelnost — stav záznamu auditů a export spisu.
 *
 * PROČ TO MÁ VLASTNÍ SEKCI
 * Endpoint `/api/case-file` existoval, ale bez tlačítka ho zná jen ten, kdo
 * čte kód. Spis je přitom to, co zákazník při kontrole reálně odevzdává —
 * funkce, ke které se nedá dostat, je stejně dobrá jako neexistující.
 *
 * Stav řetězu se ukazuje NAHOŘE, ne až v exportovaném souboru. Kdyby někdo
 * se záznamem hýbal, má se to člověk dozvědět dřív, než spis odevzdá.
 */

const today = () => new Date().toISOString().slice(0, 10);
const monthAgo = () => {
  const d = new Date();
  d.setMonth(d.getMonth() - 1);
  return d.toISOString().slice(0, 10);
};

export default function CaseFilePanel({ getToken }) {
  const [from, setFrom] = useState(monthAgo);
  const [to, setTo] = useState(today);
  const [chain, setChain] = useState(null);
  const [chainError, setChainError] = useState(null);
  const [busy, setBusy] = useState(null);
  const [message, setMessage] = useState(null);
  const [error, setError] = useState(null);

  const loadChain = useCallback(async () => {
    setChainError(null);
    try {
      const token = await getToken();
      const res = await fetch('/api/ledger/verify', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setChain(await res.json());
    } catch (err) {
      setChain(null);
      setChainError(err.message);
    }
  }, [getToken]);

  useEffect(() => {
    loadChain();
  }, [loadChain]);

  const exportCaseFile = async (format) => {
    setBusy(format);
    setError(null);
    setMessage(null);
    try {
      const token = await getToken();
      // `to` je datum bez času; bez posunu na konec dne by poslední den
      // období vypadl a uživatel by to nepoznal.
      const params = new URLSearchParams({
        format,
        ...(from ? { from: `${from}T00:00:00.000Z` } : {}),
        ...(to ? { to: `${to}T23:59:59.999Z` } : {}),
      });
      const name = await downloadAuthenticated(
        `/api/case-file?${params}`,
        token,
        `spis-auditu-${today()}.${format}`
      );
      setMessage(`Staženo: ${name}`);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="case-file-panel">
      <div className="card">
        <h3 className="card-title">
          <FileText size={16} color="var(--accent)" /> Spis auditů
        </h3>
        <p className="card-note">
          Doklad o provedených měřeních za období — včetně neprůkazných výsledků
          a jejich odůvodnění. Obsahuje znění pravidel platné v době měření
          a otisky, kterými jde doložit, že se záznamem nikdo nehýbal.
        </p>

        <div className="form-group-row">
          <div className="form-group">
            <label htmlFor="case-from">Od</label>
            <input
              id="case-from"
              type="date"
              value={from}
              max={to || undefined}
              onChange={(e) => setFrom(e.target.value)}
            />
          </div>
          <div className="form-group">
            <label htmlFor="case-to">Do</label>
            <input
              id="case-to"
              type="date"
              value={to}
              min={from || undefined}
              onChange={(e) => setTo(e.target.value)}
            />
          </div>
        </div>

        <div className="case-file-actions">
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => exportCaseFile('pdf')}
            disabled={busy !== null}
          >
            <Download size={16} aria-hidden="true" />
            {busy === 'pdf' ? 'Připravuji PDF…' : 'Stáhnout PDF'}
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => exportCaseFile('json')}
            disabled={busy !== null}
          >
            <Download size={16} aria-hidden="true" />
            {busy === 'json' ? 'Připravuji JSON…' : 'Stáhnout JSON'}
          </button>
        </div>

        {message && (
          <p className="case-file-ok" role="status">
            {message}
          </p>
        )}
        {error && (
          <p className="case-file-error" role="alert">
            Export selhal: {error}
          </p>
        )}
      </div>

      <div className="card">
        <h3 className="card-title">
          {chain?.ok ? (
            <ShieldCheck size={16} color="var(--success)" />
          ) : (
            <ShieldAlert size={16} color="var(--warning)" />
          )}
          Neporušenost záznamu
          <button
            type="button"
            className="btn btn-secondary case-file-refresh"
            onClick={loadChain}
            aria-label="Ověřit znovu"
          >
            <RefreshCw size={14} aria-hidden="true" />
          </button>
        </h3>

        {chainError && (
          <p className="case-file-error" role="alert">
            Ověření se nepodařilo načíst: {chainError}
          </p>
        )}

        {chain && (
          <>
            <p className={chain.ok ? 'case-file-ok' : 'case-file-error'} role="status">
              {chain.ok
                ? `Řetěz je neporušený — ${chain.count} položek.`
                : `Řetěz je porušený — ${chain.problems.length} nálezů.`}
            </p>

            {!chain.ok && (
              <ul className="case-file-problems">
                {chain.problems.map((p) => (
                  <li key={`${p.index}-${p.problem}`}>
                    položka {p.index}
                    {p.sessionId ? ` (${p.sessionId})` : ''}: {p.problem}
                  </li>
                ))}
              </ul>
            )}

            {/* Bez tohohle by zelená fajfka svedla k závěru, že je záznam
                neprůstřelný. Není — dokazuje jen, že s ním nikdo nehýbal. */}
            <p className="card-note">
              Dokazuje to, že žádný záznam nebyl dodatečně změněn ani odstraněn.
              Nedokazuje to nemožnost podvrhu: kdo smí zapisovat, může přepsat
              celou historii a otisky přepočítat. Proti tomu pomáhá ukotvení
              otisku mimo tenhle systém.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
