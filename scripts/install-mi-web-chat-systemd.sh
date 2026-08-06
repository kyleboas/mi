#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

fail() { echo "Mi web chat install failed: $*" >&2; exit 1; }
# Paths placed in a unit must have a small, literal grammar. This also keeps
# path comparisons below from accepting spelling tricks such as /./ or /../.
safe_path() {
  case "$1" in
    ''|*[!A-Za-z0-9._/-]*|*//*|*/./*|*/../*|*/.|*/..|*/) return 1 ;;
    /*) return 0 ;;
    *) return 1 ;;
  esac
}
require_safe_path() { safe_path "$1" || fail "unsafe path for $2"; }
[[ "${MI_WEB_MAINTENANCE:-0}" == 1 ]] || fail 'set MI_WEB_MAINTENANCE=1 for the explicit maintenance Web mode'
require_below() {
  case "$1" in "$2"/*) ;; *) fail "$3 must be under $2" ;; esac
}
require_at_or_below() {
  case "$1" in "$2"|"$2"/*) ;; *) fail "$3 must be under $2" ;; esac
}
# Check each existing component with lstat (-L) before asking the shell to
# enter it. A link is rejected even when it currently points back inside.
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
# A destination may not exist yet. Its first existing parent must be a real,
# canonical directory under base, and every existing component is checked.
validated_directory_below() {
  local value="$1" base="$2" label="$3" parent
  require_below "$value" "$base" "$label"
  assert_no_symlink_components "$value" "$label"
  if [[ -e "$value" ]]; then
    canonical_dir "$value" "$label" >/dev/null
  else
    parent="$value"
    while [[ ! -e "$parent" && ! -L "$parent" ]]; do parent="$(dirname "$parent")"; done
    [[ ! -L "$parent" ]] || fail "$label contains a symlink component: $parent"
    canonical_dir "$parent" "$label parent" >/dev/null
    require_at_or_below "$parent" "$base" "$label parent"
  fi
  printf '%s\n' "$value"
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
# Create exactly one checked path component. Never use mkdir -p, which could
# follow a link inserted between two components.
create_validated_directory() {
  local value="$1" base="$2" label="$3" parent
  validated_directory_below "$value" "$base" "$label" >/dev/null
  if [[ ! -e "$value" ]]; then
    parent="$(dirname "$value")"
    assert_no_symlink_components "$parent" "$label parent"
    canonical_dir "$parent" "$label parent" >/dev/null
    require_at_or_below "$parent" "$base" "$label parent"
    mkdir -m 700 -- "$value"
  fi
  validated_directory_below "$value" "$base" "$label" >/dev/null
}
validate_regular_target() {
  local value="$1" parent="$2" label="$3"
  require_below "$value" "$parent" "$label"
  assert_no_symlink_components "$value" "$label"
  [[ ! -e "$value" ]] || [[ -f "$value" && ! -L "$value" ]] || fail "refusing to replace non-file $label: $value"
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
SYSTEMD_DIR="$(validated_directory_below "$CONFIG_DIR/systemd" "$HOME_DIR" systemd-directory)"
UNIT_DIR="$(validated_directory_below "$SYSTEMD_DIR/user" "$HOME_DIR" unit-directory)"
UNIT_PATH="$UNIT_DIR/mi-web-chat.service"
DROPIN_DIR="$UNIT_DIR/mi-web-chat.service.d"
DROPIN_PATH="$DROPIN_DIR/10-mi-runtime.conf"
STATE_DIR="$(validated_directory_below "$ROOT/state" "$ROOT" state-directory)"
TLS_DIR="$(validated_directory_below "$STATE_DIR/tls" "$ROOT" tls-directory)"
RUNTIME_DROPIN="$(canonical_file_below "$ROOT/systemd/mi-web-chat.service.d/10-mi-runtime.conf" "$ROOT" 'runtime drop-in')"

DNS_NAME="${1:-}"
if [ -z "$DNS_NAME" ]; then
  DNS_NAME="$(tailscale status --json | node -e '
let input = "";
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => {
  const name = String(JSON.parse(input).Self?.DNSName || "").replace(/\.$/, "");
  if (!name) process.exit(1);
  process.stdout.write(name);
});
')"
fi
DNS_NAME="${DNS_NAME%.}"
if [[ ! "$DNS_NAME" =~ ^[A-Za-z0-9][A-Za-z0-9.-]*[A-Za-z0-9]$ ]]; then
  echo "Invalid Tailscale DNS name: $DNS_NAME" >&2
  exit 1
fi

CERT_PATH="$TLS_DIR/$DNS_NAME.crt"
KEY_PATH="$TLS_DIR/$DNS_NAME.key"
# All destination trees were checked before DNS lookup. Recheck and create one
# component at a time before writing so an inserted same-user link fails closed.
create_validated_directory "$CONFIG_DIR" "$HOME_DIR" XDG_CONFIG_HOME
create_validated_directory "$SYSTEMD_DIR" "$HOME_DIR" systemd-directory
create_validated_directory "$UNIT_DIR" "$HOME_DIR" unit-directory
create_validated_directory "$DROPIN_DIR" "$HOME_DIR" drop-in-directory
create_validated_directory "$STATE_DIR" "$ROOT" state-directory
create_validated_directory "$TLS_DIR" "$ROOT" tls-directory

TEMP_FILES=()
cleanup() {
  local file
  for file in "${TEMP_FILES[@]}"; do [[ -e "$file" || -L "$file" ]] && rm -f -- "$file" || true; done
}
trap cleanup EXIT HUP INT TERM
atomic_write_runtime_dropin() {
  local parent="$DROPIN_DIR" target="$DROPIN_PATH" temp
  validated_directory_below "$parent" "$HOME_DIR" drop-in-directory >/dev/null
  validate_regular_target "$target" "$parent" runtime-drop-in
  temp="$(mktemp "$parent/.10-mi-runtime.conf.XXXXXX")"
  TEMP_FILES+=("$temp")
  sed "s|/home/kyle|$HOME_DIR|g" "$RUNTIME_DROPIN" > "$temp"
  chmod 644 "$temp"
  validated_directory_below "$parent" "$HOME_DIR" drop-in-directory >/dev/null
  validate_regular_target "$target" "$parent" runtime-drop-in
  mv -f -- "$temp" "$target"
}
atomic_write_unit() {
  local parent="$UNIT_DIR" target="$UNIT_PATH" temp
  validated_directory_below "$parent" "$HOME_DIR" unit-directory >/dev/null
  validate_regular_target "$target" "$parent" web-unit
  temp="$(mktemp "$parent/.mi-web-chat.service.XXXXXX")"
  TEMP_FILES+=("$temp")
  cat > "$temp" <<EOF
[Unit]
Description=Mi web chat (private Tailscale UI)
Wants=llm-gateway.service
After=network-online.target llm-gateway.service

[Service]
Type=simple
WorkingDirectory=$ROOT
Environment=MI_ROOT=$ROOT
Environment=MI_WEB_MAINTENANCE=1
ExecStartPre=/usr/bin/tailscale cert --cert-file $CERT_PATH --key-file $KEY_PATH $DNS_NAME
ExecStart=/usr/bin/env node $ROOT/scripts/mi-web-chat.mjs
Restart=on-failure
RestartSec=5
PrivateTmp=true
ProtectSystem=full

[Install]
WantedBy=default.target
EOF
  chmod 644 "$temp"
  validated_directory_below "$parent" "$HOME_DIR" unit-directory >/dev/null
  validate_regular_target "$target" "$parent" web-unit
  mv -f -- "$temp" "$target"
}

atomic_write_runtime_dropin

# Remove only byte-for-byte known Mi-owned predecessors. Modified and unrelated
# operator drop-ins are preserved and reported.
old_nvm=$'# Mi V2 invokes /home/kyle/bin/pi-gateway, which execs `pi` via PATH.\n# Keep it on the supported NVM Pi binary rather than the distro-global Pi.\n[Service]\nEnvironment=PATH=/home/kyle/.nvm/versions/node/v24.15.0/bin:/usr/local/bin:/usr/bin:/bin'
old_helper="[Service]"$'\n'"Environment=MI_GATEWAY_CLIENT=${XDG_DATA_HOME:-$HOME_DIR/.local/share}/mi/mi-gateway-client.py"
old_pi="[Service]"$'\n'"Environment=PI_CMD=$HOME_DIR/bin/pi-gateway"
for candidate in 10-nvm-pi-path.conf 20-mi-gateway-client.conf 20-pi-gateway.conf 30-nvm-pi-path.conf; do
  path="$DROPIN_DIR/$candidate"
  validated_directory_below "$DROPIN_DIR" "$HOME_DIR" drop-in-directory >/dev/null
  assert_no_symlink_components "$path" old-drop-in
  [[ -f "$path" && ! -L "$path" ]] || continue
  content="$(cat "$path")"
  if [[ "$content" == "$old_nvm" || "$content" == "$old_helper" || "$content" == "$old_pi" ]]; then
    validated_directory_below "$DROPIN_DIR" "$HOME_DIR" drop-in-directory >/dev/null
    assert_no_symlink_components "$path" old-drop-in
    rm -f -- "$path"
    echo "Removed known superseded Mi drop-in: $candidate"
  else
    echo "Preserved modified or unknown drop-in: $candidate" >&2
  fi
done

atomic_write_unit
# Files only. An operator must reload and start the web service separately.
echo "Installed $UNIT_PATH for $DNS_NAME without activating services"
