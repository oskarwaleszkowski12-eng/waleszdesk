const { Router } = require('express');
const { pool }   = require('../lib/db');
const logger     = require('../lib/logger');
const { validate, z } = require('../lib/validate');

const journalPatchSchema = z.object({
  notes:         z.string().max(5000).optional(),
  checklist:     z.record(z.boolean()).optional(),
  program_notes: z.string().max(5000).optional(),
});

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

router.patch('/:id', validate(journalPatchSchema), async (req, res) => {
  try {
    const { notes, checklist, program_notes } = req.body;
    const { rows } = await pool.query(
      `UPDATE trades SET
        notes=COALESCE($1,notes),
        checklist=COALESCE($2,checklist),
        program_notes=COALESCE($3,program_notes)
       WHERE id=$4 RETURNING *`,
      [notes ?? null, checklist ? JSON.stringify(checklist) : null, program_notes ?? null, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ ok: false, error: 'Trade not found' });
    res.json({ ok: true, trade: rows[0] });
  } catch (err) {
    logger.error({ err }, '[journal PATCH]');
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.patch('/:id/publish', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE trades SET published = NOT published WHERE id=$1 RETURNING id, published`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ ok: false, error: 'Trade not found' });
    res.json({ ok: true, published: rows[0].published });
  } catch (err) {
    logger.error({ err }, '[journal PATCH publish]');
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
