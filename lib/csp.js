const crypto = require('crypto');
const fs     = require('fs');

const _cache = new Map();

function readHtml(filePath) {
  if (process.env.NODE_ENV === 'production' && _cache.has(filePath)) return _cache.get(filePath);
  const content = fs.readFileSync(filePath, 'utf8');
  if (process.env.NODE_ENV === 'production') _cache.set(filePath, content);
  return content;
}

function buildCsp(nonce) {
  const prod = process.env.NODE_ENV === 'production';
  return [
    `default-src 'self'`,
    `script-src 'nonce-${nonce}' 'strict-dynamic' https://cdnjs.cloudflare.com`,
    `style-src 'self' 'unsafe-inline' https://fonts.googleapis.com`,
    `font-src 'self' https://fonts.gstatic.com`,
    `img-src 'self' data: blob:`,
    `connect-src 'self' wss://stream.bybit.com`,
    `object-src 'none'`,
    `frame-ancestors 'none'`,
    `form-action 'self'`,
    `base-uri 'self'`,
    ...(prod ? [`upgrade-insecure-requests`] : []),
  ].join('; ');
}

function serveWithCsp(filePath) {
  return (req, res) => {
    try {
      const nonce = crypto.randomBytes(16).toString('base64');
      const html  = readHtml(filePath)
        .replace(/<script(?=[>\s])/g, `<script nonce="${nonce}"`);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Content-Security-Policy', buildCsp(nonce));
      res.send(html);
    } catch { res.status(500).end(); }
  };
}

module.exports = { serveWithCsp };
