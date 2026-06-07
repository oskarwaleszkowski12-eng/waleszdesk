'use strict';
const { pool } = require('./db');
const logger   = require('./logger');

async function logAdminAction(req, action, targetType, targetId, meta = {}) {
  try {
    await pool.query(
      `INSERT INTO admin_actions (who, action, target_type, target_id, ip, meta)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        req?.admin?.role || 'admin',
        action,
        targetType || null,
        targetId != null ? String(targetId) : null,
        (req?.headers?.['x-forwarded-for'] || req?.ip || '').split(',')[0].trim() || null,
        JSON.stringify(meta || {}),
      ]
    );
  } catch (e) {
    logger.warn({ err: e, action }, '[audit] log failed');
  }
}

module.exports = { logAdminAction };
