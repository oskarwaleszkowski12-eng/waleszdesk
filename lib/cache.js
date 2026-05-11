const balanceCache = new Map();
const BALANCE_TTL  = 30_000;

async function getCachedBalance(botId, fetchFn) {
  const cached = balanceCache.get(botId);
  if (cached && Date.now() - cached.ts < BALANCE_TTL) return cached.balance;
  try {
    const balance = await fetchFn();
    balanceCache.set(botId, { balance, ts: Date.now() });
    return balance;
  } catch {
    return null;
  }
}

module.exports = { getCachedBalance };
