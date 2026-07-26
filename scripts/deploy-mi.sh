#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if ! git diff --quiet || ! git diff --cached --quiet || [ -n "$(git ls-files --others --exclude-standard)" ]; then
  echo "Refusing to deploy Mi from a dirty tree. Commit or stash changes first." >&2
  git status --short >&2
  exit 1
fi

# Mi runs from this reviewed tree. Never copy Mi files into Pi's global
# auto-load directory.
for file in pi/extensions/mi-daemon.mjs pi/extensions/mi-capability-guard.ts pi/extensions/mi-orchestrator-adapter.ts pi/extensions/mi.ts; do
  [[ -f "$file" ]] || { echo "Missing reviewed Mi file: $file" >&2; exit 1; }
done

npm test

# Run canaries before restarting services. A failed canary changes no deployed
# files; roll back by checking out the prior reviewed commit before activation.
MI_AUTO_ACTIONS_ENABLED=false \
MI_IMESSAGE_MONITOR_ENABLED=false \
MI_DAILY_BRIEF=false \
MI_QUESTIONS_ENABLED=false \
MI_LOOP_FACTORY_ENABLED=false \
PUSHOVER_USER= \
PUSHOVER_TOKEN= \
node scripts/test-mi-tick.mjs

MI_AUTO_ACTIONS_ENABLED=false \
MI_IMESSAGE_MONITOR_ENABLED=false \
MI_DAILY_BRIEF=false \
MI_QUESTIONS_ENABLED=false \
MI_LOOP_FACTORY_ENABLED=false \
PUSHOVER_USER= \
PUSHOVER_TOKEN= \
MI_ROOT="$ROOT" \
MI_DAEMON_SYSTEMD=0 \
node dist/src/cli.js tick

restart_user_unit() {
  local unit="$1"
  if systemctl --user list-unit-files "$unit" --no-legend 2>/dev/null | grep -q "^$unit"; then
    systemctl --user restart "$unit"
  fi
}

restart_user_unit mi-daemon.service
restart_user_unit mi-web-chat.service
restart_user_unit mi-flue.service
restart_user_unit mi-tick.timer

echo "Mi deploy complete. Mi execution files remain under $ROOT/pi/extensions."
