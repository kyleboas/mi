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
  case "$1" in
    ''|*[!A-Za-z0-9._/-]*|*//*|*/./*|*/../*|*/.|*/..|*/) return 1 ;;
    /*) return 0 ;;
    *) return 1 ;;
  esac
}
require_safe_path() { safe_systemd_path "$1" || fail "unsafe path for $2"; }

# Check every existing component rather than only resolving the final path.
# A missing child is allowed only where this installer will later create it.
# That prevents a service path such as ~/.config or ~/workflows from silently
# crossing a link outside the selected service home.
assert_no_symlink_components() {
  local value="$1" label="$2" current='/' part
  require_safe_path "$value" "$label"
  local IFS='/'
  read -r -a parts <<< "${value#/}"
  for part in "${parts[@]}"; do
    [[ -n "$part" ]] || continue
    current="${current%/}/$part"
    [[ ! -L "$current" ]] || fail "$label contains a symlink component: $current"
  done
}
canonical_dir() {
  local value="$1" label="$2" result
  assert_no_symlink_components "$value" "$label"
  [[ -d "$value" ]] || fail "$label is not a directory: $value"
  result="$(cd "$value" && pwd -P)"
  [[ "$result" == "$value" ]] || fail "$label is not a canonical directory: $value"
  require_safe_path "$result" "$label"
  printf '%s\n' "$result"
}
require_below() {
  local value="$1" base="$2" label="$3"
  case "$value" in "$base"/*) ;; *) fail "$label must be under $base" ;; esac
}
require_at_or_below() {
  local value="$1" base="$2" label="$3"
  case "$value" in "$base"|"$base"/*) ;; *) fail "$label must be under $base" ;; esac
}
# Return an existing real directory under base, or a normalized missing path
# whose existing parents are all real directories under base.
validated_directory_below() {
  local value="$1" base="$2" label="$3" parent
  require_below "$value" "$base" "$label"
  assert_no_symlink_components "$value" "$label"
  if [[ -e "$value" ]]; then
    canonical_dir "$value" "$label" >/dev/null
  else
    parent="$value"
    while [[ ! -e "$parent" ]]; do parent="$(dirname "$parent")"; done
    canonical_dir "$parent" "$label parent" >/dev/null
    require_at_or_below "$parent" "$base" "$label parent"
  fi
  printf '%s\n' "$value"
}
canonical_existing_dir_below() {
  local value="$1" base="$2" label="$3" result
  result="$(validated_directory_below "$value" "$base" "$label")"
  [[ -d "$result" ]] || fail "$label is not a directory: $result"
  printf '%s\n' "$result"
}
canonical_executable() {
  local value="$1" label="$2" result
  assert_no_symlink_components "$value" "$label"
  [[ -f "$value" && -x "$value" && ! -L "$value" ]] || fail "$label is not an executable file: $value"
  result="$(readlink -f -- "$value")"
  [[ "$result" == "$value" && -f "$result" && -x "$result" ]] || fail "$label does not resolve to an executable file"
  require_safe_path "$result" "$label"
  printf '%s\n' "$result"
}
canonical_file_below() {
  local value="$1" base="$2" label="$3" result
  require_below "$value" "$base" "$label"
  assert_no_symlink_components "$value" "$label"
  [[ -f "$value" && ! -L "$value" ]] || fail "missing reviewed $label: $value"
  result="$(readlink -f -- "$value")"
  [[ "$result" == "$value" ]] || fail "$label escapes its reviewed root"
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
CONFIG_DIR="$(validated_directory_below "$RAW_CONFIG" "$HOME_DIR" XDG_CONFIG_HOME)"
UNIT_DIR="$(validated_directory_below "$CONFIG_DIR/systemd/user" "$HOME_DIR" unit-directory)"

NODE_BIN="$(canonical_executable "${MI_NODE_BIN:-/home/kyle/.nvm/versions/node/v24.15.0/bin/node}" MI_NODE_BIN)"
MI_BIN="$(canonical_executable "${MI_BIN:-/home/kyle/.nvm/versions/node/v24.15.0/bin/mi}" MI_BIN)"
DAEMON_PATH="$(canonical_file_below "$ROOT/pi/extensions/mi-daemon.mjs" "$ROOT" 'Mi daemon')"

# The daemon's only writable Pi runtime folder is its own Mi subfolder. A
# write-scoped worker also needs its configured workflow directory.
RAW_WORKFLOWS_DIR="${MI_WORKFLOWS_DIR:-$HOME_DIR/workflows}"
require_safe_path "$RAW_WORKFLOWS_DIR" MI_WORKFLOWS_DIR
WORKFLOWS_DIR="$(canonical_existing_dir_below "$RAW_WORKFLOWS_DIR" "$HOME_DIR" MI_WORKFLOWS_DIR)"
STATE_DIR="$(canonical_existing_dir_below "$ROOT/state" "$ROOT" state-directory)"
RUNTIME_DIR="$(canonical_existing_dir_below "$HOME_DIR/.pi/agent/mi" "$HOME_DIR" runtime-directory)"
MI_HOME_DIR="$(canonical_existing_dir_below "$HOME_DIR/mi" "$HOME_DIR" mi-home-directory)"
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
case "${MI_USER_UNITS_FAIL_AFTER_TEMP:-}" in ''|1) ;; *) fail 'MI_USER_UNITS_FAIL_AFTER_TEMP must be 1 when set' ;; esac

# Initialize and arm cleanup before the first temporary path is created. One
# owner-only transaction root contains both render and backup children, so any
# child-creation error has just one path to remove.
transaction=''
stage=''
backup=''
manifest=''
committed=0
rolled_back=0
config_dir_existed=0
systemd_dir_existed=0
cleanup() {
  if [[ -n "$transaction" && -d "$transaction" ]]; then
    rm -rf -- "$transaction" || true
  fi
}
validate_unit_target() {
  local target="$1"
  require_at_or_below "$target" "$UNIT_DIR" unit-target
  assert_no_symlink_components "$target" unit-target
}
restore_target() {
  local state="$1" key="$2" target="$3" parent
  validate_unit_target "$target"
  parent="$(dirname "$target")"
  validated_directory_below "$parent" "$HOME_DIR" 'unit target parent' >/dev/null
  rm -rf -- "$target"
  if [[ "$state" == present ]]; then
    mkdir -p -- "$parent"
    canonical_existing_dir_below "$parent" "$HOME_DIR" 'unit target parent' >/dev/null
    cp -a -- "$backup/$key" "$target"
  fi
}
rollback() {
  [[ "$rolled_back" == 0 ]] || return 0
  rolled_back=1
  if [[ -n "$manifest" && -f "$manifest" ]]; then
    while IFS=$'\t' read -r state key target; do
      restore_target "$state" "$key" "$target" || true
    done < "$manifest"
  fi
  # Remove only parent folders this failed first install created. Existing
  # empty folders are preserved, while an absent unit tree returns to absent.
  if [[ "$systemd_dir_existed" == 0 ]]; then rmdir -- "$CONFIG_DIR/systemd" 2>/dev/null || true; fi
  if [[ "$config_dir_existed" == 0 ]]; then rmdir -- "$CONFIG_DIR" 2>/dev/null || true; fi
  cleanup
}
on_exit() {
  local status=$?
  trap - EXIT ERR INT TERM HUP
  if [[ "$committed" == 1 ]]; then
    cleanup
  else
    rollback || true
  fi
  exit "$status"
}
trap on_exit EXIT
trap 'exit 1' ERR
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

transaction="$(mktemp -d "${TMPDIR:-/tmp}/mi-user-units-transaction.XXXXXX")"
chmod 700 "$transaction"
if [[ ${MI_USER_UNITS_FAIL_AFTER_TEMP:-} == 1 ]]; then
  fail 'injected failure after transaction temporary directory creation'
fi
stage="$transaction/render"
backup="$transaction/backup"
mkdir -m 700 -- "$stage" "$backup"
manifest="$backup/manifest"
: > "$manifest"
[[ -d "$CONFIG_DIR" ]] && config_dir_existed=1
[[ -d "$CONFIG_DIR/systemd" ]] && systemd_dir_existed=1
backup_target() {
  local target="$1" key
  validate_unit_target "$target"
  key="$(printf '%s' "$target" | sha256sum | cut -d' ' -f1)"
  if [[ -e "$target" || -L "$target" ]]; then
    cp -a -- "$target" "$backup/$key"
    printf 'present\t%s\t%s\n' "$key" "$target" >> "$manifest"
  else
    printf 'absent\t-\t%s\n' "$target" >> "$manifest"
  fi
}

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

# This is the one older daemon unit we can safely replace. It used Pi's
# automatic extension folder, but every value must still be the value derived
# above for this selected service account. Any edit, extra directive, or other
# auto-load unit remains unsafe and is rejected.
legacy_daemon_unit="$(cat <<EOF
[Unit]
Description=Mi daemon (task/socket worker supervisor)
After=network-online.target

[Service]
Type=simple
WorkingDirectory=$ROOT
Environment=HOME=$HOME_DIR
Environment=MI_ROOT=$ROOT
Environment=MI_SOCKET_PATH=$RUNTIME_DIR/main.sock
Environment=MI_RUNTIME_DIR=$RUNTIME_DIR
Environment=PATH=$SERVICE_PATH
ExecStart=$NODE_BIN $HOME_DIR/.pi/agent/extensions/mi-daemon.mjs
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF
)"
is_known_legacy_daemon_unit() {
  [[ "$(cat -- "$1")" == "$legacy_daemon_unit" ]]
}
assert_replaceable_unit() {
  local target="$1" description="$2"
  validate_unit_target "$target"
  [[ ! -e "$target" && ! -L "$target" ]] && return 0
  [[ -f "$target" && ! -L "$target" ]] || fail "refusing to replace non-file unit: $target"
  if [[ "$target" == "$UNIT_DIR/mi-daemon.service" ]] && is_known_legacy_daemon_unit "$target"; then
    return 0
  fi
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
install -d -m 700 -- "$UNIT_DIR"
UNIT_DIR="$(canonical_existing_dir_below "$UNIT_DIR" "$HOME_DIR" unit-directory)"
for name in mi-daemon.service mi-tick.service mi-tick.timer; do
  canonical_existing_dir_below "$UNIT_DIR" "$HOME_DIR" unit-directory >/dev/null
  temp="$UNIT_DIR/.${name}.tmp.$$"
  cp -- "$stage/$name" "$temp"
  chmod 600 "$temp"
  mv -f -- "$temp" "$UNIT_DIR/$name"
done

committed=1
cleanup
trap - EXIT ERR INT TERM HUP
echo 'Installed Mi daemon and tick user units without activating them'
