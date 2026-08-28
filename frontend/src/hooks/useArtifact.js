import { useState, useEffect } from 'react';

/**
 * Načte artefakt (screenshot, video) přes ověřený požadavek.
 *
 * PROČ NE PROSTĚ `<img src>`
 * Prohlížeč u `src` neposílá hlavičku `Authorization`, takže se token musel
 * propašovat do query stringu. Tam ale neskončí — Caddy zapisuje celé URI
 * do access logu s retencí 720 hodin, takže kdo se dostane k logům,
 * dostane se ke všem screenshotům všech běhů.
 *
 * Vlastní `lib/download.js` přitom už dřív popsal, proč token do URL
 * nepatří („objeví se v historii prohlížeče, v logu proxy i v Refereru…
 * u nástroje, který cizím webům vytýká úniky přes URL, obzvlášť
 * nešťastné"). U artefaktů se to porušovalo.
 *
 * Soubor se proto stáhne `fetch`em s hlavičkou a podstrčí se prohlížeči
 * jako blob. Token neopustí paměť stránky.
 *
 * CENA
 * Celý soubor projde pamětí. U screenshotů jsou to stovky kilobajtů,
 * u videa jednotky megabajtů — přijatelné. Kdyby sem někdy přibyly
 * záznamy dlouhých běhů, bude potřeba streamování přes service worker
 * nebo krátkodobý podepsaný odkaz.
 */

/**
 * @param {string|null} url  cesta k artefaktu, např. `/api/screenshots/x.png`
 * @param {() => Promise<string>} getToken
 * @returns {{objectUrl: string|null, error: string|null, loading: boolean}}
 */
export function useArtifact(url, getToken) {
  const [state, setState] = useState({ objectUrl: null, error: null, loading: false });

  useEffect(() => {
    if (!url || typeof getToken !== 'function') {
      setState({ objectUrl: null, error: null, loading: false });
      return undefined;
    }

    let zruseno = false;
    let vytvorenaUrl = null;
    setState({ objectUrl: null, error: null, loading: true });

    (async () => {
      try {
        const token = await getToken();
        const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok) {
          // Chybová odpověď je JSON — hláška ze serveru řekne víc než
          // stavový kód.
          let detail = `HTTP ${res.status}`;
          try {
            const body = await res.json();
            if (body?.error) detail = body.error;
          } catch {
            /* odpověď nebyla JSON */
          }
          throw new Error(detail);
        }
        const blob = await res.blob();
        if (zruseno) return;
        vytvorenaUrl = URL.createObjectURL(blob);
        setState({ objectUrl: vytvorenaUrl, error: null, loading: false });
      } catch (err) {
        if (!zruseno) setState({ objectUrl: null, error: err.message, loading: false });
      }
    })();

    return () => {
      zruseno = true;
      // Bez uvolnění drží blob paměť až do zavření záložky. Při proklikávání
      // kroků testu by se to nasčítalo do stovek megabajtů.
      if (vytvorenaUrl) URL.revokeObjectURL(vytvorenaUrl);
    };
  }, [url, getToken]);

  return state;
}
