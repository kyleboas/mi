#!/usr/bin/env bash
# Internal transaction coordinator. Invoke through ~/install-mi-stack.sh.
set -Eeuo pipefail

ROOT="${MI_APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
TARGET_HOME="${MI_STACK_HOME:-/home/kyle}"
SYSTEM_ROOT="${MI_SYSTEM_ROOT:-}"
MODE=install
case "${1:-}" in
  '') ;;
  --check) MODE=check ;;
  --dry-run) MODE=dry-run ;;
  *) echo 'Usage: install-mi-stack-root.sh [--check|--dry-run]' >&2; exit 2 ;;
esac

stages=(production-gateway production-registry gateway-client tailscale-web user-units photon-loopback generated-entrypoints readiness)
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
  runtime="$TARGET_HOME/.config/systemd/user/mi-web-chat.service.d/10-mi-runtime.conf"
  check_file "$runtime" 'Mi web runtime drop-in' || failed=1
  if [[ -f "$runtime" ]]; then
    check_contains "$runtime" 'Environment=MI_GATEWAY_CLIENT=' 'gateway helper path' || failed=1
    check_contains "$runtime" 'Environment=PI_CMD=' 'legacy PI_CMD rollback' || failed=1
    check_contains "$runtime" 'Environment=PATH=' 'NVM PATH' || failed=1
  fi
  photon="$SYSTEM_ROOT/etc/systemd/system/mi-photon-bridge.service"
  check_contains "$photon" 'Environment=MI_WEB_URL=http://127.0.0.1:8787' 'Photon loopback URL' || failed=1
  node_bin="${MI_NODE_BIN:-/home/kyle/.nvm/versions/node/v24.15.0/bin/node}"
  registry_dir="${MI_GATEWAY_CONFIG_DIR:-$TARGET_HOME/.pi/agent}"
  if [[ -x "$node_bin" && -f "$registry_dir/settings.json" && -f "$registry_dir/models.json" ]]; then
    MI_GATEWAY_CONFIG_DIR="$registry_dir" "$node_bin" "$ROOT/scripts/install-mi-gateway-models.mjs" --check >/dev/null || failed=1
  else
    echo 'missing: production Pi registry'; failed=1
  fi
  printf '%s\n' \
    'Expected gateway aliases: coding-main (high), mi-concierge (medium); eval aliases absent' \
    'Expected Photon URL: http://127.0.0.1:8787' \
    'Expected TLS paths: assistant/state/tls/<tailscale-dns>.{crt,key}' \
    'Expected helper: ~/.local/share/mi/mi-gateway-client.py' \
    'Expected PATH: supported NVM bin, then system bins'
  if command -v systemctl >/dev/null && [[ -z "$SYSTEM_ROOT" ]]; then
    for unit in llm-gateway.service mi-photon-bridge.service; do
      systemctl is-active --quiet "$unit" || { echo "inactive: $unit"; failed=1; }
    done
    service_user="${MI_SERVICE_USER:-kyle}"
    runtime_dir="/run/user/$(id -u "$service_user")"
    for unit in mi-web-chat.service mi-daemon.service mi-tick.timer; do
      runuser -u "$service_user" -- env XDG_RUNTIME_DIR="$runtime_dir" systemctl --user is-active --quiet "$unit" || { echo "inactive: $unit"; failed=1; }
    done
  fi
  (( failed == 0 )) && echo 'Mi stack check passed'
  exit "$failed"
fi

if [[ -z "$SYSTEM_ROOT" && ${EUID:-$(id -u)} -ne 0 ]]; then
  echo 'Mi stack preflight failed: root orchestrator requires the canonical sudo boundary' >&2
  exit 1
fi

