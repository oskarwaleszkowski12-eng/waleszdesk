const { Router } = require('express');
const crypto     = require('crypto');
const jwt        = require('jsonwebtoken');
const { pool }   = require('../lib/db');
const { JWT_SECRET, requireAuth, requireSubscriberAuth } = require('../lib/auth');
const { validate, z } = require('../lib/validate');
const { sendTelegram } = require('../lib/telegram');
const { sendSubscriberWelcome } = require('../lib/email');
const logger     = require('../lib/logger');

const router = Router();

function hashCode(code) {
  return crypto.createHash('sha256').update(code.toLowerCase().trim()).digest('hex');
}
function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const seg = () => Array.from({ length: 4 }, () => chars[crypto.randomInt(chars.length)]).join('');
  return `${seg()}-${seg()}-${seg()}`;
}

// ── Public: login ─────────────────────────────────────────────────────────────
const loginSchema = z.object({ email: z.string().email(), code: z.string().min(1) });

router.post('/login', validate(loginSchema), async (req, res) => {
  const { email, code } = req.body;
  try {
    const { rows } = await pool.query(
      'SELECT id, name, plan, status, code_hash, expires_at FROM subscribers WHERE email=$1',
      [email.toLowerCase().trim()]
    );
    const sub = rows[0];
    if (!sub || sub.code_hash !== hashCode(code))
      return res.status(401).json({ ok: false, error: 'Nieprawidłowy email lub kod dostępu.' });
    if (sub.status !== 'active')
      return res.status(403).json({ ok: false, error: 'Konto jest nieaktywne.' });
    if (sub.expires_at && new Date(sub.expires_at) < new Date())
      return res.status(403).json({ ok: false, error: 'Dostęp wygasł.' });

    const token = jwt.sign(
      { role: 'subscriber', sub_id: sub.id, plan: sub.plan, name: sub.name || null },
      JWT_SECRET, { expiresIn: '7d' }
    );
    res.cookie('wd_sub', token, {
      httpOnly: true,
      secure:   process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge:   7 * 24 * 60 * 60 * 1000,
    });
    res.json({ ok: true, plan: sub.plan, name: sub.name });
  } catch (err) {
    logger.error({ err }, '[subscriber/login]');
    res.status(500).json({ ok: false, error: 'Błąd serwera.' });
  }
});

// ── Public: logout ────────────────────────────────────────────────────────────
router.post('/logout', (req, res) => {
  res.clearCookie('wd_sub', {
    httpOnly: true,
    secure:   process.env.NODE_ENV === 'production',
    sameSite: 'strict',
  });
  res.json({ ok: true });
});

