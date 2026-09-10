/**
 * Doplnění schématu do adresy zadané uživatelem.
 *
 * PROČ
 * Lidé píšou `test.example.cz`, ne `https://test.example.cz`. Bez schématu
 * ale adresu odmítne SSRF guard na serveru s hláškou „Povoleno je pouze
 * schéma http nebo https", což je technicky pravda a prakticky matoucí —
 * uživatel žádné schéma nezadal, takže neví, co má opravit.
 *
 * ČEHO SE TO DRŽÍ
 * Doplňuje se jen tehdy, když adresa žádné schéma NEMÁ. Když ho má, nechá
 * se tak, jak je — i kdyby bylo nesmyslné. `ftp://…` nebo `javascript:…`
 * má odmítnout guard a říct proč; přepsat je na `https://` by znamenalo
 * měřit něco jiného, než uživatel zadal, a to je u nástroje, jehož výstup
 * jde úřadu, nepřijatelné.
 *
 * Prázdný vstup zůstává prázdný — z ničeho se adresa nedělá.
 */

/** `scheme:` na začátku podle RFC 3986: písmeno, pak písmena, číslice, +-. */
const MA_SCHEMA = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/**
 * Dvojtečka následovaná PORTEM, ne schématem.
 *
 * `localhost:3000` i `example.com:8443` vypadají podle RFC jako schéma
 * s cestou, ale jsou to hostitelé s portem. Bez tohohle rozlišení by
 * zůstaly beze schématu a guard by je odmítl — přičemž port u adresy je
 * zcela běžný zápis.
 *
 * Za dvojtečkou musí být jen číslice a pak konec, lomítko, otazník nebo
 * mřížka. `javascript:1234abc` tím projde jako schéma, což je správně.
 */
const JE_PORT = /^[A-Za-z0-9.-]+:\d+(?:[/?#]|$)/;

/**
 * @param {string} vstup adresa tak, jak ji člověk napsal
 * @returns {string} adresa se schématem, nebo beze změny
 */
export function normalizeUrlInput(vstup) {
  const text = String(vstup ?? '').trim();
  if (text === '') return '';

  // Už schéma má — ať jakékoli. Posoudit ho je věc guardu, ne naše.
  if (MA_SCHEMA.test(text) && !JE_PORT.test(text)) return text;

  // `//example.cz` je zápis „stejné schéma jako stránka". V poli, kam se
  // píše cíl skenu, to nedává smysl a `https://` je zjevný záměr.
  return `https://${text.replace(/^\/+/, '')}`;
}
