/**
 * Stažení souboru z endpointu, který vyžaduje přihlášení.
 *
 * PROČ NE PROSTĚ <a href>
 * Odkaz v prohlížeči neposílá hlavičku `Authorization`, takže by stahování
 * skončilo na 401. Obvyklé „řešení" je propašovat token do query — jenže
 * ten se pak objeví v historii prohlížeče, v logu proxy i v hlavičce
 * Referer u každého dalšího požadavku. U nástroje, který cizím webům
 * vytýká úniky přes URL, obzvlášť nešťastné.
 *
 * Soubor se proto stáhne přes `fetch` s hlavičkou a teprve výsledek se
 * podstrčí prohlížeči jako blob. Token neopustí paměť stránky.
 *
 * Cena: celý soubor projde pamětí. U spisu (jednotky MB) to nevadí;
 * kdyby sem někdy přibyl export videí, bude potřeba jiné řešení.
 */

/**
 * Jméno souboru z hlavičky Content-Disposition.
 *
 * Server ho posílá, protože ví, jaké období se exportovalo. Když chybí,
 * použije se záložní — stažený soubor bez jména je pro uživatele horší
 * než jméno obecné.
 */
export function filenameFromDisposition(header, fallback) {
  if (!header) return fallback;
  // `filename*=UTF-8''…` má přednost před `filename="…"` (RFC 5987).
  const utf8 = header.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8) {
    try {
      return decodeURIComponent(utf8[1]);
    } catch {
      // Vadné kódování není důvod stahování shodit.
    }
  }
  const plain = header.match(/filename="?([^";]+)"?/i);
  return plain ? plain[1] : fallback;
}

/**
 * @param {string} url
 * @param {string} token  Firebase ID token
 * @param {string} fallbackName  jméno, když ho server nepošle
 * @returns {Promise<string>} jméno staženého souboru
 */
export async function downloadAuthenticated(url, token, fallbackName) {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    // Chybová odpověď je JSON, ne soubor — vytáhnout z ní hlášku je
    // užitečnější než ukázat „HTTP 400".
    let detail = `HTTP ${response.status}`;
    try {
      const body = await response.json();
      if (body?.error) detail = body.error;
    } catch {
      // Odpověď nebyla JSON; zůstane stavový kód.
    }
    throw new Error(detail);
  }

  const blob = await response.blob();
  const name = filenameFromDisposition(
    response.headers.get('content-disposition'),
    fallbackName
  );

  const objectUrl = URL.createObjectURL(blob);
  try {
    const link = document.createElement('a');
    link.href = objectUrl;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
  } finally {
    // Bez uvolnění drží blob paměť až do zavření záložky. U opakovaného
    // exportu spisu to nasčítá desítky MB.
    URL.revokeObjectURL(objectUrl);
  }

  return name;
}
