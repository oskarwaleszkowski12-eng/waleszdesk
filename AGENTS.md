# Codex / Claude Collaboration Protocol

This repository is shared by Codex and Claude. Use `.ai-collab/` as the coordination layer before editing code.

Start of every session:
- Run `./.ai-collab/status.sh`.
- Read `.ai-collab/TASKS.md`, `.ai-collab/CLAIMS.md`, `.ai-collab/LOG.md`, and `.ai-collab/DECISIONS.md`.
- Check `git status --short` and treat existing changes as user/other-agent work.

Before editing:
- Claim the paths or responsibility area in `.ai-collab/CLAIMS.md`.
- Do not edit paths claimed by the other agent unless the claim is released or the user explicitly tells you to.
- Do not revert, overwrite, format, or clean up changes you did not make.

While working:
- Keep edits scoped to the claimed task.
- Prefer small changes that are easy to review.
- If unexpected changes appear, assume they are intentional and coordinate in `.ai-collab/LOG.md`.
- Log meaningful steps with timestamp, agent, paths touched, and verification.

Before finishing:
- Update `.ai-collab/TASKS.md`.
- Release or narrow your claim in `.ai-collab/CLAIMS.md`.
- Record verification in `.ai-collab/LOG.md`.

Useful commands:
- `./.ai-collab/status.sh`
- `git status --short`
- `git diff --stat`
- `npm run start`

