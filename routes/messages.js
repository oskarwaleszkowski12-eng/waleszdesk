const { Router } = require('express');
const { pool }   = require('../lib/db');
const { requireAuth } = require('../lib/auth');
const { validate, z } = require('../lib/validate');
const { sendTelegram } = require('../lib/telegram');
const logger = require('../lib/logger');

const router = Router();

const contactSchema = z.object({
  name:    z.string().min(1).max(100),
  email:   z.string().email(),
  subject: z.string().min(1).max(200).optional(),
  content: z.string().min(1).max(5000),
});

// ── Public: contact form (landing page) ───────────────────────────────────────
router.post('/', validate(contactSchema), async (req, res) => {
  const { name, email, subject = 'Wiadomość z landing page', content } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(`
      INSERT INTO conversations (from_email, from_name, subject, source)
      VALUES ($1, $2, $3, 'contact') RETURNING id
    `, [email.toLowerCase().trim(), name.trim(), subject.trim()]);
    const convId = rows[0].id;
    await client.query(`
      INSERT INTO messages (conversation_id, sender, content)
      VALUES ($1, 'user', $2)
    `, [convId, content.trim()]);
    await client.query('COMMIT');

    sendTelegram(
      `📬 <b>Nowa wiadomość</b> (landing)\n👤 ${name} &lt;${email}&gt;\n📌 ${subject}\n\n${content.slice(0, 300)}${content.length > 300 ? '…' : ''}`
    );
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error({ err }, '[messages POST public]');
    res.status(500).json({ ok: false, error: 'Błąd serwera.' });
  } finally {
    client.release();
  }
});

// ── Admin: unread count (for badge) ──────────────────────────────────────────
router.get('/unread-count', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS count FROM conversations WHERE unread_admin = TRUE AND status = 'open'`
    );
    res.json({ ok: true, count: rows[0].count });
  } catch (err) {
    logger.error({ err }, '[messages unread-count]');
    res.status(500).json({ ok: false, error: 'Błąd serwera.' });
  }
});

// ── Admin: list conversations ─────────────────────────────────────────────────
router.get('/conversations', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        c.id, c.from_email, c.from_name, c.subject, c.source,
        c.status, c.unread_admin, c.unread_sub, c.created_at, c.updated_at,
        s.name AS subscriber_name, s.plan AS subscriber_plan,
        (SELECT content FROM messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) AS last_message,
        (SELECT COUNT(*)::int FROM messages WHERE conversation_id = c.id) AS message_count
      FROM conversations c
      LEFT JOIN subscribers s ON s.id = c.subscriber_id
      ORDER BY c.updated_at DESC
    `);
    res.json({ ok: true, conversations: rows });
  } catch (err) {
    logger.error({ err }, '[messages conversations GET]');
    res.status(500).json({ ok: false, error: 'Błąd serwera.' });
  }
});

// ── Admin: get thread ─────────────────────────────────────────────────────────
router.get('/conversations/:id', requireAuth, async (req, res) => {
  const id = req.params.id;
  try {
    const [convRes, msgRes] = await Promise.all([
      pool.query(`
        SELECT c.*, s.name AS subscriber_name, s.plan AS subscriber_plan, s.email AS subscriber_email
        FROM conversations c LEFT JOIN subscribers s ON s.id = c.subscriber_id WHERE c.id = $1
      `, [id]),
      pool.query(
        `SELECT id, sender, content, created_at FROM messages WHERE conversation_id=$1 ORDER BY created_at ASC`,
        [id]
      ),
    ]);
    if (!convRes.rows[0]) return res.status(404).json({ ok: false, error: 'Not found' });
    await pool.query(`UPDATE conversations SET unread_admin = FALSE WHERE id=$1`, [id]);

    const msgIds = msgRes.rows.map(m => m.id);
    let attMap = {};
    if (msgIds.length) {
      const attRes = await pool.query(
        `SELECT id, ref_id, mime_type, data, filename FROM attachments WHERE ref_type='message' AND ref_id=ANY($1)`,
        [msgIds]
      );
      attRes.rows.forEach(a => { (attMap[a.ref_id] = attMap[a.ref_id] || []).push(a); });
    }
    const messages = msgRes.rows.map(m => ({ ...m, attachments: attMap[m.id] || [] }));
    res.json({ ok: true, conversation: convRes.rows[0], messages });
  } catch (err) {
    logger.error({ err }, '[messages conversation GET]');
    res.status(500).json({ ok: false, error: 'Błąd serwera.' });
  }
});

// ── Admin: reply ──────────────────────────────────────────────────────────────
const replySchema = z.object({
  content:        z.string().min(1).max(5000),
  attachment_ids: z.array(z.number().int()).optional(),
});

router.post('/conversations/:id/reply', requireAuth, validate(replySchema), async (req, res) => {
  const { content, attachment_ids = [] } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: convRows } = await client.query(
      `SELECT id, from_email, from_name, subscriber_id FROM conversations WHERE id=$1`,
      [req.params.id]
    );
    if (!convRows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ ok: false, error: 'Not found' }); }

    const { rows: msgRows } = await client.query(
      `INSERT INTO messages (conversation_id, sender, content) VALUES ($1, 'admin', $2) RETURNING id`,
      [req.params.id, content.trim()]
    );
    const msgId = msgRows[0].id;
    if (attachment_ids.length) {
      await client.query(
        `UPDATE attachments SET ref_type='message', ref_id=$1 WHERE id=ANY($2)`,
        [msgId, attachment_ids]
      );
    }
    await client.query(
      `UPDATE conversations SET unread_sub=TRUE, unread_admin=FALSE, updated_at=NOW() WHERE id=$1`,
      [req.params.id]
    );
    await client.query('COMMIT');

    const conv = convRows[0];
    sendTelegram(
      `📤 <b>Odpowiedź wysłana</b>\n👤 ${conv.from_name || conv.from_email}\n\n${content.slice(0, 200)}${content.length > 200 ? '…' : ''}`
    );
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error({ err }, '[messages reply POST]');
    res.status(500).json({ ok: false, error: 'Błąd serwera.' });
  } finally {
    client.release();
  }
});

// ── Admin: close / reopen ─────────────────────────────────────────────────────
router.patch('/conversations/:id/status', requireAuth, async (req, res) => {
  const { status } = req.body;
  if (!['open', 'closed'].includes(status))
    return res.status(400).json({ ok: false, error: 'Invalid status' });
  try {
    await pool.query(`UPDATE conversations SET status=$1, updated_at=NOW() WHERE id=$2`, [status, req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, '[messages status PATCH]');
    res.status(500).json({ ok: false, error: 'Błąd serwera.' });
  }
});

// ── Admin: delete ─────────────────────────────────────────────────────────────
router.delete('/conversations/:id', requireAuth, async (req, res) => {
  try {
    await pool.query(`DELETE FROM conversations WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, '[messages DELETE]');
    res.status(500).json({ ok: false, error: 'Błąd serwera.' });
  }
});

module.exports = router;
