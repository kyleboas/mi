#!/usr/bin/env bash
# Install Mi's local gateway client for the current user. No sudo required.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE="$ROOT/scripts/mi-gateway-client.py"
TARGET_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/mi"
TARGET="$TARGET_DIR/mi-gateway-client.py"
[ -f "$SOURCE" ] || { echo "Missing tracked helper: $SOURCE" >&2; exit 1; }
install -d -m 700 "$TARGET_DIR"
install -m 700 "$SOURCE" "$TARGET"
if [[ ${MI_GATEWAY_CLIENT_NO_SYSTEMD:-0} != 1 ]]; then
  systemctl --user daemon-reload
  if [ "${1:-}" = "--restart" ]; then
    systemctl --user restart mi-web-chat.service
  fi
fi
echo "Installed Mi gateway client at $TARGET"
