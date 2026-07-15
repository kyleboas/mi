#!/usr/bin/env bash
# Install Mi's local gateway client for the current user. No sudo required.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE="$ROOT/scripts/mi-gateway-client.py"
TARGET_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/mi"
TARGET="$TARGET_DIR/mi-gateway-client.py"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/mi-web-chat.service.d"
DROPIN="$UNIT_DIR/20-mi-gateway-client.conf"

[ -f "$SOURCE" ] || { echo "Missing tracked helper: $SOURCE" >&2; exit 1; }
install -d -m 700 "$TARGET_DIR" "$UNIT_DIR"
install -m 700 "$SOURCE" "$TARGET"
cat > "$DROPIN" <<EOF
[Service]
Environment=MI_GATEWAY_CLIENT=$TARGET
EOF
systemctl --user daemon-reload
if [ "${1:-}" = "--restart" ]; then
  systemctl --user restart mi-web-chat.service
fi
echo "Installed Mi gateway client at $TARGET"
