const { Router }              = require('express');
const crypto                  = require('crypto');
const { pool }                = require('../lib/db');
const { encrypt }             = require('../lib/crypto');
const { createExchangeClient } = require('../exchanges');
const logger                  = require('../lib/logger');

const router = Router();

router.get('/available-bots', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id,name,description,type,symbol,risk_level,est_monthly_pct,min_capital FROM algo_templates WHERE active=true ORDER BY id`
    );
    res.json({ ok: true, templates: rows });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.post('/verify-keys', async (req, res) => {
  const { key, secret, exchange, passphrase } = req.body;
  if (!key || !secret) return res.status(400).json({ ok: false, error: 'key and secret required' });
  try {
    const client = createExchangeClient(exchange || 'bybit', key, secret, passphrase);
    const { total } = await client.getBalance();
    const uid = await client.getUID();
    res.json({ ok: true, balance: parseFloat(total.toFixed(2)), uid });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

router.post('/launch', async (req, res) => {
  try {
    const { apiKey, apiSecret, apiPassphrase, exchange, templateId, allocatedCapital, inviteCode } = req.body;
    if (!apiKey || !apiSecret || !templateId || !allocatedCapital)
      return res.status(400).json({ ok: false, error: 'Missing required fields' });
    if (!inviteCode) return res.status(400).json({ ok: false, error: 'Invite code required' });

    const { rows: codeRows } = await pool.query(`SELECT id FROM invite_codes WHERE code=$1 AND used=FALSE`, [inviteCode.trim().toUpperCase()]);
    if (!codeRows.length) return res.status(400).json({ ok: false, error: 'Invalid or already used invite code' });

    const ex = (exchange || 'bybit').toLowerCase();
    const { rows: tmplRows } = await pool.query(`SELECT * FROM algo_templates WHERE id=$1 AND active=true`, [templateId]);
    if (!tmplRows.length) return res.status(404).json({ ok: false, error: 'Template not found or inactive' });
    const tmpl = tmplRows[0];

    if (allocatedCapital < parseFloat(tmpl.min_capital || 50))
      return res.status(400).json({ ok: false, error: `Minimum capital is $${tmpl.min_capital}` });

    const client = createExchangeClient(ex, apiKey, apiSecret, apiPassphrase);
    const { total: balance } = await client.getBalance().catch(e => { throw new Error('Key verification failed: ' + e.message); });
    if (allocatedCapital > balance * 0.5)
      return res.status(400).json({ ok: false, error: `Max 50% of balance ($${(balance * 0.5).toFixed(2)})` });

    const uid = await client.getUID().catch(() => 'unknown');
    const { rows: existing } = await pool.query(`SELECT id FROM algo_users WHERE uid=$1 AND exchange=$2`, [uid, ex]);
    if (existing.length) return res.json({ ok: false, error: 'UID already registered. Contact support.' });

    const { rows: botRows } = await pool.query(
      `INSERT INTO bots (name,type,symbol,status,config,stats,api_key_enc,api_secret_enc,api_passphrase_enc,exchange,allocated_balance)
       VALUES ($1,$2,$3,'active',$4,'{}', $5,$6,$7,$8,$9) RETURNING *`,
      [`[Algo] ${tmpl.name}`, tmpl.type, tmpl.symbol,
       JSON.stringify({ ...tmpl.config, symbol: tmpl.symbol, state: {} }),
       encrypt(apiKey), encrypt(apiSecret), apiPassphrase ? encrypt(apiPassphrase) : null, ex, allocatedCapital]
    );
    await pool.query(
      `INSERT INTO algo_users (api_key_enc,api_secret_enc,api_passphrase_enc,exchange,uid,balance_at_signup,bot_template_id,allocated_capital,bot_id,status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'active')`,
      [encrypt(apiKey), encrypt(apiSecret), apiPassphrase ? encrypt(apiPassphrase) : null,
       ex, uid, balance, templateId, allocatedCapital, botRows[0].id]
    );
    await pool.query(`UPDATE invite_codes SET used=TRUE WHERE code=$1`, [inviteCode.trim().toUpperCase()]);
    logger.info({ uid, botId: botRows[0].id, templateId }, '[algo] launched');
    res.json({ ok: true, botId: botRows[0].id, uid });
  } catch (err) {
    logger.error({ err }, '[algo/launch]');
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/status', async (req, res) => {
  try {
    const { uid } = req.query;
    if (!uid) return res.status(400).json({ ok: false, error: 'uid required' });
    const { rows } = await pool.query(`
      SELECT au.*, at.name AS template_name, at.symbol, at.risk_level,
        b.status AS bot_status, b.stats,
        (SELECT COUNT(*) FROM bot_trades WHERE bot_id=au.bot_id)::int AS trade_count
      FROM algo_users au
      LEFT JOIN algo_templates at ON at.id=au.bot_template_id
      LEFT JOIN bots b ON b.id=au.bot_id
      WHERE au.uid=$1
    `, [uid]);
    if (!rows.length) return res.json({ ok: false, error: 'User not found' });
    const u = rows[0];
    res.json({ ok: true, user: { template_name: u.template_name, symbol: u.symbol, risk_level: u.risk_level, allocated_capital: u.allocated_capital, status: u.bot_status || u.status, trade_count: u.trade_count, pnl: parseFloat(((u.stats || {}).total_pnl || 0)) } });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.post('/verify-invite', async (req, res) => {
  try {
    const { code } = req.body || {};
    if (!code) return res.status(400).json({ ok: false, error: 'Missing code' });
    const { rows } = await pool.query(`SELECT * FROM invite_codes WHERE code=$1 AND used=FALSE`, [code.trim().toUpperCase()]);
    if (!rows.length) return res.status(400).json({ ok: false, error: 'Invalid or already used code' });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ── Admin routes ──────────────────────────────────────
router.get('/admin/templates', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM algo_templates ORDER BY id`);
    res.json({ ok: true, templates: rows });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.post('/admin/templates', async (req, res) => {
  try {
    const { name, description, type, symbol, config, risk_level, est_monthly_pct, min_capital } = req.body;
    if (!name || !type || !symbol) return res.status(400).json({ ok: false, error: 'name, type, symbol required' });
    const { rows } = await pool.query(
      `INSERT INTO algo_templates (name,description,type,symbol,config,risk_level,est_monthly_pct,min_capital) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [name.trim(), description||'', type, symbol.toUpperCase(), JSON.stringify(config||{}), risk_level||'Medium', est_monthly_pct||null, min_capital||50]
    );
    res.json({ ok: true, template: rows[0] });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.patch('/admin/templates/:id', async (req, res) => {
  try {
    const { name, description, type, symbol, config, risk_level, est_monthly_pct, min_capital } = req.body;
    const updates = []; const vals = []; let idx = 1;
    if (name)                          { updates.push(`name=$${idx++}`);            vals.push(name.trim()); }
    if (description !== undefined)     { updates.push(`description=$${idx++}`);     vals.push(description||''); }
    if (type)                          { updates.push(`type=$${idx++}`);            vals.push(type); }
    if (symbol)                        { updates.push(`symbol=$${idx++}`);          vals.push(symbol.toUpperCase()); }
    if (config)                        { updates.push(`config=$${idx++}`);          vals.push(JSON.stringify(config)); }
    if (risk_level)                    { updates.push(`risk_level=$${idx++}`);      vals.push(risk_level); }
    if (est_monthly_pct !== undefined) { updates.push(`est_monthly_pct=$${idx++}`); vals.push(est_monthly_pct||null); }
    if (min_capital !== undefined)     { updates.push(`min_capital=$${idx++}`);     vals.push(min_capital||50); }
    if (!updates.length) return res.status(400).json({ ok: false, error: 'Nothing to update' });
    vals.push(req.params.id);
    const { rows } = await pool.query(`UPDATE algo_templates SET ${updates.join(',')} WHERE id=$${idx} RETURNING *`, vals);
    res.json({ ok: true, template: rows[0] });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.patch('/admin/templates/:id/toggle', async (req, res) => {
  try {
    const { rows } = await pool.query(`UPDATE algo_templates SET active=NOT active WHERE id=$1 RETURNING *`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ ok: false, error: 'Not found' });
    res.json({ ok: true, template: rows[0] });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.get('/admin/users', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT au.id,au.uid,au.balance_at_signup,au.allocated_capital,au.status,au.created_at,
        at.name AS template_name, at.symbol, at.type AS template_type,
        b.status AS bot_status, b.stats,
        (SELECT COUNT(*) FROM bot_trades WHERE bot_id=au.bot_id)::int AS trade_count
      FROM algo_users au
      LEFT JOIN algo_templates at ON at.id=au.bot_template_id
      LEFT JOIN bots b ON b.id=au.bot_id
      ORDER BY au.created_at DESC
    `);
    res.json({ ok: true, users: rows.map(r => ({ ...r, pnl: parseFloat(((r.stats||{}).total_pnl||0)).toFixed(2) })) });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.get('/admin/invite-codes', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM invite_codes ORDER BY created_at DESC`);
    res.json({ ok: true, codes: rows });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.post('/admin/invite-codes', async (req, res) => {
  try {
    const { label } = req.body || {};
    const code = crypto.randomBytes(4).toString('hex').toUpperCase();
    const { rows } = await pool.query(`INSERT INTO invite_codes (code,label) VALUES ($1,$2) RETURNING *`, [code, label||'']);
    res.json({ ok: true, code: rows[0] });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.patch('/admin/invite-codes/:id/deactivate', async (req, res) => {
  try {
    await pool.query(`UPDATE invite_codes SET used=TRUE WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

module.exports = router;
