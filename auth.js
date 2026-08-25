import { auth } from './db.js';
import { isEmailAllowed } from './access-control.js';

export async function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Přístup odepřen. Chybí token.' });
  }

  try {
    const decodedToken = await auth.verifyIdToken(token);

    // Platný token neznamená oprávnění.
    //
    // Registrace ve Firebase je otevřená, takže kdokoli si vyrobí platný
    // token sám. Kontrola musí být tady, na serveru — schovat tlačítko ve
    // frontendu nestačí, endpointy jdou volat přímo.
    const access = isEmailAllowed(decodedToken.email);
    if (!access.allowed) {
      // Do logu adresa patří (provozovatel má vědět, kdo se pokusil),
      // do odpovědi ne víc, než uživatel potřebuje.
      console.warn(
        `Odepřen přístup: ${decodedToken.email || '(bez adresy)'} — ${access.reason}`
      );
      return res.status(403).json({
        error:
          'Tento účet nemá přístup k této instalaci. Požádejte správce o zařazení.',
      });
    }

    req.user = { userId: decodedToken.uid, email: decodedToken.email };
    next();
  } catch (err) {
    console.error('Chyba při ověřování Firebase ID tokenu:', err.message);
    return res.status(403).json({ error: 'Neplatný nebo expirovaný token.' });
  }
}
