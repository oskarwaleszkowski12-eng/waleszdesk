const crypto = require('crypto');
const axios  = require('axios');

function getConfig() {
  return {
    apiKey:    process.env.BYBIT_API_KEY,
    apiSecret: process.env.BYBIT_API_SECRET,
    testnet:   process.env.BYBIT_TESTNET === 'true' || false,
  };
}

function sign(secret, payload) {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

function bybitError(err) {
  const data = err.response?.data;
  if (data) return new Error(`Bybit ${err.response.status}: retCode=${data.retCode} retMsg=${data.retMsg}`);
  return err;
}

async function apiGet(path, params = {}) {
  const { apiKey, apiSecret, testnet } = getConfig();
  const base = testnet ? 'https://api-testnet.bybit.com' : 'https://api.bybit.com';
  const ts  = Date.now().toString();
  const rw  = '20000';
  const qs  = Object.keys(params).sort().map(k => `${k}=${params[k]}`).join('&');
  const sig = sign(apiSecret, ts + apiKey + rw + qs);
  const url = `${base}${path}${qs ? '?' + qs : ''}`;
  try {
    const res = await axios.get(url, {
      headers: {
        'X-BAPI-API-KEY':     apiKey,
        'X-BAPI-SIGN':        sig,
        'X-BAPI-TIMESTAMP':   ts,
        'X-BAPI-RECV-WINDOW': rw,
        'X-BAPI-SIGN-TYPE':   '2',
      }
    });
    return res.data;
  } catch (err) {
    throw bybitError(err);
  }
}

async function apiPost(path, params = {}) {
  const { apiKey, apiSecret, testnet } = getConfig();
  const base = testnet ? 'https://api-testnet.bybit.com' : 'https://api.bybit.com';
  const ts   = Date.now().toString();
  const rw   = '20000';
  const body = JSON.stringify(params);
  const sig  = sign(apiSecret, ts + apiKey + rw + body);
  const url  = `${base}${path}`;
  try {
    const res = await axios.post(url, body, {
      headers: {
        'X-BAPI-API-KEY':     apiKey,
        'X-BAPI-SIGN':        sig,
        'X-BAPI-TIMESTAMP':   ts,
        'X-BAPI-RECV-WINDOW': rw,
        'X-BAPI-SIGN-TYPE':   '2',
        'Content-Type':       'application/json',
      }
    });
    return res.data;
  } catch (err) {
    throw bybitError(err);
  }
}

module.exports = { getConfig, apiGet, apiPost };
