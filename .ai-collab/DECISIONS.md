# Decisions

Durable technical decisions and assumptions go here.

## 2026-05-11 - Collaboration Protocol

Codex and Claude coordinate through `.ai-collab/` inside this repository. `AGENTS.md` is the Codex-facing protocol, `CLAUDE.md` is the Claude-facing protocol, and both agents must use `TASKS.md`, `CLAIMS.md`, and `LOG.md` before and after code edits.

## 2026-05-11 - Existing Dirty State

The repository already had modified and untracked application files before the project-local collaboration files were added. Those files must be treated as existing user or other-agent work unless the user says otherwise.

