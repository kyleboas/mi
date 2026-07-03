#!/usr/bin/env bash
set -euo pipefail

STATE_DIR="${MI_STATE_DIR:-$HOME/assistant/state}"
TICK_FILE="${MI_TICK_FILE:-$STATE_DIR/tick.json}"
SOCKET_PATH="${MI_SOCKET_PATH:-$STATE_DIR/mi-daemon.sock}"
MAX_STALE_SECONDS="${MI_WATCHDOG_MAX_STALE_SECONDS:-600}"
NOTIFY_CMD="${MI_WATCHDOG_NOTIFY_CMD:-}"
SERVICES="${MI_WATCHDOG_SERVICES-mi.service mi-daemon.service}"
now_epoch="$(date +%s)"
failures=()

notify() {
  local message="$1"
  if [[ -n "$NOTIFY_CMD" ]]; then
    "$NOTIFY_CMD" "$message" || true
  else
    printf '%s\n' "$message" >&2
  fi
}

if [[ ! -f "$TICK_FILE" ]]; then
  failures+=("missing tick file: $TICK_FILE")
else
  tick_ts="$(node -e "const fs=require('fs'); const p=process.argv[1]; try { const j=JSON.parse(fs.readFileSync(p,'utf8')); console.log(j.ts||j.completedAt||j.startedAt||''); } catch { process.exit(2); }" "$TICK_FILE" 2>/dev/null || true)"
  tick_epoch="$(date -d "$tick_ts" +%s 2>/dev/null || echo 0)"
  age=$((now_epoch - tick_epoch))
  if [[ "$tick_epoch" -le 0 || "$age" -gt "$MAX_STALE_SECONDS" ]]; then
    failures+=("stale tick: ${age}s old")
  fi
fi

if [[ ! -S "$SOCKET_PATH" ]]; then
  failures+=("daemon socket missing: $SOCKET_PATH")
fi

if command -v systemctl >/dev/null 2>&1; then
  for service in $SERVICES; do
    if ! systemctl --user is-active --quiet "$service" 2>/dev/null && ! systemctl is-active --quiet "$service" 2>/dev/null; then
      failures+=("service inactive: $service")
    fi
  done
fi

if [[ "${#failures[@]}" -gt 0 ]]; then
  notify "Mi watchdog alert: ${failures[*]}"
  exit 2
fi

printf 'Mi watchdog ok\n'
