const { Router } = require('express');
const axios      = require('axios');
const { bybitGet, bybitPost } = require('../lib/bybit');
const logger     = require('../lib/logger');
const { validate, z } = require('../lib/validate');

const numStr = z.union([z.string(), z.number()]).transform(v => parseFloat(v));

const setTpSlSchema = z.object({
  symbol: z.string().min(1).max(20),
  type:   z.enum(['TP', 'SL']),
  price:  numStr.refine(v => v > 0, 'price must be positive'),
});

const closePositionSchema = z.object({
  symbol: z.string().min(1).max(20),
  side:   z.enum(['Buy', 'Sell']),
  qty:    numStr.refine(v => v > 0, 'qty must be positive'),
});

const orderSchema = z.object({
  symbol:     z.string().min(1).max(20),
  side:       z.enum(['Buy', 'Sell']),
  orderType:  z.enum(['Market', 'Limit']),
  qty:        numStr.refine(v => v > 0, 'qty must be positive'),
  price:      numStr.refine(v => v > 0).optional(),
  stopLoss:   numStr.refine(v => v > 0).optional(),
  takeProfit: numStr.refine(v => v > 0).optional(),
  leverage:   z.number().int().min(1).max(200).optional(),
});

const router = Router();

router.get('/status', (req, res) => {
  const { API_KEY } = require('../lib/config');
  res.json({ ok: true, hasKeys: !!API_KEY, server: 'WaleszDesk v1.4' });
});

router.get('/balance', async (req, res) => {
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
    logger.error({ err }, '[balance]');
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/positions', async (req, res) => {
  try {
    const data = await bybitGet('/v5/position/list', { category: 'linear', settleCoin: 'USDT' });
    if (data.retCode !== 0) return res.status(400).json({ ok: false, error: data.retMsg });
    const positions = (data.result?.list || [])
      .filter(p => parseFloat(p.size) > 0)
      .map(p => ({
        exchange: 'bybit', symbol: p.symbol, side: p.side, size: p.size,
        entryPrice: p.avgPrice, markPrice: p.markPrice || '', liqPrice: p.liqPrice,
        unrealisedPnl: parseFloat(p.unrealisedPnl).toFixed(2),
        leverage: p.leverage, takeProfit: p.takeProfit || '', stopLoss: p.stopLoss || '',
      }));
    res.json({ ok: true, positions });
  } catch (err) {
    logger.error({ err }, '[positions]');
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/orders', async (req, res) => {
  try {
    const data = await bybitGet('/v5/order/history', { category: 'linear', limit: '20' });
    if (data.retCode !== 0) return res.status(400).json({ ok: false, error: data.retMsg });
    res.json({ ok: true, orders: data.result?.list || [] });
  } catch (err) {
    logger.error({ err }, '[orders]');
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/ticker', async (req, res) => {
  try {
    const symbol = (req.query.symbol || 'BTCUSDT').toUpperCase();
    const { data } = await axios.get('https://api.bybit.com/v5/market/tickers', {
      params: { category: 'linear', symbol },
    });
    const t = data.result?.list?.[0];
    if (!t) return res.status(404).json({ ok: false, error: 'Symbol not found' });
    res.json({ ok: true, symbol, markPrice: parseFloat(t.markPrice), lastPrice: parseFloat(t.lastPrice) });
  } catch (err) {
    logger.error({ err }, '[ticker]');
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/set-tpsl', validate(setTpSlSchema), async (req, res) => {
  try {
    const { symbol, type, price } = req.body;
    const params = { category: 'linear', symbol, positionIdx: 0, tpTriggerBy: 'MarkPrice', slTriggerBy: 'MarkPrice' };
    if (type === 'TP')      params.takeProfit = String(price);
    else if (type === 'SL') params.stopLoss   = String(price);
    else return res.status(400).json({ ok: false, error: 'type must be TP or SL' });
    logger.info({ symbol, type, price }, '[set-tpsl]');
    const data = await bybitPost('/v5/position/trading-stop', params);
    if (data.retCode !== 0) return res.status(400).json({ ok: false, error: data.retMsg });
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, '[set-tpsl]');
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/close-position', validate(closePositionSchema), async (req, res) => {
  try {
    const { symbol, side, qty } = req.body;
    const closeSide = side === 'Buy' ? 'Sell' : 'Buy';
    const qtyNum    = parseFloat(qty);
    const precision = symbol.startsWith('BTC') ? 3 : symbol.startsWith('ETH') ? 2 : 1;
    const factor    = Math.pow(10, precision);
    const qtyFloor  = Math.floor(qtyNum * factor) / factor;
    if (qtyFloor <= 0)
      return res.status(400).json({ ok: false, error: `Qty ${qty} is below minimum lot size for ${symbol}` });
    const order = {
      category: 'linear', symbol, side: closeSide, orderType: 'Market',
      qty: qtyFloor.toFixed(precision), timeInForce: 'IOC', reduceOnly: true, positionIdx: 0,
    };
    logger.info({ symbol, side, qty: order.qty }, '[close-position]');
    const data = await bybitPost('/v5/order/create', order);
    if (data.retCode !== 0) return res.status(400).json({ ok: false, error: data.retMsg });
    res.json({ ok: true, orderId: data.result?.orderId });
  } catch (err) {
    logger.error({ err }, '[close-position]');
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/order', validate(orderSchema), async (req, res) => {
  try {
    const { symbol, side, orderType, qty, price, stopLoss, takeProfit, leverage } = req.body;
    if (leverage)
      await bybitPost('/v5/position/set-leverage', { category: 'linear', symbol, buyLeverage: String(leverage), sellLeverage: String(leverage) });
    const qtyNum = parseFloat(qty);
    let qtyStr   = symbol.startsWith('BTC') ? qtyNum.toFixed(3) : symbol.startsWith('ETH') ? qtyNum.toFixed(2) : qtyNum.toFixed(1);
    qtyStr = parseFloat(qtyStr).toString();
    const order = { category: 'linear', symbol, side, orderType, qty: qtyStr, timeInForce: orderType === 'Market' ? 'IOC' : 'GTC' };
    if (orderType === 'Limit' && price) order.price      = String(price);
    if (stopLoss)   { order.stopLoss   = String(stopLoss);   order.slTriggerBy = 'LastPrice'; }
    if (takeProfit) { order.takeProfit = String(takeProfit); order.tpTriggerBy = 'LastPrice'; }
    logger.info({ symbol, side, orderType, qty: qtyStr }, '[order]');
    const data = await bybitPost('/v5/order/create', order);
    if (data.retCode !== 0) return res.status(400).json({ ok: false, error: data.retMsg });
    res.json({ ok: true, orderId: data.result?.orderId });
  } catch (err) {
    logger.error({ err }, '[order]');
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
