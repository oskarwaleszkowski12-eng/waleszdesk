const axios  = require('axios');
const logger = require('./logger');

const DEMO_BASE = 'https://demo.tradovateapi.com/v1';
const LIVE_BASE = 'https://live.tradovateapi.com/v1';
const DEVICE_ID = 'waleszdesk-tv-001';

// In-memory state
let _token       = null;
let _tokenExpiry = 0;
let _mdToken     = null;
let _accountId   = null;
let _accountSpec = null;
let _renewTimer  = null;

// Runtime credentials (override .env)
let _username = null;
let _password = null;
let _isDemo   = null;

function setCredentials(username, password, isDemo = false) {
  _username = username;
  _password = password;
  _isDemo   = isDemo;
  _accountId   = null;
  _accountSpec = null;
}

async function loadCredentialsFromDb() {
  try {
    const { pool }   = require('./db');
    const { decrypt } = require('./crypto');
    const res = await pool.query(`SELECT key, value FROM funded_settings WHERE key IN ('tv_username','tv_password','tv_is_demo')`);
    const map = Object.fromEntries(res.rows.map(r => [r.key, r.value]));
    if (map.tv_username && map.tv_password) {
      _username = decrypt(map.tv_username);
      _password = decrypt(map.tv_password);
      _isDemo   = map.tv_is_demo === 'true';
      logger.info('[tradovate] credentials loaded from DB');
      return true;
    }
  } catch (e) {
    logger.warn('[tradovate] could not load credentials from DB: ' + e.message);
  }
  return false;
}

async function saveCredentialsToDb(username, password, isDemo) {
  const { pool }    = require('./db');
  const { encrypt } = require('./crypto');
  await pool.query(`
    INSERT INTO funded_settings (key, value) VALUES ($1,$2),($3,$4),($5,$6)
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
  `, ['tv_username', encrypt(username), 'tv_password', encrypt(password), 'tv_is_demo', String(isDemo)]);
  logger.info('[tradovate] credentials saved to DB');
}

function hasCredentials() {
  const { TRADOVATE_USERNAME } = require('./config');
  return !!(_username || TRADOVATE_USERNAME);
}

function base() {
  if (_isDemo !== null) return _isDemo ? DEMO_BASE : LIVE_BASE;
  const { TRADOVATE_IS_DEMO } = require('./config');
  return TRADOVATE_IS_DEMO ? DEMO_BASE : LIVE_BASE;
}

function isDemoMode() {
  if (_isDemo !== null) return _isDemo;
  const { TRADOVATE_IS_DEMO } = require('./config');
  return TRADOVATE_IS_DEMO;
}

function _creds() {
  if (_username && _password) return { username: _username, password: _password };
  const { TRADOVATE_USERNAME, TRADOVATE_PASSWORD } = require('./config');
  return { username: TRADOVATE_USERNAME, password: TRADOVATE_PASSWORD };
}

function _appCredentials() {
  const { TRADOVATE_CID, TRADOVATE_SEC } = require('./config');
  const cid = String(TRADOVATE_CID || '').trim();
  const sec = String(TRADOVATE_SEC || '').trim();

  if (!isDemoMode() && (!cid || cid === '0' || !sec)) {
    throw new Error('Tradovate Live wymaga TRADOVATE_CID i TRADOVATE_SEC z zarejestrowanej aplikacji. Demo może działać z cid=0, Live nie.');
  }

  return {
    cid: cid || 0,
    sec,
  };
}

function isConnected() {
  return !!_token && Date.now() < _tokenExpiry - 60_000;
}

function _saveToken(d) {
  _token       = d.accessToken;
  _mdToken     = d.mdAccessToken || null;
  _tokenExpiry = d.expirationTime
    ? new Date(d.expirationTime).getTime()
    : Date.now() + 23 * 3600_000;
  logger.info('[tradovate] token saved, expires ' + new Date(_tokenExpiry).toISOString());
  _scheduleRenew();
}

// Auto-renew token 5 min before expiry
function _scheduleRenew() {
  if (_renewTimer) clearTimeout(_renewTimer);
  const delay = Math.max(_tokenExpiry - Date.now() - 5 * 60_000, 60_000);
  _renewTimer = setTimeout(async () => {
    try {
      await renewToken();
      logger.info('[tradovate] token auto-renewed');
    } catch (e) {
      logger.warn('[tradovate] auto-renew failed: ' + e.message + ' — manual reconnect needed');
      _token = null;
    }
  }, delay);
}

