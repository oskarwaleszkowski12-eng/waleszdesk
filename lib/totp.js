'use strict';
const speakeasy = require('speakeasy');
const qrcode    = require('qrcode');
const { pool }  = require('./db');

const SECRET_KEY  = 'admin_totp_secret';
const ENABLED_KEY = 'admin_totp_enabled';

async function getAdminTotpSecret() {
  const { rows } = await pool.query(`SELECT value FROM app_settings WHERE key=$1`, [SECRET_KEY]);
  return rows[0]?.value || null;
}

async function isAdminTotpEnabled() {
  const { rows } = await pool.query(`SELECT value FROM app_settings WHERE key=$1`, [ENABLED_KEY]);
  return rows[0]?.value === 'true';
}

async function saveAdminTotp(secret) {
  await pool.query(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ($1,$2,NOW())
     ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW()`,
    [SECRET_KEY, secret]
  );
  await pool.query(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ($1,'true',NOW())
     ON CONFLICT (key) DO UPDATE SET value='true', updated_at=NOW()`,
    [ENABLED_KEY]
  );
}

async function clearAdminTotp() {
  await pool.query(`DELETE FROM app_settings WHERE key IN ($1,$2)`, [SECRET_KEY, ENABLED_KEY]);
}

function verifyCode(secret, code) {
  if (!secret || !code) return false;
  return speakeasy.totp.verify({
    secret,
    encoding: 'base32',
    token:    String(code).replace(/\s/g, ''),
    window:   1,
  });
}

function generateSetup(label = 'WaleszDesk Admin') {
  const s = speakeasy.generateSecret({ name: label, length: 20 });
  return { secret: s.base32, otpauthUrl: s.otpauth_url };
}

async function buildQrDataUrl(otpauthUrl) {
  return qrcode.toDataURL(otpauthUrl, { width: 240, margin: 1 });
}

module.exports = {
  getAdminTotpSecret,
  isAdminTotpEnabled,
  saveAdminTotp,
  clearAdminTotp,
  verifyCode,
  generateSetup,
  buildQrDataUrl,
};
