const express       = require('express');
const cors          = require('cors');
const crypto        = require('crypto');
const axios         = require('axios');
const path          = require('path');
const jwt           = require('jsonwebtoken');
const { Pool }      = require('pg');
const http          = require('http');
const helmet        = require('helmet');
const rateLimit     = require('express-rate-limit');
const { WebSocketServer } = require('ws');
const startBotEngine             = require('./botEngine');
const { createExchangeClient }   = require('./exchanges');

const app = express();
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json());
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || '*' }));
app.use(express.static(path.join(__dirname)));

const limiter = rateLimit({ windowMs: 60_000, max: 120, standardHeaders: true, legacyHeaders: false });
const authLimiter = rateLimit({ windowMs: 60_000, max: 10, standardHeaders: true, legacyHeaders: false });
app.use('/api/', limiter);
app.use('/api/auth/', authLimiter);
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bots (
      id         SERIAL      PRIMARY KEY,
      name       VARCHAR(100) NOT NULL,
      type       VARCHAR(10)  NOT NULL,
      symbol     VARCHAR(20)  NOT NULL,
      status     VARCHAR(20)  NOT NULL DEFAULT 'active',
      config     JSONB        NOT NULL DEFAULT '{}',
      stats      JSONB        NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS bot_trades (
      id         SERIAL       PRIMARY KEY,
      bot_id     INTEGER      NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
      order_id   VARCHAR(100),
      side       VARCHAR(10),
      qty        DECIMAL(20,8),
      price      DECIMAL(20,8),
      status     VARCHAR(20)  DEFAULT 'open',
      meta       JSONB        DEFAULT '{}',
      created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    );
  `);
  // Migrations: add columns if missing
  await pool.query(`
    ALTER TABLE bots
      ADD COLUMN IF NOT EXISTS api_key_enc        TEXT,
      ADD COLUMN IF NOT EXISTS api_secret_enc     TEXT,
      ADD COLUMN IF NOT EXISTS api_passphrase_enc TEXT,
      ADD COLUMN IF NOT EXISTS subaccount_name    VARCHAR(100),
      ADD COLUMN IF NOT EXISTS allocated_balance  DECIMAL(20,2),
      ADD COLUMN IF NOT EXISTS exchange           VARCHAR(20) DEFAULT 'bybit';
  `);
  console.log('[DB] bots tables ready');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS algo_templates (
      id              SERIAL PRIMARY KEY,
      name            VARCHAR(100) NOT NULL,
      description     TEXT,
      type            VARCHAR(10)  NOT NULL,
      symbol          VARCHAR(20)  NOT NULL,
      config          JSONB        NOT NULL DEFAULT '{}',
      risk_level      VARCHAR(10)  DEFAULT 'Medium',
      est_monthly_pct DECIMAL(6,2),
      min_capital     DECIMAL(20,2) DEFAULT 50,
      active          BOOLEAN      DEFAULT TRUE,
      created_at      TIMESTAMPTZ  DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS algo_users (
      id                SERIAL PRIMARY KEY,
      api_key_enc       TEXT NOT NULL,
      api_secret_enc    TEXT NOT NULL,
      api_passphrase_enc TEXT,
      uid               VARCHAR(50),
      exchange          VARCHAR(20) DEFAULT 'bybit',
      balance_at_signup DECIMAL(20,2),
      bot_template_id   INTEGER REFERENCES algo_templates(id),
      allocated_capital DECIMAL(20,2),
      bot_id            INTEGER REFERENCES bots(id) ON DELETE SET NULL,
      status            VARCHAR(20) DEFAULT 'active',
      created_at        TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await pool.query(`
    ALTER TABLE algo_users
      ADD COLUMN IF NOT EXISTS api_passphrase_enc TEXT,
      ADD COLUMN IF NOT EXISTS exchange           VARCHAR(20) DEFAULT 'bybit';
  `);
  console.log('[DB] algo tables ready');
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
  await pool.query(`
    CREATE TABLE IF NOT EXISTS invite_codes (
      id         SERIAL      PRIMARY KEY,
      code       VARCHAR(20) NOT NULL UNIQUE,
      label      VARCHAR(100) DEFAULT '',
      used       BOOLEAN     NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  console.log('[DB] invite_codes table ready');
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

// ── Balance cache (TTL 30s, eliminates N concurrent exchange calls on /api/bots) ──
const balanceCache = new Map(); // botId → { balance, ts }
const BALANCE_TTL  = 30_000;

async function getCachedBalance(botId, fetchFn) {
  const cached = balanceCache.get(botId);
  if (cached && Date.now() - cached.ts < BALANCE_TTL) return cached.balance;
  try {
    const balance = await fetchFn();
    balanceCache.set(botId, { balance, ts: Date.now() });
    return balance;
  } catch {
    return null;
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

// ── Encryption (AES-256-CBC) ───────────────────────────
function encKey() {
  return crypto.createHash('sha256')
    .update(process.env.ENCRYPTION_KEY || 'waleszdesk-dev-default-key')
    .digest();
}
function encrypt(text) {
  const iv  = crypto.randomBytes(16);
  const c   = crypto.createCipheriv('aes-256-cbc', encKey(), iv);
  return iv.toString('hex') + ':' + Buffer.concat([c.update(text, 'utf8'), c.final()]).toString('hex');
}
function decrypt(ciphertext) {
  const [ivHex, hex] = ciphertext.split(':');
  const d = crypto.createDecipheriv('aes-256-cbc', encKey(), Buffer.from(ivHex, 'hex'));
  return Buffer.concat([d.update(Buffer.from(hex, 'hex')), d.final()]).toString('utf8');
}

// ── JWT Auth ───────────────────────────────────────────
const JWT_SECRET    = process.env.JWT_SECRET || 'waleszdesk-jwt-secret-dev';
const ADMIN_PASS    = process.env.ADMIN_PASSWORD || '';

function requireAuth(req, res, next) {
  const header = req.headers['authorization'] || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  try {
    jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ ok: false, error: 'Invalid or expired token' });
  }
}

app.post('/api/auth/login', (req, res) => {
  const { password } = req.body || {};
  if (!ADMIN_PASS || password !== ADMIN_PASS) {
    return res.status(401).json({ ok: false, error: 'Invalid password' });
  }
  const token = jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '24h' });
  res.json({ ok: true, token });
});

