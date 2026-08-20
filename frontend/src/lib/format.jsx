/**
 * Formátovací pomocníci vytažení z App.jsx.
 * Čisté funkce bez stavu — snadno testovatelné samostatně.
 */

/**
 * Zvýrazní značky, kterými PII redaktor na serveru nahradil osobní údaje,
 * aby bylo v logu vidět, že tam něco bylo a bylo to schválně skryto.
 */
export function formatRedactedText(text) {
  if (!text || typeof text !== 'string') return text;

  const parts = text.split(/(\[REDACTED_[A-Z_]+\])/g);
  return parts.map((part, index) => {
    if (part.startsWith('[REDACTED_')) {
      return (
        <span
          key={index}
          style={{
            backgroundColor: 'var(--accent)',
            color: 'white',
            padding: '0 4px',
            borderRadius: '3px',
            fontSize: '0.85em',
            fontWeight: 'bold',
          }}
        >
          {part}
        </span>
      );
    }
    return part;
  });
}

/** Vytáhne doménu z URL; při neplatném vstupu vrátí původní hodnotu. */
export function getDomain(urlStr) {
  try {
    return new URL(urlStr).hostname;
  } catch {
    return urlStr;
  }
}
