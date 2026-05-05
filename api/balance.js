const { apiGet } = require('./_utils');

module.exports = async (req, res) => {
  try {
    let result = null;
    for (const accountType of ['UNIFIED', 'CONTRACT', 'SPOT']) {
      const data = await apiGet('/v5/account/wallet-balance', { accountType });
      if (data.retCode === 0) {
        const account = data.result?.list?.[0] || {};
        const coins   = account.coin || [];
        const usdt    = coins.find(c => c.coin === 'USDT');
        if (usdt) {
          result = {
            balance: parseFloat(usdt.walletBalance || 0).toFixed(2),
            equity:  parseFloat(usdt.equity || usdt.walletBalance || 0).toFixed(2),
            avail:   parseFloat(usdt.availableToWithdraw || usdt.availableToBorrow || usdt.walletBalance || 0).toFixed(2),
          };
          break;
        }
        if (account.totalWalletBalance) {
          result = {
            balance: parseFloat(account.totalWalletBalance).toFixed(2),
            equity:  parseFloat(account.totalEquity || account.totalWalletBalance).toFixed(2),
            avail:   parseFloat(account.totalAvailableBalance || account.totalWalletBalance).toFixed(2),
          };
          break;
        }
      }
    }
    if (!result) return res.status(400).json({ ok: false, error: 'Brak salda USDT. Sprawdz uprawnienia klucza.' });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
};
