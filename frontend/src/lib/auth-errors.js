/**
 * Chyby přihlášení v lidské řeči.
 *
 * Firebase vrací `Firebase: Error (auth/network-request-failed).` — kód,
 * který uživateli neřekne nic a vývojáře pošle špatným směrem. Zrovna
 * tenhle konkrétní případ nastal proto, že Content-Security-Policy na
 * proxy zakazovala spojení na Google API; „network-request-failed" přitom
 * svádí hledat výpadek internetu.
 *
 * Hlášky proto říkají, CO se stalo a CO S TÍM, a u chyb konfigurace
 * nepředstírají, že si za to může uživatel.
 *
 * POZOR NA VÝČET UŽIVATELŮ
 * Firebase rozlišuje `user-not-found` a `wrong-password`. Kdyby to
 * rozlišovalo i UI, dalo by se z něj zjistit, které e-maily jsou
 * registrované. Obojí proto vede na tutéž větu.
 */

const MESSAGES = {
  // ── Chyba na straně uživatele ────────────────────────────────────────
  'auth/invalid-email': 'E-mailová adresa nemá platný tvar.',
  'auth/missing-password': 'Zadejte heslo.',
  'auth/weak-password': 'Heslo je příliš krátké. Použijte alespoň 6 znaků.',
  'auth/email-already-in-use':
    'Účet s touto adresou už existuje. Přihlaste se místo registrace.',

  // Nerozlišovat neexistující účet od špatného hesla — jinak by šlo
  // z aplikace vyčíst seznam registrovaných adres.
  'auth/user-not-found': 'Nesprávná e-mailová adresa nebo heslo.',
  'auth/wrong-password': 'Nesprávná e-mailová adresa nebo heslo.',
  'auth/invalid-credential': 'Nesprávná e-mailová adresa nebo heslo.',

  'auth/too-many-requests':
    'Příliš mnoho pokusů za sebou. Zkuste to prosím za pár minut.',
  'auth/user-disabled': 'Tento účet je zablokovaný. Obraťte se na správce.',

  // ── Chyba prostředí nebo konfigurace ─────────────────────────────────
  //
  // Tady je důležité neobvinit uživatele: s heslem to nemá co dělat
  // a opakovaný pokus nepomůže.
  'auth/network-request-failed':
    'Nepodařilo se spojit s ověřovací službou. Buď je výpadek sítě, nebo ' +
    'server blokuje spojení na Google API (Content-Security-Policy). ' +
    'Opakovaný pokus nepomůže — dejte prosím vědět správci.',
  'auth/operation-not-allowed':
    'Přihlašování e-mailem není u tohoto projektu povolené. Jde o nastavení ' +
    'na straně provozovatele, ne o chybu vašich údajů.',
  'auth/invalid-api-key':
    'Aplikace má neplatný klíč k ověřovací službě. Chyba nasazení — ' +
    'přihlášení nebude fungovat nikomu.',
  'auth/unauthorized-domain':
    'Tato doména není povolená v nastavení Firebase Auth. Chyba nasazení.',
};

/**
 * @param {unknown} error  chyba z Firebase SDK
 * @returns {string} věta pro uživatele
 */
export function authErrorMessage(error) {
  const code = error?.code;
  if (code && MESSAGES[code]) return MESSAGES[code];

  // Neznámý kód: ukázat ho, ale s vysvětlením, co s tím. Schovat ho úplně
  // by znemožnilo nahlásit problém srozumitelně.
  if (code) {
    return `Přihlášení se nezdařilo (${code}). Zkuste to prosím znovu; pokud ` +
      'potíž trvá, pošlete správci tento kód.';
  }

  return 'Přihlášení se nezdařilo. Zkuste to prosím znovu.';
}

/**
 * Je to chyba nasazení, ne uživatele?
 *
 * Podle toho se rozhoduje, jestli má smysl nabízet opakování — u vadné
 * konfigurace by uživatel klikal donekonečna.
 */
export function isConfigurationError(error) {
  return [
    'auth/network-request-failed',
    'auth/operation-not-allowed',
    'auth/invalid-api-key',
    'auth/unauthorized-domain',
  ].includes(error?.code);
}
