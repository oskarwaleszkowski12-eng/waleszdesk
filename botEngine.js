'use strict';
const { createExchangeClient } = require('./exchanges');
const logger                   = require('./lib/logger');
const { sendTelegram, escapeHtml } = require('./lib/telegram');

let _engineStarted = false;

module.exports = function startBotEngine({ pool, decrypt }) {
  if (_engineStarted) { logger.warn('[botEngine] already started — skipping duplicate start'); return; }
  _engineStarted = true;

  const botLocks = new Set();

  // ── Precision helpers ──────────────────────────────────────────────────────
  function qtyPrec(sym)   { if (sym.startsWith('BTC')) return 3; if (sym.startsWith('ETH')) return 2; return 1; }
  function pricePrec(sym) { if (sym.startsWith('BTC')) return 1; return 2; }

  function calcQty(sym, usd, price) {
    const f = Math.pow(10, qtyPrec(sym));
    return Math.floor((usd / price) * f) / f;
  }
  function fmtQty(sym, qty)     { return parseFloat(qty.toFixed(qtyPrec(sym))); }
  function fmtPrice(sym, price) { return parseFloat(price.toFixed(pricePrec(sym))); }

  // ── Build exchange client for bot ─────────────────────────────────────────
  function getBotClient(bot) {
    try {
      if (bot.api_key_enc && bot.api_secret_enc) {
        const apiKey     = decrypt(bot.api_key_enc);
        const apiSecret  = decrypt(bot.api_secret_enc);
        const passphrase = bot.api_passphrase_enc ? decrypt(bot.api_passphrase_enc) : undefined;
        return createExchangeClient(bot.exchange || 'bybit', apiKey, apiSecret, passphrase);
      }
    } catch (e) {
      logger.error({ botId: bot.id, err: e }, '[botEngine] key decrypt failed — bot will be set to error');
    }
    // No fallback to global keys — a decrypt failure means we don't know whose account to trade
    return null;
  }

  // ── Capital guard ─────────────────────────────────────────────────────────
  async function checkCapital(client, orderUsd) {
    try {
      const { available } = await client.getBalance();
      return orderUsd <= available * 0.5;
    } catch { return false; }
  }

  // ── Position helpers ──────────────────────────────────────────────────────
  async function getPosition(client, sym) {
    const positions = await client.getPositions();
    return positions.find(p => p.symbol === sym) || null;
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
    // Atomic read-modify-write using SQL jsonb operators — avoids race condition
    await pool.query(
      `UPDATE bots SET
         stats = jsonb_set(
           jsonb_set(
             jsonb_set(stats, '{total_pnl}',      to_jsonb(COALESCE((stats->>'total_pnl')::float,0)      + $2::float)),
             '{trades}',         to_jsonb(COALESCE((stats->>'trades')::int,0)          + $3::int)
           ),
           '{unrealised_pnl}',   CASE WHEN $4::boolean THEN to_jsonb($5::float) ELSE stats->'unrealised_pnl' END
         ),
         updated_at = NOW()
       WHERE id=$1`,
      [id,
       delta.total_pnl      || 0,
       delta.trades         || 0,
       delta.unrealised_pnl !== undefined,
       delta.unrealised_pnl !== undefined ? delta.unrealised_pnl : 0]
    );
  }

  async function recordTrade(botId, { orderId, side, qty, price, status = 'open', meta = {} }) {
    await pool.query(
      `INSERT INTO bot_trades (bot_id,order_id,side,qty,price,status,meta) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [botId, orderId || null, side, qty, price, status, JSON.stringify(meta)]
    );
  }

  // ── DCA Bot ───────────────────────────────────────────────────────────────
  async function tickDca(bot, client) {
    const cfg     = bot.config;
    const state   = cfg.state || {};
    const sym     = cfg.symbol;
    const isShort = cfg.side === 'SHORT';
    const enter   = isShort ? 'Sell' : 'Buy';
    const exit    = isShort ? 'Buy'  : 'Sell';

    const ticker = await client.getTicker(sym);
    const price  = ticker.markPrice;
    if (!price) return;

    const pos      = await getPosition(client, sym);
    const posSize  = pos ? pos.size          : 0;
    const avgEntry = pos ? pos.entryPrice    : 0;
    const unreal   = pos ? pos.unrealisedPnl : 0;

    await mergeStats(bot.id, { unrealised_pnl: unreal });

    if (!posSize) {
      if (state.base_order_placed) {
        // Position was closed externally — reset cycle
        state.base_order_placed    = false;
        state.safety_orders_placed = 0;
        state.initial_entry        = null;
        await saveState(bot.id, { ...cfg, state });
        return;
      }
      if (!(await checkCapital(client, cfg.base_order_size))) {
        await setBotStatus(bot.id, 'paused', 'Insufficient capital (>50% balance)');
        sendTelegram(`⏸️ <b>${escapeHtml(bot.name || 'Bot '+bot.id)}</b> — AUTO-PAUZA\nInsufficient capital (>50% balance)`);
        return;
      }
      const qty = fmtQty(sym, calcQty(sym, cfg.base_order_size, price));
      if (qty <= 0) return;
      const result = await client.placeOrder({ symbol: sym, side: enter, type: 'Market', qty });
      const orderId = result?.orderId || null;
      // Save state before recording trade so a crash doesn't place a second base order
      state.base_order_placed    = true;
      state.safety_orders_placed = 0;
      state.initial_entry        = price;
      state.last_safety_ts       = 0;
      await saveState(bot.id, { ...cfg, state });
      await recordTrade(bot.id, { orderId, side: enter, qty, price, status: 'filled', meta: { type: 'base' } });
      logger.info({ botId: bot.id, price, qty }, '[dca] base order placed');
      sendTelegram(`📈 <b>${escapeHtml(bot.name || 'Bot '+bot.id)}</b> — WEJŚCIE\n${escapeHtml(sym)} ${enter} @ $${price.toFixed(2)} · ${qty} kontraktów`);
      return;
    }

    // Position open — check TP
    const pnlPct = isShort
      ? (avgEntry - price) / avgEntry * 100
      : (price - avgEntry) / avgEntry * 100;

    if (pnlPct >= cfg.take_profit) {
      const result = await client.closePosition(sym, enter, posSize);
      const orderId = result?.orderId || null;
      await mergeStats(bot.id, { total_pnl: unreal, trades: 1, unrealised_pnl: 0 });
      state.base_order_placed    = false;
      state.safety_orders_placed = 0;
      state.initial_entry        = null;
      await saveState(bot.id, { ...cfg, state });
      await recordTrade(bot.id, { orderId, side: exit, qty: posSize, price, status: 'filled', meta: { type: 'tp', pnl: unreal } });
      logger.info({ botId: bot.id, pnlPct: pnlPct.toFixed(2), pnl: unreal.toFixed(2) }, '[dca] TP hit');
      sendTelegram(`✅ <b>${escapeHtml(bot.name || 'Bot '+bot.id)}</b> — TP HIT\n${escapeHtml(sym)} +${pnlPct.toFixed(2)}% / $${unreal.toFixed(2)}`);
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

    if (!(await checkCapital(client, cfg.safety_order_size))) {
      await setBotStatus(bot.id, 'paused', 'Insufficient capital for safety order');
      sendTelegram(`⏸️ <b>${escapeHtml(bot.name || 'Bot '+bot.id)}</b> — AUTO-PAUZA\nInsufficient capital for safety order`);
      return;
    }
    const qty = fmtQty(sym, calcQty(sym, cfg.safety_order_size, price));
    if (qty <= 0) return;
    const result2 = await client.placeOrder({ symbol: sym, side: enter, type: 'Market', qty });
    const orderId2 = result2?.orderId || null;
    await recordTrade(bot.id, { orderId: orderId2, side: enter, qty, price, status: 'filled', meta: { type: 'safety', n: placed + 1 } });
    state.safety_orders_placed = placed + 1;
    state.last_safety_ts       = Date.now();
    await saveState(bot.id, { ...cfg, state });
    logger.info({ botId: bot.id, n: state.safety_orders_placed, price, qty }, '[dca] safety order placed');
  }

  // ── Grid Bot ──────────────────────────────────────────────────────────────
  async function tickGrid(bot, client) {
    const cfg   = bot.config;
    const state = cfg.state || {};
    const sym   = cfg.symbol;

    const ticker = await client.getTicker(sym);
    const price  = ticker.markPrice;
    if (!price) return;

    if (!state.grid_prices || !state.grid_prices.length) {
      const step = (cfg.upper_price - cfg.lower_price) / cfg.grid_levels;
      state.grid_prices = Array.from({ length: cfg.grid_levels + 1 }, (_, i) =>
        parseFloat((cfg.lower_price + step * i).toFixed(pricePrec(sym)))
      );
    }

    const step = parseFloat(((cfg.upper_price - cfg.lower_price) / cfg.grid_levels).toFixed(pricePrec(sym)));

    if (!state.initialized) {
      if (!(await checkCapital(client, cfg.order_size))) {
        await setBotStatus(bot.id, 'paused', 'Insufficient capital for grid init');
        sendTelegram(`⏸️ <b>${escapeHtml(bot.name || 'Bot '+bot.id)}</b> — AUTO-PAUZA\nInsufficient capital for grid init`);
        return;
      }
      for (const lvl of state.grid_prices) {
        if (lvl <= cfg.lower_price || lvl >= cfg.upper_price) continue;
        const side = lvl < price ? 'Buy' : 'Sell';
        const qty  = fmtQty(sym, calcQty(sym, cfg.order_size, lvl));
        if (qty <= 0) continue;
        try {
          const result = await client.placeOrder({ symbol: sym, side, type: 'Limit', qty, price: fmtPrice(sym, lvl) });
          const orderId = result?.orderId || null;
          await recordTrade(bot.id, { orderId, side, qty, price: lvl, status: 'open', meta: { type: 'grid', level: lvl, step } });
        } catch (e) {
          logger.error({ botId: bot.id, lvl, err: e }, '[grid] init order failed');
        }
      }
      state.initialized = true;
      await saveState(bot.id, { ...cfg, state });
      logger.info({ botId: bot.id }, '[grid] initialized');
      return;
    }

    const openOrders = await client.getOpenOrders(sym);
    const liveIds    = new Set(openOrders.map(o => String(o.orderId)));
    const { rows: openTrades } = await pool.query(
      `SELECT * FROM bot_trades WHERE bot_id=$1 AND status='open'`, [bot.id]
    );

    for (const trade of openTrades) {
      if (liveIds.has(String(trade.order_id))) continue;

      // Verify order actually filled (not just cancelled) before acting
      let filled = true;
      try {
        const orderStatus = await client.getOrderStatus(sym, String(trade.order_id));
        if (orderStatus && orderStatus.status !== 'Filled') filled = false;
      } catch { /* if check fails, assume filled to avoid stalling the grid */ }

      if (!filled) {
        await pool.query(`UPDATE bot_trades SET status='cancelled' WHERE id=$1`, [trade.id]);
        continue;
      }

      await pool.query(`UPDATE bot_trades SET status='filled' WHERE id=$1`, [trade.id]);

      const fp    = parseFloat(trade.price);
      const fq    = parseFloat(trade.qty);
      const meta  = trade.meta || {};
      const tStep = parseFloat(meta.step) || step;
      const isBuy = trade.side === 'Buy';
      const newP  = parseFloat((isBuy ? fp + tStep : fp - tStep).toFixed(pricePrec(sym)));
      const newS  = isBuy ? 'Sell' : 'Buy';

      if (newP > cfg.lower_price && newP < cfg.upper_price && (await checkCapital(client, cfg.order_size))) {
        try {
          const qty = fmtQty(sym, calcQty(sym, cfg.order_size, newP));
          if (qty > 0) {
            const result = await client.placeOrder({ symbol: sym, side: newS, type: 'Limit', qty, price: fmtPrice(sym, newP) });
            const orderId = result?.orderId || null;
            await recordTrade(bot.id, { orderId, side: newS, qty, price: newP, status: 'open', meta: { type: 'grid', level: newP, step: tStep } });
            const profit = isBuy ? (newP - fp) * fq : (fp - newP) * fq;
            await mergeStats(bot.id, { total_pnl: profit, trades: 1 });
            logger.info({ botId: bot.id, from: `${trade.side}@${fp}`, to: `${newS}@${newP}`, profit: profit.toFixed(4) }, '[grid] order filled');
          }
        } catch (e) {
          logger.error({ botId: bot.id, newP, err: e }, '[grid] replenish failed');
        }
      }
    }
  }

  // ── Engine loop ───────────────────────────────────────────────────────────
  async function tick() {
    let bots;
    try {
      const { rows } = await pool.query(`SELECT * FROM bots WHERE status='active' LIMIT 100`);
      bots = rows;
    } catch (e) {
      logger.error({ err: e }, '[botEngine] DB error');
      return;
    }

    let running = 0;
    for (const bot of bots) {
      if (botLocks.has(bot.id)) continue;
      if (running >= 10) break;
      const client = getBotClient(bot);
      if (!client) {
        await setBotStatus(bot.id, 'error', 'No API keys or decrypt failed').catch(() => {});
        continue;
      }
      botLocks.add(bot.id);
      running++;
      (bot.type === 'dca' ? tickDca(bot, client) : tickGrid(bot, client))
        .catch(e => {
          logger.error({ botId: bot.id, err: e }, '[botEngine] uncaught tick error');
          setBotStatus(bot.id, 'error', e.message).catch(() => {});
          sendTelegram(`🚨 <b>${escapeHtml(bot.name || 'Bot '+bot.id)}</b> — BŁĄD\n${escapeHtml(e.message)}`);
        })
        .finally(() => { botLocks.delete(bot.id); running--; });
    }
  }

  setInterval(tick, 10_000);
  logger.info('[botEngine] started');
};
