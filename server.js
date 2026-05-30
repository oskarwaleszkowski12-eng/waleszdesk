const express      = require('express');
const cors         = require('cors');
const cookieParser = require('cookie-parser');
const path         = require('path');
const jwt          = require('jsonwebtoken');
const http         = require('http');
const helmet       = require('helmet');
const rateLimit    = require('express-rate-limit');
const pinoHttp     = require('pino-http');

const logger    = require('./lib/logger');
const config    = require('./lib/config');
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

// Force HTTPS in production (Railway terminates TLS and sets x-forwarded-proto)
app.use((req, res, next) => {
  if (process.env.NODE_ENV === 'production' && req.headers['x-forwarded-proto'] !== 'https')
    return res.redirect(301, 'https://' + req.headers.host + req.url);
  next();
});

app.use(pinoHttp({ logger, autoLogging: { ignore: req => req.url === '/api/status' } }));
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json());
app.use(cookieParser());
app.use(cors({ origin: config.ALLOWED_ORIGIN, credentials: true }));
app.use(express.static(path.join(__dirname)));

const limiter     = rateLimit({ windowMs: 60_000, max: 120, standardHeaders: true, legacyHeaders: false });
const authLimiter = rateLimit({ windowMs: 60_000, max: 10,  standardHeaders: true, legacyHeaders: false });
app.use('/api/', limiter);
app.use('/api/auth/', authLimiter);
app.use('/api/subscriber/', authLimiter);
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

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
  if (!config.ADMIN_PASS || password !== config.ADMIN_PASS)
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
app.get('/subscriber', (req, res) => res.sendFile(path.join(__dirname, 'subscriber.html')));
app.get('/funded', (req, res) => res.sendFile(path.join(__dirname, 'funded.html')));
app.get('/funded-by-walesz', (req, res) => res.sendFile(path.join(__dirname, 'funded-by-walesz.html')));
app.get('/algo',   (req, res) => res.sendFile(path.join(__dirname, 'algo.html')));
app.get('/engine', (req, res) => res.sendFile(path.join(__dirname, 'engine.html')));

// HTTP + WebSocket server
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
