const express  = require('express');
const cors     = require('cors');
const crypto   = require('crypto');
const axios    = require('axios');
const path     = require('path');
const { Pool } = require('pg');

const app = express();
app.use(express.json());
app.use(cors({ origin: '*' }));
app.use(express.static(path.join(__dirname)));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS trades (
      id          SERIAL PRIMARY KEY,
      symbol      VARCHAR(20)  NOT NULL,
      side        VARCHAR(10)  NOT NULL,
      entry_price DECIMAL(20,8),
      exit_price  DECIMAL(20,8),
      size        DECIMAL(20,8),
      pnl         DECIMAL(20,8),
      open_time   TIMESTAMPTZ,
      close_time  TIMESTAMPTZ,
      notes       TEXT         DEFAULT '',
      checklist   JSONB        DEFAULT '{"trend":false,"entry":false,"sl":false,"reason":false}'
    );
    CREATE UNIQUE INDEX IF NOT EXISTS trades_symbol_close_time
      ON trades(symbol, close_time);
  `);
  console.log('[DB] trades table ready');
}

// ── CLOSED-POSITION POLLING ────────────────────────────
let lastPollTime = Date.now() - 24 * 60 * 60 * 1000; // last 24h on first run

async function pollClosedTrades() {
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
          t.symbol,
          t.side,
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
    console.error('[poll] closed trades error:', e.message);
  }
}

const PORT      = process.env.PORT || 3001;
const API_KEY   = process.env.BYBIT_API_KEY;
const API_SECRET = process.env.BYBIT_API_SECRET;
const BASE      = process.env.BYBIT_TESTNET === 'true'
  ? 'https://api-testnet.bybit.com'
  : 'https://api.bybit.com';

function sign(payload) {
  return crypto.createHmac('sha256', API_SECRET).update(payload).digest('hex');
}

async function bybitGet(endpoint, params = {}) {
  const ts  = Date.now().toString();
  const rw  = '20000';
  const qs  = Object.keys(params).sort().map(k => `${k}=${params[k]}`).join('&');
  const sig = sign(ts + API_KEY + rw + qs);
  const res = await axios.get(`${BASE}${endpoint}${qs ? '?' + qs : ''}`, {
    headers: {
      'X-BAPI-API-KEY':     API_KEY,
      'X-BAPI-SIGN':        sig,
      'X-BAPI-TIMESTAMP':   ts,
      'X-BAPI-RECV-WINDOW': rw,
      'X-BAPI-SIGN-TYPE':   '2',
    },
  });
  return res.data;
}

async function bybitPost(endpoint, params = {}) {
  const ts   = Date.now().toString();
  const rw   = '20000';
  const body = JSON.stringify(params);
  const sig  = sign(ts + API_KEY + rw + body);
  const res = await axios.post(`${BASE}${endpoint}`, body, {
    headers: {
      'X-BAPI-API-KEY':     API_KEY,
      'X-BAPI-SIGN':        sig,
      'X-BAPI-TIMESTAMP':   ts,
      'X-BAPI-RECV-WINDOW': rw,
      'X-BAPI-SIGN-TYPE':   '2',
      'Content-Type':       'application/json',
    },
  });
  return res.data;
}

app.get('/api/status', (req, res) => {
  res.json({ ok: true, hasKeys: !!API_KEY, server: 'WaleszDesk v1.3' });
});

app.get('/api/balance', async (req, res) => {
  try {
    let result = null;
    for (const accountType of ['UNIFIED', 'CONTRACT', 'SPOT']) {
      const data = await bybitGet('/v5/account/wallet-balance', { accountType });
      if (data.retCode !== 0) continue;
      const account = data.result?.list?.[0] || {};
      const usdt    = (account.coin || []).find(c => c.coin === 'USDT');
      if (usdt) {
        result = {
          balance: parseFloat(usdt.walletBalance || 0).toFixed(2),
          equity:  parseFloat(usdt.equity || usdt.walletBalance || 0).toFixed(2),
          avail:   parseFloat(usdt.availableToWithdraw || usdt.availableToBorrow || usdt.walletBalance || 0).toFixed(2),
        };
        break;
      }
      if (account.totalWalletBalance) {
        result = {
          balance: parseFloat(account.totalWalletBalance).toFixed(2),
          equity:  parseFloat(account.totalEquity || account.totalWalletBalance).toFixed(2),
          avail:   parseFloat(account.totalAvailableBalance || account.totalWalletBalance).toFixed(2),
        };
        break;
      }
    }
    if (!result) return res.status(400).json({ ok: false, error: 'No USDT balance found' });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/positions', async (req, res) => {
  try {
    const data = await bybitGet('/v5/position/list', { category: 'linear', settleCoin: 'USDT' });
    if (data.retCode !== 0) return res.status(400).json({ ok: false, error: data.retMsg });
    const positions = (data.result?.list || [])
      .filter(p => parseFloat(p.size) > 0)
      .map(p => ({
        symbol:        p.symbol,
        side:          p.side,
        size:          p.size,
        entryPrice:    p.avgPrice,
        markPrice:     p.markPrice || '',
        liqPrice:      p.liqPrice,
        unrealisedPnl: parseFloat(p.unrealisedPnl).toFixed(2),
        leverage:      p.leverage,
        takeProfit:    p.takeProfit || '',
        stopLoss:      p.stopLoss  || '',
      }));
    res.json({ ok: true, positions });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/orders', async (req, res) => {
  try {
    const data = await bybitGet('/v5/order/history', { category: 'linear', limit: '20' });
    if (data.retCode !== 0) return res.status(400).json({ ok: false, error: data.retMsg });
    res.json({ ok: true, orders: data.result?.list || [] });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/pnl', async (req, res) => {
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
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/pnl/history', async (req, res) => {
  try {
    const days   = Math.min(180, Math.max(1, parseInt(req.query.days) || 7));
    const CHUNK  = 7 * 24 * 60 * 60 * 1000;
    const now    = Date.now();
    const origin = now - days * 24 * 60 * 60 * 1000;
    const since  = new Date(origin).toISOString();

    // Bybit chunked fetch + DB trade stats in parallel
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
        MAX(pnl)::float                                          AS best,
        MIN(pnl)::float                                          AS worst,
        COUNT(*)::int                                            AS total,
        COUNT(*) FILTER (WHERE pnl > 0)::int                    AS wins,
        COUNT(*) FILTER (WHERE pnl < 0)::int                    AS losses,
        COUNT(*) FILTER (WHERE pnl = 0)::int                    AS be,
        COALESCE(SUM(pnl) FILTER (WHERE pnl > 0), 0)::float     AS gross_profit,
        COALESCE(SUM(ABS(pnl)) FILTER (WHERE pnl < 0), 0)::float AS gross_loss
      FROM trades
      WHERE pnl IS NOT NULL AND close_time >= $1
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

    const s = statsResult.rows[0];
    const pf      = s.gross_loss > 0 ? parseFloat((s.gross_profit / s.gross_loss).toFixed(2)) : null;
    const avgWin  = s.wins   > 0 ? parseFloat((s.gross_profit / s.wins).toFixed(4))   : null;
    const avgLoss = s.losses > 0 ? parseFloat((s.gross_loss   / s.losses).toFixed(4)) : null;
    res.json({
      ok: true,
      history,
      tradeStats: {
        best: s.best, worst: s.worst, total: s.total,
        wins: s.wins, losses: s.losses, be: s.be,
        profitFactor: pf, avgWin, avgLoss,
      },
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/pnl/today', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT COALESCE(SUM(pnl), 0)::float AS total_pnl,
             COUNT(*)::int                AS trade_count
      FROM trades
      WHERE DATE(close_time AT TIME ZONE 'UTC') = CURRENT_DATE
        AND pnl IS NOT NULL
    `);
    res.json({
      ok:         true,
      pnl:        parseFloat(parseFloat(rows[0].total_pnl).toFixed(4)),
      tradeCount: rows[0].trade_count,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/pnl/hours', async (req, res) => {
  try {
    const [hourRows, streakRows] = await Promise.all([
      pool.query(`
        SELECT
          EXTRACT(HOUR FROM close_time AT TIME ZONE 'UTC')::int AS hour,
          ROUND(AVG(pnl)::numeric, 4)                          AS avg_pnl,
          COUNT(*)::int                                         AS trade_count
        FROM trades
        WHERE pnl IS NOT NULL
        GROUP BY EXTRACT(HOUR FROM close_time AT TIME ZONE 'UTC')::int
        ORDER BY avg_pnl DESC
      `),
      pool.query(`
        SELECT DATE(close_time AT TIME ZONE 'UTC') AS day, SUM(pnl) AS daily_pnl
        FROM trades WHERE pnl IS NOT NULL
        GROUP BY DATE(close_time AT TIME ZONE 'UTC')
        HAVING SUM(pnl) != 0
        ORDER BY day DESC
      `),
    ]);

    const fmt = h => String(h).padStart(2, '0') + ':00';
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
      streak,
      streakType,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/pnl/weekdays', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        EXTRACT(DOW FROM close_time AT TIME ZONE 'UTC')::int AS dow,
        ROUND(AVG(pnl)::numeric, 4)                         AS avg_pnl,
        ROUND(SUM(pnl)::numeric, 4)                         AS total_pnl,
        COUNT(*)::int                                        AS trade_count
      FROM trades
      WHERE pnl IS NOT NULL
      GROUP BY EXTRACT(DOW FROM close_time AT TIME ZONE 'UTC')::int
      ORDER BY dow
    `);
    // DOW: 0=Sun,1=Mon,...,6=Sat → reindex to Mon-Sun display order
    const byDow = {};
    for (const r of rows) byDow[r.dow] = r;
    const order = [1,2,3,4,5,6,0]; // Mon..Sat,Sun
    const labels = ['Pon','Wto','Śro','Czw','Pią','Sob','Niedz'];
    const weekdays = order.map((dow, i) => {
      const r = byDow[dow];
      return {
        label:      labels[i],
        avgPnl:     r ? parseFloat(r.avg_pnl)   : null,
        totalPnl:   r ? parseFloat(r.total_pnl) : null,
        tradeCount: r ? r.trade_count            : 0,
      };
    });
    res.json({ ok: true, weekdays });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/ticker', async (req, res) => {
  try {
    const symbol = (req.query.symbol || 'BTCUSDT').toUpperCase();
    const { data } = await axios.get('https://api.bybit.com/v5/market/tickers', {
      params: { category: 'linear', symbol },
    });
    const t = data.result?.list?.[0];
    if (!t) return res.status(404).json({ ok: false, error: 'Symbol not found' });
    res.json({ ok: true, symbol, markPrice: parseFloat(t.markPrice), lastPrice: parseFloat(t.lastPrice) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/set-tpsl', async (req, res) => {
  try {
    const { symbol, type, price } = req.body;
    if (!symbol || !type || price == null)
      return res.status(400).json({ ok: false, error: 'Missing fields: symbol, type, price' });

    const params = {
      category:    'linear',
      symbol,
      positionIdx: 0,
      tpTriggerBy: 'MarkPrice',
      slTriggerBy: 'MarkPrice',
    };
    if (type === 'TP') params.takeProfit = String(price);
    else if (type === 'SL') params.stopLoss = String(price);
    else return res.status(400).json({ ok: false, error: 'type must be TP or SL' });

    console.log('[set-tpsl]', JSON.stringify(params));
    const data = await bybitPost('/v5/position/trading-stop', params);
    console.log('[set-tpsl] response:', JSON.stringify(data));
    if (data.retCode !== 0) return res.status(400).json({ ok: false, error: data.retMsg });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/close-position', async (req, res) => {
  try {
    const { symbol, side, qty } = req.body;
    if (!symbol || !side || !qty)
      return res.status(400).json({ ok: false, error: 'Missing fields: symbol, side, qty' });

    const closeSide = side === 'Buy' ? 'Sell' : 'Buy';

    // floor to lot-size precision (never round up — that could exceed position)
    const qtyNum = parseFloat(qty);
    const precision = symbol.startsWith('BTC') ? 3
                    : symbol.startsWith('ETH') ? 2
                    : 1;
    const factor     = Math.pow(10, precision);
    const qtyFloored = Math.floor(qtyNum * factor) / factor;
    const qtyStr     = qtyFloored.toFixed(precision);

    console.log(`[close-position] symbol=${symbol} side=${side} closeSide=${closeSide} rawQty=${qty} qtyStr=${qtyStr}`);

    if (qtyFloored <= 0)
      return res.status(400).json({ ok: false, error: `Qty ${qty} is below minimum lot size for ${symbol}` });

    const order = {
      category:     'linear',
      symbol,
      side:         closeSide,
      orderType:    'Market',
      qty:          qtyStr,
      timeInForce:  'IOC',
      reduceOnly:   true,
      positionIdx:  0,          // one-way mode
    };
    console.log('[close-position] order payload:', JSON.stringify(order));

    const data = await bybitPost('/v5/order/create', order);
    console.log('[close-position] bybit response:', JSON.stringify(data));

    if (data.retCode !== 0) return res.status(400).json({ ok: false, error: data.retMsg });
    res.json({ ok: true, orderId: data.result?.orderId });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/order', async (req, res) => {
  try {
    const { symbol, side, orderType, qty, price, stopLoss, takeProfit, leverage } = req.body;
    if (!symbol || !side || !orderType || !qty)
      return res.status(400).json({ ok: false, error: 'Missing fields: symbol, side, orderType, qty' });

    if (leverage)
      await bybitPost('/v5/position/set-leverage', { category: 'linear', symbol, buyLeverage: String(leverage), sellLeverage: String(leverage) });

    const qtyNum = parseFloat(qty);
    let qtyStr = symbol.startsWith('BTC') ? qtyNum.toFixed(3) : symbol.startsWith('ETH') ? qtyNum.toFixed(2) : qtyNum.toFixed(1);
    qtyStr = parseFloat(qtyStr).toString();

    const order = { category: 'linear', symbol, side, orderType, qty: qtyStr, timeInForce: orderType === 'Market' ? 'IOC' : 'GTC' };
    if (orderType === 'Limit' && price)  order.price      = String(price);
    if (stopLoss)   { order.stopLoss   = String(stopLoss);   order.slTriggerBy = 'LastPrice'; }
    if (takeProfit) { order.takeProfit = String(takeProfit); order.tpTriggerBy = 'LastPrice'; }

    const data = await bybitPost('/v5/order/create', order);
    if (data.retCode !== 0) return res.status(400).json({ ok: false, error: data.retMsg });
    res.json({ ok: true, orderId: data.result?.orderId });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── STATS ─────────────────────────────────────────────
app.get('/api/stats', async (req, res) => {
  try {
    const [summary, streakRows] = await Promise.all([
      pool.query(`
        WITH daily AS (
          SELECT DATE(close_time AT TIME ZONE 'UTC') AS day, SUM(pnl) AS daily_pnl
          FROM trades WHERE pnl IS NOT NULL
          GROUP BY DATE(close_time AT TIME ZONE 'UTC')
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
        GROUP BY DATE(close_time AT TIME ZONE 'UTC')
        HAVING SUM(pnl) != 0
        ORDER BY day DESC
      `),
    ]);

    const r = summary.rows[0];
    const winRate = r.total_days > 0
      ? Math.round(r.win_days / r.total_days * 100)
      : 0;

    // streak: consecutive win/loss days from most recent
    let streak = 0, streakType = null;
    for (const row of streakRows.rows) {
      const win = parseFloat(row.daily_pnl) > 0;
      if (streakType === null) { streakType = win ? 'W' : 'L'; streak = 1; }
      else if ((win && streakType === 'W') || (!win && streakType === 'L')) streak++;
      else break;
    }

    res.json({
      ok:          true,
      winRate,
      totalTrades: r.total_trades,
      totalDays:   r.total_days,
      winDays:     r.win_days,
      lossDays:    r.loss_days,
      streak,
      streakType,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── JOURNAL ───────────────────────────────────────────
app.get('/api/journal', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM trades ORDER BY close_time DESC NULLS LAST'
    );
    res.json({ ok: true, trades: rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.patch('/api/journal/:id', async (req, res) => {
  try {
    const { notes, checklist } = req.body;
    const { rows } = await pool.query(
      `UPDATE trades SET
         notes     = COALESCE($1, notes),
         checklist = COALESCE($2, checklist)
       WHERE id = $3 RETURNING *`,
      [notes ?? null, checklist ? JSON.stringify(checklist) : null, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ ok: false, error: 'Trade not found' });
    res.json({ ok: true, trade: rows[0] });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

initDb()
  .then(() => {
    pollClosedTrades();
    setInterval(pollClosedTrades, 60_000);
  })
  .catch(err => console.error('[DB] init failed:', err.message));

app.listen(PORT, '0.0.0.0', () => console.log(`WaleszDesk running on 0.0.0.0:${PORT}`));
