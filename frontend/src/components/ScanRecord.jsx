/**
 * Doložitelnost jednoho skenu — co se o něm zapsalo do neměnného záznamu.
 *
 * PROČ TO PATŘÍ PŘÍMO K VÝSLEDKU
 * Doložitelnost dosud žila v samostatné sekci a u konkrétního skenu nebyla
 * vidět. Uživatel tak netušil, jestli má v ruce jen obrazovku, nebo něco,
 * co při kontrole obstojí. A když se zápis nezdařil, nedozvěděl se to
 * vůbec — poznal to až podle chybějící položky ve spisu.
 *
 * Nezaznamenaný sken se proto hlásí výslovně. Tichý neúspěch je u důkazního
 * nástroje horší než hlasitý.
 */

/** Tři stavy dílčí kontroly. Neprůkazné má vlastní barvu i slovo. */
const MARK = {
  true: { text: 'SPLNĚNO', color: '#10b981' },
  false: { text: 'NESPLNĚNO', color: '#ef4444' },
  null: { text: 'NEPRŮKAZNÉ', color: '#f59e0b' },
};

const markFor = (ok) => MARK[String(ok)] || MARK.null;

export default function ScanRecord({ record }) {
  if (!record) return null;

  const checks = Array.isArray(record.checks) ? record.checks : [];

  return (
    <div
      style={{
        marginTop: '16px',
        padding: '12px 14px',
        background: 'rgba(255,255,255,0.04)',
        borderRadius: '8px',
        borderLeft: `3px solid ${record.recorded ? '#10b981' : '#f59e0b'}`,
      }}
    >
      <div style={{ fontSize: '13px', fontWeight: 600, marginBottom: '8px' }}>
        {record.recorded ? 'Zaznamenáno pro doložení' : 'Nezaznamenáno'}
      </div>

      {checks.length > 0 && (
        <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: '10px' }}>
          <tbody>
            {checks.map((c) => {
              const mark = markFor(c.ok);
              return (
                <tr key={c.key}>
                  <td
                    style={{
                      color: mark.color,
                      fontWeight: 600,
                      fontSize: '11px',
                      whiteSpace: 'nowrap',
                      verticalAlign: 'top',
                      padding: '4px 10px 4px 0',
                    }}
                  >
                    {mark.text}
                  </td>
                  <td style={{ fontSize: '12px', padding: '4px 0', verticalAlign: 'top' }}>
                    <strong>{c.label || c.key}</strong>
                    {c.rationale ? (
                      <div style={{ opacity: 0.7, marginTop: '2px' }}>{c.rationale}</div>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <div style={{ fontSize: '11px', opacity: 0.7, lineHeight: 1.6 }}>
        {record.recorded ? (
          <>
            Běh <code>{record.sessionId}</code> je zapsaný v řetězu záznamů podle{' '}
            {record.ruleRefs?.length ?? 0} pravidel
            {record.ruleRefs?.length ? ` (${record.ruleRefs.join(', ')})` : ''}. Jejich
            znění i s mezemi se vytiskne do spisu v sekci Doložitelnost.
          </>
        ) : (
          <>
            Výsledek platí, ale zápis do řetězu záznamů se nezdařil — tenhle sken
            proto nepůjde doložit ve spisu. Zopakujte ho; pokud potíž trvá, jde
            o chybu na straně serveru.
          </>
        )}
      </div>
    </div>
  );
}
