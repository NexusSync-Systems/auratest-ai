import { useState, useEffect } from 'react';
import { popisVerze, verzeSouhlasi } from '../../../build-info.js';

/**
 * Verze nasazení pod odhlašovacím tlačítkem.
 *
 * PROČ TO TU JE
 * Po nasazení nešlo poznat, jestli to, co je vidět v prohlížeči,
 * odpovídá repozitáři. Konkrétní následek: na snímku obrazovky chyběla
 * nová část UI a nedalo se rozhodnout, jestli je to nenasazený commit,
 * nebo chyba v kódu. Stálo to jeden kruh navíc.
 *
 * DVĚ ČÍSLA, NE JEDNO
 * Frontend si verzi zapéká při buildu, server ji čte za běhu. Když se
 * liší, znamená to, že prohlížeč drží starý bundle — přesně ten stav,
 * kvůli kterému vznikl `lazy-with-reload.js`. Zobrazit jen jedno číslo
 * by tenhle případ zamlčelo.
 *
 * NEVÍM SE PŘIZNÁ
 * Bez `--build-arg` je verze neznámá a napíše se to. Vymyšlené číslo by
 * bylo horší než žádné: podle něj se rozhoduje, jestli nasadit znovu.
 */
export default function VersionBadge() {
  const frontend = {
    commit: import.meta.env.VITE_GIT_COMMIT,
    buildTime: import.meta.env.VITE_BUILD_TIME,
  };
  const [server, setServer] = useState(undefined);

  useEffect(() => {
    let zruseno = false;
    // Bez přihlášení — je to provozní údaj, ne data zákazníka.
    fetch('/api/version')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => { if (!zruseno) setServer(data); })
      // Nedostupná verze serveru se bere jako „nevím", ne jako neshoda.
      .catch(() => { if (!zruseno) setServer(null); });
    return () => { zruseno = true; };
  }, []);

  const shoda = server === undefined
    ? null
    : verzeSouhlasi(frontend.commit, server?.commit);

  return (
    <div className="verze">
      <span title={[
        `Frontend: ${popisVerze(frontend)}`,
        server === undefined ? 'Server: zjišťuji…' : `Server: ${popisVerze(server)}`,
      ].join('\n')}>
        Verze {popisVerze(frontend)}
      </span>

      {/* Neshoda se řekne nahlas. Uživatel vidí starou aplikaci a jediné,
          co s tím udělá, je tvrdé obnovení stránky. */}
      {shoda === false && (
        <button
          type="button"
          className="verze-neshoda"
          onClick={() => window.location.reload()}
          title={`Server běží na ${popisVerze(server)}. Načíst stránku znovu.`}
        >
          Starší verze v prohlížeči — načíst znovu
        </button>
      )}
    </div>
  );
}
