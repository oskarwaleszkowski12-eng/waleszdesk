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

// Fail fast if critical secrets are missing
['JWT_SECRET', 'ENCRYPTION_KEY', 'ADMIN_PASSWORD'].forEach(k => {
  if (!process.env[k]) {
    console.error(`FATAL: env var ${k} is not set — refusing to start`);
    process.exit(1);
  }
});

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

app.use(pinoHttp({
  logger,
  autoLogging: { ignore: req => req.url === '/api/status' },
  serializers: {
    req(req) {
      const body = req.raw?.body ? { ...req.raw.body } : undefined;
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
app.use('/api/', limiter);
app.use('/api/auth/', authLimiter);
app.use('/api/subscriber/', authLimiter);
app.use('/api/algo/', algoFlowLimiter);
app.use('/api/algo/verify-invite', verifyInviteLimiter);

// Auth
const loginSchema = z.object({ password: z.string().min(1) });
const publicAlgoRoutes = new Set([
  '/algo/available-bots',
  '/algo/verify-keys',
  '/algo/launch',
  '/algo/status',
  '/algo/verify-invite',
]);

const COOKIE_OPTS = {
  httpOnly: true,
  secure:   process.env.NODE_ENV === 'production',
  sameSite: 'strict',
};

app.post('/api/auth/login', validate(loginSchema), (req, res) => {
  const { password } = req.body;
  const h1 = crypto.createHmac('sha256', 'wd').update(password || '').digest();
  const h2 = crypto.createHmac('sha256', 'wd').update(config.ADMIN_PASS || '').digest();
  if (!config.ADMIN_PASS || !crypto.timingSafeEqual(h1, h2))
    return res.status(401).json({ ok: false, error: 'Invalid password' });
  const token = jwt.sign({ role: 'admin' }, config.JWT_SECRET, { expiresIn: '24h' });
  res.cookie('wd_admin', token, { ...COOKIE_OPTS, maxAge: 24 * 60 * 60 * 1000 });
  logger.info('[auth] login success');
  res.json({ ok: true });
});

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('wd_admin', COOKIE_OPTS);
  res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => {
  const token = req.cookies?.wd_admin;
  if (!token) return res.status(401).json({ ok: false });
  try {
    const payload = jwt.verify(token, config.JWT_SECRET);
    if (payload.role !== 'admin') return res.status(403).json({ ok: false });
    res.json({ ok: true, role: 'admin' });
  } catch {
    res.status(401).json({ ok: false });
  }
});

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
  logger.error({ err, method: req.method, url: req.url }, '[server] unhandled error');
  const status = err.status || err.statusCode || 500;
  const msg    = process.env.NODE_ENV === 'production' ? 'Internal server error' : (err.message || 'Internal server error');
  res.status(status).json({ ok: false, error: msg });
});

// ── HTTP + WebSocket server ───────────────────────────────────────────────────
const server = http.createServer(app);
setupWS(server, config.JWT_SECRET);

const tv = require('./lib/tradovate');

initDb()
  .then(async () => {
    startPoller(require('./lib/db').pool);
    startBotEngine({ pool: require('./lib/db').pool, decrypt });
    startEngineScheduler();
    await tv.loadCredentialsFromDb();
  })
  .catch(err => logger.error({ err }, '[DB] init failed'));

server.listen(config.PORT, '0.0.0.0', () =>
  logger.info(`WaleszDesk running on 0.0.0.0:${config.PORT}`)
);

process.on('SIGTERM', () => {
  logger.info('[shutdown] SIGTERM received — closing server');
  server.close(() => {
    require('./lib/db').pool.end(() => logger.info('[shutdown] DB pool drained — exit'));
  });
});

process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, '[server] unhandledRejection — check async code');
});

process.on('uncaughtException', (err) => {
  logger.error({ err }, '[server] uncaughtException — shutting down');
  process.exit(1);
});
