#!/usr/bin/env bash
# Internal transaction coordinator. Invoke through ~/install-mi-stack.sh.
set -Eeuo pipefail

ROOT="${MI_APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
TARGET_HOME="${MI_STACK_HOME:-/home/kyle}"
SYSTEM_ROOT="${MI_SYSTEM_ROOT:-}"
SERVICE_USER="${MI_SERVICE_USER:-kyle}"
GATEWAY_SERVICE_USER="${MI_GATEWAY_SERVICE_USER:-$SERVICE_USER}"
GATEWAY_SERVICE_HOME="${MI_GATEWAY_SERVICE_HOME:-$TARGET_HOME}"
GATEWAY_PI_BINARY="${MI_GATEWAY_PI_BINARY:-/home/kyle/.nvm/versions/node/v24.15.0/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js}"
GATEWAY_PI_COMMAND_DIR="${MI_GATEWAY_PI_COMMAND_DIR:-/home/kyle/.nvm/versions/node/v24.15.0/bin}"
GATEWAY_PI_AGENT_DIR="${MI_GATEWAY_PI_AGENT_DIR:-$TARGET_HOME/.pi/agent}"
GATEWAY_WORK_DIR="${MI_GATEWAY_WORK_DIR:-/var/lib/llm-gateway}"
GATEWAY_HEALTH_USER="${MI_GATEWAY_HEALTH_USER:-$GATEWAY_SERVICE_USER}"
MODE=install
case "${1:-}" in
  '') ;;
  --check) MODE=check ;;
  --dry-run) MODE=dry-run ;;
  *) echo 'Usage: install-mi-stack-root.sh [--check|--dry-run]' >&2; exit 2 ;;
esac

stages=(production-gateway gateway-client production-registry user-units photon-loopback generated-entrypoints readiness)
if [[ "$MODE" == dry-run ]]; then
  printf 'Mi stack dry-run (no changes):\n'
  printf '  %s\n' "${stages[@]}"
  exit 0
fi

check_file() { [[ -e "$1" ]] || { printf 'missing: %s\n' "$2"; return 1; }; }
check_contains() { grep -Fq -- "$2" "$1" 2>/dev/null || { printf 'mismatch: %s\n' "$3"; return 1; }; }
if [[ "$MODE" == check ]]; then
  failed=0
  check_file "$TARGET_HOME/install-mi-stack.sh" 'canonical entrypoint' || failed=1
  [[ $(stat -c '%a' "$TARGET_HOME/install-mi-stack.sh" 2>/dev/null || true) == 700 ]] || { echo 'mismatch: canonical entrypoint mode'; failed=1; }
  daemon_unit="$TARGET_HOME/.config/systemd/user/mi-daemon.service"
  check_file "$daemon_unit" 'Mi daemon user unit' || failed=1
  if [[ -f "$daemon_unit" ]]; then
    check_contains "$daemon_unit" "$ROOT/pi/extensions/mi-daemon.mjs" 'reviewed Mi daemon path' || failed=1
    if grep -Fq -- '.pi/agent/extensions' "$daemon_unit"; then
      echo 'mismatch: Mi daemon must not use Pi auto-load extensions'; failed=1
    fi
    check_contains "$daemon_unit" 'PrivateTmp=true' 'daemon private temporary files' || failed=1
    check_contains "$daemon_unit" 'ProtectSystem=full' 'daemon protected system files' || failed=1
    check_contains "$daemon_unit" 'Environment=PATH=' 'daemon fixed PATH' || failed=1
  fi
  tick_unit="$TARGET_HOME/.config/systemd/user/mi-tick.service"
  check_file "$tick_unit" 'Mi tick user unit' || failed=1
  if [[ -f "$tick_unit" ]]; then
    check_contains "$tick_unit" 'Environment=MI_PROACTIVE_IMESSAGE_NOTIFY=false' 'tick notices disabled' || failed=1
    check_contains "$tick_unit" 'Environment=MI_IMESSAGE_MONITOR_ENABLED=false' 'tick repair monitor disabled' || failed=1
  fi
  photon="$SYSTEM_ROOT/etc/systemd/system/mi-photon-bridge.service"
  check_contains "$photon" 'Environment=MI_ROOT=' 'Photon Mi root' || failed=1
  node_bin="${MI_NODE_BIN:-/home/kyle/.nvm/versions/node/v24.15.0/bin/node}"
  registry_dir="${MI_GATEWAY_CONFIG_DIR:-$TARGET_HOME/.pi/agent}"
  if [[ -x "$node_bin" && -f "$registry_dir/settings.json" && -f "$registry_dir/models.json" ]]; then
    MI_GATEWAY_CONFIG_DIR="$registry_dir" "$node_bin" "$ROOT/scripts/install-mi-gateway-models.mjs" --check >/dev/null || failed=1
  else
    echo 'missing: production Pi registry'; failed=1
  fi
  printf '%s\n' \
    'Expected gateway aliases: coding-main (high), mi-concierge (medium); eval aliases absent' \
    'Expected Photon service: mi-photon-bridge.service' \
    'Expected helper: ~/.local/share/mi/mi-gateway-client.py' \
    'Expected PATH: supported NVM bin, then system bins'
  if command -v systemctl >/dev/null && [[ -z "$SYSTEM_ROOT" ]]; then
    service_user="${MI_SERVICE_USER:-kyle}"
    runtime_dir="/run/user/$(id -u "$service_user")"
    if runuser -u "$service_user" -- env XDG_RUNTIME_DIR="$runtime_dir" systemctl --user is-active --quiet mi-tick.timer; then
      echo 'mismatch: mi-tick.timer must stay inactive until separately approved'; failed=1
    fi
  fi
  (( failed == 0 )) && echo 'Mi stack check passed'
  exit "$failed"
