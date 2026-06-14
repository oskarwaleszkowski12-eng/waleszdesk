const express      = require('express');
const cors         = require('cors');
const cookieParser = require('cookie-parser');
const path         = require('path');
const crypto       = require('crypto');
const jwt          = require('jsonwebtoken');
const http         = require('http');
const helmet       = require('helmet');
const rateLimit    = require('express-rate-limit');
const pinoHttp     = require('pino-http');
const Sentry       = require('@sentry/node');

const logger    = require('./lib/logger');
const config    = require('./lib/config');
const { serveWithCsp } = require('./lib/csp');
const { initDb } = require('./lib/db');
const { decrypt } = require('./lib/crypto');
const { requireAuth } = require('./lib/auth');
const { validate, z } = require('./lib/validate');
const { startPoller } = require('./lib/poller');
const setupWS   = require('./ws');
const startBotEngine = require('./botEngine');
const { startEngineScheduler } = require('./lib/engineScheduler');

const authRoutes        = require('./routes/auth');
const tradingRoutes = require('./routes/trading');
const pnlRoutes     = require('./routes/pnl');
const statsRoutes   = require('./routes/stats');
const botsRoutes    = require('./routes/bots');
const algoRoutes    = require('./routes/algo');
const journalRoutes = require('./routes/journal');
const fundedRoutes      = require('./routes/funded');
const waitlistRoutes    = require('./routes/waitlist');
const subscriberRoutes  = require('./routes/subscriber');
const messagesRoutes    = require('./routes/messages');
const attachmentsRoutes = require('./routes/attachments');
const engineRoutes      = require('./routes/engine');

// Fail fast if critical secrets are missing or too weak
['JWT_SECRET', 'ENCRYPTION_KEY', 'ADMIN_PASSWORD'].forEach(k => {
  if (!process.env[k]) {
    console.error(`FATAL: env var ${k} is not set — refusing to start`);
    process.exit(1);
  }
});
if ((process.env.ENCRYPTION_KEY || '').length < 32) {
  console.error('FATAL: ENCRYPTION_KEY must be at least 32 characters');
  process.exit(1);
}

// Sentry — capture unhandled errors in production. DSN-less init = no-op.
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn:                 process.env.SENTRY_DSN,
    environment:         process.env.NODE_ENV || 'development',
    tracesSampleRate:    0.1,
    profilesSampleRate:  0,
  });
  logger.info('[sentry] initialized');
}

const app = express();

// Railway sits behind a reverse proxy — trust one hop so rate limiter sees real client IP
app.set('trust proxy', 1);

// Force HTTPS in production (Railway terminates TLS and sets x-forwarded-proto)
app.use((req, res, next) => {
  if (process.env.NODE_ENV === 'production' && req.headers['x-forwarded-proto'] !== 'https') {
    const host = req.headers.host || '';
    if (!/^[a-zA-Z0-9.\-:]+$/.test(host)) return res.status(400).end();
    return res.redirect(301, 'https://' + host + req.url);
  }
  next();
});

// Request ID + Server-Timing — enables tracing under 50+ user load
app.use((req, res, next) => {
  const id = req.headers['x-request-id'] || crypto.randomBytes(8).toString('hex');
  req.id = id;
  res.setHeader('X-Request-Id', id);
  const start = process.hrtime.bigint();
  const origWriteHead = res.writeHead.bind(res);
  res.writeHead = function (...args) {
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    try { res.setHeader('Server-Timing', `app;dur=${ms.toFixed(1)}`); } catch {}
    return origWriteHead(...args);
  };
  next();
});

app.use(pinoHttp({
  logger,
  autoLogging: { ignore: req => req.url === '/api/status' },
  customProps: req => ({ reqId: req.id }),
  serializers: {
    req(req) {
      const raw = req.res?.locals?._lb;
      const body = raw && typeof raw === 'object' ? { ...raw } : undefined;
      if (body) {
        const mask = ['password', 'apiSecret', 'secret', 'key', 'apiKey', 'passphrase', 'apiPassphrase', 'code'];
        mask.forEach(f => { if (f in body) body[f] = '[REDACTED]'; });
      }
      return { method: req.method, url: req.url, body };
    },
  },
}));
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '512kb' }));
app.use((req, res, next) => { res.locals._lb = req.body; next(); });
app.use(cookieParser());
app.use(cors({ origin: config.ALLOWED_ORIGIN, credentials: true, maxAge: 86400 }));

// ── HTML pages with CSP nonce (must be before express.static) ────────────────
const ROOT = path.join(__dirname);
app.get('/',                 serveWithCsp(path.join(ROOT, 'index.html')));
app.get('/funded',           serveWithCsp(path.join(ROOT, 'funded.html')));
app.get('/funded-by-walesz', serveWithCsp(path.join(ROOT, 'funded-by-walesz.html')));
app.get('/subscriber',       serveWithCsp(path.join(ROOT, 'subscriber.html')));
app.get('/algo',             serveWithCsp(path.join(ROOT, 'algo.html')));
app.get('/engine',           serveWithCsp(path.join(ROOT, 'engine.html')));
app.get('/:page.html',       (req, res) => res.redirect(301, '/' + req.params.page));

// Static assets (JS, CSS, images, etc.) — index:false so / uses route above
app.use(express.static(ROOT, { index: false }));

