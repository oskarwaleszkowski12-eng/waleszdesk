# Tasks

## Ready

- [ ] Test Tradovate 2FA connect (rate limit resets ~14:30)
- [ ] Add real `TRADOVATE_CID` and `TRADOVATE_SEC` to local/deploy env before testing Tradovate Live.
- [ ] Place Order button — wire calculator result to POST /api/funded/order. UI should send a full Tradovate contract symbol, e.g. `ESM6`, not only root `ES`; use `/api/funded/contracts?q=ES` for suggestions if needed.

## In Progress

_No active tasks._

## Blocked

_No blocked tasks._

## Done

- [x] **Claude (2026-05-31)** — Etap 3 kompletny: konwersja ~168 inline event handlerów w `index.html` na `addEventListener` + event delegation. Zero `onclick=`/`oninput=`/`onchange=` w HTML atrybutach. Szczegóły w LOG.md.
- [x] **Claude (2026-05-31)** — `lib/csp.js` — nonce-based CSP: `script-src 'unsafe-inline'` zastąpiony `'nonce-${nonce}'`. Każda odpowiedź serwera wstrzykuje unikalny nonce do `<script>` tagów.
- [x] **Claude (2026-05-31)** — Etap 1: `routes/messages.js` + `lib/email.js` — admin reply do subskrybenta wysyła email przez `sendSubscriberReplyEmail`.
- [x] **Claude (2026-05-31)** — Etap 2: DCA stop-loss — bot zatrzymuje się po przekroczeniu progu straty.
- [x] **Codex** — Fixed confirmed bugs: protected `/api/algo/admin/*` behind auth and stopped Tradovate reconnect from sending `password:null`.
- [x] Added backend support for Tradovate Live `TRADOVATE_CID` and `TRADOVATE_SEC`.
- [x] Hardened Tradovate backend order flow: required Limit/Stop prices, exact contract lookup, and order rejection handling.
- [x] Added project-local Codex/Claude collaboration protocol.