backup="$(mktemp -d "${TMPDIR:-/tmp}/mi-stack-rollback.XXXXXX")"
manifest="$backup/manifest"
: > "$manifest"
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
$TARGET_HOME/.config/systemd/user/mi-web-chat.service
$TARGET_HOME/.config/systemd/user/mi-web-chat.service.d
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
$SYSTEM_ROOT/etc/systemd/system/llm-gateway.service.d/20-codex-subscription.conf
$SYSTEM_ROOT/etc/systemd/system/mi-photon-bridge.service
$SYSTEM_ROOT/etc/systemd/system/mi-photon-bridge.service.d/override.conf
PATHS
committed=0
rollback() {
  local status=$?
  (( committed == 1 )) && return
  echo "Mi stack failed at stage ${current_stage:-preflight}; restoring generated configuration" >&2
  while IFS=$'\t' read -r state key path; do
    rm -rf -- "$path"
    [[ "$state" == present ]] && { mkdir -p "$(dirname "$path")"; cp -a -- "$backup/$key" "$path"; }
  done < "$manifest"
  if [[ -z "$SYSTEM_ROOT" ]]; then
    systemctl daemon-reload >/dev/null 2>&1 || true
    systemctl restart llm-gateway.service mi-photon-bridge.service >/dev/null 2>&1 || true
    local service_user="${MI_SERVICE_USER:-kyle}" runtime_dir
    runtime_dir="/run/user/$(id -u "$service_user")"
    runuser -u "$service_user" -- env XDG_RUNTIME_DIR="$runtime_dir" systemctl --user daemon-reload >/dev/null 2>&1 || true
    runuser -u "$service_user" -- env XDG_RUNTIME_DIR="$runtime_dir" systemctl --user try-restart mi-web-chat.service mi-daemon.service mi-tick.timer >/dev/null 2>&1 || true
  fi
  rm -rf "$backup"
  exit "$status"
}
trap rollback ERR INT TERM

run_stage() {
  current_stage="$1"; shift
  echo "Mi stack stage: $current_stage"
  if [[ -n ${MI_STACK_STAGE_COMMAND_DIR:-} && -x "$MI_STACK_STAGE_COMMAND_DIR/$current_stage" ]]; then
    "$MI_STACK_STAGE_COMMAND_DIR/$current_stage"
  else
    "$@"
  fi
}
as_user() {
  if [[ -n "$SYSTEM_ROOT" || ${MI_STACK_NO_RUNUSER:-0} == 1 ]]; then "$@"; else runuser -u "${MI_SERVICE_USER:-kyle}" -- "$@"; fi
}

run_stage production-gateway env MI_GATEWAY_ROOT="$SYSTEM_ROOT" "$ROOT/scripts/install-mi-subscription-gateway-root.sh"
run_stage production-registry as_user env MI_GATEWAY_CONFIG_DIR="$TARGET_HOME/.pi/agent" "${MI_NODE_BIN:-/home/kyle/.nvm/versions/node/v24.15.0/bin/node}" "$ROOT/scripts/install-mi-gateway-models.mjs"
run_stage gateway-client as_user env HOME="$TARGET_HOME" XDG_DATA_HOME="$TARGET_HOME/.local/share" XDG_CONFIG_HOME="$TARGET_HOME/.config" MI_GATEWAY_CLIENT_NO_SYSTEMD=1 "$ROOT/scripts/install-mi-gateway-client.sh"
run_stage tailscale-web as_user env HOME="$TARGET_HOME" XDG_CONFIG_HOME="$TARGET_HOME/.config" MI_APP_DIR="$ROOT" "$ROOT/scripts/install-mi-web-chat-systemd.sh"
run_stage user-units as_user env HOME="$TARGET_HOME" XDG_CONFIG_HOME="$TARGET_HOME/.config" MI_APP_DIR="$ROOT" "$ROOT/scripts/install-mi-user-units.sh"
run_stage photon-loopback env MI_APP_DIR="$ROOT" MI_SYSTEM_ROOT="$SYSTEM_ROOT" "$ROOT/scripts/install-mi-imessage-stack-root.sh"
run_stage generated-entrypoints env MI_STACK_HOME="$TARGET_HOME" "$ROOT/scripts/install-mi-home-entrypoints.sh"
run_stage readiness "$ROOT/scripts/check-mi-stack-readiness.sh"
committed=1
trap - ERR INT TERM
rm -rf "$backup"
echo 'Mi stack install complete'
