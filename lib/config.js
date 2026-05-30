module.exports = {
  PORT:                process.env.PORT || 3001,
  TRADOVATE_USERNAME:  process.env.TRADOVATE_USERNAME  || '',
  TRADOVATE_PASSWORD:  process.env.TRADOVATE_PASSWORD  || '',
  TRADOVATE_IS_DEMO:   process.env.TRADOVATE_IS_DEMO !== 'false',
  TRADOVATE_CID:       process.env.TRADOVATE_CID       || '',
  TRADOVATE_SEC:       process.env.TRADOVATE_SEC       || '',
  API_KEY:             process.env.BYBIT_API_KEY,
  API_SECRET:          process.env.BYBIT_API_SECRET,
  BASE:                process.env.BYBIT_TESTNET === 'true'
                         ? 'https://api-testnet.bybit.com'
                         : 'https://api.bybit.com',
  JWT_SECRET:          process.env.JWT_SECRET          || null,
  ADMIN_PASS:          process.env.ADMIN_PASSWORD       || null,
  ENCRYPTION_KEY:      process.env.ENCRYPTION_KEY       || null,
  ALLOWED_ORIGIN:      process.env.ALLOWED_ORIGIN       || '*',
  REDIS_URL:           process.env.REDIS_URL            || '',
  TELEGRAM_BOT_TOKEN:  process.env.TELEGRAM_BOT_TOKEN   || '',
  TELEGRAM_CHAT_ID:    process.env.TELEGRAM_CHAT_ID     || '',
  RESEND_API_KEY:      process.env.RESEND_API_KEY        || '',
  RESEND_FROM:         process.env.RESEND_FROM           || 'Funded by Walesz <onboarding@resend.dev>',
};
