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

# This one-time migration is pinned to the reviewed live bundle. Generating an
# expected unit from the installer's current environment is not an identity
# check: matching bytes can still be rejected when any rendered input differs
# in the real stack invocation. Exact hashes make the sole accepted bytes
# independent of caller configuration while the file/type/owner/mode checks
# below keep the migration fail closed.
readonly LEGACY_DAEMON_SHA256='40d4ac150ab908f1935b954ac30624b678f7ca67e7fd1464287cbb33064fb375'
readonly LEGACY_DAEMON_DROPIN_SHA256='aaed2d6c33eda381c1c950aad6baf566ccdd28304525333be0f5598c09eed7bc'
# The reviewed live tick bundle: an old NVM `mi tick` base with a proactive
# notice and a one-minute timer, plus the two staged drop-ins that force the v2
# path, both notice switches off, and a five-minute interval. The replacement
# bases carry the safe switches directly, so the drop-ins become obsolete.
readonly LEGACY_TICK_SERVICE_SHA256='84bc7112f6eca73c81e392e0f7716107f2e6d240524825fab8db105e5366e464'
readonly LEGACY_TICK_TIMER_SHA256='34931c182422d14de7fe5526a8e8e621e7b990ba1fe4d622f2e18f5af2674723'
readonly LEGACY_TICK_SERVICE_DROPIN_SHA256='b77c29ea99903d3e27ec9ab21a1328c5182a21bfb4163d9861a184346713a8dd'
readonly LEGACY_TICK_TIMER_DROPIN_SHA256='fb4a14fe38ed9b1bec2974409c421286296cd549031112805848603aa33bec15'
sha256_file() {
  local output
  output="$(sha256sum -- "$1")"
  printf '%s\n' "${output%% *}"
}

