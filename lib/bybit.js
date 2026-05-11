const crypto = require('crypto');
const axios  = require('axios');
const { API_KEY, API_SECRET, BASE } = require('./config');

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
      'X-BAPI-API-KEY': API_KEY, 'X-BAPI-SIGN': sig,
      'X-BAPI-TIMESTAMP': ts, 'X-BAPI-RECV-WINDOW': rw, 'X-BAPI-SIGN-TYPE': '2',
    },
    timeout: 8000,
  });
  return res.data;
}

async function bybitPost(endpoint, params = {}) {
  const ts   = Date.now().toString();
  const rw   = '20000';
  const body = JSON.stringify(params);
  const sig  = sign(ts + API_KEY + rw + body);
  const res  = await axios.post(`${BASE}${endpoint}`, body, {
    headers: {
      'X-BAPI-API-KEY': API_KEY, 'X-BAPI-SIGN': sig,
      'X-BAPI-TIMESTAMP': ts, 'X-BAPI-RECV-WINDOW': rw,
      'X-BAPI-SIGN-TYPE': '2', 'Content-Type': 'application/json',
    },
    timeout: 8000,
  });
  return res.data;
}

async function bybitGetWithKeys(apiKey, apiSecret, endpoint, params = {}) {
  const ts  = Date.now().toString();
  const rw  = '20000';
  const qs  = Object.keys(params).sort().map(k => `${k}=${params[k]}`).join('&');
  const sig = crypto.createHmac('sha256', apiSecret).update(ts + apiKey + rw + qs).digest('hex');
  const res = await axios.get(`${BASE}${endpoint}${qs ? '?' + qs : ''}`, {
    headers: {
      'X-BAPI-API-KEY': apiKey, 'X-BAPI-SIGN': sig,
      'X-BAPI-TIMESTAMP': ts, 'X-BAPI-RECV-WINDOW': rw, 'X-BAPI-SIGN-TYPE': '2',
    },
    timeout: 8000,
  });
  return res.data;
}

async function bybitPostWithKeys(apiKey, apiSecret, endpoint, params = {}) {
  const ts   = Date.now().toString();
  const rw   = '20000';
  const body = JSON.stringify(params);
  const sig  = crypto.createHmac('sha256', apiSecret).update(ts + apiKey + rw + body).digest('hex');
  const res  = await axios.post(`${BASE}${endpoint}`, body, {
    headers: {
      'X-BAPI-API-KEY': apiKey, 'X-BAPI-SIGN': sig,
      'X-BAPI-TIMESTAMP': ts, 'X-BAPI-RECV-WINDOW': rw,
      'X-BAPI-SIGN-TYPE': '2', 'Content-Type': 'application/json',
    },
    timeout: 8000,
  });
  return res.data;
}

module.exports = { bybitGet, bybitPost, bybitGetWithKeys, bybitPostWithKeys };
