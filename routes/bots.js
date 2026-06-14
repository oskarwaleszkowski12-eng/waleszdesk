const { Router }             = require('express');
const { pool }               = require('../lib/db');
const { encrypt, decrypt }   = require('../lib/crypto');
const { getCachedBalance }   = require('../lib/cache');
const { createExchangeClient } = require('../exchanges');
const { API_KEY, API_SECRET }  = require('../lib/config');
const { requireAuth }        = require('../lib/auth');
const logger                 = require('../lib/logger');
const { validate, z }        = require('../lib/validate');
const { logAdminAction }     = require('../lib/audit');

const createBotSchema = z.object({
  name:             z.string().min(1).max(100),
  type:             z.enum(['dca', 'grid']),
  symbol:           z.string().min(1).max(20),
  config:           z.record(z.unknown()),
  apiKey:           z.string().min(1),
  apiSecret:        z.string().min(1),
  apiPassphrase:    z.string().optional(),
  exchange:         z.string().optional(),
  subaccountName:   z.string().max(100).optional(),
  allocatedBalance: z.number().positive().optional(),
});

const router = Router();

function botPublic(row) {
  const { api_key_enc, api_secret_enc, api_passphrase_enc, webhook_secret, ...pub } = row;
  pub.exchange         = row.exchange || 'bybit';
  pub.api_key_masked   = api_key_enc ? (() => { try { return decrypt(api_key_enc).slice(0, 4) + '***'; } catch { return '****'; } })() : null;
  pub.webhook_enabled  = !!webhook_secret;

  // Health badge: green = ticked in last 60s + no recent error
  //               yellow = ticked but stale (60s-5min) OR last error within 1h
  //               red = no tick in 5min+ OR active+no_tick OR recent error
  const now           = Date.now();
  const lastTickMs    = row.last_tick_at  ? new Date(row.last_tick_at).getTime()  : 0;
  const lastErrMs     = row.last_error_at ? new Date(row.last_error_at).getTime() : 0;
  const tickAgeSec    = lastTickMs ? Math.floor((now - lastTickMs) / 1000) : null;
  const errAgeSec     = lastErrMs  ? Math.floor((now - lastErrMs)  / 1000) : null;

  let health = 'unknown';
  if (row.status === 'active') {
    if (lastTickMs === 0)                                              health = 'unknown';
    else if (errAgeSec !== null && errAgeSec < 3600)                   health = 'red';
    else if (tickAgeSec <= 60)                                         health = 'green';
    else if (tickAgeSec <= 300)                                        health = 'yellow';
    else                                                               health = 'red';
  } else if (row.status === 'error')   health = 'red';
  else if (row.status === 'paused')    health = 'yellow';
  else if (row.status === 'stopped')   health = 'gray';

  pub.health        = health;
  pub.tick_age_sec  = tickAgeSec;
  pub.error_age_sec = errAgeSec;
  return pub;
}

function botClientDetails(row) {
  try {
    if (row.api_key_enc && row.api_secret_enc) {
      return {
        exchange:   row.exchange || 'bybit',
        apiKey:     decrypt(row.api_key_enc),
        apiSecret:  decrypt(row.api_secret_enc),
        passphrase: row.api_passphrase_enc ? decrypt(row.api_passphrase_enc) : undefined,
      };
    }
  } catch (e) {
    logger.error({ err: e, botId: row.id }, '[bots] key decrypt error');
  }
  return { exchange: 'bybit', apiKey: API_KEY, apiSecret: API_SECRET, passphrase: undefined };
}

router.post('/test-connection', requireAuth, async (req, res) => {
  const { key, secret, exchange, passphrase } = req.body;
  if (!key || !secret) return res.status(400).json({ ok: false, error: 'key and secret required' });
  try {
    const client = createExchangeClient(exchange || 'bybit', key, secret, passphrase);
    const { total } = await client.getBalance();
    res.json({ ok: true, balance: parseFloat(total.toFixed(2)) });
  } catch (e) {
    const safe = e?.response?.data?.retMsg || e?.response?.data?.msg || e?.response?.data?.message;
    res.json({ ok: false, error: safe ? String(safe).slice(0, 200) : 'Connection failed' });
  }
});

