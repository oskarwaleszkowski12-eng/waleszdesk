const { Router } = require('express');
const { bybitGet } = require('../lib/bybit');
const { pool }     = require('../lib/db');
const logger       = require('../lib/logger');

const router = Router();

router.get('/', async (req, res) => {
  try {
    const posData = await bybitGet('/v5/position/list', { category: 'linear', settleCoin: 'USDT' });
    let unrealised = 0;
    if (posData.retCode === 0)
      (posData.result?.list || []).forEach(p => { unrealised += parseFloat(p.unrealisedPnl || 0); });

    const today = new Date(); today.setHours(0, 0, 0, 0);
    const closedToday = await bybitGet('/v5/position/closed-pnl', { category: 'linear', startTime: today.getTime().toString(), limit: '50' });
    let realisedToday = 0;
    if (closedToday.retCode === 0)
      (closedToday.result?.list || []).forEach(p => { realisedToday += parseFloat(p.closedPnl || 0); });

    const closedAll = await bybitGet('/v5/position/closed-pnl', { category: 'linear', limit: '200' });
    let realisedAllTime = 0;
    if (closedAll.retCode === 0)
      (closedAll.result?.list || []).forEach(p => { realisedAllTime += parseFloat(p.closedPnl || 0); });

    res.json({
      ok: true,
      unrealised:      parseFloat(unrealised.toFixed(4)),
      realisedToday:   parseFloat(realisedToday.toFixed(4)),
      realisedAllTime: parseFloat(realisedAllTime.toFixed(4)),
      totalToday:      parseFloat((realisedToday + unrealised).toFixed(4)),
      totalAllTime:    parseFloat((realisedAllTime + unrealised).toFixed(4)),
    });
  } catch (err) {
    logger.error({ err }, '[pnl]');
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/history', async (req, res) => {
  try {
    const days   = Math.min(180, Math.max(1, parseInt(req.query.days) || 7));
    const CHUNK  = 7 * 24 * 60 * 60 * 1000;
    const now    = Date.now();
    const origin = now - days * 24 * 60 * 60 * 1000;
    const since  = new Date(origin).toISOString();

    const chunksPromise = (async () => {
      const all = [];
      for (let end = now; end > origin; end -= CHUNK) {
        const start = Math.max(end - CHUNK, origin);
        const data  = await bybitGet('/v5/position/closed-pnl', {
          category: 'linear', startTime: start.toString(), endTime: end.toString(), limit: '200',
        });
        if (data.retCode !== 0) continue;
        all.push(...(data.result?.list || []));
      }
      return all;
    })();

    const statsPromise = pool.query(`
      SELECT
        MAX(pnl)::float                                           AS best,
        MIN(pnl)::float                                           AS worst,
        COUNT(*)::int                                             AS total,
        COUNT(*) FILTER (WHERE pnl > 0)::int                     AS wins,
        COUNT(*) FILTER (WHERE pnl < 0)::int                     AS losses,
        COUNT(*) FILTER (WHERE pnl = 0)::int                     AS be,
        COALESCE(SUM(pnl) FILTER (WHERE pnl > 0), 0)::float      AS gross_profit,
        COALESCE(SUM(ABS(pnl)) FILTER (WHERE pnl < 0), 0)::float AS gross_loss
      FROM trades WHERE pnl IS NOT NULL AND close_time >= $1
    `, [since]);

    const [allTrades, statsResult] = await Promise.all([chunksPromise, statsPromise]);

    const byDay = {};
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(); d.setUTCDate(d.getUTCDate() - i); d.setUTCHours(0,0,0,0);
      byDay[d.toISOString().slice(0,10)] = 0;
    }
    for (const t of allTrades) {
      const day = new Date(parseInt(t.updatedTime)).toISOString().slice(0,10);
      if (day in byDay) byDay[day] += parseFloat(t.closedPnl || 0);
    }
    const history = Object.entries(byDay).map(([date, pnl]) => ({ date, pnl: parseFloat(pnl.toFixed(4)) }));

    const s     = statsResult.rows[0];
    const pf    = s.gross_loss > 0 ? parseFloat((s.gross_profit / s.gross_loss).toFixed(2)) : null;
    const avgWin  = s.wins   > 0 ? parseFloat((s.gross_profit / s.wins).toFixed(4))   : null;
    const avgLoss = s.losses > 0 ? parseFloat((s.gross_loss   / s.losses).toFixed(4)) : null;
    res.json({ ok: true, history, tradeStats: { best: s.best, worst: s.worst, total: s.total, wins: s.wins, losses: s.losses, be: s.be, profitFactor: pf, avgWin, avgLoss } });
  } catch (err) {
    logger.error({ err }, '[pnl/history]');
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/today', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT COALESCE(SUM(pnl), 0)::float AS total_pnl, COUNT(*)::int AS trade_count
      FROM trades WHERE DATE(close_time AT TIME ZONE 'UTC') = CURRENT_DATE AND pnl IS NOT NULL
    `);
    res.json({ ok: true, pnl: parseFloat(parseFloat(rows[0].total_pnl).toFixed(4)), tradeCount: rows[0].trade_count });
  } catch (err) {
    logger.error({ err }, '[pnl/today]');
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/hours', async (req, res) => {
  try {
    const [hourRows, streakRows] = await Promise.all([
      pool.query(`
        SELECT EXTRACT(HOUR FROM close_time AT TIME ZONE 'UTC')::int AS hour,
               ROUND(AVG(pnl)::numeric, 4) AS avg_pnl, COUNT(*)::int AS trade_count
        FROM trades WHERE pnl IS NOT NULL
        GROUP BY EXTRACT(HOUR FROM close_time AT TIME ZONE 'UTC')::int ORDER BY avg_pnl DESC
      `),
      pool.query(`
        SELECT DATE(close_time AT TIME ZONE 'UTC') AS day, SUM(pnl) AS daily_pnl
        FROM trades WHERE pnl IS NOT NULL
        GROUP BY DATE(close_time AT TIME ZONE 'UTC') HAVING SUM(pnl) != 0 ORDER BY day DESC
      `),
    ]);
    const fmt  = h => String(h).padStart(2, '0') + ':00';
    const rows = hourRows.rows;
    const best  = rows.length ? rows[0] : null;
    const worst = rows.length ? rows[rows.length - 1] : null;
    let streak = 0, streakType = null;
    for (const row of streakRows.rows) {
      const win = parseFloat(row.daily_pnl) > 0;
      if (streakType === null) { streakType = win ? 'W' : 'L'; streak = 1; }
      else if ((win && streakType === 'W') || (!win && streakType === 'L')) streak++;
      else break;
    }
    res.json({
      ok: true,
      best:  best  ? { hour: fmt(best.hour),  avgPnl: parseFloat(best.avg_pnl),  trades: best.trade_count  } : null,
      worst: worst ? { hour: fmt(worst.hour), avgPnl: parseFloat(worst.avg_pnl), trades: worst.trade_count } : null,
      streak, streakType,
    });
  } catch (err) {
    logger.error({ err }, '[pnl/hours]');
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/weekdays', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT EXTRACT(DOW FROM close_time AT TIME ZONE 'UTC')::int AS dow,
             ROUND(AVG(pnl)::numeric, 4) AS avg_pnl, ROUND(SUM(pnl)::numeric, 4) AS total_pnl, COUNT(*)::int AS trade_count
      FROM trades WHERE pnl IS NOT NULL
      GROUP BY EXTRACT(DOW FROM close_time AT TIME ZONE 'UTC')::int ORDER BY dow
    `);
    const byDow = {};
    for (const r of rows) byDow[r.dow] = r;
    const order   = [1,2,3,4,5,6,0];
    const labels  = ['Pon','Wto','Śro','Czw','Pią','Sob','Niedz'];
    const weekdays = order.map((dow, i) => {
      const r = byDow[dow];
      return { label: labels[i], avgPnl: r ? parseFloat(r.avg_pnl) : null, totalPnl: r ? parseFloat(r.total_pnl) : null, tradeCount: r ? r.trade_count : 0 };
    });
    res.json({ ok: true, weekdays });
  } catch (err) {
    logger.error({ err }, '[pnl/weekdays]');
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
