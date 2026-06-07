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
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('error', () => {});
    logger.info('[ws] client connected');
  });

  const pingHandle = setInterval(() => {
    wss.clients.forEach(ws => {
      if (!ws.isAlive) { ws.terminate(); return; }
      ws.isAlive = false;
      ws.ping();
    });
  }, 30_000);

  function broadcast(payload) {
    const msg = JSON.stringify(payload);
    wss.clients.forEach(ws => {
      if (ws.readyState !== 1) return;
      try { ws.send(msg); } catch (e) { logger.warn({ err: e }, '[ws] send failed'); }
    });
  }

  async function broadcastLiveData() {
    if (wss.clients.size === 0) return;
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

      broadcast({
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
    try {
      const { rows } = await pool.query(`
        SELECT b.id, b.name, b.type, b.symbol, b.status, b.config, b.stats,
          b.exchange, b.subaccount_name, b.allocated_balance,
          COUNT(bt.id)::int                                          AS trade_count,
          COUNT(bt.id) FILTER (WHERE bt.status='open')::int         AS open_orders
        FROM bots b
        LEFT JOIN bot_trades bt ON bt.bot_id = b.id
        GROUP BY b.id
        ORDER BY b.created_at DESC
      `);
      broadcast({ type: 'bot_stats', bots: rows });
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
