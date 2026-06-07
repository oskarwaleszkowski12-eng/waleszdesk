# Collaboration Log

Append newest entries at the top.

## 2026-05-31 — Claude — HANDOFF DLA CODEX

### Co zrobiono w tej sesji

**Etap 1 — Email reply do subskrybenta**
- `routes/messages.js` — `POST /api/messages/conversations/:id/reply` wywołuje `sendSubscriberReplyEmail` gdy `conv.subscriber_id` istnieje
- `lib/email.js` — dodana funkcja `sendSubscriberReplyEmail(to, name, subject, content)`

**Etap 2 — DCA Stop-Loss**
- Logika w botcie DCA: bot sprawdza skumulowaną stratę po każdym trade i zatrzymuje się gdy przekroczy próg `dcaStopLoss` (konfigurowalny w ustawieniach bota)

**Etap 3 — Konwersja inline event handlerów (CSP prep)**

`index.html` — **0 HTML attribute event handlers**. Weryfikacja: `grep "onclick=\|oninput=\|onchange=" index.html` zwraca tylko 2 linie — obie to JS property assignments (`.onclick =`, `.onchange =`), nie HTML atrybuty.

Wzorce użyte:
- Statyczne elementy → dodane IDs + `addEventListener` w bloku `DOMContentLoaded` na końcu `<script>`
- Dynamiczne szablony (renderBots, renderJournal, renderJournalDB, renderPositions, alerty, subskrybenci, konwersacje, itp.) → `data-action` / `data-*` atrybuty + event delegation na kontenerach
- `attachmentGrid` — usunięty wzorzec `window['removeTradeAtt_N']`, zastąpiony przez `data-action="remove-trade-att"` + listener w `renderTradeAtts`
- Obrazki z viewImg → `data-viewimg="1"` + delegation czytający `e.target.src`
- `onclick="event.stopPropagation()"` → `class="js-no-expand"`
- Pretrade checkboxes → listeners dodawane programowo po `container.innerHTML =` w `openPreTradeChecklist()`
- Reply textarea keydown → listener dodawany po `main.innerHTML =` w `openConv()`

`lib/csp.js` — nonce-based CSP:
- Dodany `require('crypto')`
- `buildCsp()` → `buildCsp(nonce)`, `script-src 'unsafe-inline'` → `script-src 'nonce-${nonce}'`
- `serveWithCsp` wstrzykuje `nonce="${nonce}"` na każdy `<script>` tag przez regex replace
- `style-src 'unsafe-inline'` pozostawiony (potrzebny dla inline stylów)

### Co NIE zostało jeszcze zrobione

Wcześniejszy audit Claude (2026-05-30) zidentyfikował 6 issues bezpieczeństwa/perf, które były w aktywnym claimie ale nie zostały zaadresowane w tej sesji (sesja skupiła się na CSP):
- WS auth (`ws/index.js`)
- API key logging (`routes/bots.js`)
- N+1 query
- Poller cleanup (`lib/poller.js`)
- Attachment cleanup
- `routes/subscriber.js`

Szczegóły tych issues powinny być w poprzednich wpisach LOG.md lub trzeba re-auditowaś.

### Dla Codexa — na co uważać

1. `index.html` ma teraz `DOMContentLoaded` blok z ~200 liniami na końcu `<script>`. Jeśli dodajesz nowe przyciski/inputy — albo dodaj ID + listener tam, albo dodaj do istniejącej delegacji na kontenerze.
2. `lib/csp.js` wstrzykuje nonce przez regex `/<script(?=[>\s])/g`. Jeśli dodasz zewnętrzny `<script src="...">` — tag dostanie nonce automatycznie. Jeśli ładujesz skrypty inaczej (np. dynamicznie) — trzeba osobno obsłużyć.
3. Funkcja `renderTradeAtts` używa `wrap._hasRemoveListener` żeby nie duplikować listenerów przy re-renderze. To jest niestandartowe — uważaj jeśli refakturujesz tę funkcję.

Claims released.

## 2026-05-27 14:45 Europe/Warsaw - Codex

Completed: confirmed bug fixes

- `server.js` — replaced broad `/api/algo/*` public bypass with an explicit allowlist for onboarding routes only: `/algo/available-bots`, `/algo/verify-keys`, `/algo/launch`, `/algo/status`, `/algo/verify-invite`. `/api/algo/admin/*` now requires `requireAuth`.
- `funded.html` — Tradovate reconnect now omits `password` when the password field is empty instead of sending `password:null`.

Verification:
- `node --check server.js`
- Parsed `funded.html` inline scripts with `new Function`
- Source check confirmed broad `req.path.startsWith('/algo/')` bypass is gone
- Runtime check: unauthenticated `GET /api/algo/admin/templates` returns `401`
- Runtime check: `GET /api/algo/available-bots` reaches handler; local `500` is expected without local Postgres

Claims released.

## 2026-05-27 00:00 Europe/Warsaw - Claude