// ── STEP 1: Initiate auth — sends credentials, may get p-ticket ──
async function initiateAuth() {
  const { username, password } = _creds();
  const { cid, sec } = _appCredentials();
  if (!username || !password)
    throw new Error('Brak credentials — wpisz username i hasło w panelu Connect');

  const res = await axios.post(`${base()}/auth/accesstokenrequest`, {
    name:       username,
    password:   password,
    appId:      'WaleszDesk',
    appVersion: '1.0',
    deviceId:   DEVICE_ID,
    cid,
    sec,
  });

  const d = res.data;

  // Immediate error (wrong credentials)
  if (d.errorText && !d['p-ticket']) {
    throw new Error('Błędne dane logowania: ' + d.errorText);
  }

  // 2FA required — return p-ticket to frontend
  if (d['p-ticket']) {
    logger.info('[tradovate] 2FA required, p-ticket received');
    return { requires2FA: true, pTicket: d['p-ticket'], pTime: d['p-time'] };
  }

  // No 2FA — logged in immediately
  if (d.accessToken) {
    _accountId   = null;
    _accountSpec = null;
    _saveToken(d);
    return { requires2FA: false };
  }

  throw new Error('Nieoczekiwana odpowiedź Tradovate: ' + JSON.stringify(d));
}

// ── STEP 2: Complete auth with 2FA code ──
async function completeAuth(pTicket, totpCode) {
  const { username, password } = _creds();
  const { cid, sec } = _appCredentials();

  const res = await axios.post(`${base()}/auth/accesstokenrequest`, {
    name:        username,
    password:    password,
    appId:       'WaleszDesk',
    appVersion:  '1.0',
    deviceId:    DEVICE_ID,
    cid,
    sec,
    'p-ticket':  pTicket,
    'p-captcha': String(totpCode),
  });

  const d = res.data;
  if (d.errorText) throw new Error('Błędny kod 2FA: ' + d.errorText);
  if (!d.accessToken) throw new Error('Brak tokena w odpowiedzi: ' + JSON.stringify(d));

  _accountId   = null;
  _accountSpec = null;
  _saveToken(d);
  logger.info('[tradovate] 2FA complete, connected');
  return { ok: true };
}

// ── Token renewal (no 2FA needed) ──
async function renewToken() {
  if (!_token) throw new Error('Brak tokena do odnowienia — zaloguj się ponownie');
  const res = await axios.post(
    `${base()}/auth/renewaccesstoken`,
    {},
    { headers: { Authorization: `Bearer ${_token}` } }
  );
  const d = res.data;
  if (!d.accessToken) throw new Error('Renewal failed: ' + JSON.stringify(d));
  _saveToken(d);
  return d.accessToken;
}

// ── HTTP HELPERS ──────────────────────────────────────────
async function tvGet(path, params = {}) {
  if (!isConnected()) throw new Error('Nie połączono z Tradovate — zaloguj się w panelu Funded');
  try {
    const res = await axios.get(`${base()}${path}`, {
      headers: { Authorization: `Bearer ${_token}` },
      params,
    });
    return res.data;
  } catch (err) {
    throw new Error(_formatHttpError(err));
  }
}

async function tvPost(path, body = {}) {
  if (!isConnected()) throw new Error('Nie połączono z Tradovate — zaloguj się w panelu Funded');
  try {
    const res = await axios.post(`${base()}${path}`, body, {
      headers: { Authorization: `Bearer ${_token}`, 'Content-Type': 'application/json' },
    });
    return res.data;
  } catch (err) {
    throw new Error(_formatHttpError(err));
  }
}

function _formatHttpError(err) {
  const status = err.response?.status;
  const data   = err.response?.data;
  if (data?.errorText) return data.errorText;
  if (data?.failureText) return data.failureText;
  if (data?.message) return data.message;
  if (typeof data === 'string' && data.trim()) return data;
  return status ? `Tradovate HTTP ${status}` : err.message;
}

function _assertOrderAccepted(result) {
  if (!result) throw new Error('Pusta odpowiedź Tradovate po złożeniu ordera');
  if (result.failureReason && result.failureReason !== 'Success') {
    const details = result.failureText ? `: ${result.failureText}` : '';
    throw new Error(`Order rejected (${result.failureReason})${details}`);
  }
  if (result.errorText) throw new Error(result.errorText);
  return result;
}

// ── ACCOUNT ───────────────────────────────────────────────
async function getPrimaryAccount() {
  if (_accountId) return { id: _accountId, name: _accountSpec };
  const accounts = await tvGet('/account/list');
  if (!accounts.length) throw new Error('Brak kont Tradovate');
  const acc    = accounts[0];
  _accountId   = acc.id;
  _accountSpec = acc.name;
  return acc;
}