router.post('/', validate(createBotSchema), async (req, res) => {
  try {
    const { name, type, symbol, config, apiKey, apiSecret, apiPassphrase, exchange, subaccountName, allocatedBalance } = req.body;
    const ex = (exchange || 'bybit').toLowerCase();
    const { rows } = await pool.query(
      `INSERT INTO bots (name,type,symbol,status,config,stats,api_key_enc,api_secret_enc,api_passphrase_enc,exchange,subaccount_name,allocated_balance)
       VALUES ($1,$2,$3,'active',$4,'{}', $5,$6,$7,$8,$9,$10) RETURNING *`,
      [name.trim(), type, symbol.toUpperCase(), JSON.stringify({ ...config, state: {} }),
       encrypt(apiKey), encrypt(apiSecret), apiPassphrase ? encrypt(apiPassphrase) : null,
       ex, subaccountName || null, allocatedBalance || null]
    );
    logger.info({ botId: rows[0].id, name: name.trim(), symbol }, '[bots] created');
    logAdminAction(req, 'bots.create', 'bot', rows[0].id, { name: name.trim(), type, symbol, exchange: ex });
    res.json({ ok: true, bot: botPublic(rows[0]) });
  } catch (err) {
    logger.error({ err }, '[bots POST]');
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT b.*,
        COALESCE(bt.trade_count, 0) AS trade_count,
        COALESCE(bt.open_orders, 0) AS open_orders
      FROM bots b
      LEFT JOIN (
        SELECT bot_id,
          COUNT(*)::int                                   AS trade_count,
          COUNT(*) FILTER (WHERE status='open')::int      AS open_orders
        FROM bot_trades
        GROUP BY bot_id
      ) bt ON bt.bot_id = b.id
      ORDER BY b.created_at DESC
    `);
    const withTimeout = (p, ms) => Promise.race([p, new Promise(r => setTimeout(() => r(null), ms))]);
    const results = await Promise.allSettled(rows.map(async row => {
      const pub = botPublic(row);
      if (row.status === 'active') {
        pub.live_balance = await withTimeout(getCachedBalance(row.id, async () => {
          const { exchange, apiKey, apiSecret, passphrase } = botClientDetails(row);
          const client = createExchangeClient(exchange, apiKey, apiSecret, passphrase);
          const { total } = await client.getBalance();
          return parseFloat(total.toFixed(2));
        }), 4000);
      } else {
        pub.live_balance = null;
      }
      return pub;
    }));
    const bots = results.map((r, i) => {
      if (r.status === 'fulfilled') return r.value;
      logger.warn({ err: r.reason, botId: rows[i].id }, '[bots] enrich failed');
      return { ...botPublic(rows[i]), live_balance: null };
    });
    res.json({ ok: true, bots });
  } catch (err) {
    logger.error({ err }, '[bots GET]');
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.patch('/pause-all', async (req, res) => {
  try {
    const { rowCount } = await pool.query(`UPDATE bots SET status='paused',updated_at=NOW() WHERE status='active'`);
    logAdminAction(req, 'bots.pause_all', 'bots', null, { count: rowCount });
    res.json({ ok: true, paused: rowCount });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.patch('/stop-all', async (req, res) => {
  try {
    const { rows } = await pool.query(`UPDATE bots SET status='stopped',updated_at=NOW() WHERE status IN ('active','paused') RETURNING *`);
    logAdminAction(req, 'bots.stop_all', 'bots', null, { count: rows.length });
    await Promise.allSettled(rows.map(async bot => {
      try {
        const { exchange, apiKey, apiSecret, passphrase } = botClientDetails(bot);
        await createExchangeClient(exchange, apiKey, apiSecret, passphrase).cancelAllOrders(bot.symbol);
      } catch (e) {
        logger.warn({ botId: bot.id, symbol: bot.symbol, err: e?.message }, '[bots/stop-all] cancel failed');
      }
    }));
    res.json({ ok: true, stopped: rows.length });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.patch('/:id', async (req, res) => {
  try {
    const { name, symbol, config, apiKey, apiSecret, apiPassphrase, exchange, subaccountName, allocatedBalance } = req.body;
    const { rows: existing } = await pool.query(`SELECT * FROM bots WHERE id=$1`, [req.params.id]);
    if (!existing.length) return res.status(404).json({ ok: false, error: 'Bot not found' });
    const updates = []; const vals = []; let idx = 1;
    if (name)     { updates.push(`name=$${idx++}`);     vals.push(name.trim()); }
    if (symbol)   { updates.push(`symbol=$${idx++}`);   vals.push(symbol.toUpperCase()); }
    if (exchange) { updates.push(`exchange=$${idx++}`); vals.push(exchange.toLowerCase()); }
    if (config) {
      const existingState = (existing[0].config || {}).state || {};
      updates.push(`config=$${idx++}`);
      vals.push(JSON.stringify({ ...config, state: existingState }));
    }
    if (apiKey && apiSecret) {
      updates.push(`api_key_enc=$${idx++}`, `api_secret_enc=$${idx++}`);
      vals.push(encrypt(apiKey), encrypt(apiSecret));
      if (apiPassphrase !== undefined) { updates.push(`api_passphrase_enc=$${idx++}`); vals.push(apiPassphrase ? encrypt(apiPassphrase) : null); }
    }
    if (subaccountName !== undefined)   { updates.push(`subaccount_name=$${idx++}`);   vals.push(subaccountName || null); }
    if (allocatedBalance !== undefined) { updates.push(`allocated_balance=$${idx++}`); vals.push(allocatedBalance || null); }
    if (!updates.length) return res.status(400).json({ ok: false, error: 'Nothing to update' });
    updates.push(`updated_at=NOW()`);
    vals.push(req.params.id);
    const { rows } = await pool.query(`UPDATE bots SET ${updates.join(',')} WHERE id=$${idx} RETURNING *`, vals);
    res.json({ ok: true, bot: botPublic(rows[0]) });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.get('/:id/trades', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM bot_trades WHERE bot_id=$1 ORDER BY created_at DESC LIMIT 50`, [req.params.id]);
    res.json({ ok: true, trades: rows });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.patch('/:id/pause', async (req, res) => {
  try {
    const { rows } = await pool.query(`UPDATE bots SET status='paused',updated_at=NOW() WHERE id=$1 RETURNING *`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ ok: false, error: 'Bot not found' });
    res.json({ ok: true, bot: botPublic(rows[0]) });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.patch('/:id/resume', async (req, res) => {
  try {
    const { rows } = await pool.query(`UPDATE bots SET status='active',updated_at=NOW() WHERE id=$1 RETURNING *`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ ok: false, error: 'Bot not found' });
    res.json({ ok: true, bot: botPublic(rows[0]) });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// Generate (or rotate) a TradingView webhook secret for this bot.
// Secret is returned ONCE; subsequent GET /api/bots only exposes webhook_enabled boolean.
router.post('/:id/webhook', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: 'Bad id' });
  const secret = require('crypto').randomBytes(24).toString('hex');
  try {
    const { rowCount } = await pool.query(
      `UPDATE bots SET webhook_secret=$1, updated_at=NOW() WHERE id=$2`,
      [secret, id]
    );
    if (!rowCount) return res.status(404).json({ ok: false, error: 'Bot not found' });
    logAdminAction(req, 'bots.webhook.enable', 'bot', id, {});
    res.json({ ok: true, secret, path: `/api/webhook/tv/${id}` });
  } catch (err) {
    logger.error({ err }, '[bots] webhook enable failed');
    res.status(500).json({ ok: false, error: 'DB error' });
  }
});

// Webhook audit log for a bot (last N events, newest first).
router.get('/:id/webhook-events', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: 'Bad id' });
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  try {
    const { rows } = await pool.query(
      `SELECT id, ip, action, symbol, status, message, created_at
         FROM webhook_events
        WHERE bot_id=$1
        ORDER BY created_at DESC
        LIMIT $2`,
      [id, limit]
    );
    res.json({ ok: true, events: rows });
  } catch (err) {
    logger.error({ err }, '[bots] webhook-events query failed');
    res.status(500).json({ ok: false, error: 'DB error' });
  }
});

