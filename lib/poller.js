'use strict';
const { bybitGet } = require('./bybit');
const logger       = require('./logger');

const POLL_KEY  = 'poller_last_poll_time';
const DEFAULT_LOOKBACK = 24 * 60 * 60 * 1000;

let _polling = false;

async function getLastPollTime(pool) {
  const { rows } = await pool.query(`SELECT value FROM app_settings WHERE key=$1`, [POLL_KEY]);
  return rows[0] ? parseInt(rows[0].value) : Date.now() - DEFAULT_LOOKBACK;
}

async function setLastPollTime(pool, ts) {
  await pool.query(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ($1,$2,NOW())
     ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW()`,
    [POLL_KEY, String(ts)]
  );
}

async function pollClosedTrades(pool) {
  if (_polling) return;
  _polling = true;
  try {
    const lastPollTime = await getLastPollTime(pool);
    const data = await bybitGet('/v5/position/closed-pnl', {
      category:  'linear',
      startTime: lastPollTime.toString(),
    });
    await setLastPollTime(pool, Date.now());
    if (data.retCode !== 0) return;
    const list = data.result?.list || [];
    if (!list.length) return;

    // Batch INSERT — single round-trip instead of N
    const COLS = 8;
    const values = [];
    const placeholders = [];
    list.forEach((t, i) => {
      const o = i * COLS;
      placeholders.push(`($${o+1},$${o+2},$${o+3},$${o+4},$${o+5},$${o+6},$${o+7},$${o+8})`);
      values.push(
        t.symbol, t.side,
        parseFloat(t.avgEntryPrice) || null,
        parseFloat(t.avgExitPrice)  || null,
        parseFloat(t.qty)           || null,
        parseFloat(t.closedPnl)     || null,
        t.createdTime ? new Date(parseInt(t.createdTime)) : null,
        t.updatedTime ? new Date(parseInt(t.updatedTime)) : null,
      );
    });
    await pool.query(
      `INSERT INTO trades (symbol, side, entry_price, exit_price, size, pnl, open_time, close_time)
       VALUES ${placeholders.join(',')}
       ON CONFLICT (symbol, close_time) DO NOTHING`,
      values
    );
  } catch (e) {
    logger.error({ err: e }, '[poller] closed trades error');
  } finally {
    _polling = false;
  }
}

function startPoller(pool) {
  pollClosedTrades(pool);
  const handle = setInterval(() => pollClosedTrades(pool), 15_000);
  return () => clearInterval(handle);
}

module.exports = { startPoller };
