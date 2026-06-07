const { WebSocketServer } = require('ws');
const jwt                 = require('jsonwebtoken');
const { bybitGet }        = require('../lib/bybit');
const { pool }            = require('../lib/db');
const logger              = require('../lib/logger');

function setupWS(server, jwtSecret) {
  const wss = new WebSocketServer({ server, path: '/ws' });

  function parseCookie(cookieStr, name) {
    if (!cookieStr) return null;
    const m = cookieStr.split(';').find(c => c.trim().startsWith(name + '='));
    return m ? decodeURIComponent(m.trim().slice(name.length + 1)) : null;
  }

  wss.on('connection', (ws, req) => {
    const token = parseCookie(req.headers.cookie, 'wd_admin');
    try {
      const payload = jwt.verify(token, jwtSecret);
      if (payload.role !== 'admin') { ws.close(1008, 'Forbidden'); return; }
    } catch { ws.close(1008, 'Unauthorized'); return; }

    ws.isAlive = true;
    // Per-client topic subscriptions. Defaults to everything for backwards compat.
    ws.subs    = new Set(['live_data', 'bot_stats']);
    // Optional per-bot filter (Set<botId>); empty = receive all bots in bot_stats
    ws.botIds  = new Set();

    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('error', () => {});
    ws.on('message', raw => {
      try {
        const msg = JSON.parse(String(raw).slice(0, 2000));
        if (msg.type === 'subscribe' && Array.isArray(msg.topics)) {
          msg.topics.forEach(t => ws.subs.add(String(t)));
        } else if (msg.type === 'unsubscribe' && Array.isArray(msg.topics)) {
          msg.topics.forEach(t => ws.subs.delete(String(t)));
        } else if (msg.type === 'filter_bots' && Array.isArray(msg.botIds)) {
          ws.botIds = new Set(msg.botIds.map(Number).filter(Boolean));
        } else if (msg.type === 'filter_bots_clear') {
          ws.botIds = new Set();
        } else if (msg.type === 'ping') {
          try { ws.send(JSON.stringify({ type: 'pong', ts: Date.now() })); } catch {}
        }
      } catch {}
    });
    logger.info('[ws] client connected');
  });

  const pingHandle = setInterval(() => {
    wss.clients.forEach(ws => {
      if (!ws.isAlive) { ws.terminate(); return; }
      ws.isAlive = false;
      ws.ping();
    });
  }, 30_000);

  // Topic-aware broadcast. Clients only receive payloads they subscribed to.
  function broadcast(topic, payload, perClientTransform) {
    wss.clients.forEach(ws => {
      if (ws.readyState !== 1) return;
      if (ws.subs && !ws.subs.has(topic)) return;
      try {
        const out = perClientTransform ? perClientTransform(ws, payload) : payload;
        if (out === null || out === undefined) return;
        ws.send(JSON.stringify(out));
      } catch (e) {
        logger.warn({ err: e, topic }, '[ws] send failed');
      }
    });
  }

  async function broadcastLiveData() {
    if (wss.clients.size === 0) return;
    let liveSubscribers = 0;
    for (const ws of wss.clients) if (ws.subs?.has('live_data')) liveSubscribers++;
    if (liveSubscribers === 0) return;

    try {
      const [balRes, posRes, todayRes] = await Promise.allSettled([
        bybitGet('/v5/account/wallet-balance', { accountType: 'UNIFIED' }),
        bybitGet('/v5/position/list', { category: 'linear', settleCoin: 'USDT' }),
        bybitGet('/v5/position/closed-pnl', { category: 'linear', startTime: new Date().setHours(0,0,0,0).toString(), limit: '50' }),
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
            entryPrice: p.avgPrice, markPrice: p.markPrice || '', liqPrice: p.liqPrice,
            unrealisedPnl: parseFloat(p.unrealisedPnl).toFixed(2),
            leverage: p.leverage, takeProfit: p.takeProfit || '', stopLoss: p.stopLoss || '',
          }));
      }

      const unrealised = positions.reduce((s, p) => s + parseFloat(p.unrealisedPnl || 0), 0);
      let realisedToday = 0;
      if (todayRes.status === 'fulfilled' && todayRes.value?.retCode === 0)
        (todayRes.value.result?.list || []).forEach(p => { realisedToday += parseFloat(p.closedPnl || 0); });

      broadcast('live_data', {
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
      logger.error({ err: e }, '[ws] broadcast error');
    }
  }

  async function broadcastBotStats() {
    if (wss.clients.size === 0) return;
    let statsSubscribers = 0;
    for (const ws of wss.clients) if (ws.subs?.has('bot_stats')) statsSubscribers++;
    if (statsSubscribers === 0) return;

    try {
      const { rows } = await pool.query(`
        SELECT b.id, b.name, b.type, b.symbol, b.status, b.config, b.stats,
          b.exchange, b.subaccount_name, b.allocated_balance,
          b.last_tick_at, b.last_trade_at, b.last_error_msg, b.last_error_at,
          COALESCE(bt.trade_count,0) AS trade_count,
          COALESCE(bt.open_orders,0) AS open_orders
        FROM bots b
        LEFT JOIN (
          SELECT bot_id,
            COUNT(*)::int                              AS trade_count,
            COUNT(*) FILTER (WHERE status='open')::int AS open_orders
          FROM bot_trades
          GROUP BY bot_id
        ) bt ON bt.bot_id = b.id
        ORDER BY b.created_at DESC
      `);

      const fullPayload = { type: 'bot_stats', bots: rows };
      broadcast('bot_stats', fullPayload, (ws, payload) => {
        // If client filtered by botIds, slice the array — fewer bytes over the wire
        if (ws.botIds && ws.botIds.size > 0) {
          return { ...payload, bots: payload.bots.filter(b => ws.botIds.has(b.id)) };
        }
        return payload;
      });
    } catch (e) {
      logger.error({ err: e }, '[ws] bot_stats error');
    }
  }

  const liveHandle  = setInterval(broadcastLiveData,  5_000);
  const statsHandle = setInterval(broadcastBotStats, 10_000);
  logger.info('[ws] server ready');

  return () => {
    clearInterval(liveHandle);
    clearInterval(statsHandle);
    clearInterval(pingHandle);
    wss.clients.forEach(ws => { try { ws.close(1001, 'Server shutting down'); } catch {} });
    wss.close();
  };
}

module.exports = setupWS;
