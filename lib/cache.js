'use strict';
const logger = require('./logger');

// Per-key TTLs — balance changes slow, ticker fast.
const TTL = {
  balance:   30_000,
  ticker:    15_000,
  positions: 10_000,
  generic:   30_000,
};

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

// In-memory fallback (LRU-ish: prune on miss)
const memCache = new Map();

function memPrune() {
  const now = Date.now();
  for (const [k, v] of memCache) {
    if (v.expiresAt <= now) memCache.delete(k);
  }
}

async function _get(key) {
  if (redis) {
    try {
      const v = await redis.get(key);
      if (v !== null) return JSON.parse(v);
    } catch {}
    return null;
  }
  const hit = memCache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.value;
  if (Math.random() < 0.01) memPrune();
  return null;
}

async function _set(key, value, ttlMs) {
  if (redis) {
    redis.set(key, JSON.stringify(value), 'PX', ttlMs).catch(() => {});
  } else {
    memCache.set(key, { value, expiresAt: Date.now() + ttlMs });
  }
}

async function cached(key, ttlMs, fetchFn) {
  const hit = await _get(key);
  if (hit !== null && hit !== undefined) return hit;
  try {
    const value = await fetchFn();
    if (value !== null && value !== undefined) await _set(key, value, ttlMs);
    return value;
  } catch {
    return null;
  }
}

// ── Specialized helpers ──────────────────────────────────────────────────────
async function getCachedBalance(botId, fetchFn) {
  return cached(`balance:${botId}`, TTL.balance, fetchFn);
}

async function getCachedTicker(exchange, symbol, fetchFn) {
  return cached(`ticker:${exchange}:${symbol}`, TTL.ticker, fetchFn);
}

async function getCachedPositions(botId, fetchFn) {
  return cached(`positions:${botId}`, TTL.positions, fetchFn);
}

function invalidate(prefix) {
  if (redis) {
    // Best-effort; SCAN+DEL avoids blocking on large keyspaces
    const stream = redis.scanStream({ match: `${prefix}*` });
    stream.on('data', keys => { if (keys.length) redis.unlink(...keys).catch(() => {}); });
    stream.on('error', () => {});
    return;
  }
  for (const k of memCache.keys()) if (k.startsWith(prefix)) memCache.delete(k);
}

module.exports = { getCachedBalance, getCachedTicker, getCachedPositions, cached, invalidate };
