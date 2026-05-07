'use strict';
const BybitClient   = require('./bybit');
const BinanceClient = require('./binance');
const OkxClient     = require('./okx');
const BitgetClient  = require('./bitget');
const MexcClient    = require('./mexc');
const BlofinClient  = require('./blofin');

function createExchangeClient(exchange, apiKey, apiSecret, passphrase) {
  switch ((exchange || 'bybit').toLowerCase()) {
    case 'binance': return new BinanceClient(apiKey, apiSecret);
    case 'okx':     return new OkxClient(apiKey, apiSecret, passphrase);
    case 'bitget':  return new BitgetClient(apiKey, apiSecret, passphrase);
    case 'mexc':    return new MexcClient(apiKey, apiSecret);
    case 'blofin':  return new BlofinClient(apiKey, apiSecret, passphrase);
    default:        return new BybitClient(apiKey, apiSecret);
  }
}

module.exports = { createExchangeClient };
