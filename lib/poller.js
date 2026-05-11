const { bybitGet } = require('./bybit');
const logger       = require('./logger');

let lastPollTime = Date.now() - 24 * 60 * 60 * 1000;

async function pollClosedTrades(pool) {
  try {
    const data = await bybitGet('/v5/position/closed-pnl', {
      category:  'linear',
      startTime: lastPollTime.toString(),
    });
    lastPollTime = Date.now();
    if (data.retCode !== 0) return;
    for (const t of (data.result?.list || [])) {
      await pool.query(
        `INSERT INTO trades (symbol, side, entry_price, exit_price, size, pnl, open_time, close_time)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (symbol, close_time) DO NOTHING`,
        [
          t.symbol, t.side,
          parseFloat(t.avgEntryPrice) || null,
          parseFloat(t.avgExitPrice)  || null,
          parseFloat(t.qty)           || null,
          parseFloat(t.closedPnl)     || null,
          t.createdTime ? new Date(parseInt(t.createdTime)) : null,
          t.updatedTime ? new Date(parseInt(t.updatedTime)) : null,
        ]
      );
    }
  } catch (e) {
    logger.error({ err: e }, '[poller] closed trades error');
  }
}

function startPoller(pool) {
  pollClosedTrades(pool);
  setInterval(() => pollClosedTrades(pool), 15_000);
}

module.exports = { startPoller };
