/**
 * Z čeho je tahle instalace postavená.
 *
 * PROČ TO EXISTUJE
 * Po nasazení nejde poznat, jestli se to, co je vidět v prohlížeči,
 * shoduje s tím, co je v repozitáři. Sám jsem se na to napálil: na
 * snímku obrazovky chyběla legenda stavů a nešlo rozhodnout, jestli je
 * to nenasazený commit, nebo moje chyba. Stálo to jeden kruh navíc.
 *
 * DVĚ ČÍSLA, NE JEDNO
 * Verze frontendu se zapéká při buildu, verze serveru se čte za běhu.
 * Když se liší, znamená to, že prohlížeč drží starý bundle — přesně ten
 * stav, kvůli kterému vznikl `lazy-with-reload.js`. Zobrazit jen jedno
 * číslo by tenhle případ zamlčelo.
 *
 * NEZNÁMÁ VERZE SE PŘIZNÁ
 * Když se commit do image nedostane (build mimo git, chybějící ARG),
 * vrací se `null`, ne vymyšlená hodnota. Číslo verze, kterému se nedá
 * věřit, je horší než žádné — podle něj se rozhoduje, jestli se má
 * nasazovat znovu.
 */

/** Zkrátí commit na čitelných sedm znaků. Prázdný a vadný vstup → `null`. */
export function zkratCommit(raw) {
  const t = String(raw ?? '').trim();
  // `unknown` a podobné výplně z build argů se berou jako „nevím".
  if (t === '' || t === 'unknown' || t === 'null' || t === 'undefined') return null;
  if (!/^[0-9a-f]{7,40}$/i.test(t)) return null;
  return t.slice(0, 7);
}

/** Čas buildu na čitelný tvar. Nečitelný vstup → `null`. */
export function formatBuildTime(raw) {
  const d = new Date(String(raw ?? ''));
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

/**
 * Popisek verze pro zobrazení.
 *
 * @param {{commit?: string|null, buildTime?: string|null}} info
 * @returns {string}
 */
export function popisVerze(info) {
  const commit = zkratCommit(info?.commit);
  const cas = formatBuildTime(info?.buildTime);
  if (!commit && !cas) return 'verze neznámá';
  if (!commit) return `sestaveno ${cas.slice(0, 10)}`;
  if (!cas) return commit;
  return `${commit} · ${cas.slice(0, 10)}`;
}

/**
 * Shodují se verze frontendu a serveru?
 *
 * `null` = nedá se posoudit (jedna ze stran verzi nezná). Neznamená to
 * shodu ani neshodu — a tvrdit „vše v pořádku" na základě chybějícího
 * údaje je táž vada, jakou hlídají skenery.
 *
 * @returns {boolean|null}
 */
export function verzeSouhlasi(frontend, server) {
  const a = zkratCommit(frontend);
  const b = zkratCommit(server);
  if (!a || !b) return null;
  return a === b;
}

/** Verze serveru z prostředí. Doplňuje se při buildu image. */
export function serverBuildInfo(env = process.env) {
  return {
    commit: zkratCommit(env.GIT_COMMIT),
    buildTime: formatBuildTime(env.BUILD_TIME),
  };
}
