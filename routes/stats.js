const { Router } = require('express');
const { pool }   = require('../lib/db');
const logger     = require('../lib/logger');

const router = Router();

router.get('/stats', async (req, res) => {
  try {
    const [summary, streakRows] = await Promise.all([
      pool.query(`
        WITH daily AS (
          SELECT DATE(close_time AT TIME ZONE 'UTC') AS day, SUM(pnl) AS daily_pnl
          FROM trades WHERE pnl IS NOT NULL GROUP BY DATE(close_time AT TIME ZONE 'UTC')
        )
        SELECT
          (SELECT COUNT(*)::int FROM trades WHERE pnl IS NOT NULL) AS total_trades,
          COUNT(*)::int                                             AS total_days,
          COUNT(*) FILTER (WHERE daily_pnl > 0)::int               AS win_days,
          COUNT(*) FILTER (WHERE daily_pnl < 0)::int               AS loss_days
        FROM daily WHERE daily_pnl != 0
      `),
      pool.query(`
        SELECT DATE(close_time AT TIME ZONE 'UTC') AS day, SUM(pnl) AS daily_pnl
        FROM trades WHERE pnl IS NOT NULL
        GROUP BY DATE(close_time AT TIME ZONE 'UTC') HAVING SUM(pnl) != 0 ORDER BY day DESC
      `),
    ]);
    const r = summary.rows[0];
    const winRate = r.total_days > 0 ? Math.round(r.win_days / r.total_days * 100) : 0;
    let streak = 0, streakType = null;
    for (const row of streakRows.rows) {
      const win = parseFloat(row.daily_pnl) > 0;
      if (streakType === null) { streakType = win ? 'W' : 'L'; streak = 1; }
      else if ((win && streakType === 'W') || (!win && streakType === 'L')) streak++;
      else break;
    }
    res.json({ ok: true, winRate, totalTrades: r.total_trades, totalDays: r.total_days, winDays: r.win_days, lossDays: r.loss_days, streak, streakType });
  } catch (err) {
    logger.error({ err }, '[stats]');
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
