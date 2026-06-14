'use strict';
const { Router }               = require('express');
const crypto                   = require('crypto');
const { pool }                 = require('../lib/db');
const { decrypt }              = require('../lib/crypto');
const { createExchangeClient } = require('../exchanges');
const { validate, z }          = require('../lib/validate');
const { sendTelegram, escapeHtml } = require('../lib/telegram');
const logger                   = require('../lib/logger');

const router = Router();

const tvSchema = z.object({
  secret:  z.string().min(8).max(128),
  action:  z.enum(['buy', 'sell', 'close']),
  symbol:  z.string().min(1).max(20).optional(),
  qty_usd: z.number().positive().max(1_000_000).optional(),
});

function qtyPrec(sym) {
  if (sym.startsWith('BTC')) return 3;
  if (sym.startsWith('ETH')) return 2;
  return 1;
}
function calcQty(sym, usd, price) {
  const f = Math.pow(10, qtyPrec(sym));
  return Math.floor((usd / price) * f) / f;
}

function timingSafeEq(a, b) {
  const ab = Buffer.from(a || '', 'utf8');
  const bb = Buffer.from(b || '', 'utf8');
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// POST /api/webhook/tv/:botId — TradingView (or any HTTP client) entry point
router.post('/tv/:botId', validate(tvSchema), async (req, res) => {
  const botId = parseInt(req.params.botId, 10);
  if (!Number.isFinite(botId)) return res.status(400).json({ ok: false, error: 'Bad botId' });
  const { secret, action, symbol: bodySymbol, qty_usd } = req.body;

  let bot;
  try {
    const { rows } = await pool.query(`SELECT * FROM bots WHERE id=$1`, [botId]);
    bot = rows[0];
  } catch (e) {
    logger.error({ err: e, botId }, '[webhook] DB lookup failed');
    return res.status(500).json({ ok: false, error: 'DB error' });
  }

  // Always return 401 on missing bot OR missing secret OR mismatch — don't leak which.
  if (!bot || !bot.webhook_secret || !timingSafeEq(secret, bot.webhook_secret)) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  // Webhook on inactive bot: acknowledge but do not execute (prevents TradingView from
  // hammering the endpoint with retries when the user has manually paused the bot).
  if (bot.status !== 'active') {
    logger.info({ botId, status: bot.status }, '[webhook] bot not active — acked, skipped');
    return res.json({ ok: true, executed: false, reason: 'bot not active' });
  }
  if (!bot.api_key_enc || !bot.api_secret_enc) {
    return res.status(409).json({ ok: false, error: 'Bot has no API keys' });
  }

  const symbol = bodySymbol || bot.symbol;

  let client;
  try {
    const apiKey     = decrypt(bot.api_key_enc);
    const apiSecret  = decrypt(bot.api_secret_enc);
    const passphrase = bot.api_passphrase_enc ? decrypt(bot.api_passphrase_enc) : undefined;
    client = createExchangeClient(bot.exchange || 'bybit', apiKey, apiSecret, passphrase);
  } catch (e) {
    logger.error({ botId, err: e }, '[webhook] key decrypt failed');
    return res.status(500).json({ ok: false, error: 'Key decrypt failed' });
  }

  try {
    let orderId = null, qty = 0, price = 0, side = null;

    if (action === 'close') {
      const positions = await client.getPositions();
      const pos = positions.find(p => p.symbol === symbol);
      if (!pos || !parseFloat(pos.size)) {
        return res.json({ ok: true, executed: false, reason: 'no open position' });
      }
      qty   = parseFloat(pos.size);
      price = parseFloat(pos.markPrice || pos.entryPrice);
      side  = pos.side;
      const result = await client.closePosition(symbol, side, qty);
      orderId = result?.orderId || null;
    } else {
      const ticker = await client.getTicker(symbol);
      price = ticker.markPrice || ticker.lastPrice;
      if (!price) throw new Error('No ticker price');
      const usd = qty_usd || parseFloat(bot.config?.base_order_size || 0);
      if (!usd) return res.status(400).json({ ok: false, error: 'qty_usd missing and bot has no base_order_size' });
      qty = calcQty(symbol, usd, price);
      if (qty <= 0) return res.status(400).json({ ok: false, error: 'Computed qty <= 0' });
      side = action === 'buy' ? 'Buy' : 'Sell';
      const result = await client.placeOrder({ symbol, side, type: 'Market', qty });
      orderId = result?.orderId || null;
    }

    await pool.query(
      `INSERT INTO bot_trades (bot_id, order_id, side, qty, price, status, meta)
       VALUES ($1,$2,$3,$4,$5,'filled',$6)`,
      [botId, orderId, side, qty, price, JSON.stringify({ type: 'webhook', source: 'tradingview', action })]
    ).catch(err => logger.warn({ err }, '[webhook] trade log insert failed'));

    await pool.query(`UPDATE bots SET last_trade_at=NOW() WHERE id=$1`, [botId]).catch(() => {});

    sendTelegram(
      `🔔 <b>${escapeHtml(bot.name || 'Bot ' + bot.id)}</b> — WEBHOOK (TradingView)\n` +
      `${escapeHtml(symbol)} ${escapeHtml(action.toUpperCase())} · ${qty} @ $${Number(price).toFixed(2)}`
    );
    logger.info({ botId, action, symbol, qty, price, orderId }, '[webhook] executed');

    res.json({ ok: true, executed: true, orderId, action, symbol, qty, price });
  } catch (e) {
    logger.error({ botId, err: e }, '[webhook] execution failed');
    sendTelegram(
      `🚨 <b>${escapeHtml(bot.name || 'Bot ' + bot.id)}</b> — WEBHOOK BŁĄD\n${escapeHtml(e.message || 'unknown')}`
    );
    res.status(500).json({ ok: false, error: 'Execution failed: ' + (e.message || 'unknown') });
  }
});

module.exports = router;
