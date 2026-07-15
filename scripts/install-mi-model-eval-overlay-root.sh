#!/bin/sh
# Composite entrypoint used only by /home/kyle/install-mi-model-eval-gateway.sh.
set -eu
[ "$(id -u)" -eq 0 ] || { echo "Run as root: sudo $0" >&2; exit 1; }
repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
runuser -u kyle -- /home/kyle/.nvm/versions/node/v24.15.0/bin/node "$repo_dir/scripts/install-mi-model-eval-models.mjs"
if ! "$repo_dir/scripts/install-mi-model-eval-gateway-root.sh"; then
  runuser -u kyle -- /home/kyle/.nvm/versions/node/v24.15.0/bin/node "$repo_dir/scripts/uninstall-mi-model-eval-models.mjs" >/dev/null 2>&1 || true
  exit 1
fi