// ── Subscriber: refresh token ─────────────────────────────────────────────────
router.post('/refresh', requireSubscriberAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, plan, name FROM subscribers WHERE id=$1 AND status='active' AND (expires_at IS NULL OR expires_at > NOW())`,
      [req.subscriber.sub_id]
    );
    if (!rows[0]) return res.status(403).json({ ok: false, error: 'Konto nieaktywne lub dostęp wygasł.' });
    const sub   = rows[0];
    const token = jwt.sign(
      { role: 'subscriber', sub_id: sub.id, plan: sub.plan, name: sub.name || null },
      JWT_SECRET, { expiresIn: '7d' }
    );
    res.cookie('wd_sub', token, {
      httpOnly: true,
      secure:   process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge:   7 * 24 * 60 * 60 * 1000,
    });
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, '[subscriber/refresh]');
    res.status(500).json({ ok: false, error: 'Błąd serwera.' });
  }
});

// ── Subscriber: me ────────────────────────────────────────────────────────────
router.get('/me', requireSubscriberAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, email, name, plan, status, activated_at, expires_at FROM subscribers WHERE id=$1',
      [req.subscriber.sub_id]
    );
    if (!rows[0]) return res.status(404).json({ ok: false, error: 'Not found' });
    res.json({ ok: true, subscriber: rows[0] });
  } catch (err) {
    logger.error({ err }, '[subscriber/me]');
    res.status(500).json({ ok: false, error: 'Błąd serwera.' });
  }
});

// ── Subscriber: performance ───────────────────────────────────────────────────
router.get('/performance', requireSubscriberAuth, async (req, res) => {
  const period = Math.min(365, Math.max(7, parseInt(req.query.days) || 30));
  const since  = new Date(Date.now() - period * 86400000).toISOString();

  try {
    const [statsRes, historyRes, monthlyRes, drawdownRes] = await Promise.all([
      // Aggregate stats for the period
      pool.query(`
        SELECT
          COUNT(*)::int                                              AS total_trades,
          COUNT(*) FILTER (WHERE pnl > 0)::int                      AS wins,
          COUNT(*) FILTER (WHERE pnl < 0)::int                      AS losses,
          COALESCE(SUM(pnl),0)::float                               AS net_pnl,
          COALESCE(MAX(pnl),0)::float                               AS best_trade,
          COALESCE(MIN(pnl),0)::float                               AS worst_trade,
          COALESCE(SUM(pnl) FILTER (WHERE pnl > 0),0)::float        AS gross_profit,
          COALESCE(SUM(ABS(pnl)) FILTER (WHERE pnl < 0),0)::float   AS gross_loss
        FROM trades
        WHERE pnl IS NOT NULL AND published = TRUE AND close_time >= $1
      `, [since]),

      // Daily equity data (all-time) for cumulative chart
      pool.query(`
        SELECT
          TO_CHAR(DATE(close_time AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
          ROUND(SUM(pnl)::numeric, 4) AS pnl
        FROM trades
        WHERE pnl IS NOT NULL AND published = TRUE
        GROUP BY DATE(close_time AT TIME ZONE 'UTC')
        ORDER BY DATE(close_time AT TIME ZONE 'UTC')
      `),

      // Monthly breakdown
      pool.query(`
        SELECT
          TO_CHAR(DATE_TRUNC('month', close_time AT TIME ZONE 'UTC'), 'YYYY-MM') AS month,
          ROUND(SUM(pnl)::numeric, 2)::float                         AS pnl,
          COUNT(*)::int                                               AS total,
          COUNT(*) FILTER (WHERE pnl > 0)::int                       AS wins,
          COUNT(*) FILTER (WHERE pnl < 0)::int                       AS losses
        FROM trades
        WHERE pnl IS NOT NULL AND published = TRUE
        GROUP BY DATE_TRUNC('month', close_time AT TIME ZONE 'UTC')
        ORDER BY DATE_TRUNC('month', close_time AT TIME ZONE 'UTC') DESC
        LIMIT 24
      `),

      // Max drawdown (all-time published)
      pool.query(`
        WITH cum AS (
          SELECT SUM(pnl) OVER (ORDER BY close_time ROWS UNBOUNDED PRECEDING) AS equity
          FROM trades WHERE pnl IS NOT NULL AND published = TRUE ORDER BY close_time
        ),
        peaks AS (
          SELECT equity, MAX(equity) OVER (ORDER BY equity ROWS UNBOUNDED PRECEDING) AS peak FROM cum
        )
        SELECT ROUND(COALESCE(MIN(equity - peak), 0)::numeric, 4)::float AS max_drawdown FROM peaks
      `),
    ]);

    const s = statsRes.rows[0];
    const winRate      = s.total_trades > 0 ? Math.round(s.wins / s.total_trades * 100) : 0;
    const profitFactor = s.gross_loss > 0 ? parseFloat((s.gross_profit / s.gross_loss).toFixed(2)) : null;
    const maxDrawdown  = drawdownRes.rows[0]?.max_drawdown ?? 0;

    // Build cumulative equity from daily history
    let running = 0;
    const history = historyRes.rows.map(r => {
      running += parseFloat(r.pnl);
      return { day: r.day, pnl: parseFloat(r.pnl), equity: parseFloat(running.toFixed(4)) };
    });

    res.json({
      ok: true,
      period,
      stats: {
        totalTrades: s.total_trades,
        wins: s.wins,
        losses: s.losses,
        winRate,
        netPnl: parseFloat(s.net_pnl.toFixed(4)),
        bestTrade: parseFloat(s.best_trade.toFixed(4)),
        worstTrade: parseFloat(s.worst_trade.toFixed(4)),
        profitFactor,
        maxDrawdown,
      },
      history,
      monthly: monthlyRes.rows,
    });
  } catch (err) {
    logger.error({ err }, '[subscriber/performance]');
    res.status(500).json({ ok: false, error: 'Błąd serwera.' });
  }
});

// ── Subscriber: trades ────────────────────────────────────────────────────────
router.get('/trades', requireSubscriberAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT id, symbol, side, entry_price, exit_price, size, pnl, open_time, close_time, program_notes AS notes
      FROM trades
      WHERE pnl IS NOT NULL AND published = TRUE
      ORDER BY close_time DESC
      LIMIT 100
    `);
    res.json({ ok: true, trades: rows });
  } catch (err) {
    logger.error({ err }, '[subscriber/trades]');
    res.status(500).json({ ok: false, error: 'Błąd serwera.' });
  }
});

