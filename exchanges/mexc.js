'use strict';
const axios  = require('axios');
const crypto = require('crypto');

const BASE = 'https://contract.mexc.com';

function toMexcSym(symbol) {
  // BTCUSDT → BTC_USDT
  return symbol.replace(/USDT$/, '_USDT');
}

function fromMexcSym(sym) {
  // BTC_USDT → BTCUSDT
  return sym.replace('_', '');
}

class MexcClient {
  constructor(apiKey, apiSecret) {
    this.apiKey    = apiKey;
    this.apiSecret = apiSecret;
  }

  _sign(ts, bodyStr = '') {
    return crypto.createHmac('sha256', this.apiSecret)
      .update(this.apiKey + ts + bodyStr)
      .digest('hex');
  }

  _headers(ts, bodyStr = '') {
    return {
      'ApiKey':       this.apiKey,
      'Request-Time': ts,
      'Signature':    this._sign(ts, bodyStr),
      'Content-Type': 'application/json',
    };
  }

  async _get(path, params = {}) {
    const ts = Date.now().toString();
    const qs = Object.keys(params).length ? '?' + Object.keys(params).map(k => `${k}=${params[k]}`).join('&') : '';
    const res = await axios.get(`${BASE}${path}${qs}`, {
      headers: this._headers(ts),
      timeout: 8000,
    });
    return res.data;
  }

  async _post(path, body = {}) {
    const ts      = Date.now().toString();
    const bodyStr = JSON.stringify(body);
    const res = await axios.post(`${BASE}${path}`, bodyStr, {
      headers: this._headers(ts, bodyStr),
      timeout: 8000,
    });
    return res.data;
  }

  async getBalance() {
    const d    = await this._get('/api/v1/private/account/assets');
    if (!d.success) throw new Error(`MEXC: ${d.message || 'error'}`);
    const usdt = (d.data || []).find(a => a.currency === 'USDT');
    if (!usdt) throw new Error('No USDT balance');
    return {
      total:     parseFloat(usdt.equity || usdt.availableBalance || 0),
      available: parseFloat(usdt.availableBalance || 0),
    };
  }

  async getPositions() {
    const d = await this._get('/api/v1/private/position/open_positions');
    if (!d.success) return [];
    return (d.data || []).map(p => ({
      symbol:        fromMexcSym(p.symbol),
      side:          p.holdSide === 1 ? 'Buy' : 'Sell',
      size:          parseFloat(p.holdVol),
      entryPrice:    parseFloat(p.holdAvgPrice),
      markPrice:     parseFloat(p.markPrice || 0),
      unrealisedPnl: parseFloat(p.unrealizedValue || 0),
      tp:            '',
      sl:            '',
    }));
  }

  async placeOrder({ symbol, side, type = 'Market', qty, price, reduceOnly = false }) {
    const mexcSym = toMexcSym(symbol);
    // side: 1=openLong, 2=closeShort, 3=openShort, 4=closeLong
    let mexcSide;
    if (!reduceOnly) {
      mexcSide = side === 'Buy' ? 1 : 3;
    } else {
      mexcSide = side === 'Buy' ? 2 : 4;
    }
    const body = {
      symbol:   mexcSym,
      side:     mexcSide,
      vol:      qty,
      orderType: type === 'Market' ? 5 : 1, // 1=limit, 5=market
      openType:  1, // cross margin
    };
    if (type !== 'Market' && price) body.price = price;
    const d = await this._post('/api/v1/private/order/submit', body);
    if (!d.success) throw new Error(`MEXC: ${d.message}`);
    return { orderId: String(d.data) };
  }

  async cancelOrder(symbol, orderId) {
    const d = await this._post('/api/v1/private/order/cancel', { orderId });
    return !!(d.success);
  }

  async cancelAllOrders(symbol) {
    const mexcSym = toMexcSym(symbol);
    const d = await this._post('/api/v1/private/order/cancel_all', { symbol: mexcSym });
    return !!(d.success);
  }

  async closePosition(symbol, side, qty) {
    const closeSide = side === 'Buy' ? 'Sell' : 'Buy';
    return this.placeOrder({ symbol, side: closeSide, type: 'Market', qty, reduceOnly: true });
  }

  async getTicker(symbol) {
    const mexcSym = toMexcSym(symbol);
    const res     = await axios.get(`${BASE}/api/v1/contract/ticker`, {
      params: { symbol: mexcSym },
      timeout: 5000,
    });
    const t = res.data?.data;
    if (!t) throw new Error(`MEXC ticker not found: ${symbol}`);
    return {
      markPrice: parseFloat(t.fairPrice),
      lastPrice: parseFloat(t.lastPrice),
    };
  }

  async getUID() {
    try {
      const d = await this._get('/api/v1/private/account/info');
      return String(d.data?.userId || 'unknown');
    } catch { return 'unknown'; }
  }

  async getOpenOrders(symbol) {
    const mexcSym = toMexcSym(symbol);
    const d = await this._get(`/api/v1/private/order/open_orders/${mexcSym}`);
    if (!d.success) return [];
    return (d.data || []).map(o => ({
      orderId: String(o.orderId),
      side:    [1, 2].includes(o.side) ? 'Buy' : 'Sell',
      price:   parseFloat(o.price || 0),
      qty:     parseFloat(o.vol),
      status:  o.state,
    }));
  }
}

module.exports = MexcClient;
