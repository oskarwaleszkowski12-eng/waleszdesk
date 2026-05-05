const { getConfig } = require('./_utils');

module.exports = (req, res) => {
  const { testnet, apiKey } = getConfig();
  res.json({ ok: true, testnet, hasKeys: !!apiKey, server: 'WaleszDesk v1.3' });
};
