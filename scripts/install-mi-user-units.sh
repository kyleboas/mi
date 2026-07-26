#!/usr/bin/env bash
# Install Mi's private user units. Installation does not activate any unit.
set -Eeuo pipefail
umask 077

fail() { echo "Mi user-unit install failed: $*" >&2; exit 1; }
unsafe_systemd_path() {
  [[ -z "$1" || "$1" != /* || "$1" == *'%'* || "$1" == *$'\n'* || "$1" == *$'\r'* || "$1" == *$'\t'* || "$1" =~ [[:space:]] || "$1" == *'\\'* || "$1" == *'"'* || "$1" == *"'"* ]]
}
require_safe_path() { if unsafe_systemd_path "$1"; then fail "unsafe path for $2"; fi; }
canonical_dir() {
  local value="$1" label="$2" result
  require_safe_path "$value" "$label"
  [[ -d "$value" ]] || fail "$label is not a directory: $value"
  result="$(cd "$value" && pwd -P)"
  require_safe_path "$result" "$label"
  printf '%s\n' "$result"
}
canonical_executable() {
  local value="$1" label="$2" result
  require_safe_path "$value" "$label"
  [[ -f "$value" && -x "$value" ]] || fail "$label is not an executable file: $value"
  result="$(readlink -f -- "$value")"
  [[ -f "$result" && -x "$result" ]] || fail "$label does not resolve to an executable file"
  require_safe_path "$result" "$label"
  printf '%s\n' "$result"
}

RAW_ROOT="${MI_APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)}"
RAW_HOME="${HOME:?HOME is required}"
require_safe_path "$RAW_ROOT" MI_APP_DIR
require_safe_path "$RAW_HOME" HOME
[[ "$RAW_HOME" != /root && "$RAW_HOME" != /root/* ]] || fail 'refusing root HOME; set the target service user HOME explicitly'
ROOT="$(canonical_dir "$RAW_ROOT" MI_APP_DIR)"
HOME_DIR="$(canonical_dir "$RAW_HOME" HOME)"
RAW_CONFIG="${XDG_CONFIG_HOME:-$HOME_DIR/.config}"
require_safe_path "$RAW_CONFIG" XDG_CONFIG_HOME
# The config directory may be new, but it must still be an unambiguous child of
# the target home. This prevents root's inherited XDG settings from being used.
case "$RAW_CONFIG" in "$HOME_DIR"|"$HOME_DIR"/*) ;; *) fail 'XDG_CONFIG_HOME must be under the target service user HOME' ;; esac
CONFIG_DIR="$RAW_CONFIG"
UNIT_DIR="$CONFIG_DIR/systemd/user"
require_safe_path "$UNIT_DIR" unit-directory

NODE_BIN="$(canonical_executable "${MI_NODE_BIN:-/home/kyle/.nvm/versions/node/v24.15.0/bin/node}" MI_NODE_BIN)"
MI_BIN="$(canonical_executable "${MI_BIN:-/home/kyle/.nvm/versions/node/v24.15.0/bin/mi}" MI_BIN)"
DAEMON_PATH="$ROOT/pi/extensions/mi-daemon.mjs"
require_safe_path "$DAEMON_PATH" daemon-path
[[ -f "$DAEMON_PATH" && ! -L "$DAEMON_PATH" ]] || fail "missing reviewed Mi daemon: $DAEMON_PATH"
DAEMON_PATH="$(readlink -f -- "$DAEMON_PATH")"
case "$DAEMON_PATH" in "$ROOT"/pi/extensions/mi-daemon.mjs) ;; *) fail 'reviewed daemon escapes the private Mi extension root' ;; esac

# Do not inherit a caller PATH. It is deterministic and contains only the two
# reviewed executable directories plus system command directories.
path_part() { dirname "$1"; }
SERVICE_PATH="$(path_part "$NODE_BIN"):$(path_part "$MI_BIN"):/usr/local/bin:/usr/bin:/bin"
# Remove duplicate path entries while keeping the reviewed Node and Mi paths first.
IFS=: read -r -a path_entries <<< "$SERVICE_PATH"
SERVICE_PATH=""
for entry in "${path_entries[@]}"; do
  [[ ":$SERVICE_PATH:" == *":$entry:"* ]] && continue
  SERVICE_PATH+="${SERVICE_PATH:+:}$entry"
done

PROACTIVE_NOTICE="${MI_PROACTIVE_IMESSAGE_NOTIFY:-false}"
MONITOR_ENABLED="${MI_IMESSAGE_MONITOR_ENABLED:-false}"
case "$PROACTIVE_NOTICE" in true|false|1|0|yes|no|on|off) ;; *) fail 'MI_PROACTIVE_IMESSAGE_NOTIFY must be a boolean' ;; esac
case "$MONITOR_ENABLED" in true|false|1|0|yes|no|on|off) ;; *) fail 'MI_IMESSAGE_MONITOR_ENABLED must be a boolean' ;; esac

stage="$(mktemp -d "${TMPDIR:-/tmp}/mi-user-units-render.XXXXXX")"
backup="$(mktemp -d "${TMPDIR:-/tmp}/mi-user-units-backup.XXXXXX")"
manifest="$backup/manifest"
: > "$manifest"
committed=0
backup_target() {
  local target="$1" key
  key="$(printf '%s' "$target" | sha256sum | cut -d' ' -f1)"
  if [[ -e "$target" || -L "$target" ]]; then
    cp -a -- "$target" "$backup/$key"
    printf 'present\t%s\t%s\n' "$key" "$target" >> "$manifest"
  else
    printf 'absent\t-\t%s\n' "$target" >> "$manifest"
  fi
}
rollback() {
  local status=$?
  (( committed == 1 )) && return
  while IFS=$'\t' read -r state key target; do
    rm -rf -- "$target"
    if [[ "$state" == present ]]; then
      mkdir -p "$(dirname "$target")"
      cp -a -- "$backup/$key" "$target"
    fi
  done < "$manifest"
  rm -rf -- "$stage" "$backup"
  exit "$status"
}
cleanup() { rm -rf -- "$stage" "$backup"; }
trap rollback ERR INT TERM
trap '(( committed == 1 )) && cleanup || true' EXIT

cat > "$stage/mi-daemon.service" <<EOF
[Unit]
Description=Mi background task daemon
After=network-online.target

[Service]
Type=simple
WorkingDirectory=$ROOT
Environment=HOME=$HOME_DIR
Environment=MI_ROOT=$ROOT
Environment=PATH=$SERVICE_PATH
ExecStart=$NODE_BIN $DAEMON_PATH
Restart=on-failure
RestartSec=5
PrivateTmp=true
ProtectSystem=full
ProtectHome=read-only
NoNewPrivileges=true
ReadWritePaths=$ROOT/state $HOME_DIR/.pi/agent $HOME_DIR/mi

[Install]
WantedBy=default.target
EOF
cat > "$stage/mi-tick.service" <<EOF
[Unit]
Description=Mi scheduled tick

[Service]
Type=oneshot
WorkingDirectory=$ROOT
Environment=HOME=$HOME_DIR
Environment=MI_ROOT=$ROOT
Environment=PATH=$SERVICE_PATH
Environment=MI_PROACTIVE_IMESSAGE_NOTIFY=false
Environment=MI_IMESSAGE_MONITOR_ENABLED=false
Environment=MI_PHOTON_NOTIFY_PORT=8788
ExecStart=$MI_BIN tick
Nice=5
PrivateTmp=true
ProtectSystem=full
ProtectHome=read-only
NoNewPrivileges=true
ReadWritePaths=$ROOT/state $HOME_DIR/.pi/agent $HOME_DIR/mi
EOF
cat > "$stage/mi-tick.timer" <<'EOF'
[Unit]
Description=Run Mi scheduled tick

[Timer]
OnCalendar=*:0/1
AccuracySec=30s
Persistent=true

[Install]
WantedBy=timers.target
EOF
chmod 600 "$stage"/*
# Check all generated text before the target unit directory changes.
grep -Fqx "Environment=PATH=$SERVICE_PATH" "$stage/mi-daemon.service" || fail 'daemon PATH rendering failed'
grep -Fqx 'Environment=MI_PROACTIVE_IMESSAGE_NOTIFY=false' "$stage/mi-tick.service" || fail 'tick notice safety rendering failed'
grep -Fqx 'Environment=MI_IMESSAGE_MONITOR_ENABLED=false' "$stage/mi-tick.service" || fail 'tick monitor safety rendering failed'
if command -v systemd-analyze >/dev/null && [[ ${MI_USER_UNITS_SKIP_SYSTEMD_VERIFY:-0} != 1 ]]; then
  systemd-analyze verify "$stage/mi-daemon.service" "$stage/mi-tick.service" "$stage/mi-tick.timer" >/dev/null
fi

# Do not replace an unrelated administrator unit or a former unsafe Mi unit.
# The small description check accepts older generated Mi units so safe reruns
# can tighten them, but contamination is always a hard failure.
assert_replaceable_unit() {
  local target="$1" description="$2"
  [[ ! -e "$target" && ! -L "$target" ]] && return 0
  [[ -f "$target" && ! -L "$target" ]] || fail "refusing to replace non-file unit: $target"
  grep -Fqx "Description=$description" "$target" || fail "refusing to replace unrelated unit: $target"
  ! grep -Fq '.pi/agent/extensions' "$target" || fail "refusing contaminated Pi auto-load unit: $target"
}
assert_replaceable_unit "$UNIT_DIR/mi-daemon.service" 'Mi background task daemon'
assert_replaceable_unit "$UNIT_DIR/mi-tick.service" 'Mi scheduled tick'
assert_replaceable_unit "$UNIT_DIR/mi-tick.timer" 'Run Mi scheduled tick'
install -d -m 700 "$UNIT_DIR"
for target in "$UNIT_DIR/mi-daemon.service" "$UNIT_DIR/mi-tick.service" "$UNIT_DIR/mi-tick.timer" \
  "$UNIT_DIR/mi-daemon.service.d" "$UNIT_DIR/mi-tick.service.d" "$UNIT_DIR/mi-tick.timer.d"; do backup_target "$target"; done
for name in mi-daemon.service mi-tick.service mi-tick.timer; do
  temp="$UNIT_DIR/.${name}.tmp.$$"
  cp -- "$stage/$name" "$temp"
  chmod 600 "$temp"
  mv -f -- "$temp" "$UNIT_DIR/$name"
done

if [[ ${MI_USER_UNITS_NO_SYSTEMD:-0} != 1 ]]; then
  systemctl --user daemon-reload
  if [[ ${MI_USER_UNITS_ACTIVATE_DAEMON:-0} == 1 ]]; then
    systemctl --user enable --now mi-daemon.service
  fi
  if [[ ${MI_USER_UNITS_ACTIVATE_TIMER:-0} == 1 ]]; then
    [[ -n ${MI_PROACTIVE_IMESSAGE_NOTIFY+x} && -n ${MI_IMESSAGE_MONITOR_ENABLED+x} ]] || fail 'timer activation requires explicit notice and monitor values'
    systemctl --user enable --now mi-tick.timer
  fi
fi
committed=1
cleanup
trap - ERR INT TERM EXIT
echo 'Installed Mi daemon and tick user units without starting them'
