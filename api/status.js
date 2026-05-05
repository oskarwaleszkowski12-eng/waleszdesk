const { CONFIG } = require('./_utils');

module.exports = (req, res) => {
  res.json({ ok: true, testnet: CONFIG.testnet, hasKeys: !!CONFIG.apiKey, server: 'WaleszDesk v1.3' });
};
