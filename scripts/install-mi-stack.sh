#!/usr/bin/env bash
# MI-GENERATED-SOURCE: install-mi-stack-v1
# Canonical user-facing installer. The prepared copy is ~/install-mi-stack.sh.
set -euo pipefail

ROOT="${MI_APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
ROOT_INSTALLER="$ROOT/scripts/install-mi-stack-root.sh"
mode=install
case "${1:-}" in
  '') ;;
  --check) mode=check; shift ;;
  --dry-run) mode=dry-run; shift ;;
  *) echo 'Usage: install-mi-stack.sh [--check|--dry-run]' >&2; exit 2 ;;
esac
[[ $# -eq 0 ]] || { echo 'Usage: install-mi-stack.sh [--check|--dry-run]' >&2; exit 2; }
[[ -x "$ROOT_INSTALLER" ]] || { echo 'Mi stack preflight failed: tracked root orchestrator missing' >&2; exit 1; }

if [[ "$mode" == dry-run ]]; then
  exec "$ROOT_INSTALLER" --dry-run
fi

safe_path() { [[ "$1" =~ ^/[A-Za-z0-9._/-]+$ ]]; }
safe_user() { [[ "$1" =~ ^[a-z_][a-z0-9_-]*$ ]]; }
add_path_input() {
  local name="$1" value="${!1:-}"
  [[ -z "$value" ]] && return
  safe_path "$value" || { echo "Mi stack preflight failed: unsafe $name" >&2; exit 1; }
  root_environment+=("$name=$value")
}
add_user_input() {
  local name="$1" value="${!1:-}"
  [[ -z "$value" ]] && return
  safe_user "$value" || { echo "Mi stack preflight failed: unsafe $name" >&2; exit 1; }
  root_environment+=("$name=$value")
}

# Pass only reviewed inputs across the privilege boundary. env -i prevents a
# caller's HOME, XDG roots, PATH, or unrelated variables reaching root.
root_environment=("MI_APP_DIR=$ROOT" 'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin')
for name in MI_STACK_HOME MI_SYSTEM_ROOT MI_NODE_BIN MI_GATEWAY_CONFIG_DIR MI_GATEWAY_SERVICE_HOME MI_GATEWAY_PI_BINARY MI_GATEWAY_PI_COMMAND_DIR MI_GATEWAY_PI_AGENT_DIR MI_GATEWAY_WORK_DIR MI_GATEWAY_HEALTH_COMMAND MI_STACK_STAGE_COMMAND_DIR; do
  add_path_input "$name"
done
for name in MI_SERVICE_USER MI_GATEWAY_SERVICE_USER MI_GATEWAY_HEALTH_USER; do
  add_user_input "$name"
done
[[ -z ${MI_STACK_NO_RUNUSER:-} || ${MI_STACK_NO_RUNUSER} == 1 ]] || { echo 'Mi stack preflight failed: unsafe MI_STACK_NO_RUNUSER' >&2; exit 1; }
[[ -z ${MI_STACK_FAIL_SETUP:-} || ${MI_STACK_FAIL_SETUP} == after-temp || ${MI_STACK_FAIL_SETUP} == after-manifest ]] || { echo 'Mi stack preflight failed: unsafe MI_STACK_FAIL_SETUP' >&2; exit 1; }
[[ -z ${MI_STACK_NO_RUNUSER:-} ]] || root_environment+=("MI_STACK_NO_RUNUSER=$MI_STACK_NO_RUNUSER")
[[ -z ${MI_STACK_FAIL_SETUP:-} ]] || root_environment+=("MI_STACK_FAIL_SETUP=$MI_STACK_FAIL_SETUP")

root_arguments=()
[[ "$mode" == check ]] && root_arguments+=(--check)
if [[ ${EUID:-$(id -u)} -eq 0 ]]; then
  exec env -i "${root_environment[@]}" "$ROOT_INSTALLER" "${root_arguments[@]}"
fi
# This is the sole privilege boundary for install and check operations.
exec sudo -- env -i "${root_environment[@]}" "$ROOT_INSTALLER" "${root_arguments[@]}"
