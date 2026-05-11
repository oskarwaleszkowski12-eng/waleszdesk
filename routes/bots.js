const { Router }             = require('express');
const { pool }               = require('../lib/db');
const { encrypt, decrypt }   = require('../lib/crypto');
const { getCachedBalance }   = require('../lib/cache');
const { createExchangeClient } = require('../exchanges');
const { API_KEY, API_SECRET }  = require('../lib/config');
const logger                 = require('../lib/logger');

const router = Router();

function botPublic(row) {
  const { api_key_enc, api_secret_enc, api_passphrase_enc, ...pub } = row;
  pub.exchange       = row.exchange || 'bybit';
  pub.api_key_masked = api_key_enc ? (() => { try { return decrypt(api_key_enc).slice(0, 4) + '***'; } catch { return '****'; } })() : null;
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

router.get('/test-connection', async (req, res) => {
  const { key, secret, exchange, passphrase } = req.query;
  if (!key || !secret) return res.status(400).json({ ok: false, error: 'key and secret required' });
  try {
    const client = createExchangeClient(exchange || 'bybit', key, secret, passphrase);
    const { total } = await client.getBalance();
    res.json({ ok: true, balance: parseFloat(total.toFixed(2)) });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const { name, type, symbol, config, apiKey, apiSecret, apiPassphrase, exchange, subaccountName, allocatedBalance } = req.body;
    if (!name || !type || !symbol || !config)
      return res.status(400).json({ ok: false, error: 'Missing: name, type, symbol, config' });
    if (!['dca', 'grid'].includes(type))
      return res.status(400).json({ ok: false, error: 'type must be dca or grid' });
    if (!apiKey || !apiSecret)
      return res.status(400).json({ ok: false, error: 'API key and secret are required' });
    const ex = (exchange || 'bybit').toLowerCase();
    const { rows } = await pool.query(
      `INSERT INTO bots (name,type,symbol,status,config,stats,api_key_enc,api_secret_enc,api_passphrase_enc,exchange,subaccount_name,allocated_balance)
       VALUES ($1,$2,$3,'active',$4,'{}', $5,$6,$7,$8,$9,$10) RETURNING *`,
      [name.trim(), type, symbol.toUpperCase(), JSON.stringify({ ...config, state: {} }),
       encrypt(apiKey), encrypt(apiSecret), apiPassphrase ? encrypt(apiPassphrase) : null,
       ex, subaccountName || null, allocatedBalance || null]
    );
    logger.info({ botId: rows[0].id, name: name.trim(), symbol }, '[bots] created');
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
        (SELECT COUNT(*) FROM bot_trades WHERE bot_id=b.id)::int                   AS trade_count,
        (SELECT COUNT(*) FROM bot_trades WHERE bot_id=b.id AND status='open')::int AS open_orders
      FROM bots b ORDER BY b.created_at DESC
    `);
    const bots = await Promise.all(rows.map(async row => {
      const pub = botPublic(row);
      if (row.status !== 'stopped') {
        pub.live_balance = await getCachedBalance(row.id, async () => {
          const { exchange, apiKey, apiSecret, passphrase } = botClientDetails(row);
          const client = createExchangeClient(exchange, apiKey, apiSecret, passphrase);
          const { total } = await client.getBalance();
          return parseFloat(total.toFixed(2));
        });
      } else {
        pub.live_balance = null;
      }
      return pub;
    }));
    res.json({ ok: true, bots });
  } catch (err) {
    logger.error({ err }, '[bots GET]');
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.patch('/pause-all', async (req, res) => {
  try {
    const { rowCount } = await pool.query(`UPDATE bots SET status='paused',updated_at=NOW() WHERE status='active'`);
    res.json({ ok: true, paused: rowCount });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.patch('/stop-all', async (req, res) => {
  try {
    const { rows } = await pool.query(`UPDATE bots SET status='stopped',updated_at=NOW() WHERE status IN ('active','paused') RETURNING *`);
    await Promise.allSettled(rows.map(async bot => {
      try {
        const { exchange, apiKey, apiSecret, passphrase } = botClientDetails(bot);
        await createExchangeClient(exchange, apiKey, apiSecret, passphrase).cancelAllOrders(bot.symbol);
      } catch {}
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

router.delete('/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM bots WHERE id=$1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ ok: false, error: 'Bot not found' });
    const bot = rows[0];
    if (bot.status === 'stopped') {
      await pool.query(`DELETE FROM bots WHERE id=$1`, [req.params.id]);
    } else {
      try {
        const { exchange, apiKey, apiSecret, passphrase } = botClientDetails(bot);
        await createExchangeClient(exchange, apiKey, apiSecret, passphrase).cancelAllOrders(bot.symbol);
      } catch (e) {
        logger.warn({ err: e, symbol: bot.symbol }, '[bots] cancel-all failed');
      }
      await pool.query(`UPDATE bots SET status='stopped',updated_at=NOW() WHERE id=$1`, [req.params.id]);
    }
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

module.exports = router;
