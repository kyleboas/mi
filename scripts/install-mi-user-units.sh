#!/usr/bin/env bash
# Install Mi's private user units. Installation writes files only; it never
# reloads, enables, starts, restarts, or otherwise activates a unit.
set -Eeuo pipefail
umask 077

fail() { echo "Mi user-unit install failed: $*" >&2; exit 1; }
# These values are rendered into systemd fields or PATH entries. Keep their
# grammar deliberately smaller than shell paths so systemd cannot reinterpret
# a value as an expansion, specifier, list, or quoted argument.
safe_systemd_path() {
  [[ "$1" =~ ^/[A-Za-z0-9._/-]+$ ]]
}
require_safe_path() { safe_systemd_path "$1" || fail "unsafe path for $2"; }
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
  [[ -f "$value" && -x "$value" && ! -L "$value" ]] || fail "$label is not an executable file: $value"
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
case "$RAW_CONFIG" in "$HOME_DIR"/*) ;; *) fail 'XDG_CONFIG_HOME must be under the target service user HOME' ;; esac
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

# The daemon's only writable Pi runtime folder is its own Mi subfolder. A
# write-scoped worker also needs its configured workflow directory.
RAW_WORKFLOWS_DIR="${MI_WORKFLOWS_DIR:-$HOME_DIR/workflows}"
require_safe_path "$RAW_WORKFLOWS_DIR" MI_WORKFLOWS_DIR
case "$RAW_WORKFLOWS_DIR" in "$HOME_DIR"/*) ;; *) fail 'MI_WORKFLOWS_DIR must be under the target service user HOME' ;; esac
WORKFLOWS_DIR="$(canonical_dir "$RAW_WORKFLOWS_DIR" MI_WORKFLOWS_DIR)"
STATE_DIR="$(canonical_dir "$ROOT/state" state-directory)"
RUNTIME_DIR="$(canonical_dir "$HOME_DIR/.pi/agent/mi" runtime-directory)"
MI_HOME_DIR="$(canonical_dir "$HOME_DIR/mi" mi-home-directory)"
for rendered_path in "$STATE_DIR" "$RUNTIME_DIR" "$MI_HOME_DIR" "$WORKFLOWS_DIR"; do
  [[ -w "$rendered_path" ]] || fail "$rendered_path is not writable"
done

# Do not inherit a caller PATH. It has exactly the reviewed executable folders
# followed by fixed system folders. Validate every individual PATH member.
path_part() { dirname "$1"; }
NODE_DIR="$(path_part "$NODE_BIN")"
MI_DIR="$(path_part "$MI_BIN")"
for rendered_path in "$NODE_DIR" "$MI_DIR" /usr/local/bin /usr/bin /bin; do require_safe_path "$rendered_path" PATH; done
SERVICE_PATH="$NODE_DIR:$MI_DIR:/usr/local/bin:/usr/bin:/bin"
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

# All values above are checked before either temporary or target state exists.
stage="$(mktemp -d "${TMPDIR:-/tmp}/mi-user-units-render.XXXXXX")"
backup="$(mktemp -d "${TMPDIR:-/tmp}/mi-user-units-backup.XXXXXX")"
manifest="$backup/manifest"
: > "$manifest"
committed=0
rolled_back=0
config_dir_existed=0
systemd_dir_existed=0
[[ -d "$CONFIG_DIR" ]] && config_dir_existed=1
[[ -d "$CONFIG_DIR/systemd" ]] && systemd_dir_existed=1
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
cleanup() { rm -rf -- "$stage" "$backup"; }
rollback() {
  (( rolled_back == 1 )) && return
  rolled_back=1
  while IFS=$'\t' read -r state key target; do
    rm -rf -- "$target"
    if [[ "$state" == present ]]; then
      mkdir -p "$(dirname "$target")"
      cp -a -- "$backup/$key" "$target"
    fi
  done < "$manifest"
  # Remove only parent folders this failed first install created. Existing
  # empty folders are preserved, while an absent unit tree returns to absent.
  (( systemd_dir_existed == 1 )) || rmdir -- "$CONFIG_DIR/systemd" 2>/dev/null || true
  (( config_dir_existed == 1 )) || rmdir -- "$CONFIG_DIR" 2>/dev/null || true
  cleanup
}
on_exit() {
  local status=$?
  trap - EXIT ERR INT TERM HUP
  (( committed == 1 )) || rollback
  exit "$status"
}
trap on_exit EXIT
trap 'exit $?' ERR
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

cat > "$stage/mi-daemon.service" <<EOF
[Unit]
Description=Mi background task daemon
After=network-online.target

[Service]
Type=simple
WorkingDirectory=$ROOT
Environment=HOME=$HOME_DIR
Environment=MI_ROOT=$ROOT
Environment=MI_WORKFLOWS_DIR=$WORKFLOWS_DIR
Environment=PATH=$SERVICE_PATH
ExecStart=$NODE_BIN $DAEMON_PATH
Restart=on-failure
RestartSec=5
PrivateTmp=true
ProtectSystem=full
ProtectHome=read-only
NoNewPrivileges=true
ReadWritePaths=$STATE_DIR $RUNTIME_DIR $MI_HOME_DIR $WORKFLOWS_DIR

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
Environment=MI_WORKFLOWS_DIR=$WORKFLOWS_DIR
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
ReadWritePaths=$STATE_DIR $RUNTIME_DIR $MI_HOME_DIR $WORKFLOWS_DIR
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
grep -Fqx "Environment=PATH=$SERVICE_PATH" "$stage/mi-daemon.service" || fail 'daemon PATH rendering failed'
grep -Fqx "Environment=MI_WORKFLOWS_DIR=$WORKFLOWS_DIR" "$stage/mi-daemon.service" || fail 'daemon workflow rendering failed'
grep -Fqx 'Environment=MI_PROACTIVE_IMESSAGE_NOTIFY=false' "$stage/mi-tick.service" || fail 'tick notice safety rendering failed'
grep -Fqx 'Environment=MI_IMESSAGE_MONITOR_ENABLED=false' "$stage/mi-tick.service" || fail 'tick monitor safety rendering failed'
if command -v systemd-analyze >/dev/null && [[ ${MI_USER_UNITS_SKIP_SYSTEMD_VERIFY:-0} != 1 ]]; then
  systemd-analyze verify "$stage/mi-daemon.service" "$stage/mi-tick.service" "$stage/mi-tick.timer" >/dev/null
fi

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
for target in "$UNIT_DIR/mi-daemon.service" "$UNIT_DIR/mi-tick.service" "$UNIT_DIR/mi-tick.timer" \
  "$UNIT_DIR/mi-daemon.service.d" "$UNIT_DIR/mi-tick.service.d" "$UNIT_DIR/mi-tick.timer.d"; do backup_target "$target"; done
# Put this snapshot last so rollback restores the complete old directory after
# individual files, and removes a directory that did not exist before a run.
backup_target "$UNIT_DIR"
install -d -m 700 "$UNIT_DIR"
for name in mi-daemon.service mi-tick.service mi-tick.timer; do
  temp="$UNIT_DIR/.${name}.tmp.$$"
  cp -- "$stage/$name" "$temp"
  chmod 600 "$temp"
  mv -f -- "$temp" "$UNIT_DIR/$name"
done

committed=1
cleanup
trap - EXIT ERR INT TERM HUP
echo 'Installed Mi daemon and tick user units without activating them'