fi

if [[ -z "$SYSTEM_ROOT" && ${EUID:-$(id -u)} -ne 0 ]]; then
  echo 'Mi stack preflight failed: root orchestrator requires the canonical sudo boundary' >&2
  exit 1
fi

STACK_NODE_BIN="${MI_NODE_BIN:-/home/kyle/.nvm/versions/node/v24.15.0/bin/node}"
safe_stack_path() { [[ "$1" =~ ^/[A-Za-z0-9._/-]+$ ]]; }
require_stack_path() { safe_stack_path "$1" || { echo "Mi stack preflight failed: unsafe $2" >&2; exit 1; }; }
require_stack_path "$ROOT" MI_APP_DIR
require_stack_path "$TARGET_HOME" MI_STACK_HOME
require_stack_path "$STACK_NODE_BIN" MI_NODE_BIN
[[ "$SERVICE_USER" =~ ^[a-z_][a-z0-9_-]*$ ]] || { echo 'Mi stack preflight failed: unsafe MI_SERVICE_USER' >&2; exit 1; }
# Never derive service paths from a root caller environment. The service home
# is an existing, canonical target-account directory; XDG roots are fixed
# children of it and PATH comes only from the reviewed Node path and system dirs.
[[ -d "$TARGET_HOME" && ! -L "$TARGET_HOME" ]] || { echo 'Mi stack preflight failed: MI_STACK_HOME must be a real directory' >&2; exit 1; }
TARGET_HOME="$(cd "$TARGET_HOME" && pwd -P)"
require_stack_path "$TARGET_HOME" MI_STACK_HOME
[[ -x "$STACK_NODE_BIN" && ! -L "$STACK_NODE_BIN" ]] || { echo 'Mi stack preflight failed: MI_NODE_BIN must be an executable file' >&2; exit 1; }
STACK_NODE_BIN="$(readlink -f -- "$STACK_NODE_BIN")"
require_stack_path "$STACK_NODE_BIN" MI_NODE_BIN
TARGET_XDG_CONFIG_HOME="$TARGET_HOME/.config"
TARGET_XDG_DATA_HOME="$TARGET_HOME/.local/share"
TARGET_SERVICE_PATH="${STACK_NODE_BIN%/*}:/usr/local/bin:/usr/bin:/bin"
case "${MI_STACK_FAIL_SETUP:-}" in ''|after-temp|after-manifest) ;; *) echo 'Mi stack preflight failed: MI_STACK_FAIL_SETUP must name a supported setup step' >&2; exit 1 ;; esac