assert_safe_existing_file() {
  local target="$1" label="$2" mode owner
  [[ -f "$target" && ! -L "$target" ]] || fail "$label is not a regular file: $target"
  owner="$(stat -c '%u' -- "$target")"
  mode="$(stat -c '%a' -- "$target")"
  [[ "$owner" == "${EUID:-$(id -u)}" ]] || fail "$label has an unsafe owner: $target"
  (( (8#$mode & 8#022) == 0 )) || fail "$label is writable by group or other: $target"
}
assert_safe_existing_directory() {
  local target="$1" label="$2" mode owner
  [[ -d "$target" && ! -L "$target" ]] || fail "$label is not a real directory: $target"
  owner="$(stat -c '%u' -- "$target")"
  mode="$(stat -c '%a' -- "$target")"
  [[ "$owner" == "${EUID:-$(id -u)}" ]] || fail "$label has an unsafe owner: $target"
  (( (8#$mode & 8#022) == 0 )) || fail "$label is writable by group or other: $target"
}
# The hashes embed the reviewed paths, but also pin the replacement target: the
# same old bytes copied into another account, or replaced from another Node or
# Mi runtime, must not authorize migration. Every clause returns explicitly so
# the pin still holds when `set -e` is suspended by the calling condition.
is_reviewed_live_account() {
  [[ "$HOME_DIR" == /home/kyle ]] || return 1
  [[ "$ROOT" == /home/kyle/assistant ]] || return 1
  [[ "${EUID:-$(id -u)}" == 1000 ]] || return 1
  [[ "$NODE_BIN" == /home/kyle/.nvm/versions/node/v24.15.0/bin/node ]] || return 1
  [[ "$MI_BIN" == /home/kyle/.nvm/versions/node/v24.15.0/bin/mi ]] || return 1
}
is_known_legacy_daemon_unit() {
  local target="$1" mode
  assert_safe_existing_file "$target" 'legacy daemon unit'
  is_reviewed_live_account || return 1
  [[ "$(sha256_file "$target")" == "$LEGACY_DAEMON_SHA256" ]] || return 1
  mode="$(stat -c '%a' -- "$target")"
  [[ "$mode" == 644 ]] || fail "legacy daemon unit has an unexpected mode: $target"
}
# A published bundle keeps an empty owner-only drop-in directory, so accept
# only that shape beside an already hardened base.
assert_known_hardened_dropins() {
  local target="$1" label="$2" mode
  local entries
  if [[ ! -e "$target" && ! -L "$target" ]]; then return 0; fi
  validate_unit_target "$target"
  assert_safe_existing_directory "$target" "$label"
  mode="$(stat -c '%a' -- "$target")"
  [[ "$mode" == 700 ]] || fail "$label has an unexpected mode: $target"
  shopt -s nullglob dotglob
  entries=("$target"/*)
  shopt -u nullglob dotglob
  [[ "${#entries[@]}" == 0 ]] || fail "refusing unknown $label bundle: $target"
}
assert_known_hardened_daemon_dropins() {
  assert_known_hardened_dropins "$UNIT_DIR/mi-daemon.service.d" 'hardened daemon drop-in directory'
}
# Each reviewed legacy drop-in directory holds exactly one reviewed file. Their
# directory and file modes differ per bundle, so pin every one of them exactly.
assert_known_legacy_dropin_dir() {
  local target="$1" dir_mode="$2" name="$3" file_mode="$4" expected_sha="$5" label="$6" mode
  local entries
  validate_unit_target "$target"
  assert_safe_existing_directory "$target" "$label directory"
  mode="$(stat -c '%a' -- "$target")"
  [[ "$mode" == "$dir_mode" ]] || fail "$label directory has an unexpected mode: $target"
  shopt -s nullglob dotglob
  entries=("$target"/*)
  shopt -u nullglob dotglob
  [[ "${#entries[@]}" == 1 && "${entries[0]}" == "$target/$name" ]] || fail "refusing unknown $label bundle: $target"
  assert_safe_existing_file "${entries[0]}" "$label file"
  mode="$(stat -c '%a' -- "${entries[0]}")"
  [[ "$mode" == "$file_mode" ]] || fail "$label file has an unexpected mode: ${entries[0]}"
  [[ "$(sha256_file "${entries[0]}")" == "$expected_sha" ]] || fail "$label file has unexpected contents: ${entries[0]}"
}
assert_known_legacy_daemon_dropins() {
  assert_known_legacy_dropin_dir "$UNIT_DIR/mi-daemon.service.d" 755 resource-limits.conf 644 \
    "$LEGACY_DAEMON_DROPIN_SHA256" 'legacy daemon drop-in'
}
is_known_legacy_tick_service() {
  local target="$1"
  assert_safe_existing_file "$target" 'legacy tick service'
  is_reviewed_live_account || return 1
  [[ "$(sha256_file "$target")" == "$LEGACY_TICK_SERVICE_SHA256" ]] || return 1
}
# The reviewed legacy tick base identifies a bundle of four members. Migration
# accepts only that complete bundle: exact types, owner, modes, filenames, and
# bytes. Nothing here parses or trusts unit content.
assert_known_legacy_tick_bundle() {
  local service="$UNIT_DIR/mi-tick.service" timer="$UNIT_DIR/mi-tick.timer" mode
  mode="$(stat -c '%a' -- "$service")"
  [[ "$mode" == 644 ]] || fail "legacy tick service has an unexpected mode: $service"
  validate_unit_target "$timer"
  assert_safe_existing_file "$timer" 'legacy tick timer'
  mode="$(stat -c '%a' -- "$timer")"
  [[ "$mode" == 644 ]] || fail "legacy tick timer has an unexpected mode: $timer"
  [[ "$(sha256_file "$timer")" == "$LEGACY_TICK_TIMER_SHA256" ]] || fail "legacy tick timer has unexpected contents: $timer"
  assert_known_legacy_dropin_dir "$UNIT_DIR/mi-tick.service.d" 700 90-mi-staged-activation.conf 600 \
    "$LEGACY_TICK_SERVICE_DROPIN_SHA256" 'legacy tick service drop-in'
  assert_known_legacy_dropin_dir "$UNIT_DIR/mi-tick.timer.d" 755 50-interval.conf 644 \
    "$LEGACY_TICK_TIMER_DROPIN_SHA256" 'legacy tick timer drop-in'
}
legacy_daemon=0
legacy_tick=0
# Accepting a unit prints its migration marker rather than assigning a variable,
# because each predicate runs in a subshell so one rejection cannot hide the
# remaining ones.
assert_replaceable_unit() {
  local target="$1" stage_file="$2"
  validate_unit_target "$target"
  if [[ ! -e "$target" && ! -L "$target" ]]; then
    # An absent tick base under leftover drop-ins is an incomplete bundle: the
    # tick migration publishes both bases together, so refuse to write a base
    # beneath overrides that were never reviewed against it.
    assert_replaceable_dropins "$target"
    return 0
  fi
  assert_safe_existing_file "$target" 'existing unit'
  if [[ "$target" == "$UNIT_DIR/mi-daemon.service" ]] && is_known_legacy_daemon_unit "$target"; then
    assert_known_legacy_daemon_dropins
    printf 'legacy-daemon\n'
    return 0
  fi
  if [[ "$target" == "$UNIT_DIR/mi-tick.service" ]] && is_known_legacy_tick_service "$target"; then
    assert_known_legacy_tick_bundle
    printf 'legacy-tick\n'
    return 0
  fi
  # The timer was already accepted byte for byte as a member of that bundle.
  if [[ "$target" == "$UNIT_DIR/mi-tick.timer" && "$legacy_tick" == 1 ]]; then return 0; fi
  if [[ "$target" == "$UNIT_DIR/mi-daemon.service" ]] && grep -Fq '.pi/agent/extensions' -- "$target"; then
    fail "refusing contaminated Pi auto-load unit: $target"
  fi
  cmp -s -- "$stage_file" "$target" || fail "refusing to replace altered or unrelated unit: $target"
  assert_replaceable_dropins "$target"
}
assert_replaceable_dropins() {
  case "$1" in
    "$UNIT_DIR/mi-daemon.service") assert_known_hardened_daemon_dropins ;;
    "$UNIT_DIR/mi-tick.service")
      assert_known_hardened_dropins "$UNIT_DIR/mi-tick.service.d" 'hardened tick service drop-in directory' ;;
    "$UNIT_DIR/mi-tick.timer")
      assert_known_hardened_dropins "$UNIT_DIR/mi-tick.timer.d" 'hardened tick timer drop-in directory' ;;
  esac
}
# Collect every rejection instead of returning at the first one. A serial
# preflight hides later blockers behind the first, so an operator learns about
# them one failed run at a time; the whole bundle is reported together here.
# Each predicate runs in a command substitution, whose subshell resets the
# inherited traps, so a rejection can neither roll back nor exit this run. A
# signal is still fatal rather than a blocker: it is not a fact about a unit.
preflight_blockers=()
preflight_unit() {
  local target="$1" stage_file="$2" marks='' status=0 message mark
  marks="$(assert_replaceable_unit "$target" "$stage_file" 2>"$transaction/preflight.err")" || status=$?
  if (( status == 0 )); then
    for mark in $marks; do
      case "$mark" in
        legacy-daemon) legacy_daemon=1 ;;
        legacy-tick) legacy_tick=1 ;;
        *) fail "unexpected preflight marker for $target: $mark" ;;
      esac
    done
    return 0
  fi
  (( status < 128 )) || exit "$status"
  message="$(< "$transaction/preflight.err")"
  message="${message#Mi user-unit install failed: }"
  preflight_blockers+=("${message:-rejected without a message (status $status): $target}")
  return 0
}
preflight_unit "$UNIT_DIR/mi-daemon.service" "$stage/mi-daemon.service"
preflight_unit "$UNIT_DIR/mi-tick.service" "$stage/mi-tick.service"
preflight_unit "$UNIT_DIR/mi-tick.timer" "$stage/mi-tick.timer"
if (( ${#preflight_blockers[@]} > 0 )); then
  printf 'Mi user-unit install blocker: %s\n' "${preflight_blockers[@]}" >&2
  fail "${#preflight_blockers[@]} preflight blocker(s); no unit was changed"
fi
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
# Replace each complete reviewed legacy bundle, rather than leaving accepted
# drop-ins beside the hardened base that already carries their safe settings.
# Every staged replacement is empty by design. Moving an old directory aside
# before publishing preserves an exact rollback source if any later filesystem
# operation fails.
retire_legacy_dropins() {
  local name="$1" target
  target="$UNIT_DIR/$name"
  if [[ -d "$target" ]]; then
    mv -- "$target" "$transaction/retired-$name"
  fi
  mkdir -m 700 -- "$stage/$name"
  mv -- "$stage/$name" "$target"
}
if [[ "$legacy_daemon" == 1 ]]; then
  retire_legacy_dropins mi-daemon.service.d
fi
if [[ "$legacy_tick" == 1 ]]; then
  retire_legacy_dropins mi-tick.service.d
  retire_legacy_dropins mi-tick.timer.d
fi

committed=1
cleanup
trap - EXIT ERR INT TERM HUP
echo 'Installed Mi daemon and tick user units without activating them'
