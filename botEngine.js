'use strict';
const axios  = require('axios');
const crypto = require('crypto');

const BASE_URL = process.env.BYBIT_TESTNET === 'true'
  ? 'https://api-testnet.bybit.com'
  : 'https://api.bybit.com';

module.exports = function startBotEngine({ pool, decrypt }) {
  const botLocks = new Set();

  // ── Precision helpers ──────────────────────────────────────────────────────
  function qtyPrec(sym)   { if (sym.startsWith('BTC')) return 3; if (sym.startsWith('ETH')) return 2; return 1; }
  function pricePrec(sym) { if (sym.startsWith('BTC')) return 1; return 2; }

  function calcQty(sym, usd, price) {
    const f = Math.pow(10, qtyPrec(sym));
    return Math.floor((usd / price) * f) / f;
  }
  function fmtQty(sym, qty)     { return qty.toFixed(qtyPrec(sym)); }
  function fmtPrice(sym, price) { return price.toFixed(pricePrec(sym)); }

  // ── Market data (public) ───────────────────────────────────────────────────
  async function getMarkPrice(sym) {
    const { data } = await axios.get(`${BASE_URL}/v5/market/tickers`, {
      params: { category: 'linear', symbol: sym },
    });
    const t = data.result?.list?.[0];
    return t ? parseFloat(t.markPrice) : null;
  }

  // ── Per-bot signed Bybit client ────────────────────────────────────────────
  function makeBotClient(apiKey, apiSecret) {
    function sign(payload) {
      return crypto.createHmac('sha256', apiSecret).update(payload).digest('hex');
    }
    async function botGet(endpoint, params = {}) {
      const ts  = Date.now().toString();
      const rw  = '20000';
      const qs  = Object.keys(params).sort().map(k => `${k}=${params[k]}`).join('&');
      const sig = sign(ts + apiKey + rw + qs);
      const res = await axios.get(`${BASE_URL}${endpoint}${qs ? '?' + qs : ''}`, {
        headers: { 'X-BAPI-API-KEY': apiKey, 'X-BAPI-SIGN': sig, 'X-BAPI-TIMESTAMP': ts, 'X-BAPI-RECV-WINDOW': rw, 'X-BAPI-SIGN-TYPE': '2' },
        timeout: 8000,
      });
      return res.data;
    }
    async function botPost(endpoint, params = {}) {
      const ts   = Date.now().toString();
      const rw   = '20000';
      const body = JSON.stringify(params);
      const sig  = sign(ts + apiKey + rw + body);
      const res  = await axios.post(`${BASE_URL}${endpoint}`, body, {
        headers: { 'X-BAPI-API-KEY': apiKey, 'X-BAPI-SIGN': sig, 'X-BAPI-TIMESTAMP': ts, 'X-BAPI-RECV-WINDOW': rw, 'X-BAPI-SIGN-TYPE': '2', 'Content-Type': 'application/json' },
        timeout: 8000,
      });
      return res.data;
    }
    return { botGet, botPost };
  }

  // ── Resolve per-bot keys (fallback to global env) ─────────────────────────
  function getBotClient(bot) {
    try {
      if (bot.api_key_enc && bot.api_secret_enc) {
        return makeBotClient(decrypt(bot.api_key_enc), decrypt(bot.api_secret_enc));
      }
    } catch (e) {
      console.error(`[bot:${bot.id}] key decrypt failed:`, e.message);
    }
    // Fallback to global keys
    const apiKey    = process.env.BYBIT_API_KEY;
    const apiSecret = process.env.BYBIT_API_SECRET;
    if (!apiKey || !apiSecret) return null;
    return makeBotClient(apiKey, apiSecret);
  }

  // ── Capital guard ─────────────────────────────────────────────────────────
  async function checkCapital(botGet, orderUsd) {
    for (const accountType of ['UNIFIED', 'CONTRACT']) {
      try {
        const d = await botGet('/v5/account/wallet-balance', { accountType });
        if (d.retCode !== 0) continue;
        const acc  = d.result?.list?.[0] || {};
        const usdt = (acc.coin || []).find(c => c.coin === 'USDT');
        const avail = usdt
          ? parseFloat(usdt.availableToWithdraw || usdt.walletBalance || 0)
          : parseFloat(acc.totalAvailableBalance || 0);
        if (avail > 0) return orderUsd <= avail * 0.5;
      } catch {}
    }
    return false;
  }

  // ── Bybit position / orders ────────────────────────────────────────────────
  async function getPosition(botGet, sym) {
    const d = await botGet('/v5/position/list', { category: 'linear', symbol: sym });
    if (d.retCode !== 0) return null;
    return (d.result?.list || []).find(p => parseFloat(p.size) > 0) || null;
  }

  async function getOpenOrders(botGet, sym) {
    const d = await botGet('/v5/order/realtime', { category: 'linear', symbol: sym });
    if (d.retCode !== 0) return [];
    return d.result?.list || [];
  }

  async function placeOrder(botPost, { symbol, side, qty, price, reduceOnly }) {
    const params = {
      category: 'linear', symbol, side,
      orderType:   price ? 'Limit' : 'Market',
      qty:         fmtQty(symbol, qty),
      timeInForce: price ? 'GTC' : 'IOC',
    };
    if (price)      params.price      = fmtPrice(symbol, price);
    if (reduceOnly) params.reduceOnly = true;
    const d = await botPost('/v5/order/create', params);
    if (d.retCode !== 0) throw new Error(`Bybit: ${d.retMsg}`);
    return d.result?.orderId;
  }

  // ── DB helpers ────────────────────────────────────────────────────────────
  async function setBotStatus(id, status, msg) {
    await pool.query(
      `UPDATE bots SET status=$1, stats=stats||$2::jsonb, updated_at=NOW() WHERE id=$3`,
      [status, JSON.stringify({ status_msg: msg || status }), id]
    );
  }

  async function saveState(id, cfg) {
    await pool.query(
      `UPDATE bots SET config=$1, updated_at=NOW() WHERE id=$2`,
      [JSON.stringify(cfg), id]
    );
  }

  async function mergeStats(id, delta) {
    const { rows } = await pool.query(`SELECT stats FROM bots WHERE id=$1`, [id]);
    if (!rows.length) return;
    const s = rows[0].stats || {};
    await pool.query(
      `UPDATE bots SET stats=$1, updated_at=NOW() WHERE id=$2`,
      [JSON.stringify({
        ...s,
        total_pnl:      (parseFloat(s.total_pnl      || 0) + (delta.total_pnl      || 0)),
        trades:         (parseInt(  s.trades          || 0) + (delta.trades         || 0)),
        unrealised_pnl: delta.unrealised_pnl !== undefined ? delta.unrealised_pnl : parseFloat(s.unrealised_pnl || 0),
      }), id]
    );
  }

  async function recordTrade(botId, { orderId, side, qty, price, status = 'open', meta = {} }) {
    await pool.query(
      `INSERT INTO bot_trades (bot_id,order_id,side,qty,price,status,meta) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [botId, orderId, side, qty, price, status, JSON.stringify(meta)]
    );
  }

  // ── DCA Bot ───────────────────────────────────────────────────────────────
  async function tickDca(bot, { botGet, botPost }) {
    const cfg     = bot.config;
    const state   = cfg.state || {};
    const sym     = cfg.symbol;
    const isShort = cfg.side === 'SHORT';
    const enter   = isShort ? 'Sell' : 'Buy';
    const exit    = isShort ? 'Buy'  : 'Sell';

    const price = await getMarkPrice(sym);
    if (!price) return;

    const pos      = await getPosition(botGet, sym);
    const posSize  = pos ? parseFloat(pos.size)          : 0;
    const avgEntry = pos ? parseFloat(pos.avgPrice)      : 0;
    const unreal   = pos ? parseFloat(pos.unrealisedPnl) : 0;

    await mergeStats(bot.id, { unrealised_pnl: unreal });

    if (!posSize) {
      if (state.base_order_placed) {
        // Position closed externally — reset cycle
        state.base_order_placed    = false;
        state.safety_orders_placed = 0;
        state.initial_entry        = null;
        await saveState(bot.id, { ...cfg, state });
        return;
      }
      if (!(await checkCapital(botGet, cfg.base_order_size))) {
        await setBotStatus(bot.id, 'paused', 'Insufficient capital (>50% balance)');
        return;
      }
      const qty = calcQty(sym, cfg.base_order_size, price);
      if (qty <= 0) return;
      const orderId = await placeOrder(botPost, { symbol: sym, side: enter, qty });
      await recordTrade(bot.id, { orderId, side: enter, qty, price, status: 'filled', meta: { type: 'base' } });
      state.base_order_placed    = true;
      state.safety_orders_placed = 0;
      state.initial_entry        = price;
      state.last_safety_ts       = 0;
      await saveState(bot.id, { ...cfg, state });
      console.log(`[dca:${bot.id}] base @ ~${price} qty=${qty}`);
      return;
    }

    // Position open — check TP
    const pnlPct = isShort
      ? (avgEntry - price) / avgEntry * 100
      : (price - avgEntry) / avgEntry * 100;

    if (pnlPct >= cfg.take_profit) {
      const orderId = await placeOrder(botPost, { symbol: sym, side: exit, qty: posSize, reduceOnly: true });
      await recordTrade(bot.id, { orderId, side: exit, qty: posSize, price, status: 'filled', meta: { type: 'tp', pnl: unreal } });
      await mergeStats(bot.id, { total_pnl: unreal, trades: 1, unrealised_pnl: 0 });
      state.base_order_placed    = false;
      state.safety_orders_placed = 0;
      state.initial_entry        = null;
      await saveState(bot.id, { ...cfg, state });
      console.log(`[dca:${bot.id}] TP @ ${pnlPct.toFixed(2)}% pnl=$${unreal.toFixed(2)}`);
      return;
    }

    // Safety order check
    const placed = state.safety_orders_placed || 0;
    if (placed >= cfg.max_safety_orders) return;
    if (Date.now() - (state.last_safety_ts || 0) < 30_000) return;

    const initEntry = state.initial_entry || avgEntry;
    const dev       = (placed + 1) * cfg.price_deviation / 100;
    const trigger   = isShort ? initEntry * (1 + dev) : initEntry * (1 - dev);
    if (isShort ? price < trigger : price > trigger) return;

    if (!(await checkCapital(botGet, cfg.safety_order_size))) {
      await setBotStatus(bot.id, 'paused', 'Insufficient capital for safety order');
      return;
    }
    const qty = calcQty(sym, cfg.safety_order_size, price);
    if (qty <= 0) return;
    const orderId = await placeOrder(botPost, { symbol: sym, side: enter, qty });
    await recordTrade(bot.id, { orderId, side: enter, qty, price, status: 'filled', meta: { type: 'safety', n: placed + 1 } });
    state.safety_orders_placed = placed + 1;
    state.last_safety_ts       = Date.now();
    await saveState(bot.id, { ...cfg, state });
    console.log(`[dca:${bot.id}] safety #${state.safety_orders_placed} @ ~${price} qty=${qty}`);
  }

  // ── Grid Bot ──────────────────────────────────────────────────────────────
  async function tickGrid(bot, { botGet, botPost }) {
    const cfg   = bot.config;
    const state = cfg.state || {};
    const sym   = cfg.symbol;

    const price = await getMarkPrice(sym);
    if (!price) return;

    if (!state.grid_prices || !state.grid_prices.length) {
      const step = (cfg.upper_price - cfg.lower_price) / cfg.grid_levels;
      state.grid_prices = Array.from({ length: cfg.grid_levels + 1 }, (_, i) =>
        parseFloat((cfg.lower_price + step * i).toFixed(pricePrec(sym)))
      );
    }

    const step = parseFloat(((cfg.upper_price - cfg.lower_price) / cfg.grid_levels).toFixed(pricePrec(sym)));

    if (!state.initialized) {
      if (!(await checkCapital(botGet, cfg.order_size))) {
        await setBotStatus(bot.id, 'paused', 'Insufficient capital for grid init');
        return;
      }
      for (const lvl of state.grid_prices) {
        if (lvl <= cfg.lower_price || lvl >= cfg.upper_price) continue;
        const side = lvl < price ? 'Buy' : 'Sell';
        const qty  = calcQty(sym, cfg.order_size, lvl);
        if (qty <= 0) continue;
        try {
          const orderId = await placeOrder(botPost, { symbol: sym, side, qty, price: lvl });
          await recordTrade(bot.id, { orderId, side, qty, price: lvl, status: 'open', meta: { type: 'grid', level: lvl, step } });
        } catch (e) {
          console.error(`[grid:${bot.id}] init @ ${lvl} failed:`, e.message);
        }
      }
      state.initialized = true;
      await saveState(bot.id, { ...cfg, state });
      console.log(`[grid:${bot.id}] initialized`);
      return;
    }

    const liveIds = new Set((await getOpenOrders(botGet, sym)).map(o => o.orderId));
    const { rows: openTrades } = await pool.query(
      `SELECT * FROM bot_trades WHERE bot_id=$1 AND status='open'`, [bot.id]
    );

    for (const trade of openTrades) {
      if (liveIds.has(trade.order_id)) continue;
      await pool.query(`UPDATE bot_trades SET status='filled' WHERE id=$1`, [trade.id]);

      const fp    = parseFloat(trade.price);
      const fq    = parseFloat(trade.qty);
      const meta  = trade.meta || {};
      const tStep = parseFloat(meta.step) || step;
      const isBuy = trade.side === 'Buy';
      const newP  = parseFloat((isBuy ? fp + tStep : fp - tStep).toFixed(pricePrec(sym)));
      const newS  = isBuy ? 'Sell' : 'Buy';

      if (newP > cfg.lower_price && newP < cfg.upper_price && (await checkCapital(botGet, cfg.order_size))) {
        try {
          const qty = calcQty(sym, cfg.order_size, newP);
          if (qty > 0) {
            const orderId = await placeOrder(botPost, { symbol: sym, side: newS, qty, price: newP });
            await recordTrade(bot.id, { orderId, side: newS, qty, price: newP, status: 'open', meta: { type: 'grid', level: newP, step: tStep } });
            const profit = isBuy ? (newP - fp) * fq : (fp - newP) * fq;
            await mergeStats(bot.id, { total_pnl: profit, trades: 1 });
            console.log(`[grid:${bot.id}] ${trade.side}@${fp}→${newS}@${newP} ~$${profit.toFixed(4)}`);
          }
        } catch (e) {
          console.error(`[grid:${bot.id}] replenish @ ${newP} failed:`, e.message);
        }
      }
    }
  }

  // ── Engine loop ───────────────────────────────────────────────────────────
  async function tick() {
    let bots;
    try {
      const { rows } = await pool.query(`SELECT * FROM bots WHERE status='active'`);
      bots = rows;
    } catch (e) {
      console.error('[botEngine] DB error:', e.message);
      return;
    }
    for (const bot of bots) {
      if (botLocks.has(bot.id)) continue;
      const client = getBotClient(bot);
      if (!client) {
        await setBotStatus(bot.id, 'error', 'No API keys configured').catch(() => {});
        continue;
      }
      botLocks.add(bot.id);
      (bot.type === 'dca' ? tickDca(bot, client) : tickGrid(bot, client))
        .catch(e => {
          console.error(`[bot:${bot.id}] uncaught:`, e.message);
          setBotStatus(bot.id, 'error', e.message).catch(() => {});
        })
        .finally(() => botLocks.delete(bot.id));
    }
  }

  setInterval(tick, 10_000);
  console.log('[botEngine] started');
};
