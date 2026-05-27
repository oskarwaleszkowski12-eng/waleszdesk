const { Router } = require('express');
const logger     = require('../lib/logger');
const { validate, z } = require('../lib/validate');
const tv         = require('../lib/tradovate');

const router = Router();

// ── AUTH STATUS ───────────────────────────────────────────
router.get('/status', (req, res) => {
  res.json({
    ok:          true,
    configured:  tv.hasCredentials(),
    connected:   tv.isConnected(),
    platform:    'tradovate',
  });
});

// ── SAVED CREDENTIALS INFO (username only, never password) ──
router.get('/credentials', async (req, res) => {
  try {
    const { pool }    = require('../lib/db');
    const { decrypt } = require('../lib/crypto');
    const r = await pool.query(`SELECT value FROM funded_settings WHERE key='tv_username'`);
    const username = r.rows.length ? decrypt(r.rows[0].value) : null;
    const isDemo   = await pool.query(`SELECT value FROM funded_settings WHERE key='tv_is_demo'`);
    res.json({ ok: true, username, isDemo: isDemo.rows[0]?.value !== 'false' });
  } catch {
    res.json({ ok: true, username: null, isDemo: true });
  }
});

// ── STEP 1: Init auth — credentials optional if already saved in DB ──
const initSchema = z.object({
  username: z.string().min(1).optional(),
  password: z.string().min(1).optional(),
  isDemo:   z.boolean().default(false),
});
router.post('/auth/init', validate(initSchema), async (req, res) => {
  try {
    const { username, password, isDemo } = req.body;
    if (username && password) {
      tv.setCredentials(username, password, isDemo);
      try { await tv.saveCredentialsToDb(username, password, isDemo); }
      catch (dbErr) { logger.warn('[funded] credentials not saved to DB: ' + dbErr.message); }
    }
    const result = await tv.initiateAuth();
    res.json({ ok: true, ...result });
  } catch (err) {
    const msg = err.message || String(err);
    logger.error('[funded] auth init error: ' + msg);
    res.status(400).json({ ok: false, error: msg });
  }
});

// ── STEP 2: Complete auth with 2FA code ──
const verifySchema = z.object({
  pTicket: z.string().min(1),
  code:    z.string().min(4).max(8),
});
router.post('/auth/verify', validate(verifySchema), async (req, res) => {
  try {
    await tv.completeAuth(req.body.pTicket, req.body.code);
    const account = await tv.getAccountSummary();
    res.json({ ok: true, account });
  } catch (err) {
    logger.error('[funded] auth verify error: ' + err.message);
    res.status(400).json({ ok: false, error: err.message });
  }
});

// ── ACCOUNT ───────────────────────────────────────────────
router.get('/account', async (req, res) => {
  try {
    const data = await tv.getAccountSummary();
    res.json({ ok: true, data });
  } catch (err) {
    logger.error('[funded] account error: ' + err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── POSITIONS ─────────────────────────────────────────────
router.get('/positions', async (req, res) => {
  try {
    const data = await tv.getPositions();
    res.json({ ok: true, data });
  } catch (err) {
    logger.error('[funded] positions error: ' + err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── HISTORY ───────────────────────────────────────────────
router.get('/history', async (req, res) => {
  try {
    const data = await tv.getOrderHistory(50);
    res.json({ ok: true, data });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── CONTRACT SEARCH ───────────────────────────────────────
router.get('/contracts', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q) return res.json({ ok: true, data: [] });
    const data = await tv.searchContracts(q);
    res.json({ ok: true, data });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── PLACE ORDER ───────────────────────────────────────────
const orderSchema = z.object({
  symbol:    z.string().min(1).max(20),
  action:    z.enum(['Buy', 'Sell']),
  qty:       z.number().int().min(1).max(100),
  orderType: z.enum(['Market', 'Limit', 'Stop', 'StopLimit']).default('Market'),
  price:     z.number().positive().optional(),
  stopPrice: z.number().positive().optional(),
}).superRefine((order, ctx) => {
  if ((order.orderType === 'Limit' || order.orderType === 'StopLimit') && order.price == null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['price'], message: 'price is required for Limit/StopLimit orders' });
  }
  if ((order.orderType === 'Stop' || order.orderType === 'StopLimit') && order.stopPrice == null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['stopPrice'], message: 'stopPrice is required for Stop/StopLimit orders' });
  }
});
router.post('/order', validate(orderSchema), async (req, res) => {
  try {
    const data = await tv.placeOrder(req.body);
    res.json({ ok: true, data });
  } catch (err) {
    logger.error('[funded] order error: ' + err.message);
    res.status(400).json({ ok: false, error: err.message });
  }
});

// ── CLOSE POSITION ────────────────────────────────────────
router.post('/close/:positionId', async (req, res) => {
  try {
    const positionId = parseInt(req.params.positionId, 10);
    if (isNaN(positionId)) return res.status(400).json({ ok: false, error: 'Invalid positionId' });
    const data = await tv.closePosition(positionId);
    res.json({ ok: true, data });
  } catch (err) {
    logger.error('[funded] close error: ' + err.message);
    res.status(400).json({ ok: false, error: err.message });
  }
});

module.exports = router;
