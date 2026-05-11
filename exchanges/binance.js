'use strict';
const axios  = require('axios');
const crypto = require('crypto');
const { withRetry } = require('./_utils');

const FAPI = 'https://fapi.binance.com';
const API  = 'https://api.binance.com';

class BinanceClient {
  constructor(apiKey, apiSecret) {
    this.apiKey    = apiKey;
    this.apiSecret = apiSecret;
  }

  _sign(qs) {
    return crypto.createHmac('sha256', this.apiSecret).update(qs).digest('hex');
  }

  async _get(base, endpoint, params = {}) {
    const res = await withRetry(() => {
      const p  = { ...params, timestamp: Date.now(), recvWindow: 20000 };
      const qs = Object.keys(p).map(k => `${k}=${p[k]}`).join('&');
      return axios.get(`${base}${endpoint}?${qs}&signature=${this._sign(qs)}`, {
        headers: { 'X-MBX-APIKEY': this.apiKey },
        timeout: 8000,
      });
    }, 'binance');
    return res.data;
  }

  async _post(base, endpoint, params = {}) {
    const res = await withRetry(() => {
      const p  = { ...params, timestamp: Date.now(), recvWindow: 20000 };
      const qs = Object.keys(p).map(k => `${k}=${p[k]}`).join('&');
      return axios.post(`${base}${endpoint}`, `${qs}&signature=${this._sign(qs)}`, {
        headers: { 'X-MBX-APIKEY': this.apiKey, 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 8000,
      });
    }, 'binance');
    return res.data;
  }

  async _delete(base, endpoint, params = {}) {
    const res = await withRetry(() => {
      const p  = { ...params, timestamp: Date.now(), recvWindow: 20000 };
      const qs = Object.keys(p).map(k => `${k}=${p[k]}`).join('&');
      return axios.delete(`${base}${endpoint}?${qs}&signature=${this._sign(qs)}`, {
        headers: { 'X-MBX-APIKEY': this.apiKey },
        timeout: 8000,
      });
    }, 'binance');
    return res.data;
  }

  async getBalance() {
    const data = await this._get(FAPI, '/fapi/v2/balance', {});
    const usdt = data.find(a => a.asset === 'USDT');
    if (!usdt) throw new Error('No USDT balance');
    return {
      total:     parseFloat(usdt.balance),
      available: parseFloat(usdt.availableBalance),
    };
  }

  async getPositions() {
    const data = await this._get(FAPI, '/fapi/v2/positionRisk', {});
    return data
      .filter(p => parseFloat(p.positionAmt) !== 0)
      .map(p => {
        const amt = parseFloat(p.positionAmt);
        return {
          symbol:        p.symbol,
          side:          amt > 0 ? 'Buy' : 'Sell',
          size:          Math.abs(amt),
          entryPrice:    parseFloat(p.entryPrice),
          markPrice:     parseFloat(p.markPrice),
          unrealisedPnl: parseFloat(p.unRealizedProfit),
          tp:            '',
          sl:            '',
        };
      });
  }

  async placeOrder({ symbol, side, type = 'Market', qty, price, reduceOnly = false }) {
    const params = {
      symbol,
      side:         side === 'Buy' ? 'BUY' : 'SELL',
      type:         type.toUpperCase(),
      quantity:     String(qty),
      positionSide: 'BOTH',
    };
    if (type !== 'Market' && price) {
      params.price         = String(price);
      params.timeInForce   = 'GTC';
    }
    if (reduceOnly) params.reduceOnly = 'true';
    const d = await this._post(FAPI, '/fapi/v1/order', params);
    return { orderId: String(d.orderId) };
  }

  async cancelOrder(symbol, orderId) {
    try {
      await this._delete(FAPI, '/fapi/v1/order', { symbol, orderId });
      return true;
    } catch { return false; }
  }

  async cancelAllOrders(symbol) {
    try {
      await this._delete(FAPI, '/fapi/v1/allOpenOrders', { symbol });
      return true;
    } catch { return false; }
  }

  async closePosition(symbol, side, qty) {
    const closeSide = side === 'Buy' ? 'Sell' : 'Buy';
    return this.placeOrder({ symbol, side: closeSide, type: 'Market', qty, reduceOnly: true });
  }

  async getTicker(symbol) {
    const { data } = await axios.get(`${FAPI}/fapi/v1/premiumIndex`, {
      params: { symbol },
      timeout: 5000,
    });
    return {
      markPrice: parseFloat(data.markPrice),
      lastPrice: parseFloat(data.indexPrice || data.markPrice),
    };
  }

  async getUID() {
    try {
      const d = await this._get(API, '/sapi/v1/account/uid', {});
      return String(d.uid || 'unknown');
    } catch { return 'unknown'; }
  }

  async getOpenOrders(symbol) {
    const data = await this._get(FAPI, '/fapi/v1/openOrders', { symbol });
    return data.map(o => ({
      orderId: String(o.orderId),
      side:    o.side === 'BUY' ? 'Buy' : 'Sell',
      price:   parseFloat(o.price),
      qty:     parseFloat(o.origQty),
      status:  o.status,
    }));
  }
}

module.exports = BinanceClient;