router.delete('/:id/webhook', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: 'Bad id' });
  try {
    const { rowCount } = await pool.query(
      `UPDATE bots SET webhook_secret=NULL, updated_at=NOW() WHERE id=$1`,
      [id]
    );
    if (!rowCount) return res.status(404).json({ ok: false, error: 'Bot not found' });
    logAdminAction(req, 'bots.webhook.disable', 'bot', id, {});
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, '[bots] webhook disable failed');
    res.status(500).json({ ok: false, error: 'DB error' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM bots WHERE id=$1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ ok: false, error: 'Bot not found' });
    const bot = rows[0];
    if (bot.status === 'stopped') {
      await pool.query(`DELETE FROM bots WHERE id=$1`, [req.params.id]);
      logAdminAction(req, 'bots.delete', 'bot', bot.id, { name: bot.name, symbol: bot.symbol });
    } else {
      try {
        const { exchange, apiKey, apiSecret, passphrase } = botClientDetails(bot);
        await createExchangeClient(exchange, apiKey, apiSecret, passphrase).cancelAllOrders(bot.symbol);
      } catch (e) {
        logger.warn({ err: e, symbol: bot.symbol }, '[bots] cancel-all failed');
      }
      await pool.query(`UPDATE bots SET status='stopped',updated_at=NOW() WHERE id=$1`, [req.params.id]);
      logAdminAction(req, 'bots.stop', 'bot', bot.id, { name: bot.name, symbol: bot.symbol });
    }
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

module.exports = router;
