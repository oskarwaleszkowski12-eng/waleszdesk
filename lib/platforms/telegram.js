const axios  = require('axios');
const config = require('../config');

async function postToTelegram(platformConfig, text, imageUrl) {
  const token  = platformConfig.bot_token || config.TELEGRAM_BOT_TOKEN;
  const chatId = platformConfig.chat_id;
  if (!token || !chatId) throw new Error('Brak konfiguracji Telegram (bot_token / chat_id)');

  const base = `https://api.telegram.org/bot${token}`;
  const payload = { chat_id: chatId, parse_mode: 'HTML' };

  let r;
  if (imageUrl) {
    r = await axios.post(`${base}/sendPhoto`, { ...payload, photo: imageUrl, caption: text || undefined });
  } else {
    r = await axios.post(`${base}/sendMessage`, { ...payload, text: text || '.', disable_web_page_preview: false });
  }

  if (!r.data.ok) throw new Error(r.data.description || 'Telegram error');
  return { message_id: r.data.result.message_id };
}

module.exports = { postToTelegram };
