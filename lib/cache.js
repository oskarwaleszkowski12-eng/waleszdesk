'use strict';
const logger = require('./logger');

const TTL_MS = 30_000;

// Redis (optional) — activated when REDIS_URL env var is set
let redis = null;
if (process.env.REDIS_URL) {
  try {
    const Redis = require('ioredis');
    redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 1, enableReadyCheck: false });
    redis.on('error', err => logger.warn({ err }, '[cache] Redis error'));
    redis.on('connect', () => logger.info('[cache] Redis connected'));
  } catch (e) {
    logger.warn({ err: e }, '[cache] ioredis unavailable, falling back to in-memory');
  }
}

// In-memory fallback
const memCache = new Map();

async function getCachedBalance(botId, fetchFn) {
  const key = `balance:${botId}`;

  if (redis) {
    try {
      const v = await redis.get(key);
      if (v !== null) return parseFloat(v);
    } catch {}
  } else {
    const hit = memCache.get(botId);
    if (hit && Date.now() - hit.ts < TTL_MS) return hit.balance;
  }

  try {
    const balance = await fetchFn();
    if (redis) {
      redis.set(key, balance, 'PX', TTL_MS).catch(() => {});
    } else {
      memCache.set(botId, { balance, ts: Date.now() });
    }
    return balance;
  } catch {
    return null;
  }
}

module.exports = { getCachedBalance };
