'use strict';
const axios  = require('axios');
const config = require('./config');
const logger = require('./logger');

async function sendTelegram(text) {
  const { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID } = config;
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await axios.post(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      { chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'HTML' },
      { timeout: 5000 }
    );
  } catch (e) {
    logger.warn({ err: e }, '[telegram] send failed');
  }
}

module.exports = { sendTelegram };
