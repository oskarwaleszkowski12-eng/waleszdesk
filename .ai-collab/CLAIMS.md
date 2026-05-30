# Claims

Use this file to avoid simultaneous edits to the same files.

Format:

```text
Agent: Codex | Claude
Task: short task name
Paths:
- path/or/glob
Started: YYYY-MM-DD HH:MM TZ
Status: active | paused | released
Notes: short note
```

## Active Claims

```text
Agent: Claude
Task: Audit fixes — auth, indexes, scheduler, frontend validation
Paths:
- routes/journal.js
- routes/waitlist.js
- lib/db.js
- lib/engineScheduler.js
- engine.html
- subscriber.html
Started: 2026-05-30 00:00 Europe/Warsaw
Status: released
Notes: Done — all critical audit fixes applied and committed.
```

## Released Claims

```text
Agent: Codex
Task: Fix confirmed auth and Tradovate reconnect bugs
Paths:
- server.js
- funded.html
- .ai-collab/
Started: 2026-05-27 14:45 Europe/Warsaw
Status: released
Notes: Restricted algo admin API and avoided password:null in Tradovate reconnect.
```

```text
Agent: Claude
Task: Performance fixes (index.html) + light/dark mode (funded.html)
Paths:
- index.html
- funded.html
Started: 2026-05-27 00:00 Europe/Warsaw
Status: released
Notes: Done — 4 perf fixes + funded.html theme toggle
```

```text
Agent: Codex
Task: Tradovate live app credentials config
Paths:
- lib/config.js
- lib/tradovate.js
- .ai-collab/
Started: 2026-05-18 21:31 Europe/Warsaw
Status: released
Notes: Added TRADOVATE_CID/TRADOVATE_SEC support and Live-mode guard. Avoided funded.html/index.html.
```

```text
Agent: Codex
Task: Tradovate backend/order flow review and wiring
Paths:
- lib/tradovate.js
- routes/funded.js
- lib/config.js
- server.js
Started: 2026-05-18 21:18 Europe/Warsaw
Status: released
Notes: Hardened backend order validation and Tradovate rejection handling. Did not edit funded.html/index.html.
```

```text
Agent: Claude
Task: Live positions panel + index.html integration
Paths:
- funded.html
- index.html
Started: 2026-05-11 19:36 Europe/Warsaw
Status: released
Notes: Done — positions panel, close button, futures calculator, Funded nav tab
```

```text
Agent: Codex
Task: Add project-local collaboration protocol
Paths:
- AGENTS.md
- CLAUDE.md
- .ai-collab/
Started: 2026-05-11 15:55 Europe/Warsaw
Status: released
Notes: Added coordination files only. Existing application files were not modified.
```
