const { Router } = require('express');
const jwt        = require('jsonwebtoken');
const { pool }   = require('../lib/db');
const { JWT_SECRET } = require('../lib/auth');
const logger     = require('../lib/logger');

const router  = Router();
const MAX_KB  = 5120; // 5 MB

function flexAuth(req, res, next) {
  // Cookie first (wd_admin or wd_sub), then Bearer header fallback
  const h = req.headers['authorization'] || '';
  const token = req.cookies?.wd_admin || req.cookies?.wd_sub ||
    (h.startsWith('Bearer ') ? h.slice(7) : null);
  if (!token) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  try { req.jwt = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ ok: false, error: 'Invalid token' }); }
}

// POST /api/attachments — upload (admin or subscriber)
router.post('/', flexAuth, async (req, res) => {
  const { ref_type = 'pending', ref_id = 0, filename = 'image', mime_type, data } = req.body;
  const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
  if (!ALLOWED_MIME.includes(mime_type))
    return res.status(400).json({ ok: false, error: 'Tylko obrazy JPEG, PNG, GIF lub WebP.' });
  if (!/^data:image\/(jpeg|png|gif|webp);base64,[A-Za-z0-9+/]+=*$/.test(data || ''))
    return res.status(400).json({ ok: false, error: 'Nieprawidłowy format danych obrazu.' });
  const sizeKb = Math.round((data.length) * 0.75 / 1024);
  if (sizeKb > MAX_KB)
    return res.status(400).json({ ok: false, error: 'Maksymalny rozmiar to 5 MB.' });
  if (req.jwt.role === 'subscriber' && ref_type !== 'pending')
    return res.status(403).json({ ok: false, error: 'Forbidden' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO attachments (ref_type, ref_id, filename, mime_type, data, size_kb)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [ref_type, ref_id, filename, mime_type, data, sizeKb]
    );
    res.json({ ok: true, id: rows[0].id });
  } catch (err) {
    logger.error({ err }, '[attachments POST]');
    res.status(500).json({ ok: false, error: 'Błąd serwera.' });
  }
});

// GET /api/attachments/ref?type=X&id=Y
router.get('/ref', flexAuth, async (req, res) => {
  const { type, id } = req.query;
  if (!type || !id) return res.status(400).json({ ok: false, error: 'Brak type/id' });
  if (req.jwt.role === 'subscriber' && type === 'trade')
    return res.status(403).json({ ok: false, error: 'Forbidden' });
  try {
    let rows;
    if (req.jwt.role === 'subscriber' && type === 'message') {
      // Verify the message belongs to a conversation owned by this subscriber
      const check = await pool.query(
        `SELECT a.id, a.filename, a.mime_type, a.data, a.size_kb
         FROM attachments a
         JOIN messages m ON m.id = a.ref_id AND a.ref_type = 'message'
         JOIN conversations c ON c.id = m.conversation_id
         WHERE a.ref_type=$1 AND a.ref_id=$2 AND c.subscriber_id=$3
         ORDER BY a.created_at`,
        [type, parseInt(id), req.jwt.sub_id]
      );
      rows = check.rows;
    } else {
      const result = await pool.query(
        `SELECT id, filename, mime_type, data, size_kb FROM attachments WHERE ref_type=$1 AND ref_id=$2 ORDER BY created_at`,
        [type, parseInt(id)]
      );
      rows = result.rows;
    }
    res.json({ ok: true, attachments: rows });
  } catch (err) {
    logger.error({ err }, '[attachments GET ref]');
    res.status(500).json({ ok: false, error: 'Błąd serwera.' });
  }
});

// DELETE /api/attachments/:id — admin only
router.delete('/:id', flexAuth, async (req, res) => {
  if (req.jwt.role !== 'admin') return res.status(403).json({ ok: false, error: 'Forbidden' });
  try {
    await pool.query('DELETE FROM attachments WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, '[attachments DELETE]');
    res.status(500).json({ ok: false, error: 'Błąd serwera.' });
  }
});

module.exports = router;
