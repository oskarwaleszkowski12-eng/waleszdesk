async function postToTwitter(platformConfig, text) {
  // Twitter API v2 — wymaga Bearer Token + OAuth 2.0 PKCE
  // Skonfiguruj TWITTER_BEARER_TOKEN i TWITTER_ACCESS_TOKEN w env
  const token = platformConfig.access_token || process.env.TWITTER_ACCESS_TOKEN;
  if (!token) throw new Error('Twitter: brak access_token — skonfiguruj w Platformy');

  const axios = require('axios');
  const r = await axios.post(
    'https://api.twitter.com/2/tweets',
    { text: text.slice(0, 280) },
    { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
  );
  return { tweet_id: r.data.data?.id };
}

module.exports = { postToTwitter };
