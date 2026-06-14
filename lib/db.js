const { Pool } = require('pg');
const logger   = require('./logger');

const pool = new Pool({
  connectionString:      process.env.DATABASE_URL,
  ssl:                   process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
  max:                   20,   // support ~50 concurrent users (each request holds connection briefly)
  min:                   2,    // keep 2 warm in idle
  idleTimeoutMillis:     30_000,
  connectionTimeoutMillis: 3_000,
});

pool.on('error', err => logger.error({ err }, '[DB] pool error'));

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
      ADD COLUMN IF NOT EXISTS exchange           VARCHAR(20) DEFAULT 'bybit',
      ADD COLUMN IF NOT EXISTS webhook_secret     TEXT;
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

  await pool.query(`
    CREATE TABLE IF NOT EXISTS funded_settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  logger.info('[DB] funded_settings table ready');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS waitlist (
      id         SERIAL PRIMARY KEY,
      email      TEXT NOT NULL UNIQUE,
      plan       TEXT NOT NULL DEFAULT 'pro' CHECK (plan IN ('pro', 'vip', 'mentoring')),
      name       TEXT,
      message    TEXT,
      ip         TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS waitlist_email_idx ON waitlist(email)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS waitlist_plan_idx  ON waitlist(plan)`);
  logger.info('[DB] waitlist table ready');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS subscribers (
      id           SERIAL PRIMARY KEY,
      email        TEXT NOT NULL UNIQUE,
      name         TEXT,
      plan         TEXT NOT NULL DEFAULT 'pro' CHECK (plan IN ('pro', 'vip', 'mentoring')),
      status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'expired')),
      code_hash    TEXT NOT NULL,
      waitlist_id  INTEGER REFERENCES waitlist(id) ON DELETE SET NULL,
      notes        TEXT,
      activated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at   TIMESTAMPTZ
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS subscribers_email_idx ON subscribers(email)`);
  logger.info('[DB] subscribers table ready');

  await pool.query(`ALTER TABLE trades ADD COLUMN IF NOT EXISTS published BOOLEAN NOT NULL DEFAULT FALSE`);
  await pool.query(`ALTER TABLE trades ADD COLUMN IF NOT EXISTS program_notes TEXT NOT NULL DEFAULT ''`);
  logger.info('[DB] trades.published + program_notes ready');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS journal_posts (
      id          SERIAL PRIMARY KEY,
      title       TEXT NOT NULL,
      content     TEXT NOT NULL,
      plan_access TEXT NOT NULL DEFAULT 'pro' CHECK (plan_access IN ('pro', 'vip', 'mentoring')),
      published   BOOLEAN NOT NULL DEFAULT TRUE,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  logger.info('[DB] journal_posts table ready');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS conversations (
      id            SERIAL PRIMARY KEY,
      from_email    TEXT NOT NULL,
      from_name     TEXT,
      subject       TEXT NOT NULL DEFAULT 'Wiadomość',
      source        TEXT NOT NULL DEFAULT 'contact' CHECK (source IN ('contact', 'subscriber')),
      subscriber_id INTEGER REFERENCES subscribers(id) ON DELETE SET NULL,
      status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
      unread_admin  BOOLEAN NOT NULL DEFAULT TRUE,
      unread_sub    BOOLEAN NOT NULL DEFAULT FALSE,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id              SERIAL PRIMARY KEY,
      conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      sender          TEXT NOT NULL CHECK (sender IN ('user', 'admin')),
      content         TEXT NOT NULL,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS messages_conv_idx ON messages(conversation_id)`);
  logger.info('[DB] conversations + messages tables ready');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS attachments (
      id         SERIAL PRIMARY KEY,
      ref_type   TEXT NOT NULL DEFAULT 'pending',
      ref_id     INTEGER NOT NULL DEFAULT 0,
      filename   TEXT NOT NULL DEFAULT 'image',
      mime_type  TEXT NOT NULL,
      data       TEXT NOT NULL,
      size_kb    INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS attachments_ref_idx ON attachments(ref_type, ref_id)`);
  logger.info('[DB] attachments table ready');

  // ── Engine tables ────────────────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS engine_posts (
      id                 SERIAL PRIMARY KEY,
      content            TEXT NOT NULL DEFAULT '',
      platform_overrides JSONB NOT NULL DEFAULT '{}',
      platforms          JSONB NOT NULL DEFAULT '[]',
      image_url          TEXT,
      status             TEXT NOT NULL DEFAULT 'draft',
      scheduled_at       TIMESTAMPTZ,
      published_at       TIMESTAMPTZ,
      publish_results    JSONB NOT NULL DEFAULT '{}',
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS engine_platforms (
      id         SERIAL PRIMARY KEY,
      key        TEXT UNIQUE NOT NULL,
      label      TEXT NOT NULL,
      type       TEXT NOT NULL,
      config     JSONB NOT NULL DEFAULT '{}',
      enabled    BOOLEAN NOT NULL DEFAULT TRUE,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS engine_research_sources (
      id         SERIAL PRIMARY KEY,
      name       TEXT NOT NULL,
      type       TEXT NOT NULL DEFAULT 'rss',
      identifier TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS engine_research_items (
      id           SERIAL PRIMARY KEY,
      source_id    INTEGER REFERENCES engine_research_sources(id) ON DELETE CASCADE,
      author       TEXT NOT NULL DEFAULT '',
      content      TEXT NOT NULL,
      url          TEXT,
      external_id  TEXT,
      published_at TIMESTAMPTZ,
      used         BOOLEAN NOT NULL DEFAULT FALSE,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS eng_research_uniq ON engine_research_items(source_id, external_id) WHERE external_id IS NOT NULL`);
  logger.info('[DB] engine tables ready');

  // ── Performance indexes ──────────────────────────────────────────────────────
  await pool.query(`CREATE INDEX IF NOT EXISTS trades_published_close ON trades(published, close_time DESC NULLS LAST)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS messages_conv_created  ON messages(conversation_id, created_at DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS convs_sub_updated      ON conversations(subscriber_id, updated_at DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS convs_status_idx       ON conversations(status)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS convs_unread_admin_idx ON conversations(unread_admin)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS engine_posts_sched_idx ON engine_posts(status, scheduled_at)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS bot_trades_bot_status  ON bot_trades(bot_id, status)`);
  logger.info('[DB] performance indexes ready');

  // ── Schema hardening ─────────────────────────────────────────────────────
  // Add NOT NULL + defaults to bot_trades trading-critical columns
  await pool.query(`ALTER TABLE bot_trades ALTER COLUMN side   SET NOT NULL`).catch(() => {});
  await pool.query(`ALTER TABLE bot_trades ALTER COLUMN qty    SET NOT NULL`).catch(() => {});
  await pool.query(`ALTER TABLE bot_trades ALTER COLUMN price  SET NOT NULL`).catch(() => {});
  await pool.query(`ALTER TABLE bot_trades ALTER COLUMN status SET NOT NULL`).catch(() => {});
  // Prevent duplicate algo_users for same uid+exchange
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS algo_users_uid_exchange ON algo_users(uid, exchange) WHERE uid IS NOT NULL AND uid != 'unknown'`);
  logger.info('[DB] schema hardening applied');

  // ── App settings (generic key-value store) ────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  logger.info('[DB] app_settings table ready');

  // ── Admin audit log ───────────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_actions (
      id          SERIAL PRIMARY KEY,
      who         TEXT NOT NULL DEFAULT 'admin',
      action      TEXT NOT NULL,
      target_type TEXT,
      target_id   TEXT,
      ip          TEXT,
      meta        JSONB NOT NULL DEFAULT '{}',
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS admin_actions_created_idx ON admin_actions(created_at DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS admin_actions_action_idx  ON admin_actions(action)`);
  logger.info('[DB] admin_actions table ready');

  // ── Bot health columns ────────────────────────────────────────────────────
  await pool.query(`
    ALTER TABLE bots
      ADD COLUMN IF NOT EXISTS last_tick_at    TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS last_trade_at   TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS last_error_msg  TEXT,
      ADD COLUMN IF NOT EXISTS last_error_at   TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS peak_pnl        NUMERIC(20,4) NOT NULL DEFAULT 0
  `);
  logger.info('[DB] bot health columns ready');

  // ── Blok 6 indexes / constraints ─────────────────────────────────────────
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS bot_trades_order_id_uniq ON bot_trades(order_id) WHERE order_id IS NOT NULL`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS attachments_ref_created ON attachments(ref_type, ref_id, created_at DESC)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS trades_symbol_idx ON trades(symbol)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS subscribers_plan_idx ON subscribers(plan)`).catch(() => {});
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS eng_research_sources_uniq ON engine_research_sources(type, identifier)`).catch(() => {});
  logger.info('[DB] Blok 6 indexes ready');
}

module.exports = { pool, initDb };
