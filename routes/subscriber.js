const { Router } = require('express');
const crypto     = require('crypto');
const jwt        = require('jsonwebtoken');
const { pool }   = require('../lib/db');
const { JWT_SECRET, requireAuth, requireSubscriberAuth } = require('../lib/auth');
const { validate, z } = require('../lib/validate');
const logger     = require('../lib/logger');

const router = Router();

function hashCode(code) {
  return crypto.createHash('sha256').update(code.toLowerCase().trim()).digest('hex');
}
function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const seg = () => Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
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
      JWT_SECRET, { expiresIn: '30d' }
    );
    res.json({ ok: true, token, plan: sub.plan, name: sub.name });
  } catch (err) {
    logger.error({ err }, '[subscriber/login]');
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
  } catch (err) {
    logger.error({ err }, '[subscriber/admin/create]');
    res.status(500).json({ ok: false, error: 'Błąd serwera.' });
  }
});

router.put('/admin/:id', requireAuth, async (req, res) => {
  const { status, notes, expires_at } = req.body;
  try {
    await pool.query('UPDATE subscribers SET status=$1,notes=$2,expires_at=$3 WHERE id=$4',
      [status, notes || null, expires_at || null, req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, '[subscriber/admin/update]');
    res.status(500).json({ ok: false, error: 'Błąd serwera.' });
  }
});

router.post('/admin/:id/regenerate', requireAuth, async (req, res) => {
  const code = genCode();
  try {
    const { rowCount } = await pool.query(
      'UPDATE subscribers SET code_hash=$1 WHERE id=$2', [hashCode(code), req.params.id]
    );
    if (!rowCount) return res.status(404).json({ ok: false, error: 'Not found' });
    res.json({ ok: true, code });
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

module.exports = router;
