'use strict';
const logger = require('../lib/logger');

function isTimestampError(err) {
  const data = err?.response?.data;
  const msg  = (typeof data === 'object' ? data?.msg || data?.message || '' : String(data || ''))
             + (err?.message || '');
  const low  = msg.toLowerCase();
  return low.includes('timestamp') || low.includes('expired') || low.includes('signature');
}

async function withRetry(fn, exchange, maxRetries = 2) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const isAuthErr = isTimestampError(err);
      if (isAuthErr) {
        logger.warn({ exchange, attempt, msg: err?.response?.data?.msg || err.message }, `[${exchange}] timestamp/signature error`);
      }
      if (attempt < maxRetries && isAuthErr) {
        await new Promise(r => setTimeout(r, 100));
        continue;
      }
      if (!isAuthErr && err?.response?.status === 401) {
        logger.error({ exchange, status: 401 }, `[${exchange}] auth error`);
      }
      throw err;
    }
  }
}

module.exports = { isTimestampError, withRetry };
