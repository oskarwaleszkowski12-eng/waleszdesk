const { Router } = require('express');
const { pool }   = require('../lib/db');
const { requireAuth } = require('../lib/auth');
const { validate, z } = require('../lib/validate');
const { publishPost, refreshResearch } = require('../lib/engineScheduler');
const logger = require('../lib/logger');

const router = Router();
router.use(requireAuth);

// ── POSTS ─────────────────────────────────────────────────────────────────────
const postSchema = z.object({
  content:            z.string().max(10000).default(''),
  platform_overrides: z.record(z.string()).optional().default({}),
  platforms:          z.array(z.object({
    key:    z.string(),
    type:   z.string(),
    label:  z.string(),
    config: z.record(z.unknown()).optional().default({}),
  })).default([]),
  image_url:    z.string().url().optional().nullable(),
  status:       z.enum(['draft','scheduled','publish_now']).default('draft'),
  scheduled_at: z.string().optional().nullable(),
});

router.get('/posts', async (req, res) => {
  const { status } = req.query;
  try {
    const where = status && status !== 'all' ? `WHERE status=$1` : '';
    const args  = status && status !== 'all' ? [status] : [];
    const { rows } = await pool.query(
      `SELECT * FROM engine_posts ${where} ORDER BY COALESCE(scheduled_at, created_at) DESC LIMIT 100`,
      args
    );
    res.json({ ok: true, posts: rows });
  } catch (err) {
    logger.error({ err }, '[engine posts GET]');
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

router.post('/posts', validate(postSchema), async (req, res) => {
  const { content, platform_overrides, platforms, image_url, status, scheduled_at } = req.body;
  try {
    const realStatus = status === 'publish_now' ? 'publishing' : status;
    const { rows } = await pool.query(
      `INSERT INTO engine_posts (content, platform_overrides, platforms, image_url, status, scheduled_at)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [content, JSON.stringify(platform_overrides), JSON.stringify(platforms), image_url || null,
       realStatus, scheduled_at || null]
    );
    const post = rows[0];
    if (status === 'publish_now') {
      const result = await publishPost(post);
      return res.json({ ok: true, post: { ...post, ...result } });
    }
    res.json({ ok: true, post });
  } catch (err) {
    logger.error({ err }, '[engine posts POST]');
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

router.put('/posts/:id', validate(postSchema), async (req, res) => {
  const { content, platform_overrides, platforms, image_url, status, scheduled_at } = req.body;
  try {
    const { rows } = await pool.query(
      `UPDATE engine_posts SET content=$1, platform_overrides=$2, platforms=$3, image_url=$4,
       status=$5, scheduled_at=$6 WHERE id=$7 RETURNING *`,
      [content, JSON.stringify(platform_overrides), JSON.stringify(platforms), image_url || null,
       status, scheduled_at || null, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ ok: false, error: 'Not found' });
    res.json({ ok: true, post: rows[0] });
  } catch (err) {
    logger.error({ err }, '[engine posts PUT]');
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

router.delete('/posts/:id', async (req, res) => {
  try {
    await pool.query(`DELETE FROM engine_posts WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, '[engine posts DELETE]');
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// ── PLATFORMS ─────────────────────────────────────────────────────────────────
const platformSchema = z.object({
  key:        z.string().min(1).max(100),
  label:      z.string().min(1).max(100),
  type:       z.enum(['telegram','twitter','instagram','facebook']),
  config:     z.record(z.unknown()).default({}),
  enabled:    z.boolean().default(true),
  sort_order: z.number().int().default(0),
});

const SENSITIVE_KEYS = ['bot_token', 'access_token', 'page_access_token'];
function maskConfig(cfg) {
  return Object.fromEntries(
    Object.entries(cfg || {}).map(([k, v]) =>
      SENSITIVE_KEYS.includes(k) ? [k, v ? '***' : ''] : [k, v]
    )
  );
}

router.get('/platforms', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM engine_platforms ORDER BY sort_order, id`);
    res.json({ ok: true, platforms: rows.map(p => ({ ...p, config: maskConfig(p.config) })) });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

router.post('/platforms', validate(platformSchema), async (req, res) => {
  const { key, label, type, config, enabled, sort_order } = req.body;
  try {
    const { rows } = await pool.query(
      `INSERT INTO engine_platforms (key, label, type, config, enabled, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (key) DO UPDATE SET label=$2, type=$3, config=$4, enabled=$5, sort_order=$6
       RETURNING *`,
      [key, label, type, JSON.stringify(config), enabled, sort_order]
    );
    res.json({ ok: true, platform: rows[0] });
  } catch (err) {
    logger.error({ err }, '[engine platforms POST]');
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

router.delete('/platforms/:key', async (req, res) => {
  try {
    await pool.query(`DELETE FROM engine_platforms WHERE key=$1`, [req.params.key]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

router.post('/platforms/test/:key', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM engine_platforms WHERE key=$1`, [req.params.key]);
    if (!rows[0]) return res.status(404).json({ ok: false, error: 'Platform not found' });
    const p = rows[0];
    if (p.type === 'telegram') {
      const { postToTelegram } = require('../lib/platforms/telegram');
      await postToTelegram(p.config, '✅ Walesz Engine — test połączenia');
      return res.json({ ok: true, message: 'Wiadomość testowa wysłana!' });
    }
    res.json({ ok: false, error: 'Test nie zaimplementowany dla tej platformy' });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// ── RESEARCH ──────────────────────────────────────────────────────────────────
router.get('/research', async (req, res) => {
  const { source_id, search, limit = 50 } = req.query;
  try {
    let q = `SELECT ri.*, rs.name AS source_name FROM engine_research_items ri
             JOIN engine_research_sources rs ON rs.id = ri.source_id WHERE 1=1`;
    const args = [];
    if (source_id) { args.push(source_id); q += ` AND ri.source_id=$${args.length}`; }
    if (search)    { args.push(`%${search}%`); q += ` AND ri.content ILIKE $${args.length}`; }
    q += ` ORDER BY COALESCE(ri.published_at, ri.created_at) DESC LIMIT $${args.length + 1}`;
    args.push(parseInt(limit));
    const { rows } = await pool.query(q, args);
    res.json({ ok: true, items: rows });
  } catch (err) {
    logger.error({ err }, '[engine research GET]');
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

router.get('/research/sources', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM engine_research_sources ORDER BY name`);
    res.json({ ok: true, sources: rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

const sourceSchema = z.object({
  name:       z.string().min(1).max(100),
  type:       z.enum(['rss','nitter','manual']).default('rss'),
  identifier: z.string().min(1).max(500),
});

router.post('/research/sources', validate(sourceSchema), async (req, res) => {
  const { name, type, identifier } = req.body;
  try {
    const { rows } = await pool.query(
      `INSERT INTO engine_research_sources (name, type, identifier) VALUES ($1,$2,$3) RETURNING *`,
      [name, type, identifier]
    );
    res.json({ ok: true, source: rows[0] });
  } catch (err) {
    logger.error({ err }, '[engine research sources POST]');
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

router.delete('/research/sources/:id', async (req, res) => {
  try {
    await pool.query(`DELETE FROM engine_research_sources WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

router.post('/research/manual', async (req, res) => {
  const { author = '', content, url, source_id } = req.body;
  if (!content || !source_id) return res.status(400).json({ ok: false, error: 'content + source_id required' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO engine_research_items (source_id, author, content, url, published_at)
       VALUES ($1,$2,$3,$4,NOW()) RETURNING *`,
      [source_id, author, content, url || null]
    );
    res.json({ ok: true, item: rows[0] });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

router.post('/research/refresh', async (req, res) => {
  refreshResearch().catch(() => {});
  res.json({ ok: true, message: 'Odświeżanie w tle...' });
});

module.exports = router;
