const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('./config');

function requireAuth(req, res, next) {
  const header = req.headers['authorization'] || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  try {
    jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ ok: false, error: 'Invalid or expired token' });
  }
}

function requireSubscriberAuth(req, res, next) {
  const header = req.headers['authorization'] || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.role !== 'subscriber') return res.status(403).json({ ok: false, error: 'Forbidden' });
    req.subscriber = payload;
    next();
  } catch {
    res.status(401).json({ ok: false, error: 'Invalid or expired token' });
  }
}

module.exports = { requireAuth, requireSubscriberAuth, JWT_SECRET };
