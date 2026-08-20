import { useReducer, useMemo, useCallback } from 'react';

/**
 * Stav všech auditů v jednom reduceru.
 *
 * Dřív měl každý audit vlastní dvojici `xLoading` / `xResult` (22 useState
 * dohromady) a k tomu tři místa, kam se nový audit musel ručně zapojit:
 * `clearAllResults`, `isAnyAuditLoading` a zobrazovací podmínka. U auditů
 * `aiAct` a `chaos` se na to zapomnělo, takže jejich výsledky se nikdy
 * nezobrazily a nešel ani spinner.
 *
 * Tenhle hook to řeší systémově: přidání auditu do AUDIT_IDS stačí.
 */
export const AUDIT_IDS = [
  'a11y',
  'nis2',
  'green',
  'cra',
  'craVuln',
  'cookie',
  'aiAct',
  'chaos',
  'monitorPage',
  'monitorForm',
  'security',
];

const EMPTY = { status: 'idle', data: null, error: null };

function initialState() {
  return Object.fromEntries(AUDIT_IDS.map((id) => [id, EMPTY]));
}

function reducer(state, action) {
  switch (action.type) {
    case 'start':
      return { ...state, [action.id]: { status: 'loading', data: null, error: null } };
    case 'success':
      return { ...state, [action.id]: { status: 'done', data: action.data, error: null } };
    case 'failure':
      return { ...state, [action.id]: { status: 'error', data: null, error: action.error } };
    case 'reset':
      return { ...state, [action.id]: EMPTY };
    case 'resetAll':
      return initialState();
    default:
      return state;
  }
}

export function useAudits() {
  const [state, dispatch] = useReducer(reducer, undefined, initialState);

  const start = useCallback((id) => dispatch({ type: 'start', id }), []);
  const succeed = useCallback((id, data) => dispatch({ type: 'success', id, data }), []);
  const fail = useCallback((id, error) => dispatch({ type: 'failure', id, error }), []);
  const resetAll = useCallback(() => dispatch({ type: 'resetAll' }), []);

  /**
   * Obalí volání auditu: sám zapne i vypne loading. Dřív pět handlerů
   * loading flag jen vypínalo ve finally, ale nikdy nezapínalo, takže při
   * samostatném spuštění uživatel neviděl žádnou zpětnou vazbu.
   */
  const run = useCallback(async (id, fn) => {
    start(id);
    try {
      const data = await fn();
      succeed(id, data);
      return data;
    } catch (err) {
      fail(id, err.message || String(err));
      throw err;
    }
  }, [start, succeed, fail]);

  const isAnyLoading = useMemo(
    () => AUDIT_IDS.some((id) => state[id].status === 'loading'),
    [state]
  );

  const hasAnyResult = useMemo(
    () => AUDIT_IDS.some((id) => state[id].status === 'done' || state[id].status === 'error'),
    [state]
  );

  return { audits: state, run, start, succeed, fail, resetAll, isAnyLoading, hasAnyResult };
}
