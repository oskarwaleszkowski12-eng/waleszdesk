const { pool }         = require('./db');
const logger           = require('./logger');
const { postToTelegram } = require('./platforms/telegram');
const { postToTwitter }  = require('./platforms/twitter');
const { sendTelegram, escapeHtml } = require('./telegram');

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

let _schedulerRunning = false;
async function runScheduler() {
  if (_schedulerRunning) return;
  _schedulerRunning = true;
  try {
    const { rows } = await pool.query(
      `SELECT * FROM engine_posts WHERE status='scheduled' AND scheduled_at <= NOW()`
    );
    for (const post of rows) {
      await publishPost(post);
    }
  } catch (err) {
    logger.error({ err }, '[engine scheduler] tick error');
  } finally {
    _schedulerRunning = false;
  }
}

function isSafeUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    if (!['http:', 'https:'].includes(u.protocol)) return false;
    const h = u.hostname;
    if (/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|::1$|fc00:|fd)/.test(h)) return false;
    return true;
  } catch { return false; }
}

let _researchRunning = false;
async function refreshResearch() {
  if (_researchRunning) return;
  _researchRunning = true;
  try {
    const axios = require('axios');
    const { rows: sources } = await pool.query(`SELECT * FROM engine_research_sources`);

    for (const src of sources) {
      try {
        let url = src.identifier;
        if (src.type === 'nitter') url = `https://nitter.net/${src.identifier.replace('@','')}/rss`;
        if (!isSafeUrl(url)) { logger.warn({ url }, '[engine research] blocked unsafe URL'); continue; }
        const r = await axios.get(url, { timeout: 8000, maxContentLength: 5 * 1024 * 1024, headers: { 'User-Agent': 'WaleszEngine/1.0' } });
        const items = parseRSS(r.data, src.name).slice(0, 20);
        const withId    = items.filter(i => i.external_id);
        const withoutId = items.filter(i => !i.external_id).slice(0, 5);

        if (withId.length) {
          await pool.query(
            `INSERT INTO engine_research_items (source_id, author, content, url, external_id, published_at)
             SELECT $1, unnest($2::text[]), unnest($3::text[]), unnest($4::text[]), unnest($5::text[]), unnest($6::timestamptz[])
             ON CONFLICT (source_id, external_id) WHERE external_id IS NOT NULL DO NOTHING`,
            [
              src.id,
              withId.map(i => i.author || src.name),
              withId.map(i => i.content),
              withId.map(i => i.url),
              withId.map(i => i.external_id),
              withId.map(i => i.published_at),
            ]
          );
        }
        for (const item of withoutId) {
          await pool.query(
            `INSERT INTO engine_research_items (source_id, author, content, url, external_id, published_at)
             VALUES ($1,$2,$3,$4,NULL,$5)`,
            [src.id, item.author || src.name, item.content, item.url, item.published_at]
          );
        }
      } catch { /* skip failed source */ }
    }
  } catch (err) {
    logger.error({ err }, '[engine research] refresh error');
  } finally {
    _researchRunning = false;
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
    const clean = content.replace(/<[^>]+>/g, '');
    items.push({
      author:      get('dc:creator') || get('author') || defaultAuthor,
      content:     clean.slice(0, 1000),
      url:         link,
      external_id: link || clean.slice(0, 500) || null,
      published_at: (() => { if (!date) return null; const d = new Date(date); return isNaN(d.getTime()) ? null : d.toISOString(); })(),
    });
  }
  return items;
}

async function checkSubscriberExpiry() {
  try {
    const { rows } = await pool.query(`
      SELECT name, email, plan, expires_at
      FROM subscribers
      WHERE status = 'active'
        AND expires_at BETWEEN NOW() + INTERVAL '6 days' AND NOW() + INTERVAL '7 days'
    `);
    if (!rows.length) return;
    const planLabel = { pro: 'PRO', vip: 'VIP', mentoring: 'Mentoring' };
    const list = rows.map(s => `${escapeHtml(s.name || s.email)} (${planLabel[s.plan] || s.plan})`).join(', ');
    await sendTelegram(`⚠️ <b>Subskrybenci wygasają za ~7 dni</b>\n${list}`);
    logger.info({ count: rows.length }, '[engine] subscriber expiry alert sent');
  } catch (err) {
    logger.error({ err }, '[engine] subscriber expiry check error');
  }
}

async function sendDailyBotSummary() {
  try {
    const { rows: bots } = await pool.query(`
      SELECT b.id, b.name, b.type, b.status, b.stats,
        (SELECT COUNT(*) FROM bot_trades WHERE bot_id=b.id AND status='filled'
         AND created_at > NOW() - INTERVAL '24 hours')::int AS trades_24h
      FROM bots b ORDER BY b.status, b.name
    `);
    if (!bots.length) return;

    const statusLabel = { active: 'aktywny', paused: 'wstrzymany', stopped: 'zatrzymany', error: 'błąd' };
    const statusEmoji = { active: '✅', paused: '⏸️', stopped: '⏹', error: '🚨' };
    const typeLabel   = { dca: 'DCA', grid: 'Grid' };

    let totalPnl = 0;
    const lines = bots.map(b => {
      const pnl = parseFloat((b.stats || {}).total_pnl || 0);
      totalPnl += pnl;
      const pnlStr    = `Total PnL: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`;
      const actStr    = b.trades_24h > 0 ? `${b.trades_24h} trade${b.trades_24h === 1 ? '' : 's'} 24h` : 'brak aktywności 24h';
      const emoji     = statusEmoji[b.status] || '⚪';
      const statusStr = statusLabel[b.status] || b.status;
      return `${emoji} <b>${escapeHtml(b.name)}</b> (${typeLabel[b.type] || b.type}) — ${statusStr}\n   ${pnlStr} · ${actStr}`;
    });

    const today = new Date().toISOString().slice(0, 10);
    const totalStr = `${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}`;
    await sendTelegram(`📊 <b>Dzienny raport botów</b> — ${today}\n\n${lines.join('\n\n')}\n\n<b>Łącznie PnL: ${totalStr}</b>`);
    logger.info({ botCount: bots.length }, '[engine] daily bot summary sent');
  } catch (err) {
    logger.error({ err }, '[engine] daily summary error');
  }
}

let _lastDailySummaryDay = null;
async function maybeSendDailyBotSummary() {
  const now = new Date();
  if (now.getUTCHours() !== 8) return;
  const today = now.toISOString().slice(0, 10);
  if (_lastDailySummaryDay === today) return;
  _lastDailySummaryDay = today;
  await sendDailyBotSummary();
}

async function cleanupPendingAttachments() {
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM attachments WHERE ref_type='pending' AND created_at < NOW() - INTERVAL '24 hours'`
    );
    if (rowCount > 0) logger.info({ rowCount }, '[engine] cleaned up stale pending attachments');
  } catch (err) {
    logger.error({ err }, '[engine] attachment cleanup error');
  }
}

function startEngineScheduler() {
  const handles = [
    setInterval(runScheduler,              60_000),
    setInterval(refreshResearch,           15 * 60_000),
    setInterval(cleanupPendingAttachments, 60 * 60_000),
    setInterval(checkSubscriberExpiry,     24 * 60 * 60_000),
    setInterval(maybeSendDailyBotSummary,  60_000),
  ];
  runScheduler();
  cleanupPendingAttachments();
  logger.info('[engine] scheduler + research poller started');
  return () => handles.forEach(clearInterval);
}

module.exports = { startEngineScheduler, publishPost, refreshResearch, checkSubscriberExpiry };
