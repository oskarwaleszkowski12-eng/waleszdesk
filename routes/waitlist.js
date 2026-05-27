const express = require('express');
const router  = express.Router();
const { pool } = require('../lib/db');
const { validate, z } = require('../lib/validate');
const logger  = require('../lib/logger');

const waitlistSchema = z.object({
  email:   z.string().email(),
  plan:    z.enum(['pro', 'vip', 'mentoring']).default('pro'),
  name:    z.string().max(100).optional(),
  message: z.string().max(500).optional(),
});

router.post('/', validate(waitlistSchema), async (req, res) => {
  const { email, plan, name, message } = req.body;
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;
  try {
    await pool.query(
      `INSERT INTO waitlist (email, plan, name, message, ip)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (email) DO UPDATE
         SET plan = EXCLUDED.plan, name = EXCLUDED.name, message = EXCLUDED.message`,
      [email.toLowerCase().trim(), plan, name || null, message || null, ip]
    );
    logger.info({ email, plan }, '[waitlist] new signup');
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, '[waitlist] insert failed');
    res.status(500).json({ ok: false, error: 'Coś poszło nie tak.' });
  }
});

router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, email, plan, name, created_at FROM waitlist ORDER BY created_at DESC`
    );
    res.json({ ok: true, count: rows.length, data: rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'DB error' });
  }
});

module.exports = router;
