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

if [[ "$mode" == check ]]; then
  exec "$ROOT_INSTALLER" --check
fi
if [[ "$mode" == dry-run ]]; then
  exec "$ROOT_INSTALLER" --dry-run
fi
if [[ ${MI_STACK_NO_SUDO:-0} == 1 ]]; then
  exec "$ROOT_INSTALLER"
fi
# This is the sole privilege boundary for the complete stack operation.
exec sudo -- "$ROOT_INSTALLER"