# Arm one cleanup path before creating the owner-only transaction root. This
# covers a failed mktemp, manifest creation, or snapshot before any stage runs.
transaction=''
backup=''
manifest=''
committed=0
rolled_back=0
current_stage=preflight
cleanup() {
  [[ -n "$transaction" && -d "$transaction" ]] && rm -rf -- "$transaction" || true
}
rollback() {
  [[ "$rolled_back" == 0 ]] || return 0
  rolled_back=1
  if [[ -n "$manifest" && -f "$manifest" ]]; then
    echo "Mi stack failed at stage $current_stage; restoring generated configuration" >&2
    while IFS=$'\t' read -r state key path; do
      rm -rf -- "$path" || true
      [[ "$state" == present ]] && { mkdir -p "$(dirname "$path")" && cp -a -- "$backup/$key" "$path"; } || true
    done < "$manifest"
  fi
  # This transaction is files-only. Restoring files must not reload, enable,
  # start, stop, or restart a gateway, Photon, web, daemon, or timer service.
  cleanup
}
on_exit() {
  local status=$?
  trap - EXIT ERR INT TERM HUP
  if [[ "$committed" == 1 ]]; then cleanup; else rollback; fi
  exit "$status"
}
trap on_exit EXIT
trap 'exit 1' ERR
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

transaction="$(mktemp -d "${TMPDIR:-/tmp}/mi-stack-rollback.XXXXXX")"
chmod 700 "$transaction"
backup="$transaction"
[[ ${MI_STACK_FAIL_SETUP:-} != after-temp ]] || { echo 'Mi stack injected failure after transaction temporary directory creation' >&2; exit 1; }
manifest="$backup/manifest"
: > "$manifest"
[[ ${MI_STACK_FAIL_SETUP:-} != after-manifest ]] || { echo 'Mi stack injected failure after transaction manifest creation' >&2; exit 1; }
backup_path() {
  local path="$1" key
  key=$(printf '%s' "$path" | sha256sum | cut -d' ' -f1)
  if [[ -e "$path" || -L "$path" ]]; then
    cp -a -- "$path" "$backup/$key"
    printf 'present\t%s\t%s\n' "$key" "$path" >> "$manifest"
  else
    printf 'absent\t-\t%s\n' "$path" >> "$manifest"
  fi
}
while IFS= read -r path; do backup_path "$path"; done <<PATHS
$TARGET_HOME/.config/systemd/user/mi-daemon.service
$TARGET_HOME/.config/systemd/user/mi-tick.service
$TARGET_HOME/.config/systemd/user/mi-tick.timer
$TARGET_HOME/.local/share/mi/mi-gateway-client.py
$TARGET_HOME/.pi/agent/settings.json
$TARGET_HOME/.pi/agent/models.json
$TARGET_HOME/install-mi-stack.sh
$TARGET_HOME/install-mi-subscription-gateway.sh
$TARGET_HOME/fix-mi-gateway.sh
$SYSTEM_ROOT/etc/litellm/config.yaml
$SYSTEM_ROOT/etc/litellm/pi_subscription_handler.py
$SYSTEM_ROOT/etc/litellm/pi_subscription_eval_handler.py
$SYSTEM_ROOT/usr/local/libexec/start-llm-gateway
$SYSTEM_ROOT/usr/local/libexec/wait-for-llm-gateway-health
$SYSTEM_ROOT/etc/systemd/system/llm-gateway.service.d/20-codex-subscription.conf
$SYSTEM_ROOT/etc/systemd/system/mi-photon-bridge.service
$SYSTEM_ROOT/etc/systemd/system/mi-photon-bridge.service.d/override.conf
PATHS

