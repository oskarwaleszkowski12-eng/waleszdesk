'use strict';
const axios = require('axios');
const http  = require('http');
const https = require('https');

// Shared agents with HTTP keep-alive — reuses TCP connections per host,
// cuts TLS handshake overhead under load (50+ users hitting exchanges).
const httpAgent  = new http.Agent({  keepAlive: true, maxSockets: 100, maxFreeSockets: 20, timeout: 60_000 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 100, maxFreeSockets: 20, timeout: 60_000 });

module.exports = axios.create({ httpAgent, httpsAgent });
