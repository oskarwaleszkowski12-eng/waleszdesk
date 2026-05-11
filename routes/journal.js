const { Router } = require('express');
const { pool }   = require('../lib/db');
const logger     = require('../lib/logger');

const router = Router();

router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM trades ORDER BY close_time DESC NULLS LAST');
    res.json({ ok: true, trades: rows });
  } catch (err) {
    logger.error({ err }, '[journal GET]');
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.patch('/:id', async (req, res) => {
  try {
    const { notes, checklist } = req.body;
    const { rows } = await pool.query(
      `UPDATE trades SET notes=COALESCE($1,notes), checklist=COALESCE($2,checklist) WHERE id=$3 RETURNING *`,
      [notes ?? null, checklist ? JSON.stringify(checklist) : null, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ ok: false, error: 'Trade not found' });
    res.json({ ok: true, trade: rows[0] });
  } catch (err) {
    logger.error({ err }, '[journal PATCH]');
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