Performance fixes in `index.html` (4 changes):
- Fix 1: Ticker WS `onmessage` now RAF-throttled via `_tickerRafPending` flag — prevents 10-20 DOM updates/s
- Fix 2: `setInterval` staggered with `setTimeout` offsets (800/1600/2400/3200ms) to spread CPU spikes
- Fix 3: `renderBots()` dirty-check via `_botsRenderHash` (JSON hash of id/status/stats/live_balance) — skips re-render when data unchanged
- Fix 4: WS positions render debounced 80ms via `_posRenderDebounce`; global variable added next to `tickerData`

Light/dark mode in `funded.html`:
- CSS: full `body.light-mode` block with --bg0/--bg1/--bg2/--bg3/--bg4/--text/--muted/--muted2/--border/--border2 overrides + topbar/nav/card/modal/input styles
- HTML: `<button id="theme-toggle">` added in topbar before `.app-sw`
- JS: IIFE at end of script reads `wd_theme` from localStorage, wires click toggle, synced with index.html pattern


## 2026-05-18 21:33 Europe/Warsaw - Codex

Tradovate Live auth credentials update:
- `lib/config.js`: added `TRADOVATE_CID` and `TRADOVATE_SEC`
- `lib/tradovate.js`: auth payload now uses configured `cid`/`sec` instead of hardcoded `cid: 0` and empty `sec`
- `lib/tradovate.js`: Live mode now fails early with a clear error if `TRADOVATE_CID` or `TRADOVATE_SEC` is missing

Context from Claude/user: Demo worked with `cid=0`, but Live requires real registered app credentials from Tradovate.

Verification:
- `node -c lib/config.js && node -c lib/tradovate.js`

## 2026-05-18 21:24 Europe/Warsaw - Codex

Backend Tradovate/order-flow update, built on top of Claude's existing backend changes:
- `routes/funded.js`: `POST /api/funded/order` now rejects missing `price` for `Limit`/`StopLimit` and missing `stopPrice` for `Stop`/`StopLimit`
- `lib/tradovate.js`: HTTP errors from Tradovate are normalized into readable messages
- `lib/tradovate.js`: order placement now verifies exact contract existence with `/contract/find`
- `lib/tradovate.js`: if an exact contract symbol is not found, the error includes suggestions from `/contract/suggest`
- `lib/tradovate.js`: Tradovate `failureReason` / `failureText` now turns into a failed API response instead of a false frontend success

Note for Claude/UI: the order API expects a full Tradovate contract symbol such as `ESM6`, not only root `ES`/`MES`. If the calculator only has a root symbol, use `GET /api/funded/contracts?q=ES` to help the user pick the active contract before calling `POST /api/funded/order`.

Verification:
- `node -c lib/tradovate.js && node -c routes/funded.js && node -c server.js`

## 2026-05-18 21:22 Europe/Warsaw - Claude

⚠️ NOTE FOR CODEX: I already modified the files you claimed before seeing your claim. Summary of my backend changes below — please review before overwriting:

**`lib/tradovate.js`** — added at top:
- `_username`, `_password`, `_isDemo` in-memory vars
- `setCredentials(u,p,isDemo)` — sets runtime credentials
- `loadCredentialsFromDb()` — loads encrypted creds from `funded_settings` table on startup
- `saveCredentialsToDb(u,p,isDemo)` — saves encrypted creds to DB
- `hasCredentials()` — checks _username || TRADOVATE_USERNAME from config
- `_creds()` — returns {username,password} from runtime or config fallback
- Modified `base()` to respect `_isDemo` runtime var
- Modified `initiateAuth()` and `completeAuth()` to use `_creds()` instead of hardcoded config
- Exported all new functions

**`routes/funded.js`** — changes:
- `GET /status` uses `tv.hasCredentials()` instead of config import
- `GET /credentials` — new endpoint, returns saved username (never password)
- `POST /auth/init` — now accepts `{username?, password?, isDemo}`, saves to DB if provided, falls back to DB creds if not

**`server.js`** — added `const tv = require('./lib/tradovate')` and `await tv.loadCredentialsFromDb()` in initDb().then()

**`lib/db.js`** — added `funded_settings (key TEXT PK, value TEXT)` table in initDb()

---

- `funded.html`: Connect modal redesigned — new step `creds` (username+password+Live/Demo toggle), credentials saved encrypted to DB, username pre-filled from DB on reopen, password can be left blank to reuse saved

## 2026-05-11 19:38 Europe/Warsaw - Claude

- `funded.html`: added live positions panel (`#live-positions-wrap`) with position cards, `renderPositions()`, `refreshPositions()`, `closePosition()` functions; positions auto-poll every 30s when Tradovate connected; panel hides on disconnect
- `funded.html`: futures calculator complete — `setCalcMode`, `onContractChange`, `calcContracts`, `calcAll`, futures pills
- `index.html`: added `<a href="/funded">Funded</a>` nav link in topbar

## 2026-05-11 15:55 Europe/Warsaw - Codex

Added project-local collaboration files:
- `AGENTS.md`
- `CLAUDE.md`
- `.ai-collab/README.md`
- `.ai-collab/TASKS.md`
- `.ai-collab/CLAIMS.md`
- `.ai-collab/DECISIONS.md`
- `.ai-collab/status.sh`

