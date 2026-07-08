import { auth } from './db.js';

export async function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Přístup odepřen. Chybí token.' });
  }

  try {
    const decodedToken = await auth.verifyIdToken(token);
    req.user = { userId: decodedToken.uid, email: decodedToken.email };
    next();
  } catch (err) {
    console.error('Chyba při ověřování Firebase ID tokenu:', err.message);
    return res.status(403).json({ error: 'Neplatný nebo expirovaný token.' });
  }
}
