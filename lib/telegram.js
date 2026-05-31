'use strict';
const axios  = require('axios');
const config = require('./config');
const logger = require('./logger');

function escapeHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

async function sendTelegram(text) {
  const { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID } = config;
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  const delays = [1000, 2000];
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      await axios.post(
        `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
        { chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'HTML' },
        { timeout: 5000 }
      );
      return;
    } catch (e) {
      if (attempt < delays.length) {
        await new Promise(r => setTimeout(r, delays[attempt]));
      } else {
        logger.warn({ err: e }, '[telegram] send failed after retries');
      }
    }
  }
}

module.exports = { sendTelegram, escapeHtml };