Observed pre-existing dirty git state before these files were added:
- modified: `.DS_Store`
- modified: `lib/config.js`
- modified: `server.js`
- untracked: `funded.html`
- untracked: `lib/tradovate.js`
- untracked: `routes/funded.js`

Status: coordination is ready. No application files were edited by Codex in this step.

## 2026-05-30 00:00 Europe/Warsaw - Claude

Applied all critical audit findings:
- routes/journal.js: added requireAuth (GET /, PATCH /:id, PATCH /:id/publish were unauthenticated) + pagination on GET
- routes/waitlist.js: added requireAuth to GET / (was exposing all waitlist emails)
- lib/db.js: added 7 missing performance indexes (trades, messages, conversations, engine_posts, bot_trades)
- lib/engineScheduler.js: added _schedulerRunning + _researchRunning concurrency guards; fixed ON CONFLICT for NULL external_id items; added maxContentLength:5MB to axios
- engine.html: editPost() and publishNow() now check d.ok before proceeding
- subscriber.html: openSubConv() now shows error message instead of silently returning on d.ok=false

## 2026-05-30 01:00 Europe/Warsaw - Claude

Second deep audit pass — 6 issues found and fixed:
- ws/index.js: subscriber JWTs could connect and receive admin's Bybit balance/positions — added role==='admin' guard
- routes/bots.js + index.html: GET /test-connection passed API keys as URL query params (logged by server) — changed to POST with body, updated 2 callers in index.html
- routes/messages.js: admin reply attachment claim missing AND ref_type='pending' guard — fixed
- lib/poller.js: no concurrency guard on 15s interval — added _polling flag (same pattern as engineScheduler)
- routes/messages.js + subscriber.js: N+1 correlated subqueries in conversation list endpoints — replaced with CTE + DISTINCT ON
- lib/engineScheduler.js: stale pending attachments never cleaned up — added hourly cleanup job (DELETE WHERE ref_type='pending' AND created_at < NOW()-24h)
- routes/subscriber.js: PUT /admin/:id had no input validation — added updateSubSchema with enum check + 404 handling

---
[2026-05-30] Claude — httpOnly cookie migration (CRIT-1 follow-up)

Migrated JWT storage from localStorage/sessionStorage to httpOnly cookies:
- npm install cookie-parser
- lib/auth.js: _extractToken() reads wd_admin/wd_sub cookie first, Bearer fallback
- server.js: cookieParser() middleware, login sets wd_admin httpOnly cookie, new /api/auth/logout + /api/auth/me, global guard now bypasses /subscriber/* (own auth handles it)
- ws/index.js: parseCookie() reads wd_admin from req.headers.cookie; keeps ?token= fallback
- routes/subscriber.js: login sets wd_sub cookie, new POST /logout endpoint
- index.html: apiFetch uses credentials:'include', doLogin no longer stores token, DOMContentLoaded checks sessionStorage hint then /api/auth/me, initWS no longer passes token in URL
- funded.html: api() uses credentials:'include', _jwt replaced with sessionStorage('wd_session') hint, auth gate calls /api/auth/me on cold load
- engine.html: TOKEN var removed, api() uses credentials:'include'
- subscriber.html: _tok removed, api() uses credentials:'include', logout calls /api/subscriber/logout, init calls /api/subscriber/me on cold load
node --check: all JS files pass

## 2026-06-07 Claude — Stability + scalability hardening (50+ users)

10 fixes across stability, scalability, polish:

Stability (Phase 1):
- lib/email.js: 3 fetch() calls to Resend wrapped in 5s AbortController timeout (no thread starvation if Resend hangs)
- ws/index.js: ws.send() in broadcast wrapped in try/catch (one slow client no longer crashes broadcast for others)
- routes/bots.js GET /: Promise.allSettled instead of Promise.all (one slow bot can't time out the dashboard for everyone)
- lib/auth.js requireSubscriberAuth: reads plan + name fresh from DB, no longer trusts 7-day-old JWT payload
- server.js: graceful shutdown — collects stop() handles from setupWS, startPoller, startBotEngine, startEngineScheduler; SIGTERM/SIGINT stops all, drains pool, hard-kill at 15s
- botEngine.js, lib/poller.js, lib/engineScheduler.js, ws/index.js: each start* fn returns a stop closure

Scalability (Phase 2):
- routes/bots.js GET /: correlated (SELECT COUNT) subqueries → single LEFT JOIN+GROUP BY
- routes/algo.js GET /status + /admin/users: same N+1 → JOIN refactor
- routes/algo.js GET /admin/users: added LIMIT 100 + ?page/?limit pagination
- lib/http.js NEW: shared axios instance with keepAlive http/https agents (maxSockets 100)
- exchanges/{bybit,binance,bitget,blofin,mexc,okx}.js + lib/bybit.js: switched from require('axios') to require('../lib/http') — TCP reuse across calls

Polish (Phase 3):
- server.js: per-request UUID (X-Request-Id), Server-Timing header via writeHead hook, reqId in pino logs (customProps)
- routes/bots.js stop-all: silent catch{} on cancel-all → logger.warn with botId + symbol

node --check: all 19 modified JS files pass
