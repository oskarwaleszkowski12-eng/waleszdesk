const { apiGet } = require('./_utils');

module.exports = async (req, res) => {
  try {
    const data = await apiGet('/v5/order/history', { category: 'linear', limit: '20' });
    if (data.retCode !== 0) return res.status(400).json({ ok: false, error: data.retMsg });
    res.json({ ok: true, orders: data.result?.list || [] });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
};
