const { pool }         = require('./db');
const logger           = require('./logger');
const { postToTelegram } = require('./platforms/telegram');
const { postToTwitter }  = require('./platforms/twitter');

async function publishPost(post) {
  const platforms = Array.isArray(post.platforms) ? post.platforms : [];
  const overrides = post.platform_overrides || {};
  const results   = {};

  for (const p of platforms) {
    const text = (overrides[p.key] || post.content || '').trim();
    try {
      if (p.type === 'telegram') {
        results[p.key] = await postToTelegram(p.config || {}, text, post.image_url || null);
      } else if (p.type === 'twitter') {
        results[p.key] = await postToTwitter(p.config || {}, text);
      } else {
        results[p.key] = { skipped: true, reason: 'platform not implemented' };
      }
      results[p.key].ok = true;
    } catch (err) {
      logger.error({ err, platform: p.key }, '[engine publish]');
      results[p.key] = { ok: false, error: err.message };
    }
  }

  const anyOk = Object.values(results).some(r => r.ok);
  const status = platforms.length === 0 ? 'published'
    : Object.values(results).every(r => r.ok) ? 'published'
    : anyOk ? 'partial' : 'failed';

  await pool.query(
    `UPDATE engine_posts SET status=$1, published_at=NOW(), publish_results=$2 WHERE id=$3`,
    [status, JSON.stringify(results), post.id]
  );
  logger.info({ postId: post.id, status }, '[engine] post published');
  return { status, results };
}

async function runScheduler() {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM engine_posts WHERE status='scheduled' AND scheduled_at <= NOW()`
    );
    for (const post of rows) {
      await publishPost(post);
    }
  } catch (err) {
    logger.error({ err }, '[engine scheduler] tick error');
  }
}

async function refreshResearch() {
  try {
    const axios = require('axios');
    const { rows: sources } = await pool.query(`SELECT * FROM engine_research_sources`);

    for (const src of sources) {
      try {
        let url = src.identifier;
        if (src.type === 'nitter') url = `https://nitter.net/${src.identifier.replace('@','')}/rss`;
        const r = await axios.get(url, { timeout: 8000, headers: { 'User-Agent': 'WaleszEngine/1.0' } });
        const items = parseRSS(r.data, src.name);
        for (const item of items.slice(0, 20)) {
          await pool.query(
            `INSERT INTO engine_research_items (source_id, author, content, url, external_id, published_at)
             VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
            [src.id, item.author || src.name, item.content, item.url, item.external_id, item.published_at]
          );
        }
      } catch { /* skip failed source */ }
    }
  } catch (err) {
    logger.error({ err }, '[engine research] refresh error');
  }
}

function parseRSS(xml, defaultAuthor) {
  const items = [];
  const re = /<item>([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const b = m[1];
    const get = t => {
      const x = b.match(new RegExp(`<${t}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${t}>|<${t}[^>]*>([^<]{0,2000})<\\/${t}>`));
      return x ? (x[1] || x[2] || '').trim() : '';
    };
    const content = get('description') || get('title');
    const link    = get('link') || get('guid');
    const date    = get('pubDate') || get('dc:date');
    if (!content) continue;
    items.push({
      author:      get('dc:creator') || get('author') || defaultAuthor,
      content:     content.replace(/<[^>]+>/g, '').slice(0, 1000),
      url:         link,
      external_id: link || null,
      published_at: date ? new Date(date).toISOString() : null,
    });
  }
  return items;
}

function startEngineScheduler() {
  setInterval(runScheduler,   60_000);
  setInterval(refreshResearch, 15 * 60_000);
  runScheduler();
  logger.info('[engine] scheduler + research poller started');
}

module.exports = { startEngineScheduler, publishPost, refreshResearch };
