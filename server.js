/**
 * WaleszDesk — Bybit API Backend v1.3 (axios)
 * Uruchomienie: BYBIT_API_KEY=xxx BYBIT_API_SECRET=xxx node server.js
 */

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

const PORT = 3001;

const CONFIG = {
  apiKey:    process.env.BYBIT_API_KEY    || 'euTDVCQDzmfvN99sQz',
  apiSecret: process.env.BYBIT_API_SECRET || 'YEZ9Iy8CeigBPLwMIQIAXKR7dgTQgqWfX6XK',
  testnet:   process.env.BYBIT_TESTNET === 'true' || false,
};

const BASE = CONFIG.testnet ? 'https://api-testnet.bybit.com' : 'https://api.bybit.com';

function sign(payload) {
  return crypto.createHmac('sha256', CONFIG.apiSecret).update(payload).digest('hex');
}

async function apiGet(path, params = {}) {
  const ts  = Date.now().toString();
  const rw  = '5000';
  const qs  = Object.keys(params).sort().map(k => `${k}=${params[k]}`).join('&');
  const sig = sign(ts + CONFIG.apiKey + rw + qs);
  const url = `${BASE}${path}${qs ? '?' + qs : ''}`;
  console.log('GET', url);
  const res = await axios.get(url, {
    headers: {
      'X-BAPI-API-KEY':     CONFIG.apiKey,
      'X-BAPI-SIGN':        sig,
      'X-BAPI-TIMESTAMP':   ts,
      'X-BAPI-RECV-WINDOW': rw,
      'X-BAPI-SIGN-TYPE':   '2',
    }
  });
  console.log('RESPONSE:', JSON.stringify(res.data).slice(0, 200));
  return res.data;
}

async function apiPost(path, params = {}) {
  const ts   = Date.now().toString();
  const rw   = '5000';
  const body = JSON.stringify(params);
  const sig  = sign(ts + CONFIG.apiKey + rw + body);
  const url  = `${BASE}${path}`;
  console.log('POST', url, body);
  const res = await axios.post(url, params, {
    headers: {
      'X-BAPI-API-KEY':     CONFIG.apiKey,
      'X-BAPI-SIGN':        sig,
      'X-BAPI-TIMESTAMP':   ts,
      'X-BAPI-RECV-WINDOW': rw,
      'X-BAPI-SIGN-TYPE':   '2',
    }
  });
  console.log('RESPONSE:', JSON.stringify(res.data).slice(0, 200));
  return res.data;
}

// ─── ROUTES ──────────────────────────────────────────────────────

app.get('/status', (req, res) => {
  res.json({ ok: true, testnet: CONFIG.testnet, hasKeys: CONFIG.apiKey !== 'euTDVCQDzmfvN99sQz', server: 'WaleszDesk v1.3' });
});

