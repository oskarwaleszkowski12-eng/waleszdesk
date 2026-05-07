'use strict';
const axios  = require('axios');
const crypto = require('crypto');

const BASE = process.env.BYBIT_TESTNET === 'true'
  ? 'https://api-testnet.bybit.com'
  : 'https://api.bybit.com';

class BybitClient {
  constructor(apiKey, apiSecret) {
    this.apiKey    = apiKey;
    this.apiSecret = apiSecret;
  }

  _sign(payload) {
    return crypto.createHmac('sha256', this.apiSecret).update(payload).digest('hex');
  }

  async _get(endpoint, params = {}) {
    const ts  = Date.now().toString();
    const rw  = '20000';
    const qs  = Object.keys(params).sort().map(k => `${k}=${params[k]}`).join('&');
    const sig = this._sign(ts + this.apiKey + rw + qs);
    const res = await axios.get(`${BASE}${endpoint}${qs ? '?' + qs : ''}`, {
      headers: { 'X-BAPI-API-KEY': this.apiKey, 'X-BAPI-SIGN': sig, 'X-BAPI-TIMESTAMP': ts, 'X-BAPI-RECV-WINDOW': rw, 'X-BAPI-SIGN-TYPE': '2' },
      timeout: 8000,
    });
    return res.data;
  }

  async _post(endpoint, params = {}) {
    const ts   = Date.now().toString();
    const rw   = '20000';
    const body = JSON.stringify(params);
    const sig  = this._sign(ts + this.apiKey + rw + body);
    const res  = await axios.post(`${BASE}${endpoint}`, body, {
      headers: { 'X-BAPI-API-KEY': this.apiKey, 'X-BAPI-SIGN': sig, 'X-BAPI-TIMESTAMP': ts, 'X-BAPI-RECV-WINDOW': rw, 'X-BAPI-SIGN-TYPE': '2', 'Content-Type': 'application/json' },
      timeout: 8000,
    });
    return res.data;
  }

  async getBalance() {
    for (const accountType of ['UNIFIED', 'CONTRACT']) {
      try {
        const d = await this._get('/v5/account/wallet-balance', { accountType });
        if (d.retCode !== 0) continue;
        const acc  = d.result?.list?.[0] || {};
        const usdt = (acc.coin || []).find(c => c.coin === 'USDT');
        if (usdt) return {
          total:     parseFloat(usdt.walletBalance || 0),
          available: parseFloat(usdt.availableToWithdraw || usdt.walletBalance || 0),
        };
        if (acc.totalWalletBalance) return {
          total:     parseFloat(acc.totalWalletBalance),
          available: parseFloat(acc.totalAvailableBalance || acc.totalWalletBalance),
        };
      } catch {}
    }
    throw new Error('No USDT balance found');
  }

  async getPositions() {
    const d = await this._get('/v5/position/list', { category: 'linear', settleCoin: 'USDT' });
    if (d.retCode !== 0) throw new Error(d.retMsg);
    return (d.result?.list || [])
      .filter(p => parseFloat(p.size) > 0)
      .map(p => ({
        symbol:        p.symbol,
        side:          p.side,
        size:          parseFloat(p.size),
        entryPrice:    parseFloat(p.avgPrice),
        markPrice:     parseFloat(p.markPrice || 0),
        unrealisedPnl: parseFloat(p.unrealisedPnl),
        tp:            p.takeProfit || '',
        sl:            p.stopLoss  || '',
      }));
  }

  async placeOrder({ symbol, side, type = 'Market', qty, price, reduceOnly = false }) {
    const params = {
      category:    'linear',
      symbol,
      side,
      orderType:   type,
      qty:         String(qty),
      timeInForce: type === 'Market' ? 'IOC' : 'GTC',
    };
    if (price)      params.price      = String(price);
    if (reduceOnly) params.reduceOnly = true;
    const d = await this._post('/v5/order/create', params);
    if (d.retCode !== 0) throw new Error(`Bybit: ${d.retMsg}`);
    return { orderId: d.result?.orderId };
  }

  async cancelOrder(symbol, orderId) {
    const d = await this._post('/v5/order/cancel', { category: 'linear', symbol, orderId });
    return d.retCode === 0;
  }

  async cancelAllOrders(symbol) {
    const d = await this._post('/v5/order/cancel-all', { category: 'linear', symbol });
    return d.retCode === 0;
  }

  async closePosition(symbol, side, qty) {
    const closeSide = side === 'Buy' ? 'Sell' : 'Buy';
    return this.placeOrder({ symbol, side: closeSide, type: 'Market', qty, reduceOnly: true });
  }

  async getTicker(symbol) {
    const { data } = await axios.get(`${BASE}/v5/market/tickers`, {
      params: { category: 'linear', symbol },
      timeout: 5000,
    });
    const t = data.result?.list?.[0];
    if (!t) throw new Error(`Ticker not found: ${symbol}`);
    return { markPrice: parseFloat(t.markPrice), lastPrice: parseFloat(t.lastPrice) };
  }

  async getUID() {
    const d = await this._get('/v5/user/query-api', {});
    return String(d.result?.uid || d.result?.id || 'unknown');
  }

  async getOpenOrders(symbol) {
    const d = await this._get('/v5/order/realtime', { category: 'linear', symbol });
    if (d.retCode !== 0) return [];
    return (d.result?.list || []).map(o => ({
      orderId: o.orderId,
      side:    o.side,
      price:   parseFloat(o.price),
      qty:     parseFloat(o.qty),
      status:  o.orderStatus,
    }));
  }
}

module.exports = BybitClient;