const limiter             = rateLimit({ windowMs: 60_000,      max: 120, standardHeaders: true, legacyHeaders: false });
const authLimiter         = rateLimit({ windowMs: 60_000,      max: 10,  standardHeaders: true, legacyHeaders: false });
const algoFlowLimiter     = rateLimit({ windowMs: 60_000,      max: 30,  standardHeaders: true, legacyHeaders: false });
const verifyInviteLimiter = rateLimit({ windowMs: 60 * 60_000, max: 10,  standardHeaders: true, legacyHeaders: false });
const waitlistLimiter     = rateLimit({ windowMs: 60_000,      max: 5,   standardHeaders: true, legacyHeaders: false });
const contactLimiter      = rateLimit({ windowMs: 60_000,      max: 5,   standardHeaders: true, legacyHeaders: false });
app.use('/api/', limiter);
app.use('/api/auth/', authLimiter);
app.use('/api/subscriber/', authLimiter);
app.use('/api/algo/', algoFlowLimiter);
app.use('/api/algo/verify-invite', verifyInviteLimiter);
app.use('/api/waitlist', waitlistLimiter);
app.use((req, res, next) => {
  if (req.path === '/api/messages' && req.method === 'POST') return contactLimiter(req, res, next);
  next();
});

// Public route allowlist (rest are protected by requireAuth)
const publicAlgoRoutes = new Set([
  '/algo/available-bots',
  '/algo/verify-keys',
  '/algo/launch',
  '/algo/status',
  '/algo/verify-invite',
]);

// Auth guard — public: /status, /auth/*, /subscriber/* (own auth), selected algo routes, POST /waitlist, POST /messages
app.use('/api', (req, res, next) => {
  if (
    req.path === '/status' ||
    req.path.startsWith('/auth/') ||
    req.path.startsWith('/subscriber/') ||
    publicAlgoRoutes.has(req.path) ||
    (req.path === '/waitlist' && req.method === 'POST') ||
    (req.path === '/messages' && req.method === 'POST')
  ) return next();
  requireAuth(req, res, next);
});

// Routes
app.use('/api/auth', authRoutes);
app.use('/api', tradingRoutes);
app.use('/api/pnl', pnlRoutes);
app.use('/api', statsRoutes);
app.use('/api/bots', botsRoutes);
app.use('/api/algo', algoRoutes);
app.use('/api/journal', journalRoutes);
app.use('/api/funded', fundedRoutes);
app.use('/api/waitlist', waitlistRoutes);
app.use('/api/subscriber', subscriberRoutes);
app.use('/api/messages', messagesRoutes);
app.use('/api/attachments', attachmentsRoutes);
app.use('/api/engine', engineRoutes);

// ── 404 handler ──────────────────────────────────────────────────────────────
app.use((req, res) => {
  if (req.path.startsWith('/api/'))
    return res.status(404).json({ ok: false, error: 'Not found' });
  res.status(404).end('Not found');
});

// ── Global error handler ──────────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  logger.error({ err, method: req.method, url: req.url, reqId: req.id }, '[server] unhandled error');
  if (process.env.SENTRY_DSN) {
    Sentry.withScope(scope => {
      scope.setTag('reqId', req.id);
      scope.setExtra('url', req.url);
      scope.setExtra('method', req.method);
      Sentry.captureException(err);
    });
  }
  const status = err.status || err.statusCode || 500;
  const msg    = process.env.NODE_ENV === 'production' ? 'Internal server error' : (err.message || 'Internal server error');
  res.status(status).json({ ok: false, errorCode: 'INTERNAL', error: msg });
});

// ── HTTP + WebSocket server ───────────────────────────────────────────────────
const server = http.createServer(app);
const stopWS = setupWS(server, config.JWT_SECRET);

const tv = require('./lib/tradovate');

const shutdownHooks = [stopWS];

initDb()
  .then(async () => {
    shutdownHooks.push(startPoller(require('./lib/db').pool));
    shutdownHooks.push(startBotEngine({ pool: require('./lib/db').pool, decrypt }));
    shutdownHooks.push(startEngineScheduler());
    await tv.loadCredentialsFromDb();
  })
  .catch(err => logger.error({ err }, '[DB] init failed'));

server.listen(config.PORT, '0.0.0.0', () =>
  logger.info(`WaleszDesk running on 0.0.0.0:${config.PORT}`)
);

let _shuttingDown = false;
function shutdown(signal) {
  if (_shuttingDown) return;
  _shuttingDown = true;
  logger.info({ signal }, '[shutdown] received — stopping background work');

  // Hard kill if anything hangs
  const hardKill = setTimeout(() => {
    logger.error('[shutdown] hard timeout — force exit');
    process.exit(1);
  }, 15_000);
  hardKill.unref();

  // Stop schedulers, bot engine, poller, ws
  for (const stop of shutdownHooks) {
    try { stop && stop(); } catch (e) { logger.warn({ err: e }, '[shutdown] hook failed'); }
  }

  // Stop accepting new HTTP, then drain DB pool
  server.close(() => {
    logger.info('[shutdown] HTTP server closed — draining DB pool');
    require('./lib/db').pool.end()
      .then(() => { logger.info('[shutdown] DB pool drained — exit'); process.exit(0); })
      .catch(err => { logger.error({ err }, '[shutdown] DB drain error'); process.exit(1); });
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, '[server] unhandledRejection — check async code');
  if (process.env.SENTRY_DSN) Sentry.captureException(reason);
});

process.on('uncaughtException', (err) => {
  logger.error({ err }, '[server] uncaughtException — shutting down');
  if (process.env.SENTRY_DSN) {
    Sentry.captureException(err);
    Sentry.flush(2000).finally(() => process.exit(1));
  } else {
    process.exit(1);
  }
});