app.get('/balance', async (req, res) => {
  try {
    let result = null;
    for (const accountType of ['UNIFIED', 'CONTRACT', 'SPOT']) {
      const data = await apiGet('/v5/account/wallet-balance', { accountType });
      if (data.retCode === 0) {
        const account = data.result?.list?.[0] || {};
        const coins   = account.coin || [];
        const usdt    = coins.find(c => c.coin === 'USDT');
        if (usdt) {
          console.log('✓ Saldo USDT w', accountType, ':', usdt.walletBalance);
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
    }
    if (!result) return res.status(400).json({ ok: false, error: 'Brak salda USDT. Sprawdz uprawnienia klucza.' });
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('Balance error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/positions', async (req, res) => {
  try {
    const data = await apiGet('/v5/position/list', { category: 'linear', settleCoin: 'USDT' });
    if (data.retCode !== 0) return res.status(400).json({ ok: false, error: data.retMsg });
    const positions = (data.result?.list || []).filter(p => parseFloat(p.size) > 0).map(p => ({
      symbol: p.symbol, side: p.side, size: p.size,
      entryPrice: p.avgPrice, liqPrice: p.liqPrice,
      unrealisedPnl: parseFloat(p.unrealisedPnl).toFixed(2), leverage: p.leverage,
    }));
    res.json({ ok: true, positions });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/order', async (req, res) => {
  try {
    const { symbol, side, orderType, qty, price, stopLoss, takeProfit, leverage } = req.body;
    if (!symbol || !side || !orderType || !qty)
      return res.status(400).json({ ok: false, error: 'Brakujace pola: symbol, side, orderType, qty' });

    if (leverage) {
      await apiPost('/v5/position/set-leverage', {
        category: 'linear', symbol,
        buyLeverage: String(leverage), sellLeverage: String(leverage),
      });
    }

    // Round qty properly for Bybit (BTC=3 decimals, others vary)
    const qtyNum = parseFloat(qty);
    let qtyStr;
    if (symbol.startsWith('BTC')) {
      qtyStr = qtyNum.toFixed(3);
    } else if (symbol.startsWith('ETH')) {
      qtyStr = qtyNum.toFixed(2);
    } else {
      qtyStr = qtyNum.toFixed(1);
    }
    // Remove trailing zeros but keep minimum precision
    qtyStr = parseFloat(qtyStr).toString();

    const orderParams = {
      category: 'linear', symbol, side, orderType,
      qty: qtyStr, timeInForce: orderType === 'Market' ? 'IOC' : 'GTC',
    };
    if (orderType === 'Limit' && price)  orderParams.price      = String(price);
    if (stopLoss)   { orderParams.stopLoss   = String(stopLoss);   orderParams.slTriggerBy = 'LastPrice'; }
    if (takeProfit) { orderParams.takeProfit = String(takeProfit); orderParams.tpTriggerBy = 'LastPrice'; }

    const data = await apiPost('/v5/order/create', orderParams);
    if (data.retCode !== 0) return res.status(400).json({ ok: false, error: `Bybit: ${data.retMsg}` });
    res.json({ ok: true, orderId: data.result?.orderId, message: `${side} ${qty} ${symbol} zlezone!` });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/orders', async (req, res) => {
  try {
    const data = await apiGet('/v5/order/history', { category: 'linear', limit: '20' });
    if (data.retCode !== 0) return res.status(400).json({ ok: false, error: data.retMsg });
    res.json({ ok: true, orders: data.result?.list || [] });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/status",(q,r)=>r.json({ok:true,server:"WaleszDesk"}));
app.listen(PORT, () => {
  console.log('');
  console.log('╔══════════════════════════════════════╗');
  console.log('║      WaleszDesk Backend v1.3         ║');
  console.log('╠══════════════════════════════════════╣');
  console.log(`║  Adres:   http://localhost:${PORT}       ║`);
  console.log(`║  Testnet: ${CONFIG.testnet ? 'TAK                  ' : 'NIE (live trading)   '}║`);
  console.log(`║  Klucze:  ${CONFIG.apiKey !== 'euTDVCQDzmfvN99sQz' ? 'skonfigurowane ✓     ' : 'BRAK!                '}║`);
  console.log('╚══════════════════════════════════════╝');
  console.log('');
});

// ─── PNL ENDPOINT ────────────────────────────────────────────────
app.get('/pnl', async (req, res) => {
  try {
    // Unrealised PnL from open positions
    const posData = await apiGet('/v5/position/list', { category: 'linear', settleCoin: 'USDT' });
    let unrealised = 0;
    if (posData.retCode === 0) {
      (posData.result?.list || []).forEach(p => {
        unrealised += parseFloat(p.unrealisedPnl || 0);
      });
    }

    // Realised PnL today from closed orders
    const today = new Date();
    today.setHours(0,0,0,0);
    const startMs = today.getTime().toString();

    const closedData = await apiGet('/v5/position/closed-pnl', {
      category: 'linear',
      startTime: startMs,
      limit: '50',
    });
    let realisedToday = 0;
    if (closedData.retCode === 0) {
      (closedData.result?.list || []).forEach(p => {
        realisedToday += parseFloat(p.closedPnl || 0);
      });
    }

    // All time realised PnL
    const allTimeData = await apiGet('/v5/position/closed-pnl', {
      category: 'linear',
      limit: '200',
    });
    let realisedAllTime = 0;
    if (allTimeData.retCode === 0) {
      (allTimeData.result?.list || []).forEach(p => {
        realisedAllTime += parseFloat(p.closedPnl || 0);
      });
    }

    res.json({
      ok: true,
      unrealised:      parseFloat(unrealised.toFixed(4)),
      realisedToday:   parseFloat(realisedToday.toFixed(4)),
      realisedAllTime: parseFloat(realisedAllTime.toFixed(4)),
      totalToday:      parseFloat((realisedToday + unrealised).toFixed(4)),
      totalAllTime:    parseFloat((realisedAllTime + unrealised).toFixed(4)),
    });
  } catch (err) {
    console.error('PnL error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});
