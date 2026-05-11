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

const app = express();
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
app.post('/api/auth/login', validate(loginSchema), (req, res) => {
  const { password } = req.body;
  if (!config.ADMIN_PASS || password !== config.ADMIN_PASS)
    return res.status(401).json({ ok: false, error: 'Invalid password' });
  const token = jwt.sign({ role: 'admin' }, config.JWT_SECRET, { expiresIn: '24h' });
  logger.info('[auth] login success');
  res.json({ ok: true, token });
});

// Auth guard — public: /status, /auth/*, /algo/*
app.use('/api', (req, res, next) => {
  if (req.path === '/status' || req.path.startsWith('/auth/') || req.path.startsWith('/algo/') || req.path === '/algo') return next();
  requireAuth(req, res, next);
});

// Routes
app.use('/api', tradingRoutes);
app.use('/api/pnl', pnlRoutes);
app.use('/api', statsRoutes);
app.use('/api/bots', botsRoutes);
app.use('/api/algo', algoRoutes);
app.use('/api/journal', journalRoutes);
app.get('/algo', (req, res) => res.sendFile(path.join(__dirname, 'algo.html')));

// HTTP + WebSocket server
const server = http.createServer(app);
setupWS(server, config.JWT_SECRET);

initDb()
  .then(() => {
    startPoller(require('./lib/db').pool);
    startBotEngine({ pool: require('./lib/db').pool, decrypt });
  })
  .catch(err => logger.error({ err }, '[DB] init failed'));

server.listen(config.PORT, '0.0.0.0', () =>
  logger.info(`WaleszDesk running on 0.0.0.0:${config.PORT}`)
);