// ── Subscriber: journal posts ─────────────────────────────────────────────────
const PLAN_ACCESS = { pro: ['pro'], vip: ['pro', 'vip'], mentoring: ['pro', 'vip', 'mentoring'] };

router.get('/journal', requireSubscriberAuth, async (req, res) => {
  const plan    = req.subscriber.plan;
  const allowed = PLAN_ACCESS[plan] || ['pro'];
  try {
    const { rows } = await pool.query(
      `SELECT id, title, content, plan_access, created_at
       FROM journal_posts
       WHERE published = TRUE AND plan_access = ANY($1)
       ORDER BY created_at DESC`,
      [allowed]
    );
    res.json({ ok: true, posts: rows });
  } catch (err) {
    logger.error({ err }, '[subscriber/journal]');
    res.status(500).json({ ok: false, error: 'Błąd serwera.' });
  }
});

// ── Admin: subscribers CRUD ───────────────────────────────────────────────────
const createSchema = z.object({
  email:       z.string().email(),
  name:        z.string().optional(),
  plan:        z.enum(['pro', 'vip', 'mentoring']),
  waitlist_id: z.number().int().optional(),
  notes:       z.string().optional(),
  expires_at:  z.string().optional(),
});

router.get('/admin/stats', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE status = 'active')::int AS active,
        COUNT(*) FILTER (WHERE status != 'active')::int AS inactive,
        COUNT(*) FILTER (WHERE plan = 'pro')::int AS plan_pro,
        COUNT(*) FILTER (WHERE plan = 'vip')::int AS plan_vip,
        COUNT(*) FILTER (WHERE plan = 'mentoring')::int AS plan_mentoring,
        COUNT(*) FILTER (WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at < NOW() + INTERVAL '14 days')::int AS expiring_soon
      FROM subscribers
    `);
    const r = rows[0];
    res.json({
      ok: true,
      total: r.total,
      active: r.active,
      inactive: r.inactive,
      byPlan: { pro: r.plan_pro, vip: r.plan_vip, mentoring: r.plan_mentoring },
      expiringSoon: r.expiring_soon,
    });
  } catch (err) {
    logger.error({ err }, '[subscriber/admin/stats]');
    res.status(500).json({ ok: false, error: 'Błąd serwera.' });
  }
});

router.get('/admin', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, email, name, plan, status, activated_at, expires_at, notes, waitlist_id FROM subscribers ORDER BY activated_at DESC'
    );
    res.json({ ok: true, subscribers: rows });
  } catch (err) {
    logger.error({ err }, '[subscriber/admin/list]');
    res.status(500).json({ ok: false, error: 'Błąd serwera.' });
  }
});

router.post('/admin', requireAuth, validate(createSchema), async (req, res) => {
  const { email, name, plan, waitlist_id, notes, expires_at } = req.body;
  const code = genCode();
  try {
    const { rows } = await pool.query(`
      INSERT INTO subscribers (email, name, plan, code_hash, waitlist_id, notes, expires_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (email) DO NOTHING RETURNING id
    `, [email.toLowerCase().trim(), name || null, plan, hashCode(code), waitlist_id || null, notes || null, expires_at || null]);
    if (!rows[0]) return res.status(409).json({ ok: false, error: 'Email już istnieje.' });
    res.json({ ok: true, id: rows[0].id, code });
    sendSubscriberWelcome(email.toLowerCase().trim(), name || null, plan, code).catch(() => {});
  } catch (err) {
    logger.error({ err }, '[subscriber/admin/create]');
    res.status(500).json({ ok: false, error: 'Błąd serwera.' });
  }
});

const updateSubSchema = z.object({
  status:     z.enum(['active', 'suspended', 'expired']),
  notes:      z.string().max(5000).optional().nullable(),
  expires_at: z.string().optional().nullable(),
});

router.put('/admin/:id', requireAuth, validate(updateSubSchema), async (req, res) => {
  const { status, notes, expires_at } = req.body;
  try {
    const { rowCount } = await pool.query('UPDATE subscribers SET status=$1,notes=$2,expires_at=$3 WHERE id=$4',
      [status, notes || null, expires_at || null, req.params.id]);
    if (!rowCount) return res.status(404).json({ ok: false, error: 'Not found' });
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, '[subscriber/admin/update]');
    res.status(500).json({ ok: false, error: 'Błąd serwera.' });
  }
});

router.post('/admin/:id/regenerate', requireAuth, async (req, res) => {
  const code = genCode();
  try {
    const { rows: subRows } = await pool.query(
      'SELECT email, name, plan FROM subscribers WHERE id=$1', [req.params.id]
    );
    if (!subRows[0]) return res.status(404).json({ ok: false, error: 'Not found' });
    await pool.query(
      'UPDATE subscribers SET code_hash=$1 WHERE id=$2', [hashCode(code), req.params.id]
    );
    res.json({ ok: true, code });
    sendSubscriberWelcome(subRows[0].email, subRows[0].name, subRows[0].plan, code).catch(() => {});
  } catch (err) {
    logger.error({ err }, '[subscriber/admin/regenerate]');
    res.status(500).json({ ok: false, error: 'Błąd serwera.' });
  }
});

router.delete('/admin/:id', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM subscribers WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, '[subscriber/admin/delete]');
    res.status(500).json({ ok: false, error: 'Błąd serwera.' });
  }
});

// ── Admin: journal posts CRUD ─────────────────────────────────────────────────
const postSchema = z.object({
  title:       z.string().min(1).max(200),
  content:     z.string().min(1),
  plan_access: z.enum(['pro', 'vip', 'mentoring']).optional(),
  published:   z.boolean().optional(),
});

router.get('/admin/journal-posts', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, title, content, plan_access, published, created_at FROM journal_posts ORDER BY created_at DESC'
    );
    res.json({ ok: true, posts: rows });
  } catch (err) {
    logger.error({ err }, '[subscriber/admin/journal-posts GET]');
    res.status(500).json({ ok: false, error: 'Błąd serwera.' });
  }
});

router.post('/admin/journal-posts', requireAuth, validate(postSchema), async (req, res) => {
  const { title, content, plan_access = 'pro', published = true } = req.body;
  try {
    const { rows } = await pool.query(
      'INSERT INTO journal_posts (title, content, plan_access, published) VALUES ($1,$2,$3,$4) RETURNING id',
      [title, content, plan_access, published]
    );
    res.json({ ok: true, id: rows[0].id });
  } catch (err) {
    logger.error({ err }, '[subscriber/admin/journal-posts POST]');
    res.status(500).json({ ok: false, error: 'Błąd serwera.' });
  }
});

router.delete('/admin/journal-posts/:id', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM journal_posts WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, '[subscriber/admin/journal-posts DELETE]');
    res.status(500).json({ ok: false, error: 'Błąd serwera.' });
  }
});

// ── Subscriber: conversations ─────────────────────────────────────────────────
const convSchema = z.object({
  subject: z.string().min(1).max(200),
  content: z.string().min(1).max(5000),
});
const msgSchema = z.object({
  content:        z.string().min(1).max(5000),
  attachment_ids: z.array(z.number().int()).optional(),
});

router.get('/conversations', requireSubscriberAuth, async (req, res) => {
  try {
    const page   = Math.max(1, parseInt(req.query.page) || 1);
    const limit  = 50;
    const offset = (page - 1) * limit;
    const { rows } = await pool.query(`
      WITH last_msg AS (
        SELECT DISTINCT ON (conversation_id)
          conversation_id, content, sender
        FROM messages
        ORDER BY conversation_id, created_at DESC
      ),
      msg_counts AS (
        SELECT conversation_id, COUNT(*)::int AS message_count
        FROM messages
        GROUP BY conversation_id
      )
      SELECT
        c.id, c.subject, c.status, c.unread_sub, c.created_at, c.updated_at,
        lm.content AS last_message, lm.sender AS last_sender,
        COALESCE(mc.message_count, 0) AS message_count
      FROM conversations c
      LEFT JOIN last_msg   lm ON lm.conversation_id = c.id
      LEFT JOIN msg_counts mc ON mc.conversation_id = c.id
      WHERE c.subscriber_id=$1
      ORDER BY c.updated_at DESC
      LIMIT $2 OFFSET $3
    `, [req.subscriber.sub_id, limit, offset]);
    res.json({ ok: true, conversations: rows, page, limit });
  } catch (err) {
    logger.error({ err }, '[subscriber/conversations GET]');
    res.status(500).json({ ok: false, error: 'Błąd serwera.' });
  }
});

router.post('/conversations', requireSubscriberAuth, validate(convSchema), async (req, res) => {
  const { subject, content } = req.body;
  const sub = req.subscriber;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const subRes = await client.query('SELECT email, name FROM subscribers WHERE id=$1', [sub.sub_id]);
    const subRow = subRes.rows[0];
    const { rows } = await client.query(`
      INSERT INTO conversations (from_email, from_name, subject, source, subscriber_id)
      VALUES ($1, $2, $3, 'subscriber', $4) RETURNING id
    `, [subRow.email, subRow.name || sub.name || null, subject.trim(), sub.sub_id]);
    const convId = rows[0].id;
    await client.query(
      `INSERT INTO messages (conversation_id, sender, content) VALUES ($1, 'user', $2)`,
      [convId, content.trim()]
    );
    await client.query('COMMIT');
    const planLabels = { pro: 'Pro', vip: 'VIP', mentoring: 'Mentoring' };
    sendTelegram(
      `📬 <b>Nowa wiadomość</b> (${planLabels[sub.plan]||sub.plan})\n👤 ${subRow.name||subRow.email}\n📌 ${subject}\n\n${content.slice(0,300)}${content.length>300?'…':''}`
    );
    res.json({ ok: true, id: convId });
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error({ err }, '[subscriber/conversations POST]');
    res.status(500).json({ ok: false, error: 'Błąd serwera.' });
  } finally {
    client.release();
  }
});

router.get('/conversations/:id', requireSubscriberAuth, async (req, res) => {
  try {
    const { rows: convRows } = await pool.query(
      `SELECT id, subject, status, unread_sub FROM conversations WHERE id=$1 AND subscriber_id=$2`,
      [req.params.id, req.subscriber.sub_id]
    );
    if (!convRows[0]) return res.status(404).json({ ok: false, error: 'Not found' });
    const { rows: msgs } = await pool.query(
      `SELECT id, sender, content, created_at FROM messages WHERE conversation_id=$1 ORDER BY created_at ASC`,
      [req.params.id]
    );
    const msgIds = msgs.map(m => m.id);
    let attMap = {};
    if (msgIds.length) {
      const attRes = await pool.query(
        `SELECT id, ref_id, filename, mime_type, data FROM attachments WHERE ref_type='message' AND ref_id=ANY($1)`,
        [msgIds]
      );
      attRes.rows.forEach(a => { (attMap[a.ref_id] = attMap[a.ref_id] || []).push(a); });
    }
    await pool.query(`UPDATE conversations SET unread_sub=FALSE WHERE id=$1`, [req.params.id]);
    res.json({ ok: true, conversation: convRows[0], messages: msgs.map(m => ({ ...m, attachments: attMap[m.id] || [] })) });
  } catch (err) {
    logger.error({ err }, '[subscriber/conversations/:id GET]');
    res.status(500).json({ ok: false, error: 'Błąd serwera.' });
  }
});

router.post('/conversations/:id/messages', requireSubscriberAuth, validate(msgSchema), async (req, res) => {
  const { content, attachment_ids = [] } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT id FROM conversations WHERE id=$1 AND subscriber_id=$2`,
      [req.params.id, req.subscriber.sub_id]
    );
    if (!rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ ok: false, error: 'Not found' }); }
    const { rows: msgRows } = await client.query(
      `INSERT INTO messages (conversation_id, sender, content) VALUES ($1, 'user', $2) RETURNING id`,
      [req.params.id, content.trim()]
    );
    const msgId = msgRows[0].id;
    if (attachment_ids.length) {
      await client.query(
        `UPDATE attachments SET ref_type='message', ref_id=$1 WHERE id=ANY($2) AND ref_type='pending'`,
        [msgId, attachment_ids]
      );
    }
    await client.query(
      `UPDATE conversations SET unread_admin=TRUE, unread_sub=FALSE, updated_at=NOW() WHERE id=$1`,
      [req.params.id]
    );
    await client.query('COMMIT');
    const subName = req.subscriber.name || req.subscriber.plan;
    sendTelegram(`💬 <b>Odpowiedź od subskrybenta</b>\n👤 ${subName}\n\n${content.slice(0,300)}${content.length>300?'…':''}`);
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error({ err }, '[subscriber/conversations/:id/messages POST]');
    res.status(500).json({ ok: false, error: 'Błąd serwera.' });
  } finally {
    client.release();
  }
});

module.exports = router;
