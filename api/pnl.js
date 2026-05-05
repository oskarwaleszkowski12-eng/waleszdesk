const { apiGet } = require('./_utils');

module.exports = async (req, res) => {
  try {
    const posData = await apiGet('/v5/position/list', { category: 'linear', settleCoin: 'USDT' });
    let unrealised = 0;
    if (posData.retCode === 0) {
      (posData.result?.list || []).forEach(p => {
        unrealised += parseFloat(p.unrealisedPnl || 0);
      });
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const startMs = today.getTime().toString();

    const closedData = await apiGet('/v5/position/closed-pnl', {
      category: 'linear',
      startTime: startMs,
      limit: '50',
    });
    let realisedToday = 0;
    if (closedData.retCode === 0) {
      (closedData.result?.list || []).forEach(p => {
        realisedToday += parseFloat(p.closedPnl || 0);
      });
    }

    const allTimeData = await apiGet('/v5/position/closed-pnl', {
      category: 'linear',
      limit: '200',
    });
    let realisedAllTime = 0;
    if (allTimeData.retCode === 0) {
      (allTimeData.result?.list || []).forEach(p => {
        realisedAllTime += parseFloat(p.closedPnl || 0);
      });
    }

    res.json({
      ok: true,
      unrealised:      parseFloat(unrealised.toFixed(4)),
      realisedToday:   parseFloat(realisedToday.toFixed(4)),
      realisedAllTime: parseFloat(realisedAllTime.toFixed(4)),
      totalToday:      parseFloat((realisedToday + unrealised).toFixed(4)),
      totalAllTime:    parseFloat((realisedAllTime + unrealised).toFixed(4)),
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
};
