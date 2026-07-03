#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if ! git diff --quiet || ! git diff --cached --quiet || [ -n "$(git ls-files --others --exclude-standard)" ]; then
  echo "Refusing to deploy Mi from a dirty tree. Commit or stash changes first." >&2
  git status --short >&2
  exit 1
fi

npm test

install -d -m 700 "$HOME/.pi/agent/extensions"
DEPLOY_DIR="$HOME/.pi/agent/extensions"
BACKUP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/mi-deploy-backup.XXXXXX")"
rollback_deploy() {
  echo "Mi deploy canary failed; rolling back previous deployed extension files." >&2
  for file in mi.ts mi-daemon.mjs mi-capability-guard.ts; do
    if [ -f "$BACKUP_DIR/$file" ]; then
      install -m "$(stat -c '%a' "$BACKUP_DIR/$file")" "$BACKUP_DIR/$file" "$DEPLOY_DIR/$file"
    else
      rm -f "$DEPLOY_DIR/$file"
    fi
  done
  restart_user_unit mi-daemon.service || true
  restart_user_unit mi-web-chat.service || true
}
for file in mi.ts mi-daemon.mjs mi-capability-guard.ts; do
  if [ -f "$DEPLOY_DIR/$file" ]; then cp -p "$DEPLOY_DIR/$file" "$BACKUP_DIR/$file"; fi
done
install -m 600 pi/extensions/mi.ts "$DEPLOY_DIR/mi.ts"
install -m 700 pi/extensions/mi-daemon.mjs "$DEPLOY_DIR/mi-daemon.mjs"
if [ -f pi/extensions/mi-capability-guard.ts ]; then
  install -m 600 pi/extensions/mi-capability-guard.ts "$DEPLOY_DIR/mi-capability-guard.ts"
fi

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

if ! MI_AUTO_ACTIONS_ENABLED=false \
  MI_IMESSAGE_MONITOR_ENABLED=false \
  MI_DAILY_BRIEF=false \
  MI_QUESTIONS_ENABLED=false \
  MI_LOOP_FACTORY_ENABLED=false \
  PUSHOVER_USER= \
  PUSHOVER_TOKEN= \
  node scripts/test-mi-tick.mjs; then
  rollback_deploy
  exit 1
fi

if ! MI_AUTO_ACTIONS_ENABLED=false \
  MI_IMESSAGE_MONITOR_ENABLED=false \
  MI_DAILY_BRIEF=false \
  MI_QUESTIONS_ENABLED=false \
  MI_LOOP_FACTORY_ENABLED=false \
  PUSHOVER_USER= \
  PUSHOVER_TOKEN= \
  node dist/src/cli.js tick; then
  rollback_deploy
  exit 1
fi

if systemctl --user is-active --quiet mi-daemon.service 2>/dev/null; then
  if ! node dist/src/cli.js task list >/dev/null; then
    rollback_deploy
    exit 1
  fi
fi

rm -rf "$BACKUP_DIR"
echo "Mi deploy complete."