// Protect all /api/* routes except /api/auth/*, /api/algo/*, and /api/status
app.use('/api', (req, res, next) => {
  if (req.path === '/status' || req.path.startsWith('/auth/') || req.path.startsWith('/algo/') || req.path === '/algo') return next();
  requireAuth(req, res, next);
});

// ── Bybit helpers with explicit keys ──────────────────
async function bybitGetWithKeys(apiKey, apiSecret, endpoint, params = {}) {
  const ts  = Date.now().toString();
  const rw  = '20000';
  const qs  = Object.keys(params).sort().map(k => `${k}=${params[k]}`).join('&');
  const sig = crypto.createHmac('sha256', apiSecret).update(ts + apiKey + rw + qs).digest('hex');
  const res = await axios.get(`${BASE}${endpoint}${qs ? '?' + qs : ''}`, {
    headers: { 'X-BAPI-API-KEY': apiKey, 'X-BAPI-SIGN': sig, 'X-BAPI-TIMESTAMP': ts, 'X-BAPI-RECV-WINDOW': rw, 'X-BAPI-SIGN-TYPE': '2' },
    timeout: 5000,
  });
  return res.data;
}
async function bybitPostWithKeys(apiKey, apiSecret, endpoint, params = {}) {
  const ts   = Date.now().toString();
  const rw   = '20000';
  const body = JSON.stringify(params);
  const sig  = crypto.createHmac('sha256', apiSecret).update(ts + apiKey + rw + body).digest('hex');
  const res  = await axios.post(`${BASE}${endpoint}`, body, {
    headers: { 'X-BAPI-API-KEY': apiKey, 'X-BAPI-SIGN': sig, 'X-BAPI-TIMESTAMP': ts, 'X-BAPI-RECV-WINDOW': rw, 'X-BAPI-SIGN-TYPE': '2', 'Content-Type': 'application/json' },
    timeout: 5000,
  });
  return res.data;
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
        exchange:      'bybit',
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

// ── BOTS ──────────────────────────────────────────────
function botPublic(row) {
  const { api_key_enc, api_secret_enc, api_passphrase_enc, ...pub } = row;
  pub.exchange       = row.exchange || 'bybit';
  pub.api_key_masked = api_key_enc ? (() => { try { return decrypt(api_key_enc).slice(0, 4) + '***'; } catch { return '****'; } })() : null;
  return pub;
}

function botClientDetails(row) {
  try {
    if (row.api_key_enc && row.api_secret_enc) {
      return {
        exchange:    row.exchange || 'bybit',
        apiKey:      decrypt(row.api_key_enc),
        apiSecret:   decrypt(row.api_secret_enc),
        passphrase:  row.api_passphrase_enc ? decrypt(row.api_passphrase_enc) : undefined,
      };
    }
  } catch (e) {
    console.error(`[bots:${row.id}] key decrypt error:`, e.message);
  }
  return { exchange: 'bybit', apiKey: API_KEY, apiSecret: API_SECRET, passphrase: undefined };
}

app.get('/api/bots/test-connection', async (req, res) => {
  const { key, secret, exchange, passphrase } = req.query;
  if (!key || !secret) return res.status(400).json({ ok: false, error: 'key and secret required' });
  try {
    const client  = createExchangeClient(exchange || 'bybit', key, secret, passphrase);
    const { total } = await client.getBalance();
    res.json({ ok: true, balance: parseFloat(total.toFixed(2)) });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.post('/api/bots', async (req, res) => {
  try {
    const { name, type, symbol, config, apiKey, apiSecret, apiPassphrase, exchange, subaccountName, allocatedBalance } = req.body;
    if (!name || !type || !symbol || !config)
      return res.status(400).json({ ok: false, error: 'Missing: name, type, symbol, config' });
    if (!['dca', 'grid'].includes(type))
      return res.status(400).json({ ok: false, error: 'type must be dca or grid' });
    if (!apiKey || !apiSecret)
      return res.status(400).json({ ok: false, error: 'API key and secret are required' });

    const ex = (exchange || 'bybit').toLowerCase();
    const { rows } = await pool.query(
      `INSERT INTO bots (name, type, symbol, status, config, stats, api_key_enc, api_secret_enc, api_passphrase_enc, exchange, subaccount_name, allocated_balance)
       VALUES ($1,$2,$3,'active',$4,'{}', $5, $6, $7, $8, $9, $10) RETURNING *`,
      [name.trim(), type, symbol.toUpperCase(), JSON.stringify({ ...config, state: {} }),
       encrypt(apiKey), encrypt(apiSecret),
       apiPassphrase ? encrypt(apiPassphrase) : null,
       ex, subaccountName || null, allocatedBalance || null]
    );
    res.json({ ok: true, bot: botPublic(rows[0]) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/bots', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT b.*,
        (SELECT COUNT(*)             FROM bot_trades WHERE bot_id = b.id)::int                  AS trade_count,
        (SELECT COUNT(*)             FROM bot_trades WHERE bot_id = b.id AND status='open')::int AS open_orders
      FROM bots b ORDER BY b.created_at DESC
    `);
    const bots = await Promise.all(rows.map(async row => {
      const pub = botPublic(row);
      if (row.status !== 'stopped') {
        pub.live_balance = await getCachedBalance(row.id, async () => {
          const { exchange, apiKey, apiSecret, passphrase } = botClientDetails(row);
          const client = createExchangeClient(exchange, apiKey, apiSecret, passphrase);
          const { total } = await client.getBalance();
          return parseFloat(total.toFixed(2));
        });
      } else {
        pub.live_balance = null;
      }
      return pub;
    }));
    res.json({ ok: true, bots });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.patch('/api/bots/pause-all', async (req, res) => {
  try {
    const { rowCount } = await pool.query(
      `UPDATE bots SET status='paused', updated_at=NOW() WHERE status='active'`
    );
    res.json({ ok: true, paused: rowCount });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.patch('/api/bots/stop-all', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE bots SET status='stopped', updated_at=NOW() WHERE status IN ('active','paused') RETURNING *`
    );
    await Promise.allSettled(rows.map(async bot => {
      try {
        const { exchange, apiKey, apiSecret, passphrase } = botClientDetails(bot);
        const client = createExchangeClient(exchange, apiKey, apiSecret, passphrase);
        await client.cancelAllOrders(bot.symbol);
      } catch {}
    }));
    res.json({ ok: true, stopped: rows.length });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.patch('/api/bots/:id', async (req, res) => {
  try {
    const { name, symbol, config, apiKey, apiSecret, apiPassphrase, exchange, subaccountName, allocatedBalance } = req.body;
    const { rows: existing } = await pool.query(`SELECT * FROM bots WHERE id=$1`, [req.params.id]);
    if (!existing.length) return res.status(404).json({ ok: false, error: 'Bot not found' });

    const updates = [];
    const vals    = [];
    let   idx     = 1;

    if (name)     { updates.push(`name=$${idx++}`);     vals.push(name.trim()); }
    if (symbol)   { updates.push(`symbol=$${idx++}`);   vals.push(symbol.toUpperCase()); }
    if (exchange) { updates.push(`exchange=$${idx++}`); vals.push(exchange.toLowerCase()); }
    if (config) {
      const existingState = (existing[0].config || {}).state || {};
      updates.push(`config=$${idx++}`);
      vals.push(JSON.stringify({ ...config, state: existingState }));
    }
    if (apiKey && apiSecret) {
      updates.push(`api_key_enc=$${idx++}`, `api_secret_enc=$${idx++}`);
      vals.push(encrypt(apiKey), encrypt(apiSecret));
      if (apiPassphrase !== undefined) {
        updates.push(`api_passphrase_enc=$${idx++}`);
        vals.push(apiPassphrase ? encrypt(apiPassphrase) : null);
      }
    }
    if (subaccountName !== undefined)   { updates.push(`subaccount_name=$${idx++}`);    vals.push(subaccountName || null); }
    if (allocatedBalance !== undefined) { updates.push(`allocated_balance=$${idx++}`);  vals.push(allocatedBalance || null); }

    if (!updates.length) return res.status(400).json({ ok: false, error: 'Nothing to update' });
    updates.push(`updated_at=NOW()`);
    vals.push(req.params.id);

    const { rows } = await pool.query(
      `UPDATE bots SET ${updates.join(',')} WHERE id=$${idx} RETURNING *`,
      vals
    );
    res.json({ ok: true, bot: botPublic(rows[0]) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/bots/:id/trades', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM bot_trades WHERE bot_id=$1 ORDER BY created_at DESC LIMIT 50`,
      [req.params.id]
    );
    res.json({ ok: true, trades: rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.patch('/api/bots/:id/pause', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE bots SET status='paused', updated_at=NOW() WHERE id=$1 RETURNING *`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ ok: false, error: 'Bot not found' });
    res.json({ ok: true, bot: botPublic(rows[0]) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.patch('/api/bots/:id/resume', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE bots SET status='active', updated_at=NOW() WHERE id=$1 RETURNING *`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ ok: false, error: 'Bot not found' });
    res.json({ ok: true, bot: botPublic(rows[0]) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.delete('/api/bots/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM bots WHERE id=$1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ ok: false, error: 'Bot not found' });
    const bot = rows[0];
    if (bot.status === 'stopped') {
      await pool.query(`DELETE FROM bots WHERE id=$1`, [req.params.id]);
    } else {
      try {
        const { exchange, apiKey, apiSecret, passphrase } = botClientDetails(bot);
        const client = createExchangeClient(exchange, apiKey, apiSecret, passphrase);
        await client.cancelAllOrders(bot.symbol);
      } catch (e) {
        console.error(`[bots] cancel-all failed for ${bot.symbol}:`, e.message);
      }
      await pool.query(`UPDATE bots SET status='stopped', updated_at=NOW() WHERE id=$1`, [req.params.id]);
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── ALGO (client-facing) ──────────────────────────────
app.get('/algo', (req, res) => res.sendFile(path.join(__dirname, 'algo.html')));

app.get('/api/algo/available-bots', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, description, type, symbol, risk_level, est_monthly_pct, min_capital
       FROM algo_templates WHERE active=true ORDER BY id`
    );
    res.json({ ok: true, templates: rows });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.post('/api/algo/verify-keys', async (req, res) => {
  const { key, secret, exchange, passphrase } = req.body;
  if (!key || !secret) return res.status(400).json({ ok: false, error: 'key and secret required' });
  try {
    const client  = createExchangeClient(exchange || 'bybit', key, secret, passphrase);
    const { total } = await client.getBalance();
    const uid     = await client.getUID();
    res.json({ ok: true, balance: parseFloat(total.toFixed(2)), uid });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

app.post('/api/algo/launch', async (req, res) => {
  try {
    const { apiKey, apiSecret, apiPassphrase, exchange, templateId, allocatedCapital, inviteCode } = req.body;
    if (!apiKey || !apiSecret || !templateId || !allocatedCapital)
      return res.status(400).json({ ok: false, error: 'Missing required fields' });

    // Validate invite code
    if (!inviteCode) return res.status(400).json({ ok: false, error: 'Invite code required' });
    const { rows: codeRows } = await pool.query(
      `SELECT id FROM invite_codes WHERE code=$1 AND used=FALSE`, [inviteCode.trim().toUpperCase()]
    );
    if (!codeRows.length) return res.status(400).json({ ok: false, error: 'Invalid or already used invite code' });

    const ex = (exchange || 'bybit').toLowerCase();

    const { rows: tmplRows } = await pool.query(
      `SELECT * FROM algo_templates WHERE id=$1 AND active=true`, [templateId]
    );
    if (!tmplRows.length) return res.status(404).json({ ok: false, error: 'Template not found or inactive' });
    const tmpl = tmplRows[0];

    if (allocatedCapital < parseFloat(tmpl.min_capital || 50))
      return res.status(400).json({ ok: false, error: `Minimum capital is $${tmpl.min_capital}` });

    const client  = createExchangeClient(ex, apiKey, apiSecret, apiPassphrase);
    const { total: balance } = await client.getBalance().catch(e => { throw new Error('Key verification failed: ' + e.message); });
    if (allocatedCapital > balance * 0.5)
      return res.status(400).json({ ok: false, error: `Max 50% of balance ($${(balance * 0.5).toFixed(2)})` });

    const uid = await client.getUID().catch(() => 'unknown');

    const { rows: existing } = await pool.query(`SELECT id FROM algo_users WHERE uid=$1 AND exchange=$2`, [uid, ex]);
    if (existing.length) return res.json({ ok: false, error: 'UID already registered. Contact support.' });

    const botConfig = { ...tmpl.config, symbol: tmpl.symbol };
    const { rows: botRows } = await pool.query(
      `INSERT INTO bots (name, type, symbol, status, config, stats, api_key_enc, api_secret_enc, api_passphrase_enc, exchange, allocated_balance)
       VALUES ($1,$2,$3,'active',$4,'{}', $5, $6, $7, $8, $9) RETURNING *`,
      [`[Algo] ${tmpl.name}`, tmpl.type, tmpl.symbol,
       JSON.stringify({ ...botConfig, state: {} }),
       encrypt(apiKey), encrypt(apiSecret),
       apiPassphrase ? encrypt(apiPassphrase) : null,
       ex, allocatedCapital]
    );
    const bot = botRows[0];

    await pool.query(
      `INSERT INTO algo_users (api_key_enc, api_secret_enc, api_passphrase_enc, exchange, uid, balance_at_signup, bot_template_id, allocated_capital, bot_id, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'active')`,
      [encrypt(apiKey), encrypt(apiSecret),
       apiPassphrase ? encrypt(apiPassphrase) : null,
       ex, uid, balance, templateId, allocatedCapital, bot.id]
    );
    await pool.query(`UPDATE invite_codes SET used=TRUE WHERE code=$1`, [inviteCode.trim().toUpperCase()]);
    res.json({ ok: true, botId: bot.id, uid });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.get('/api/algo/status', async (req, res) => {
  try {
    const { uid } = req.query;
    if (!uid) return res.status(400).json({ ok: false, error: 'uid required' });
    const { rows } = await pool.query(`
      SELECT au.*, at.name AS template_name, at.symbol, at.risk_level,
        b.status AS bot_status, b.stats,
        (SELECT COUNT(*) FROM bot_trades WHERE bot_id=au.bot_id)::int AS trade_count
      FROM algo_users au
      LEFT JOIN algo_templates at ON at.id = au.bot_template_id
      LEFT JOIN bots b ON b.id = au.bot_id
      WHERE au.uid=$1
    `, [uid]);
    if (!rows.length) return res.json({ ok: false, error: 'User not found' });
    const u = rows[0];
    res.json({ ok: true, user: {
      template_name:     u.template_name,
      symbol:            u.symbol,
      risk_level:        u.risk_level,
      allocated_capital: u.allocated_capital,
      status:            u.bot_status || u.status,
      trade_count:       u.trade_count,
      pnl:               parseFloat(((u.stats || {}).total_pnl || 0)),
    }});
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ── ALGO ADMIN ────────────────────────────────────────
app.get('/api/algo/admin/templates', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM algo_templates ORDER BY id`);
    res.json({ ok: true, templates: rows });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.post('/api/algo/admin/templates', async (req, res) => {
  try {
    const { name, description, type, symbol, config, risk_level, est_monthly_pct, min_capital } = req.body;
    if (!name || !type || !symbol) return res.status(400).json({ ok: false, error: 'name, type, symbol required' });
    const { rows } = await pool.query(
      `INSERT INTO algo_templates (name, description, type, symbol, config, risk_level, est_monthly_pct, min_capital)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [name.trim(), description||'', type, symbol.toUpperCase(),
       JSON.stringify(config||{}), risk_level||'Medium', est_monthly_pct||null, min_capital||50]
    );
    res.json({ ok: true, template: rows[0] });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.patch('/api/algo/admin/templates/:id', async (req, res) => {
  try {
    const { name, description, type, symbol, config, risk_level, est_monthly_pct, min_capital } = req.body;
    const updates = []; const vals = []; let idx = 1;
    if (name)                          { updates.push(`name=$${idx++}`);             vals.push(name.trim()); }
    if (description !== undefined)     { updates.push(`description=$${idx++}`);      vals.push(description||''); }
    if (type)                          { updates.push(`type=$${idx++}`);             vals.push(type); }
    if (symbol)                        { updates.push(`symbol=$${idx++}`);           vals.push(symbol.toUpperCase()); }
    if (config)                        { updates.push(`config=$${idx++}`);           vals.push(JSON.stringify(config)); }
    if (risk_level)                    { updates.push(`risk_level=$${idx++}`);       vals.push(risk_level); }
    if (est_monthly_pct !== undefined) { updates.push(`est_monthly_pct=$${idx++}`);  vals.push(est_monthly_pct||null); }
    if (min_capital !== undefined)     { updates.push(`min_capital=$${idx++}`);      vals.push(min_capital||50); }
    if (!updates.length) return res.status(400).json({ ok: false, error: 'Nothing to update' });
    vals.push(req.params.id);
    const { rows } = await pool.query(
      `UPDATE algo_templates SET ${updates.join(',')} WHERE id=$${idx} RETURNING *`, vals
    );
    res.json({ ok: true, template: rows[0] });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.patch('/api/algo/admin/templates/:id/toggle', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE algo_templates SET active = NOT active WHERE id=$1 RETURNING *`, [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ ok: false, error: 'Not found' });
    res.json({ ok: true, template: rows[0] });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.get('/api/algo/admin/users', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT au.id, au.uid, au.balance_at_signup, au.allocated_capital, au.status, au.created_at,
        at.name AS template_name, at.symbol, at.type AS template_type,
        b.status AS bot_status, b.stats,
        (SELECT COUNT(*) FROM bot_trades WHERE bot_id=au.bot_id)::int AS trade_count
      FROM algo_users au
      LEFT JOIN algo_templates at ON at.id = au.bot_template_id
      LEFT JOIN bots b ON b.id = au.bot_id
      ORDER BY au.created_at DESC
    `);
    res.json({ ok: true, users: rows.map(r => ({
      ...r,
      pnl: parseFloat(((r.stats || {}).total_pnl || 0)).toFixed(2),
    }))});
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ── INVITE CODES (public verify + admin CRUD) ─────────
app.post('/api/algo/verify-invite', async (req, res) => {
  try {
    const { code } = req.body || {};
    if (!code) return res.status(400).json({ ok: false, error: 'Missing code' });
    const { rows } = await pool.query(
      `SELECT * FROM invite_codes WHERE code=$1 AND used=FALSE`, [code.trim().toUpperCase()]
    );
    if (!rows.length) return res.status(400).json({ ok: false, error: 'Invalid or already used code' });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.get('/api/algo/admin/invite-codes', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM invite_codes ORDER BY created_at DESC`);
    res.json({ ok: true, codes: rows });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.post('/api/algo/admin/invite-codes', async (req, res) => {
  try {
    const { label } = req.body || {};
    const code = crypto.randomBytes(4).toString('hex').toUpperCase();
    const { rows } = await pool.query(
      `INSERT INTO invite_codes (code, label) VALUES ($1,$2) RETURNING *`,
      [code, label || '']
    );
    res.json({ ok: true, code: rows[0] });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.patch('/api/algo/admin/invite-codes/:id/deactivate', async (req, res) => {
  try {
    await pool.query(`UPDATE invite_codes SET used=TRUE WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
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

// ── WebSocket server ──────────────────────────────────
const server = http.createServer(app);
const wss    = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  const token = new URL(req.url, 'ws://x').searchParams.get('token');
  try { jwt.verify(token, JWT_SECRET); } catch { ws.close(1008, 'Unauthorized'); return; }
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('error', () => {});
});

// Heartbeat — drop stale connections
setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) { ws.terminate(); return; }
    ws.isAlive = false;
    ws.ping();
  });
}, 30_000);

function wsBroadcast(payload) {
  const msg = JSON.stringify(payload);
  wss.clients.forEach(ws => { if (ws.readyState === 1) ws.send(msg); });
}

// Broadcast live data every 5s — one fetch shared across all connected clients
async function broadcastLiveData() {
  if (wss.clients.size === 0) return;
  try {
    const [balRes, posRes, todayRes] = await Promise.allSettled([
      bybitGet('/v5/account/wallet-balance', { accountType: 'UNIFIED' }),
      bybitGet('/v5/position/list', { category: 'linear', settleCoin: 'USDT' }),
      bybitGet('/v5/position/closed-pnl', {
        category: 'linear',
        startTime: new Date().setHours(0, 0, 0, 0).toString(),
        limit: '50',
      }),
    ]);

    let balance = null;
    if (balRes.status === 'fulfilled' && balRes.value?.retCode === 0) {
      const acct = balRes.value.result?.list?.[0] || {};
      const usdt = (acct.coin || []).find(c => c.coin === 'USDT');
      if (usdt) balance = {
        balance: parseFloat(usdt.walletBalance || 0).toFixed(2),
        equity:  parseFloat(usdt.equity || usdt.walletBalance || 0).toFixed(2),
        avail:   parseFloat(usdt.availableToWithdraw || usdt.walletBalance || 0).toFixed(2),
      };
    }

    let positions = [];
    if (posRes.status === 'fulfilled' && posRes.value?.retCode === 0) {
      positions = (posRes.value.result?.list || [])
        .filter(p => parseFloat(p.size) > 0)
        .map(p => ({
          exchange: 'bybit', symbol: p.symbol, side: p.side, size: p.size,
          entryPrice: p.avgPrice, markPrice: p.markPrice || '',
          liqPrice: p.liqPrice,
          unrealisedPnl: parseFloat(p.unrealisedPnl).toFixed(2),
          leverage: p.leverage, takeProfit: p.takeProfit || '', stopLoss: p.stopLoss || '',
        }));
    }

    const unrealised = positions.reduce((s, p) => s + parseFloat(p.unrealisedPnl || 0), 0);

    let realisedToday = 0;
    if (todayRes.status === 'fulfilled' && todayRes.value?.retCode === 0) {
      (todayRes.value.result?.list || []).forEach(p => { realisedToday += parseFloat(p.closedPnl || 0); });
    }

    wsBroadcast({
      type: 'live_data',
      balance,
      positions: { ok: true, positions },
      pnl: {
        unrealised:    parseFloat(unrealised.toFixed(4)),
        realisedToday: parseFloat(realisedToday.toFixed(4)),
        totalToday:    parseFloat((realisedToday + unrealised).toFixed(4)),
      },
    });
  } catch (e) {
    console.error('[ws] broadcast error:', e.message);
  }
}

setInterval(broadcastLiveData, 5_000);

initDb()
  .then(() => {
    pollClosedTrades();
    setInterval(pollClosedTrades, 15_000);
    startBotEngine({ pool, decrypt });
  })
  .catch(err => console.error('[DB] init failed:', err.message));

server.listen(PORT, '0.0.0.0', () => console.log(`WaleszDesk running on 0.0.0.0:${PORT}`));
