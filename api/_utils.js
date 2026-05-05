const crypto = require('crypto');
const axios  = require('axios');

const CONFIG = {
  apiKey:    process.env.BYBIT_API_KEY,
  apiSecret: process.env.BYBIT_API_SECRET,
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
  const res = await axios.get(url, {
    headers: {
      'X-BAPI-API-KEY':     CONFIG.apiKey,
      'X-BAPI-SIGN':        sig,
      'X-BAPI-TIMESTAMP':   ts,
      'X-BAPI-RECV-WINDOW': rw,
      'X-BAPI-SIGN-TYPE':   '2',
    }
  });
  return res.data;
}

async function apiPost(path, params = {}) {
  const ts   = Date.now().toString();
  const rw   = '5000';
  const body = JSON.stringify(params);
  const sig  = sign(ts + CONFIG.apiKey + rw + body);
  const url  = `${BASE}${path}`;
  const res = await axios.post(url, params, {
    headers: {
      'X-BAPI-API-KEY':     CONFIG.apiKey,
      'X-BAPI-SIGN':        sig,
      'X-BAPI-TIMESTAMP':   ts,
      'X-BAPI-RECV-WINDOW': rw,
      'X-BAPI-SIGN-TYPE':   '2',
    }
  });
  return res.data;
}

module.exports = { CONFIG, apiGet, apiPost };
