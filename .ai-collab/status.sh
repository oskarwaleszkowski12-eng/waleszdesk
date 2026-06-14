#!/usr/bin/env sh
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

printf 'AI collaboration status\n'
printf 'Repository: %s\n' "$ROOT"
printf 'Time: %s\n\n' "$(date '+%Y-%m-%d %H:%M:%S %Z')"

printf '== Active claims ==\n'
awk '
  /^## Released Claims/ { exit }
  found { print }
  /^## Active Claims/ { found=1; next }
' .ai-collab/CLAIMS.md | sed '/^$/N;/^\n$/D'

printf '\n== Tasks snapshot ==\n'
sed -n '1,100p' .ai-collab/TASKS.md

printf '\n== Latest log ==\n'
sed -n '1,120p' .ai-collab/LOG.md

printf '\n== Git status ==\n'
git status --short

