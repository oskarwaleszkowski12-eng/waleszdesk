const jwt    = require('jsonwebtoken');
const { pool } = require('./db');
const { JWT_SECRET } = require('./config');

function _extractToken(req, cookieName) {
  if (req.cookies?.[cookieName]) return req.cookies[cookieName];
  const h = req.headers['authorization'] || '';
  return h.startsWith('Bearer ') ? h.slice(7) : null;
}

function requireAuth(req, res, next) {
  const token = _extractToken(req, 'wd_admin');
  if (!token) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.role !== 'admin')
      return res.status(403).json({ ok: false, error: 'Forbidden' });
    req.admin = payload;
    next();
  } catch {
    res.status(401).json({ ok: false, error: 'Invalid or expired token' });
  }
}

async function requireSubscriberAuth(req, res, next) {
  const token = _extractToken(req, 'wd_sub');
  if (!token) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.role !== 'subscriber') return res.status(403).json({ ok: false, error: 'Forbidden' });
    // Re-check subscriber is still active in DB (catches suspensions after token issuance)
    const { rows } = await pool.query(
      `SELECT status, expires_at FROM subscribers WHERE id=$1`,
      [payload.sub_id]
    );
    if (!rows[0] || rows[0].status !== 'active')
      return res.status(403).json({ ok: false, error: 'Konto nieaktywne.' });
    if (rows[0].expires_at && new Date(rows[0].expires_at) < new Date())
      return res.status(403).json({ ok: false, error: 'Dostęp wygasł.' });
    req.subscriber = payload;
    next();
  } catch (err) {
    if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError')
      return res.status(401).json({ ok: false, error: 'Invalid or expired token' });
    res.status(500).json({ ok: false, error: 'Auth error' });
  }
}

module.exports = { requireAuth, requireSubscriberAuth, JWT_SECRET };
