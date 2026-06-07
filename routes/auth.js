'use strict';
const { Router } = require('express');
const crypto     = require('crypto');
const jwt        = require('jsonwebtoken');
const config     = require('../lib/config');
const logger     = require('../lib/logger');
const { validate, z } = require('../lib/validate');
const { requireAuth } = require('../lib/auth');
const totp = require('../lib/totp');

const router = Router();

const COOKIE_OPTS = {
  httpOnly: true,
  secure:   process.env.NODE_ENV === 'production',
  sameSite: 'strict',
};

const loginSchema = z.object({
  password:  z.string().min(1),
  totp_code: z.string().min(4).max(10).optional(),
});

router.post('/login', validate(loginSchema), async (req, res) => {
  const { password, totp_code } = req.body;
  try {
    const h1 = crypto.createHmac('sha256', 'wd').update(password || '').digest();
    const h2 = crypto.createHmac('sha256', 'wd').update(config.ADMIN_PASS || '').digest();
    if (!config.ADMIN_PASS || !crypto.timingSafeEqual(h1, h2))
      return res.status(401).json({ ok: false, errorCode: 'INVALID_PASSWORD', error: 'Invalid password' });

    const totpEnabled = await totp.isAdminTotpEnabled();
    if (totpEnabled) {
      if (!totp_code)
        return res.status(401).json({ ok: false, errorCode: 'TOTP_REQUIRED', error: 'TOTP code required' });
      const secret = await totp.getAdminTotpSecret();
      if (!totp.verifyCode(secret, totp_code))
        return res.status(401).json({ ok: false, errorCode: 'INVALID_TOTP', error: 'Invalid TOTP code' });
    }

    const token = jwt.sign({ role: 'admin' }, config.JWT_SECRET, { expiresIn: '24h' });
    res.cookie('wd_admin', token, { ...COOKIE_OPTS, maxAge: 24 * 60 * 60 * 1000 });
    logger.info({ totpUsed: totpEnabled }, '[auth] login success');
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, '[auth/login]');
    res.status(500).json({ ok: false, errorCode: 'INTERNAL', error: 'Server error' });
  }
});

router.post('/logout', (req, res) => {
  res.clearCookie('wd_admin', COOKIE_OPTS);
  res.json({ ok: true });
});

router.get('/me', async (req, res) => {
  const token = req.cookies?.wd_admin;
  if (!token) return res.status(401).json({ ok: false });
  try {
    const payload = jwt.verify(token, config.JWT_SECRET);
    if (payload.role !== 'admin') return res.status(403).json({ ok: false });
    const totpEnabled = await totp.isAdminTotpEnabled();
    res.json({ ok: true, role: 'admin', totpEnabled });
  } catch {
    res.status(401).json({ ok: false });
  }
});

// ── TOTP management (all require admin auth) ─────────────────────────────────
router.get('/totp/status', requireAuth, async (req, res) => {
  try {
    const enabled = await totp.isAdminTotpEnabled();
    res.json({ ok: true, enabled });
  } catch (err) {
    logger.error({ err }, '[auth/totp/status]');
    res.status(500).json({ ok: false, errorCode: 'INTERNAL', error: 'Server error' });
  }
});

router.post('/totp/setup', requireAuth, async (req, res) => {
  try {
    const { secret, otpauthUrl } = totp.generateSetup('WaleszDesk Admin');
    const qrDataUrl = await totp.buildQrDataUrl(otpauthUrl);
    res.json({ ok: true, secret, qrDataUrl });
  } catch (err) {
    logger.error({ err }, '[auth/totp/setup]');
    res.status(500).json({ ok: false, errorCode: 'INTERNAL', error: 'Server error' });
  }
});

const enableSchema = z.object({
  secret: z.string().min(16),
  code:   z.string().min(4).max(10),
});

router.post('/totp/enable', requireAuth, validate(enableSchema), async (req, res) => {
  const { secret, code } = req.body;
  try {
    if (!totp.verifyCode(secret, code))
      return res.status(400).json({ ok: false, errorCode: 'INVALID_TOTP', error: 'Code does not match secret' });
    await totp.saveAdminTotp(secret);
    logger.info('[auth] TOTP enabled');
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, '[auth/totp/enable]');
    res.status(500).json({ ok: false, errorCode: 'INTERNAL', error: 'Server error' });
  }
});

const disableSchema = z.object({ code: z.string().min(4).max(10) });

router.post('/totp/disable', requireAuth, validate(disableSchema), async (req, res) => {
  const { code } = req.body;
  try {
    const secret = await totp.getAdminTotpSecret();
    if (!secret) return res.json({ ok: true });
    if (!totp.verifyCode(secret, code))
      return res.status(401).json({ ok: false, errorCode: 'INVALID_TOTP', error: 'Invalid code' });
    await totp.clearAdminTotp();
    logger.info('[auth] TOTP disabled');
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, '[auth/totp/disable]');
    res.status(500).json({ ok: false, errorCode: 'INTERNAL', error: 'Server error' });
  }
});

// ── Admin audit log viewer ───────────────────────────────────────────────────
const { pool } = require('../lib/db');
router.get('/audit-log', requireAuth, async (req, res) => {
  try {
    const page   = Math.max(1, parseInt(req.query.page) || 1);
    const limit  = Math.min(200, Math.max(10, parseInt(req.query.limit) || 50));
    const offset = (page - 1) * limit;
    const { rows } = await pool.query(
      `SELECT id, who, action, target_type, target_id, ip, meta, created_at
       FROM admin_actions ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    res.json({ ok: true, page, limit, actions: rows });
  } catch (err) {
    logger.error({ err }, '[auth/audit-log]');
    res.status(500).json({ ok: false, errorCode: 'INTERNAL', error: 'Server error' });
  }
});

module.exports = router;