async function getAccountSummary() {
  const [acc, cash] = await Promise.all([getPrimaryAccount(), getCashBalance()]);
  const balance  = cash.cashBalance              ?? 0;
  const openPL   = cash.openTradingSessionPnl    ?? 0;
  const equity   = balance + openPL;
  const dailyPnl = cash.tradingSessionPnl        ?? openPL;
  return {
    accountId:   acc.id,
    accountName: acc.name,
    accountType: acc.accountType || 'SIM',
    currency:    acc.currency || 'USD',
    balance:     +balance.toFixed(2),
    equity:      +equity.toFixed(2),
    openPL:      +openPL.toFixed(2),
    dailyPnl:    +dailyPnl.toFixed(2),
    marginUsed:  +(cash.initialMargin       ?? 0).toFixed(2),
    marginAvail: +(cash.availableForTrading ?? balance).toFixed(2),
  };
}

async function getCashBalance() {
  const acc = await getPrimaryAccount();
  return tvPost('/cashbalance/getcashbalanceSnapshot', { accountId: acc.id });
}

// ── POSITIONS ─────────────────────────────────────────────
async function getPositions() {
  const acc = await getPrimaryAccount();
  const all  = await tvGet('/position/list');
  return all.filter(p => p.accountId === acc.id && p.netPos !== 0).map(p => ({
    id:         p.id,
    contractId: p.contractId,
    symbol:     p.contract?.name || String(p.contractId),
    netPos:     p.netPos,
    netPrice:   p.netPrice,
    openPL:     p.openPL  ?? 0,
    buyQty:     p.buyQty  ?? 0,
    sellQty:    p.sellQty ?? 0,
  }));
}

// ── ORDERS ────────────────────────────────────────────────
async function placeOrder({ symbol, action, qty, orderType = 'Market', price, stopPrice }) {
  const acc       = await getPrimaryAccount();
  const contract  = await tvGet('/contract/find', { name: symbol });
  if (!contract || !contract.id) {
    const suggestions = await searchContracts(symbol);
    const hint = suggestions.length
      ? ` Podpowiedzi: ${suggestions.slice(0, 5).map(c => c.name).join(', ')}`
      : '';
    throw new Error(`Kontrakt nieznaleziony: ${symbol}.${hint}`);
  }

  const body = {
    accountSpec: acc.name,
    accountId:   acc.id,
    action,
    symbol,
    orderQty:    qty,
    orderType,
    isAutomated: true,
  };
  if (orderType === 'Limit' || orderType === 'StopLimit') body.price     = price;
  if (orderType === 'Stop'  || orderType === 'StopLimit') body.stopPrice = stopPrice;

  const result = _assertOrderAccepted(await tvPost('/order/placeorder', body));
  logger.info(`[tradovate] order accepted: ${action} ${qty} ${symbol}`);
  return {
    ...result,
    symbol,
    contractId: contract.id,
    accountId: acc.id,
    accountName: acc.name,
  };
}

async function closePosition(positionId) {
  const acc      = await getPrimaryAccount();
  const positions = await getPositions();
  const pos      = positions.find(p => p.id === positionId);
  if (!pos) throw new Error(`Pozycja ${positionId} nieznaleziona`);
  return tvPost('/order/liquidateposition', {
    accountSpec: acc.name,
    accountId:   acc.id,
    contractId:  pos.contractId,
    isAutomated: true,
  });
}

// ── HISTORY ───────────────────────────────────────────────
async function getOrderHistory(limit = 50) {
  const acc   = await getPrimaryAccount();
  const fills = await tvGet('/fill/list');
  return fills
    .filter(f => f.accountId === acc.id)
    .slice(-limit).reverse()
    .map(f => ({
      id:         f.id,
      symbol:     f.contract?.name || String(f.contractId),
      action:     f.action,
      qty:        f.qty,
      price:      f.price,
      commission: f.commission ?? 0,
      tradeTime:  f.tradeTime,
    }));
}

async function searchContracts(query) {
  const results = await tvGet('/contract/suggest', { t: query, l: 10 });
  return (results || []).map(c => ({ id: c.id, name: c.name, description: c.description }));
}

module.exports = {
  isConnected,
  hasCredentials,
  setCredentials,
  loadCredentialsFromDb,
  saveCredentialsToDb,
  initiateAuth,
  completeAuth,
  renewToken,
  getAccountSummary,
  getPositions,
  placeOrder,
  closePosition,
  getOrderHistory,
  searchContracts,
};
