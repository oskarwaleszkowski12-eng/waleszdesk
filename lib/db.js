const { Pool } = require('pg');
const logger   = require('./logger');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bots (
      id         SERIAL       PRIMARY KEY,
      name       VARCHAR(100) NOT NULL,
      type       VARCHAR(10)  NOT NULL,
      symbol     VARCHAR(20)  NOT NULL,
      status     VARCHAR(20)  NOT NULL DEFAULT 'active',
      config     JSONB        NOT NULL DEFAULT '{}',
      stats      JSONB        NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS bot_trades (
      id         SERIAL       PRIMARY KEY,
      bot_id     INTEGER      NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
      order_id   VARCHAR(100),
      side       VARCHAR(10),
      qty        DECIMAL(20,8),
      price      DECIMAL(20,8),
      status     VARCHAR(20)  DEFAULT 'open',
      meta       JSONB        DEFAULT '{}',
      created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`
    ALTER TABLE bots
      ADD COLUMN IF NOT EXISTS api_key_enc        TEXT,
      ADD COLUMN IF NOT EXISTS api_secret_enc     TEXT,
      ADD COLUMN IF NOT EXISTS api_passphrase_enc TEXT,
      ADD COLUMN IF NOT EXISTS subaccount_name    VARCHAR(100),
      ADD COLUMN IF NOT EXISTS allocated_balance  DECIMAL(20,2),
      ADD COLUMN IF NOT EXISTS exchange           VARCHAR(20) DEFAULT 'bybit';
  `);
  logger.info('[DB] bots tables ready');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS algo_templates (
      id              SERIAL PRIMARY KEY,
      name            VARCHAR(100) NOT NULL,
      description     TEXT,
      type            VARCHAR(10)  NOT NULL,
      symbol          VARCHAR(20)  NOT NULL,
      config          JSONB        NOT NULL DEFAULT '{}',
      risk_level      VARCHAR(10)  DEFAULT 'Medium',
      est_monthly_pct DECIMAL(6,2),
      min_capital     DECIMAL(20,2) DEFAULT 50,
      active          BOOLEAN      DEFAULT TRUE,
      created_at      TIMESTAMPTZ  DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS algo_users (
      id                 SERIAL PRIMARY KEY,
      api_key_enc        TEXT NOT NULL,
      api_secret_enc     TEXT NOT NULL,
      api_passphrase_enc TEXT,
      uid                VARCHAR(50),
      exchange           VARCHAR(20) DEFAULT 'bybit',
      balance_at_signup  DECIMAL(20,2),
      bot_template_id    INTEGER REFERENCES algo_templates(id),
      allocated_capital  DECIMAL(20,2),
      bot_id             INTEGER REFERENCES bots(id) ON DELETE SET NULL,
      status             VARCHAR(20) DEFAULT 'active',
      created_at         TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await pool.query(`
    ALTER TABLE algo_users
      ADD COLUMN IF NOT EXISTS api_passphrase_enc TEXT,
      ADD COLUMN IF NOT EXISTS exchange           VARCHAR(20) DEFAULT 'bybit';
  `);
  logger.info('[DB] algo tables ready');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS trades (
      id          SERIAL PRIMARY KEY,
      symbol      VARCHAR(20)  NOT NULL,
      side        VARCHAR(10)  NOT NULL,
      entry_price DECIMAL(20,8),
      exit_price  DECIMAL(20,8),
      size        DECIMAL(20,8),
      pnl         DECIMAL(20,8),
      open_time   TIMESTAMPTZ,
      close_time  TIMESTAMPTZ,
      notes       TEXT  DEFAULT '',
      checklist   JSONB DEFAULT '{"trend":false,"entry":false,"sl":false,"reason":false}'
    );
    CREATE UNIQUE INDEX IF NOT EXISTS trades_symbol_close_time ON trades(symbol, close_time);
  `);
  logger.info('[DB] trades table ready');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS invite_codes (
      id         SERIAL      PRIMARY KEY,
      code       VARCHAR(20) NOT NULL UNIQUE,
      label      VARCHAR(100) DEFAULT '',
      used       BOOLEAN     NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  logger.info('[DB] invite_codes table ready');
}

module.exports = { pool, initDb };
