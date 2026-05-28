const express   = require('express');
const cors      = require('cors');
const path      = require('path');
const jwt       = require('jsonwebtoken');
const http      = require('http');
const helmet    = require('helmet');
const rateLimit = require('express-rate-limit');
const pinoHttp  = require('pino-http');

const logger    = require('./lib/logger');
const config    = require('./lib/config');
const { initDb } = require('./lib/db');
const { decrypt } = require('./lib/crypto');
const { requireAuth } = require('./lib/auth');
const { validate, z } = require('./lib/validate');
const { startPoller } = require('./lib/poller');
const setupWS   = require('./ws');
const startBotEngine = require('./botEngine');

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
app.use(cors({ origin: config.ALLOWED_ORIGIN }));
app.use(express.static(path.join(__dirname)));

const limiter     = rateLimit({ windowMs: 60_000, max: 120, standardHeaders: true, legacyHeaders: false });
const authLimiter = rateLimit({ windowMs: 60_000, max: 10,  standardHeaders: true, legacyHeaders: false });
app.use('/api/', limiter);
app.use('/api/auth/', authLimiter);
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

app.post('/api/auth/login', validate(loginSchema), (req, res) => {
  const { password } = req.body;
  if (!config.ADMIN_PASS || password !== config.ADMIN_PASS)
    return res.status(401).json({ ok: false, error: 'Invalid password' });
  const token = jwt.sign({ role: 'admin' }, config.JWT_SECRET, { expiresIn: '24h' });
  logger.info('[auth] login success');
  res.json({ ok: true, token });
});

// Auth guard — public: /status, /auth/*, selected onboarding /algo routes, POST /waitlist
app.use('/api', (req, res, next) => {
  if (
    req.path === '/status' ||
    req.path.startsWith('/auth/') ||
    publicAlgoRoutes.has(req.path) ||
    (req.path === '/waitlist' && req.method === 'POST') ||
    (req.path === '/subscriber/login' && req.method === 'POST') ||
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
app.get('/subscriber', (req, res) => res.sendFile(path.join(__dirname, 'subscriber.html')));
app.get('/funded', (req, res) => res.sendFile(path.join(__dirname, 'funded.html')));
app.get('/funded-by-walesz', (req, res) => res.sendFile(path.join(__dirname, 'funded-by-walesz.html')));
app.get('/algo', (req, res) => res.sendFile(path.join(__dirname, 'algo.html')));

// HTTP + WebSocket server
const server = http.createServer(app);
setupWS(server, config.JWT_SECRET);

const tv = require('./lib/tradovate');

initDb()
  .then(async () => {
    startPoller(require('./lib/db').pool);
    startBotEngine({ pool: require('./lib/db').pool, decrypt });
    await tv.loadCredentialsFromDb();
  })
  .catch(err => logger.error({ err }, '[DB] init failed'));

server.listen(config.PORT, '0.0.0.0', () =>
  logger.info(`WaleszDesk running on 0.0.0.0:${config.PORT}`)
);
