'use strict';
const axios  = require('axios');
const crypto = require('crypto');
const { withRetry } = require('./_utils');

const BASE = 'https://www.okx.com';

function toInstId(symbol) {
  // BTCUSDT → BTC-USDT-SWAP
  const base = symbol.replace(/USDT$/, '');
  return `${base}-USDT-SWAP`;
}

function fromInstId(instId) {
  // BTC-USDT-SWAP → BTCUSDT
  return instId.replace('-SWAP', '').replace(/-/g, '');
}

class OkxClient {
  constructor(apiKey, apiSecret, passphrase) {
    this.apiKey     = apiKey;
    this.apiSecret  = apiSecret;
    this.passphrase = passphrase || '';
  }

  _sign(ts, method, path, body = '') {
    const msg = ts + method + path + body;
    return crypto.createHmac('sha256', this.apiSecret).update(msg).digest('base64');
  }

  _headers(method, path, body = '') {
    const ts = new Date().toISOString();
    return {
      'OK-ACCESS-KEY':        this.apiKey,
      'OK-ACCESS-SIGN':       this._sign(ts, method, path, body),
      'OK-ACCESS-TIMESTAMP':  ts,
      'OK-ACCESS-PASSPHRASE': this.passphrase,
      'Content-Type':         'application/json',
    };
  }

  async _get(path, params = {}) {
    const qs       = Object.keys(params).length ? '?' + Object.keys(params).map(k => `${k}=${params[k]}`).join('&') : '';
    const fullPath = path + qs;
    const res = await withRetry(() => axios.get(`${BASE}${fullPath}`, {
      headers: this._headers('GET', fullPath),
      timeout: 8000,
    }), 'okx');
    return res.data;
  }

  async _post(path, body) {
    const bodyStr = JSON.stringify(body);
    const res = await withRetry(() => axios.post(`${BASE}${path}`, bodyStr, {
      headers: this._headers('POST', path, bodyStr),
      timeout: 8000,
    }), 'okx');
    return res.data;
  }

  async getBalance() {
    const d      = await this._get('/api/v5/account/balance', { ccy: 'USDT' });
    const detail = (d.data?.[0]?.details || []).find(x => x.ccy === 'USDT');
    if (!detail) throw new Error('No USDT balance');
    return {
      total:     parseFloat(detail.cashBal || detail.bal || 0),
      available: parseFloat(detail.availBal || detail.cashBal || 0),
    };
  }

  async getPositions() {
    const d = await this._get('/api/v5/account/positions', { instType: 'SWAP' });
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
      ordType: type === 'Market' ? 'market' : 'limit',
      sz:      String(qty),
    };
    if (type !== 'Market' && price) body.px = String(price);
    const d = await this._post('/api/v5/trade/order', body);
    if (d.code !== '0') throw new Error(`OKX: ${d.msg}`);
    return { orderId: d.data?.[0]?.ordId };
  }

  async cancelOrder(symbol, orderId) {
    const d = await this._post('/api/v5/trade/cancel-order', { instId: toInstId(symbol), ordId: orderId });
    return d.code === '0';
  }

  async cancelAllOrders(symbol) {
    const instId  = toInstId(symbol);
    const pending = await this._get('/api/v5/trade/orders-pending', { instType: 'SWAP', instId });
    if (!pending.data?.length) return true;
    const list = pending.data.map(o => ({ instId, ordId: o.ordId }));
    const d    = await this._post('/api/v5/trade/cancel-batch-orders', list);
    return d.code === '0';
  }

  async closePosition(symbol, side, qty) {
    const closeSide = side === 'Buy' ? 'Sell' : 'Buy';
    return this.placeOrder({ symbol, side: closeSide, type: 'Market', qty });
  }

  async getTicker(symbol) {
    const instId = toInstId(symbol);
    const d      = await this._get('/api/v5/market/mark-price', { instType: 'SWAP', instId });
    const t      = d.data?.[0];
    if (!t) throw new Error(`OKX ticker not found: ${symbol}`);
    return { markPrice: parseFloat(t.markPx), lastPrice: parseFloat(t.markPx) };
  }

  async getUID() {
    const d = await this._get('/api/v5/account/config', {});
    return String(d.data?.[0]?.uid || 'unknown');
  }

  async getOpenOrders(symbol) {
    const instId = toInstId(symbol);
    const d      = await this._get('/api/v5/trade/orders-pending', { instType: 'SWAP', instId });
    return (d.data || []).map(o => ({
      orderId: o.ordId,
      side:    o.side === 'buy' ? 'Buy' : 'Sell',
      price:   parseFloat(o.px || 0),
      qty:     parseFloat(o.sz),
      status:  o.state,
    }));
  }
}

module.exports = OkxClient;
