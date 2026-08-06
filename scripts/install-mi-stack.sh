#!/usr/bin/env bash
# MI-GENERATED-SOURCE: install-mi-stack-v1
# Canonical user-facing installer. The prepared copy is ~/install-mi-stack.sh.
set -euo pipefail

fail() { echo "Mi stack preflight failed: $*" >&2; exit 1; }
safe_path() {
  [[ "$1" =~ ^/[A-Za-z0-9._/-]+$ && "$1" != *//* && "$1" != */./* && "$1" != */../* && "$1" != */. && "$1" != */.. && "$1" != */ ]]
}
# Root must never sudo a tree writable by someone other than the invoking
# account. The public home wrapper names this reviewed file directly; reject
# links and every mutable component below the reviewed repository root.
assert_safe_reviewed_component() {
  local value="$1" label="$2" owner mode
  [[ ! -L "$value" && -e "$value" ]] || fail "$label is linked or missing: $value"
  owner="$(stat -c '%u' -- "$value")"
  mode="$(stat -c '%a' -- "$value")"
  [[ "$owner" == "${EUID:-$(id -u)}" || "$owner" == 0 ]] || fail "$label has an untrusted owner: $value"
  (( (8#$mode & 8#022) == 0 )) || fail "$label is writable by group or other: $value"
}
derive_reviewed_root() {
  local source="${BASH_SOURCE[0]}" source_dir root
  [[ -n "$source" ]] || fail 'reviewed wrapper source is missing'
  if [[ "$source" != /* ]]; then source="$(pwd -P)/$source"; fi
  safe_path "$source" || fail 'reviewed wrapper path is unsafe'
  assert_safe_reviewed_component "$source" 'reviewed wrapper'
  source_dir="$(dirname -- "$source")"
  root="$(cd "$source_dir/.." && pwd -P)"
  safe_path "$root" || fail 'reviewed application root is unsafe'
  [[ "$source_dir" == "$root/scripts" && "$(basename -- "$source")" == install-mi-stack.sh ]] || fail 'reviewed wrapper is not in the expected scripts directory'
  [[ "$(cd "$source_dir" && pwd -P)" == "$source_dir" ]] || fail 'reviewed wrapper directory is not canonical'
  assert_safe_reviewed_component "$root" 'reviewed application root'
  assert_safe_reviewed_component "$source_dir" 'reviewed scripts directory'
  printf '%s\n' "$root"
}

# MI_APP_DIR is intentionally not an input: accepting it would let a caller
# choose what root executes after sudo.
[[ -z ${MI_APP_DIR:-} ]] || fail 'MI_APP_DIR is not accepted; use the reviewed wrapper path'
ROOT="$(derive_reviewed_root)"
ROOT_INSTALLER="$ROOT/scripts/install-mi-stack-root.sh"
mode=install
case "${1:-}" in
  '') ;;
  --check) mode=check; shift ;;
  --dry-run) mode=dry-run; shift ;;
  *) echo 'Usage: install-mi-stack.sh [--check|--dry-run]' >&2; exit 2 ;;
esac
[[ $# -eq 0 ]] || { echo 'Usage: install-mi-stack.sh [--check|--dry-run]' >&2; exit 2; }
[[ -x "$ROOT_INSTALLER" && ! -L "$ROOT_INSTALLER" ]] || fail 'tracked root orchestrator missing or linked'
assert_safe_reviewed_component "$ROOT_INSTALLER" 'reviewed root orchestrator'

if [[ "$mode" == dry-run ]]; then
  exec "$ROOT_INSTALLER" --dry-run
fi

safe_user() { [[ "$1" =~ ^[a-z_][a-z0-9_-]*$ ]]; }
add_path_input() {
  local name="$1" value="${!1:-}"
  [[ -z "$value" ]] && return
  safe_path "$value" || fail "unsafe $name"
  root_environment+=("$name=$value")
}
add_user_input() {
  local name="$1" value="${!1:-}"
  [[ -z "$value" ]] && return
  safe_user "$value" || fail "unsafe $name"
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
[[ -z ${MI_STACK_NO_RUNUSER:-} || ${MI_STACK_NO_RUNUSER} == 1 ]] || fail 'unsafe MI_STACK_NO_RUNUSER'
[[ -z ${MI_STACK_FAIL_SETUP:-} || ${MI_STACK_FAIL_SETUP} == after-temp || ${MI_STACK_FAIL_SETUP} == after-manifest ]] || fail 'unsafe MI_STACK_FAIL_SETUP'
[[ -z ${MI_STACK_NO_RUNUSER:-} ]] || root_environment+=("MI_STACK_NO_RUNUSER=$MI_STACK_NO_RUNUSER")
[[ -z ${MI_STACK_FAIL_SETUP:-} ]] || root_environment+=("MI_STACK_FAIL_SETUP=$MI_STACK_FAIL_SETUP")

root_arguments=()
[[ "$mode" == check ]] && root_arguments+=(--check)
if [[ ${EUID:-$(id -u)} -eq 0 ]]; then
  exec env -i "${root_environment[@]}" "$ROOT_INSTALLER" "${root_arguments[@]}"
fi
# This is the sole privilege boundary for install and check operations.
exec sudo -- env -i "${root_environment[@]}" "$ROOT_INSTALLER" "${root_arguments[@]}"
