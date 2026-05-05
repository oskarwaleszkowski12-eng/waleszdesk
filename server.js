const express = require('express');
const cors    = require('cors');
const crypto  = require('crypto');
const axios   = require('axios');
const path    = require('path');

const app = express();
app.use(express.json());
app.use(cors({ origin: '*' }));
app.use(express.static(path.join(__dirname)));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

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
        symbol: p.symbol, side: p.side, size: p.size,
        entryPrice: p.avgPrice, liqPrice: p.liqPrice,
        unrealisedPnl: parseFloat(p.unrealisedPnl).toFixed(2), leverage: p.leverage,
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

app.listen(PORT, '0.0.0.0', () => console.log(`WaleszDesk running on 0.0.0.0:${PORT}`));
