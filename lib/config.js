module.exports = {
  PORT:           process.env.PORT || 3001,
  API_KEY:        process.env.BYBIT_API_KEY,
  API_SECRET:     process.env.BYBIT_API_SECRET,
  BASE:           process.env.BYBIT_TESTNET === 'true'
                    ? 'https://api-testnet.bybit.com'
                    : 'https://api.bybit.com',
  JWT_SECRET:     process.env.JWT_SECRET     || 'waleszdesk-jwt-secret-dev',
  ADMIN_PASS:     process.env.ADMIN_PASSWORD || '',
  ENCRYPTION_KEY: process.env.ENCRYPTION_KEY || 'waleszdesk-dev-default-key',
  ALLOWED_ORIGIN: process.env.ALLOWED_ORIGIN || '*',
};
