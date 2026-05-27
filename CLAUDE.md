# Claude Instructions

You are collaborating with Codex in this same repository:

`/Users/walesz/Desktop/WaleszDesk`

Use `.ai-collab/` as the shared coordination area. Do not rely only on chat memory.

Start every session:

```sh
cd /Users/walesz/Desktop/WaleszDesk
./.ai-collab/status.sh
```

Then read:
- `.ai-collab/README.md`
- `.ai-collab/TASKS.md`
- `.ai-collab/CLAIMS.md`
- `.ai-collab/LOG.md`
- `.ai-collab/DECISIONS.md`

Rules:
- Claim files or areas in `.ai-collab/CLAIMS.md` before editing.
- Do not touch paths claimed by Codex unless Codex releases the claim or the user explicitly redirects you.
- Do not revert or overwrite changes you did not make.
- Existing dirty git changes are treated as user or other-agent work.
- Keep task updates concrete and file-oriented.
- If blocked, write the blocker in `.ai-collab/TASKS.md` and `.ai-collab/LOG.md`.

Recommended work loop:
1. Run `./.ai-collab/status.sh`.
2. Pick one task from `.ai-collab/TASKS.md`.
3. Add your claim in `.ai-collab/CLAIMS.md`.
4. Make a focused change.
5. Verify it.
6. Update `.ai-collab/LOG.md`.
7. Release or narrow your claim.

Current caution:
- This repo already had modified/untracked files before the collaboration files were added. Treat them as existing work and do not overwrite them.

