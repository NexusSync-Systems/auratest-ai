import { useState, useCallback } from 'react';
import { ChevronRight, ExternalLink, Loader2, Printer, Download, Send } from 'lucide-react';
import { seskupPodleDne, stavBehu, zkracenyTyp, casBehu, VYSVETLENI } from '../lib/history.js';

/**
 * Historie běhů: rozkliknutím náhled, tlačítkem plný detail.
 *
 * PROČ DVĚ ÚROVNĚ
 * Kliknutí dřív rovnou přepnulo na jinou sekci a nahradilo obsah
 * pracovní plochy. Když člověk hledá konkrétní běh mezi padesáti, je to
 * padesát přepnutí tam a zpátky. Náhled odpoví na otázku „byl to tenhle?"
 * na místě; do detailu se jde, až když odpověď zní ano.
 *
 * ČEHO SE DRŽÍ NÁHLED
 * Ukazuje jen to, co je v záznamu doložené. Když se detail nepodaří
 * načíst, řekne to — nedopočítává z toho, co má v seznamu, protože
 * počet nálezů a verdikt jsou dvě různé věci podle druhu běhu.
 */
export default function HistoryList({
  sessions, authFetch, onOpenDetail,
  onPrint, onExportJson, onSlack, slackNastaven = false,
}) {
  const [otevreny, setOtevreny] = useState(null);
  const [detaily, setDetaily] = useState({});

  const prepni = useCallback(async (id) => {
    if (otevreny === id) {
      setOtevreny(null);
      return;
    }
    setOtevreny(id);
    // Jednou načtený náhled si necháme — překlikávání mezi běhy je
    // přesně to, kvůli čemu tahle úroveň vznikla, a nemá u toho blikat.
    if (detaily[id]) return;

    setDetaily((d) => ({ ...d, [id]: { stav: 'nacita' } }));
    try {
      const res = await authFetch(`/api/sessions/${id}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setDetaily((d) => ({ ...d, [id]: { stav: 'hotovo', data } }));
    } catch (err) {
      setDetaily((d) => ({ ...d, [id]: { stav: 'chyba', chyba: err.message } }));
    }
  }, [otevreny, detaily, authFetch]);

  if (!sessions || sessions.length === 0) {
    return (
      <p style={{ color: 'var(--text-muted)' }}>
        Zatím tu není žádný běh. Spusťte test v sekci „AI QA Agent".
      </p>
    );
  }

  return (
    <>
      <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginBottom: '12px' }}>
        Celkem {sessions.length} {sessions.length === 1 ? 'běh' : (sessions.length < 5 ? 'běhy' : 'běhů')}.
        Kliknutím se rozbalí náhled, tlačítkem se otevře celý záznam.
      </p>

      {/* Legenda stavů.
          Rozdíl mezi „Bez nálezu", „Nedokončeno" a „Neprůkazné" je to,
          na čem celý nástroj stojí — a v seznamu jsou to tři podobně
          vypadající odznaky. Bez vysvětlení si je čtenář přebere jako
          „asi dobrý" / „asi špatný" a trojstav je jen ozdoba. */}
      <details className="history-legenda">
        <summary>Co znamenají jednotlivé stavy</summary>
        <dl>
          {[
            ['ciste', 'Bez nálezu'],
            ['nalezy', 'Nález / Porušení'],
            ['nedokonceno', 'Neprůkazné'],
            ['nedokonceno', 'Nedokončeno'],
            ['nedokonceno', 'Bez odezvy'],
            ['bezi', 'Běží'],
          ].map(([trida, popisek], i) => (
            <div key={popisek}>
              <dt><span className={`history-stav ${trida}`}>{popisek}</span></dt>
              <dd>{[
                VYSVETLENI.ciste, VYSVETLENI.nalezy, VYSVETLENI.neprukazne,
                VYSVETLENI.nedokonceno, VYSVETLENI.bezodezvy, VYSVETLENI.bezi,
              ][i]}</dd>
            </div>
          ))}
        </dl>
      </details>

      {seskupPodleDne(sessions).map((skupina) => (
        <div key={skupina.nadpis} style={{ marginBottom: '20px' }}>
          <h3 className="history-day-heading">{skupina.nadpis}</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {skupina.bezy.map((s) => {
              const stav = stavBehu(s);
              const je = otevreny === s.id;
              return (
                <div key={s.id} className={`history-entry ${je ? 'open' : ''}`}>
                  <button
                    type="button"
                    className="history-row"
                    onClick={() => prepni(s.id)}
                    aria-expanded={je}
                    aria-controls={`nahled-${s.id}`}
                    title={s.goal || ''}
                  >
                    <ChevronRight
                      size={14}
                      className="history-chevron"
                      aria-hidden="true"
                    />
                    <span className="history-row-time">{casBehu(s.timestamp)}</span>
                    <span className="history-row-url">{s.url || ''}</span>
                    <span className="history-row-type">{zkracenyTyp(s.goal)}</span>
                    {/* Stav nese TEXT, ne jen barvu — a `title` k němu
                        dává celou větu, protože samotné „Neprůkazné"
                        si čtenář přeloží jako „asi špatný". */}
                    <span className={`history-stav ${stav.trida}`} title={stav.popis}>
                      {stav.popisek}
                    </span>
                  </button>

                  {je && (
                    <div className="history-nahled" id={`nahled-${s.id}`}>
                      {/* Co ten stav znamená, hned nahoře v náhledu.
                          Tooltip na odznaku je pro rychlé nahlédnutí,
                          tohle pro toho, kdo si běh opravdu otevřel. */}
                      <p className="history-stav-popis">
                        <span className={`history-stav ${stav.trida}`}>{stav.popisek}</span>
                        {' '}{stav.popis}
                      </p>
                      <Nahled zaznam={detaily[s.id]} souhrn={s} />
                      <Akce
                        zaznam={detaily[s.id]}
                        id={s.id}
                        onOpenDetail={onOpenDetail}
                        onPrint={onPrint}
                        onExportJson={onExportJson}
                        onSlack={onSlack}
                        slackNastaven={slackNastaven}
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </>
  );
}

/** Obsah náhledu podle toho, v jakém stavu je načítání. */
function Nahled({ zaznam, souhrn }) {
  if (!zaznam || zaznam.stav === 'nacita') {
    return (
      <p className="history-nahled-text">
        <Loader2 size={14} className="spin-inline" aria-hidden="true" /> Načítám záznam…
      </p>
    );
  }

  if (zaznam.stav === 'chyba') {
    // Nedopočítávat. Počet nálezů ze seznamu a verdikt jsou dvě různé
    // věci podle druhu běhu — vyrobit z toho náhled by znamenalo tvrdit
    // něco, co tenhle záznam nedoložil.
    return (
      <p className="history-nahled-text">
        Záznam se nepodařilo načíst ({zaznam.chyba}). Zkuste otevřít celý záznam.
      </p>
    );
  }

  const d = zaznam.data || {};
  const jeSken = d.kind === 'compliance-scan';
  const nalezy = Array.isArray(d.bugs) ? d.bugs : null;
  const varovani = Array.isArray(d.warnings) ? d.warnings : null;
  const chybyMereni = Array.isArray(d.runErrors) ? d.runErrors : null;

  return (
    <>
      {d.summary && <p className="history-nahled-text">{d.summary}</p>}

      <dl className="history-nahled-fakta">
        <div><dt>Adresa</dt><dd>{d.url || souhrn.url || '—'}</dd></div>
        <div><dt>Zadání</dt><dd>{d.goal || souhrn.goal || '—'}</dd></div>
        {!jeSken && (
          <div>
            <dt>Kroků</dt>
            <dd>{Array.isArray(d.steps) ? d.steps.length : '—'}</dd>
          </div>
        )}
        {d.performanceMetrics?.loadTimeMs && (
          <div><dt>Načtení</dt><dd>{d.performanceMetrics.loadTimeMs} ms</dd></div>
        )}
      </dl>

      {/* Předpisový sken: verdikty po pravidlech, ne počet nálezů. */}
      {jeSken && Array.isArray(d.checks) && d.checks.length > 0 && (
        <ul className="history-nahled-seznam">
          {d.checks.slice(0, 5).map((c, i) => (
            <li key={i}>
              <span className={`history-stav ${c.ok === false ? 'nalezy' : (c.ok === true ? 'ciste' : 'nedokonceno')}`}>
                {c.ok === false ? 'Porušeno' : (c.ok === true ? 'Splněno' : 'Neprůkazné')}
              </span>
              {' '}{c.rationale || c.key}
            </li>
          ))}
          {d.checks.length > 5 && (
            <li className="history-nahled-vic">a další {d.checks.length - 5} — celý seznam je v záznamu</li>
          )}
        </ul>
      )}

      {!jeSken && nalezy && nalezy.length > 0 && (
        <ul className="history-nahled-seznam">
          {nalezy.slice(0, 3).map((b, i) => (
            <li key={i}>{b.length > 160 ? `${b.slice(0, 157)}…` : b}</li>
          ))}
          {nalezy.length > 3 && (
            <li className="history-nahled-vic">a další {nalezy.length - 3} — celý seznam je v záznamu</li>
          )}
        </ul>
      )}

      {/* Prázdný seznam není totéž co chybějící seznam. */}
      {!jeSken && nalezy && nalezy.length === 0 && d.status === 'completed' && (
        <p className="history-nahled-text">
          Agent na žádný problém nenarazil. Průzkumný běh není úplný test —
          z absence nálezu neplyne, že je aplikace bez závad.
        </p>
      )}
      {!jeSken && !nalezy && (
        <p className="history-nahled-text">Záznam neobsahuje seznam nálezů.</p>
      )}

      <p className="history-nahled-vic">
        {varovani?.length > 0 && `Varování: ${varovani.length}. `}
        {/* Chyby měření nejsou nálezy o webu a takhle se i pojmenují. */}
        {chybyMereni?.length > 0 && `Chyby měření: ${chybyMereni.length}.`}
      </p>
    </>
  );
}

/**
 * Akce nad jedním záznamem.
 *
 * PROČ SE ČEKÁ NA NAČTENÝ ZÁZNAM
 * JSON i Slack pracují s daty toho běhu, ne s tím, co je zrovna
 * v aplikaci. Dokud se záznam nenačte, nemají z čeho vyjít, takže se
 * nenabízejí — nabídnout je a poslat kolegům shrnutí cizího běhu je
 * horší než počkat vteřinu.
 *
 * PDF U PŘEDPISOVÉHO SKENU
 * Tiskový report staví na výsledcích skenů v paměti aplikace. Uložený
 * předpisový sken je nese v `checks`, které report číst neumí — vytiskl
 * by se skoro prázdný dokument s hlavičkou, a to je horší než žádný.
 * Pro doložení předpisové kontroly je určený spis v Doložitelnosti.
 */
function Akce({ zaznam, id, onOpenDetail, onPrint, onExportJson, onSlack, slackNastaven }) {
  const hotovo = zaznam?.stav === 'hotovo';
  const data = hotovo ? zaznam.data : null;
  const jeSken = data?.kind === 'compliance-scan';

  return (
    <div className="history-akce">
      <button
        type="button"
        className="btn btn-secondary"
        onClick={() => onOpenDetail(id)}
      >
        Otevřít celý záznam
        <ExternalLink size={14} style={{ marginLeft: '6px' }} />
      </button>

      {onPrint && (
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => onPrint(id)}
          disabled={!hotovo || jeSken}
          title={jeSken
            ? 'Předpisový sken se dokládá spisem v sekci Doložitelnost — tiskový report jeho verdikty číst neumí.'
            : 'Načte záznam a otevře tiskový dialog'}
        >
          <Printer size={14} style={{ marginRight: '6px' }} /> PDF
        </button>
      )}

      {onExportJson && (
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => onExportJson(data)}
          disabled={!hotovo}
          title={hotovo ? 'Stáhnout záznam jako JSON' : 'Záznam se ještě nenačetl'}
        >
          <Download size={14} style={{ marginRight: '6px' }} /> JSON
        </button>
      )}

      {onSlack && (
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => onSlack(data)}
          disabled={!hotovo || !slackNastaven}
          title={slackNastaven
            ? (hotovo ? 'Odeslat shrnutí tohoto běhu na Slack' : 'Záznam se ještě nenačetl')
            : 'Slack webhook není nastavený — doplňte ho v Nastavení.'}
        >
          <Send size={14} style={{ marginRight: '6px' }} /> Slack
        </button>
      )}
    </div>
  );
}
