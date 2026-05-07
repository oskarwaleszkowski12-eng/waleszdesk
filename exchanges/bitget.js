'use strict';
const axios  = require('axios');
const crypto = require('crypto');

const BASE    = 'https://api.bitget.com';
const PRODUCT = 'USDT-FUTURES';

class BitgetClient {
  constructor(apiKey, apiSecret, passphrase) {
    this.apiKey     = apiKey;
    this.apiSecret  = apiSecret;
    this.passphrase = passphrase || '';
  }

  _sign(ts, method, path, body = '') {
    const msg = ts + method.toUpperCase() + path + body;
    return crypto.createHmac('sha256', this.apiSecret).update(msg).digest('base64');
  }

  _headers(method, path, body = '') {
    const ts = Date.now().toString();
    return {
      'ACCESS-KEY':        this.apiKey,
      'ACCESS-SIGN':       this._sign(ts, method, path, body),
      'ACCESS-TIMESTAMP':  ts,
      'ACCESS-PASSPHRASE': this.passphrase,
      'Content-Type':      'application/json',
      'locale':            'en-US',
    };
  }

  async _get(path, params = {}) {
    const qs       = Object.keys(params).length ? '?' + Object.keys(params).map(k => `${k}=${encodeURIComponent(params[k])}`).join('&') : '';
    const fullPath = path + qs;
    const res = await axios.get(`${BASE}${fullPath}`, {
      headers: this._headers('GET', fullPath),
      timeout: 8000,
    });
    return res.data;
  }

  async _post(path, body = {}) {
    const bodyStr = JSON.stringify(body);
    const res = await axios.post(`${BASE}${path}`, bodyStr, {
      headers: this._headers('POST', path, bodyStr),
      timeout: 8000,
    });
    return res.data;
  }

  async getBalance() {
    const d   = await this._get('/api/v2/mix/account/account', { productType: PRODUCT, marginCoin: 'USDT' });
    if (d.code !== '00000') throw new Error(`Bitget: ${d.msg}`);
    const acc = d.data || {};
    return {
      total:     parseFloat(acc.usdtEquity || acc.crossedMaxAvailable || 0),
      available: parseFloat(acc.crossedMaxAvailable || acc.available || 0),
    };
  }

  async getPositions() {
    const d = await this._get('/api/v2/mix/position/all-position', { productType: PRODUCT, marginCoin: 'USDT' });
    if (d.code !== '00000') throw new Error(`Bitget: ${d.msg}`);
    return (d.data || [])
      .filter(p => parseFloat(p.total || 0) > 0)
      .map(p => ({
        symbol:        p.symbol,
        side:          p.holdSide === 'long' ? 'Buy' : 'Sell',
        size:          parseFloat(p.total),
        entryPrice:    parseFloat(p.openPriceAvg),
        markPrice:     parseFloat(p.markPrice),
        unrealisedPnl: parseFloat(p.unrealizedPL),
        tp:            p.stopSurplusPrice || '',
        sl:            p.stopLossPrice    || '',
      }));
  }

  async placeOrder({ symbol, side, type = 'Market', qty, price, reduceOnly = false }) {
    let bitgetSide;
    if (!reduceOnly) {
      bitgetSide = side === 'Buy' ? 'buy_open_long' : 'sell_open_short';
    } else {
      bitgetSide = side === 'Buy' ? 'buy_close_short' : 'sell_close_long';
    }
    const body = {
      symbol,
      productType:     PRODUCT,
      marginMode:      'crossed',
      marginCoin:      'USDT',
      size:            String(qty),
      side:            bitgetSide,
      orderType:       type === 'Market' ? 'market' : 'limit',
      timeInForceValue: 'gtc',
    };
    if (type !== 'Market' && price) body.price = String(price);
    const d = await this._post('/api/v2/mix/order/place-order', body);
    if (d.code !== '00000') throw new Error(`Bitget: ${d.msg}`);
    return { orderId: d.data?.orderId };
  }

  async cancelOrder(symbol, orderId) {
    const d = await this._post('/api/v2/mix/order/cancel-order', { symbol, productType: PRODUCT, orderId });
    return d.code === '00000';
  }

  async cancelAllOrders(symbol) {
    const d = await this._post('/api/v2/mix/order/cancel-all-orders', { symbol, productType: PRODUCT, marginCoin: 'USDT' });
    return d.code === '00000';
  }

  async closePosition(symbol, side, qty) {
    const closeSide = side === 'Buy' ? 'Sell' : 'Buy';
    return this.placeOrder({ symbol, side: closeSide, type: 'Market', qty, reduceOnly: true });
  }

  async getTicker(symbol) {
    const d = await this._get('/api/v2/mix/market/ticker', { symbol, productType: PRODUCT });
    if (d.code !== '00000') throw new Error(`Bitget ticker: ${d.msg}`);
    const t = (d.data || [])[0] || {};
    return {
      markPrice: parseFloat(t.markPrice || t.lastPr || 0),
      lastPrice: parseFloat(t.lastPr || 0),
    };
  }

  async getUID() {
    try {
      const d = await this._get('/api/v2/user/info', {});
      return String(d.data?.userId || 'unknown');
    } catch { return 'unknown'; }
  }

  async getOpenOrders(symbol) {
    const d = await this._get('/api/v2/mix/order/orders-pending', { symbol, productType: PRODUCT });
    if (d.code !== '00000') return [];
    return (d.data?.entrustedList || []).map(o => ({
      orderId: o.orderId,
      side:    o.side.includes('buy') ? 'Buy' : 'Sell',
      price:   parseFloat(o.price || 0),
      qty:     parseFloat(o.size),
      status:  o.status,
    }));
  }
}

module.exports = BitgetClient;