run_stage() {
  current_stage="$1"; shift
  echo "Mi stack stage: $current_stage"
  if [[ -n ${MI_STACK_STAGE_COMMAND_DIR:-} && -x "$MI_STACK_STAGE_COMMAND_DIR/$current_stage" ]]; then
    # Test stages replace only the stage executable. Keep the as_user boundary
    # and its explicit VAR=value arguments, but remove a normal interpreter
    # and its source-file argument as one command.
    if [[ "$1" == as_user ]]; then
      shift
      local user_command=(env)
      [[ "$1" == env ]] && shift
      while (( $# )) && [[ "$1" == *=* ]]; do
        user_command+=("$1")
        shift
      done
      user_command+=("$MI_STACK_STAGE_COMMAND_DIR/$current_stage")
      as_user "${user_command[@]}"
    else
      local command=("$@")
      local last=$((${#command[@]} - 1))
      command[$last]="$MI_STACK_STAGE_COMMAND_DIR/$current_stage"
      "${command[@]}"
    fi
  else
    "$@"
  fi
}
as_user() {
  # env -i drops root HOME, XDG roots, PATH, and every other inherited value.
  # Arguments following it are the only explicit variables allowed per stage.
  if [[ -n "$SYSTEM_ROOT" || ${MI_STACK_NO_RUNUSER:-0} == 1 ]]; then
    env -i HOME="$TARGET_HOME" XDG_CONFIG_HOME="$TARGET_XDG_CONFIG_HOME" XDG_DATA_HOME="$TARGET_XDG_DATA_HOME" PATH="$TARGET_SERVICE_PATH" "$@"
  else
    runuser -u "$SERVICE_USER" -- env -i HOME="$TARGET_HOME" XDG_CONFIG_HOME="$TARGET_XDG_CONFIG_HOME" XDG_DATA_HOME="$TARGET_XDG_DATA_HOME" PATH="$TARGET_SERVICE_PATH" "$@"
  fi
}

run_stage production-gateway env \
  MI_GATEWAY_NO_SYSTEMD=1 \
  MI_GATEWAY_ROOT="$SYSTEM_ROOT" \
  MI_GATEWAY_SERVICE_USER="$GATEWAY_SERVICE_USER" \
  MI_GATEWAY_SERVICE_HOME="$GATEWAY_SERVICE_HOME" \
  MI_GATEWAY_PI_BINARY="$GATEWAY_PI_BINARY" \
  MI_GATEWAY_PI_COMMAND_DIR="$GATEWAY_PI_COMMAND_DIR" \
  MI_GATEWAY_PI_AGENT_DIR="$GATEWAY_PI_AGENT_DIR" \
  MI_GATEWAY_WORK_DIR="$GATEWAY_WORK_DIR" \
  MI_GATEWAY_HEALTH_COMMAND="${MI_GATEWAY_HEALTH_COMMAND:-/home/kyle/bin/llm-gateway-health}" \
  MI_GATEWAY_HEALTH_USER="$GATEWAY_HEALTH_USER" \
  "$ROOT/scripts/install-mi-subscription-gateway-root.sh"
# The gateway client writes the tracked coding-main registry baseline. The
# production stage then adds only aliases and remains fail-closed without it.
run_stage gateway-client as_user env \
  MI_GATEWAY_CLIENT_NO_SYSTEMD=1 \
  MI_GATEWAY_CONFIG_DIR="$TARGET_HOME/.pi/agent" \
  MI_GATEWAY_NODE_BIN="$STACK_NODE_BIN" \
  "$ROOT/scripts/install-mi-gateway-client.sh"
run_stage production-registry as_user env MI_GATEWAY_CONFIG_DIR="$TARGET_HOME/.pi/agent" "$STACK_NODE_BIN" "$ROOT/scripts/install-mi-gateway-models.mjs"
# A staged install writes reviewed units only. It never starts web, Photon,
# daemon, or tick work; activation is a separate operator step.
run_stage user-units as_user env MI_APP_DIR="$ROOT" MI_USER_UNITS_NO_SYSTEMD=1 "$ROOT/scripts/install-mi-user-units.sh"
run_stage photon-loopback env MI_APP_DIR="$ROOT" MI_SYSTEM_ROOT="$SYSTEM_ROOT" MI_PHOTON_NO_SYSTEMD=1 "$ROOT/scripts/install-mi-imessage-stack-root.sh"
run_stage generated-entrypoints env MI_STACK_HOME="$TARGET_HOME" "$ROOT/scripts/install-mi-home-entrypoints.sh"
run_stage readiness env \
  MI_STACK_READINESS_FILES_ONLY=1 \
  MI_SERVICE_USER="$SERVICE_USER" \
  MI_GATEWAY_HEALTH_USER="$GATEWAY_HEALTH_USER" \
  MI_GATEWAY_HEALTH_COMMAND="${MI_GATEWAY_HEALTH_COMMAND:-/home/kyle/bin/llm-gateway-health}" \
  "$ROOT/scripts/check-mi-stack-readiness.sh"
committed=1
cleanup
trap - EXIT ERR INT TERM HUP
echo 'Mi stack install complete'
