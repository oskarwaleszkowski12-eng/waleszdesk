const crypto = require('crypto');
const { ENCRYPTION_KEY } = require('./config');

function encKey() {
  return crypto.createHash('sha256').update(ENCRYPTION_KEY).digest();
}

function encrypt(text) {
  const iv = crypto.randomBytes(16);
  const c  = crypto.createCipheriv('aes-256-cbc', encKey(), iv);
  return iv.toString('hex') + ':' + Buffer.concat([c.update(text, 'utf8'), c.final()]).toString('hex');
}

function decrypt(ciphertext) {
  const [ivHex, hex] = ciphertext.split(':');
  const d = crypto.createDecipheriv('aes-256-cbc', encKey(), Buffer.from(ivHex, 'hex'));
  return Buffer.concat([d.update(Buffer.from(hex, 'hex')), d.final()]).toString('utf8');
}

module.exports = { encrypt, decrypt };
