/**
 * Kdo smí nástroj používat.
 *
 * PROČ TO NESTAČÍ ŘEŠIT PŘIHLÁŠENÍM
 * Skenování je za přihlášením proto, aby nešlo poslat náš server na
 * libovolnou adresu. Jenže registrace je otevřená — kdokoli, kdo najde
 * URL, si účet vyrobí sám. Brána bez zámku.
 *
 * Kontrola je proto na SERVERU, v ověřovacím middleware. Schovat tlačítko
 * ve frontendu nestačí: endpointy jdou volat přímo.
 *
 * VÝCHOZÍ STAV JE OTEVŘENÝ
 * Prázdná konfigurace znamená „bez omezení". Opačná volba by při upgradu
 * existující instalace zamkla všechny uživatele naráz, včetně toho, kdo
 * upgrade dělá. Server proto při startu vypíše výstrahu — tiché
 * neomezení by bylo horší než hlučné.
 */

/** Rozdělí čárkami oddělený seznam z prostředí. */
function parseList(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Načte konfiguraci přístupu.
 *
 * Čte se při každém volání, ne jednou při startu: testy si tím mohou
 * prostředí měnit a v provozu je to jeden split řetězce.
 */
export function accessConfig(env = process.env) {
  const emails = parseList(env.ALLOWED_EMAILS);
  // Doména se píše bez zavináče (`firma.cz`), ale kdyby ho tam někdo dal,
  // nemá to selhat tiše.
  const domains = parseList(env.ALLOWED_EMAIL_DOMAINS).map((d) => d.replace(/^@/, ''));
  return { emails, domains, restricted: emails.length > 0 || domains.length > 0 };
}

/**
 * Smí tenhle uživatel dovnitř?
 *
 * @param {string|null|undefined} email
 * @param {object} [env]
 * @returns {{allowed: boolean, reason: string|null}}
 */
export function isEmailAllowed(email, env = process.env) {
  const { emails, domains, restricted } = accessConfig(env);
  if (!restricted) return { allowed: true, reason: null };

  // Bez adresy nelze rozhodnout. Při zapnutém omezení je jediná bezpečná
  // odpověď „ne" — anonymní token by jinak omezení obešel.
  if (!email) {
    return { allowed: false, reason: 'Token neobsahuje e-mailovou adresu.' };
  }

  const normalized = String(email).trim().toLowerCase();
  if (emails.includes(normalized)) return { allowed: true, reason: null };

  const at = normalized.lastIndexOf('@');
  const domain = at === -1 ? '' : normalized.slice(at + 1);
  if (domain && domains.includes(domain)) return { allowed: true, reason: null };

  return {
    allowed: false,
    reason: 'Tato e-mailová adresa nemá přístup k této instalaci.',
  };
}

/**
 * Výstraha do logu při startu.
 *
 * Vrací řádky místo aby rovnou tiskla — díky tomu jde otestovat, že se
 * u neomezené instalace opravdu ozve.
 */
export function accessWarnings(env = process.env) {
  const { emails, domains, restricted } = accessConfig(env);

  if (!restricted) {
    return [
      'POZOR: přístup není omezený. Kdokoli si založí účet a může z tohoto ' +
        'serveru spouštět skeny na libovolné adresy.',
      'Omez ho v .env: ALLOWED_EMAILS=jan@firma.cz nebo ALLOWED_EMAIL_DOMAINS=firma.cz',
    ];
  }

  const parts = [];
  if (emails.length) parts.push(`${emails.length} adres`);
  if (domains.length) parts.push(`domény: ${domains.join(', ')}`);
  return [`Přístup omezen na ${parts.join(', ')}.`];
}
