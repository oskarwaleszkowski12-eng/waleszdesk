const { apiGet } = require('./_utils');

module.exports = async (req, res) => {
  try {
    const data = await apiGet('/v5/position/list', { category: 'linear', settleCoin: 'USDT' });
    if (data.retCode !== 0) return res.status(400).json({ ok: false, error: data.retMsg });
    const positions = (data.result?.list || []).filter(p => parseFloat(p.size) > 0).map(p => ({
      symbol: p.symbol, side: p.side, size: p.size,
      entryPrice: p.avgPrice, liqPrice: p.liqPrice,
      unrealisedPnl: parseFloat(p.unrealisedPnl).toFixed(2), leverage: p.leverage,
    }));
    res.json({ ok: true, positions });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
};
