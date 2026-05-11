'use strict';
const axios  = require('axios');
const crypto = require('crypto');
const { withRetry } = require('./_utils');

const BASE = 'https://openapi.blofin.com';

function toInstId(symbol) {
  // BTCUSDT → BTC-USDT
  return symbol.replace(/USDT$/, '-USDT');
}

function fromInstId(instId) {
  // BTC-USDT → BTCUSDT
  return instId.replace('-', '');
}

class BlofinClient {
  constructor(apiKey, apiSecret, passphrase) {
    this.apiKey     = apiKey;
    this.apiSecret  = apiSecret;
    this.passphrase = passphrase || '';
  }

  _nonce() {
    return crypto.randomBytes(8).toString('hex');
  }

  _sign(ts, nonce, method, path, body = '') {
    const msg = ts + nonce + method.toUpperCase() + path + body;
    return crypto.createHmac('sha256', this.apiSecret).update(msg).digest('base64');
  }

  _headers(method, path, body = '') {
    // Timestamp must be Unix milliseconds, generated immediately before the request
    const ts    = Date.now().toString();
    const nonce = this._nonce();
    return {
      'ACCESS-KEY':        this.apiKey,
      'ACCESS-SIGN':       this._sign(ts, nonce, method, path, body),
      'ACCESS-TIMESTAMP':  ts,
      'ACCESS-NONCE':      nonce,
      'ACCESS-PASSPHRASE': this.passphrase,
      'Content-Type':      'application/json',
    };
  }

  async _get(path, params = {}) {
    const qs       = Object.keys(params).length ? '?' + Object.keys(params).map(k => `${k}=${params[k]}`).join('&') : '';
    const fullPath = path + qs;
    const res = await withRetry(() => axios.get(`${BASE}${fullPath}`, {
      headers: this._headers('GET', fullPath),
      timeout: 8000,
    }), 'blofin');
    return res.data;
  }

  async _post(path, body) {
    const bodyStr = JSON.stringify(body);
    const res = await withRetry(() => axios.post(`${BASE}${path}`, bodyStr, {
      headers: this._headers('POST', path, bodyStr),
      timeout: 8000,
    }), 'blofin');
    return res.data;
  }

  async getBalance() {
    const d    = await this._get('/api/v1/asset/balances');
    if (d.code !== '0') throw new Error(`BloFin: ${d.msg}`);
    const usdt = (d.data || []).find(x => x.currency === 'USDT');
    if (!usdt) throw new Error('No USDT balance');
    return {
      total:     parseFloat(usdt.balance),
      available: parseFloat(usdt.available),
    };
  }

  async getPositions() {
    const d = await this._get('/api/v1/account/positions', { instType: 'SWAP' });
    if (d.code !== '0') return [];
    return (d.data || [])
      .filter(p => parseFloat(p.pos || 0) !== 0)
      .map(p => ({
        symbol:        fromInstId(p.instId),
        side:          p.posSide === 'long' ? 'Buy' : 'Sell',
        size:          Math.abs(parseFloat(p.pos)),
        entryPrice:    parseFloat(p.avgPx),
        markPrice:     parseFloat(p.markPx),
        unrealisedPnl: parseFloat(p.upl),
        tp:            p.tpTriggerPx || '',
        sl:            p.slTriggerPx || '',
      }));
  }

  async placeOrder({ symbol, side, type = 'Market', qty, price }) {
    const body = {
      instId:  toInstId(symbol),
      tdMode:  'cross',
      side:    side === 'Buy' ? 'buy' : 'sell',
      posSide: side === 'Buy' ? 'long' : 'short',
      ordType: type === 'Market' ? 'market' : 'limit',
      sz:      String(qty),
    };
    if (type !== 'Market' && price) body.px = String(price);
    const d = await this._post('/api/v1/trade/order', body);
    if (d.code !== '0') throw new Error(`BloFin: ${d.msg}`);
    return { orderId: d.data?.ordId };
  }

  async cancelOrder(symbol, orderId) {
    const d = await this._post('/api/v1/trade/cancel-order', { instId: toInstId(symbol), ordId: orderId });
    return d.code === '0';
  }

  async cancelAllOrders(symbol) {
    const instId  = toInstId(symbol);
    const pending = await this._get('/api/v1/trade/orders-pending', { instId });
    if (!pending.data?.length) return true;
    const list = pending.data.map(o => ({ instId, ordId: o.ordId }));
    const d    = await this._post('/api/v1/trade/cancel-batch-orders', list);
    return d.code === '0';
  }

  async closePosition(symbol, side, qty) {
    const closeSide = side === 'Buy' ? 'Sell' : 'Buy';
    return this.placeOrder({ symbol, side: closeSide, type: 'Market', qty });
  }

  async getTicker(symbol) {
    const instId = toInstId(symbol);
    const d      = await this._get('/api/v1/market/mark-price', { instId });
    if (d.code !== '0') throw new Error(`BloFin ticker: ${d.msg}`);
    const t = (d.data || [])[0];
    if (!t) throw new Error(`BloFin ticker not found: ${symbol}`);
    return { markPrice: parseFloat(t.markPx), lastPrice: parseFloat(t.markPx) };
  }

  async getUID() {
    try {
      const d = await this._get('/api/v1/user/info');
      return String(d.data?.uid || 'unknown');
    } catch { return 'unknown'; }
  }

  async getOpenOrders(symbol) {
    const instId = toInstId(symbol);
    const d      = await this._get('/api/v1/trade/orders-pending', { instId });
    if (d.code !== '0') return [];
    return (d.data || []).map(o => ({
      orderId: o.ordId,
      side:    o.side === 'buy' ? 'Buy' : 'Sell',
      price:   parseFloat(o.px || 0),
      qty:     parseFloat(o.sz),
      status:  o.state,
    }));
  }
}

module.exports = BlofinClient;
