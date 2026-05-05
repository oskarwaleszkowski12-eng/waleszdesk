const { apiPost } = require('./_utils');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });
  try {
    const { symbol, side, orderType, qty, price, stopLoss, takeProfit, leverage } = req.body;
    if (!symbol || !side || !orderType || !qty)
      return res.status(400).json({ ok: false, error: 'Brakujace pola: symbol, side, orderType, qty' });

    if (leverage) {
      await apiPost('/v5/position/set-leverage', {
        category: 'linear', symbol,
        buyLeverage: String(leverage), sellLeverage: String(leverage),
      });
    }

    const qtyNum = parseFloat(qty);
    let qtyStr;
    if (symbol.startsWith('BTC')) {
      qtyStr = qtyNum.toFixed(3);
    } else if (symbol.startsWith('ETH')) {
      qtyStr = qtyNum.toFixed(2);
    } else {
      qtyStr = qtyNum.toFixed(1);
    }
    qtyStr = parseFloat(qtyStr).toString();

    const orderParams = {
      category: 'linear', symbol, side, orderType,
      qty: qtyStr, timeInForce: orderType === 'Market' ? 'IOC' : 'GTC',
    };
    if (orderType === 'Limit' && price)  orderParams.price      = String(price);
    if (stopLoss)   { orderParams.stopLoss   = String(stopLoss);   orderParams.slTriggerBy = 'LastPrice'; }
    if (takeProfit) { orderParams.takeProfit = String(takeProfit); orderParams.tpTriggerBy = 'LastPrice'; }

    const data = await apiPost('/v5/order/create', orderParams);
    if (data.retCode !== 0) return res.status(400).json({ ok: false, error: `Bybit: ${data.retMsg}` });
    res.json({ ok: true, orderId: data.result?.orderId, message: `${side} ${qty} ${symbol} zlezone!` });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
};
