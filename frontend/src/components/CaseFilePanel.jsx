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
  const [anchorText, setAnchorText] = useState(null);

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

  /**
   * Ruční ukotvení.
   *
   * Automatické ukotvení nechává na konci nekrytou mezeru danou periodou.
   * Před odevzdáním spisu se proto hodí ukotvit ručně — jinak nejnovější
   * záznamy kryté nejsou.
   */
  const anchorNow = async () => {
    setBusy('anchor');
    setError(null);
    setMessage(null);
    try {
      const token = await getToken();
      const res = await fetch('/api/ledger/anchor', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setAnchorText(data.message);
      await loadChain();
    } catch (err) {
      setError(`Ukotvení selhalo: ${err.message}`);
    } finally {
      setBusy(null);
    }
  };

  const exportCaseFile = async (format) => {
    setBusy(format);
    setError(null);
    setMessage(null);
    try {
      const token = await getToken();
      // Datum se posílá tak, jak ho uživatel zadal. Konec období na celý den
      // řeší server (`periodEnd` v case-file.js) — dokud se to obcházelo tady,
      // platilo to jen pro tenhle formulář a každý jiný konzument API o den
      // měření tiše přišel.
      const params = new URLSearchParams({
        format,
        ...(from ? { from } : {}),
        ...(to ? { to } : {}),
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
                    položka {p.index}: {p.problem}
                  </li>
                ))}
              </ul>
            )}

            {/* Ukotvení je to jediné, co vylučuje useknutí konce řetězu.
                Dokud chybí, musí to zelená fajfka říct nahlas — jinak svádí
                k závěru, že je záznam neprůstřelný. */}
            {chain.anchor && (
              <p
                className={
                  chain.anchor.state === 'broken' || chain.anchor.state === 'empty'
                    ? 'case-file-error'
                    : chain.anchor.state === 'anchored'
                      ? 'case-file-ok'
                      : 'card-note'
                }
                role="status"
              >
                {chain.anchor.state === 'anchored'
                  ? `Otisk ukotven ${new Date(chain.anchor.anchoredAt).toLocaleString('cs-CZ')}.`
                  : chain.anchor.state === 'broken'
                    ? 'Pozor: dříve ukotvený otisk se v řetězu nenachází.'
                    : chain.anchor.state === 'empty'
                      ? 'Kotva vznikla nad prázdným záznamem — nekryje žádný běh.'
                      : 'Otisk zatím nebyl ukotven mimo tenhle systém.'}
              </p>
            )}

            {chain.anchor && (
              <p className="card-note">{chain.anchor.rationale}</p>
            )}

            <button
              type="button"
              onClick={anchorNow}
              disabled={busy === 'anchor'}
              className="secondary"
            >
              {busy === 'anchor' ? 'Ukotvuji…' : 'Ukotvit otisk nyní'}
            </button>

            {anchorText && (
              <>
                <p className="card-note">
                  Zkopírujte text níž a uložte ho MIMO tenhle server — do
                  e-mailu, do jiného systému, na papír. Kopie, která zůstane
                  vedle záznamu, důkazní hodnotu nemá: kdo smí zapisovat do
                  řetězu, smí zapisovat i do ní.
                </p>
                <pre className="case-file-anchor">{anchorText}</pre>
              </>
            )}

            <p className="card-note">
              Řetězení dokazuje, že žádný záznam nebyl dodatečně změněn ani
              odstraněn z prostřed historie. Nedokazuje nemožnost podvrhu: kdo
              smí zapisovat, může přepsat celou historii a otisky přepočítat.
              Právě proti tomu stojí ukotvení otisku mimo tenhle systém.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
