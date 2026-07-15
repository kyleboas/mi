#!/bin/sh
# Restore production gateway and remove only eval-only Pi registry entries.
set -eu
[ "$(id -u)" -eq 0 ] || { echo "Run as root: sudo $0" >&2; exit 1; }
repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
"$repo_dir/scripts/uninstall-mi-model-eval-gateway-root.sh"
runuser -u kyle -- /home/kyle/.nvm/versions/node/v24.15.0/bin/node "$repo_dir/scripts/uninstall-mi-model-eval-models.mjs"
