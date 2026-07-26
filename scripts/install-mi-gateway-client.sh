#!/usr/bin/env bash
# Install Mi's local gateway client for the current user. No sudo required.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE="$ROOT/scripts/mi-gateway-client.py"
BASELINE_SOURCE="$ROOT/scripts/install-mi-gateway-baseline-models.mjs"
TARGET_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/mi"
TARGET="$TARGET_DIR/mi-gateway-client.py"
NODE_BIN="${MI_GATEWAY_NODE_BIN:-node}"
[ -f "$SOURCE" ] || { echo "Missing tracked helper: $SOURCE" >&2; exit 1; }
[ -f "$BASELINE_SOURCE" ] || { echo "Missing tracked registry baseline: $BASELINE_SOURCE" >&2; exit 1; }
command -v "$NODE_BIN" >/dev/null || { echo "Missing Node command: $NODE_BIN" >&2; exit 1; }
# The production alias stage depends on this durable, non-secret coding-main
# entry. Establish it before copying the client so a failure changes no helper.
MI_GATEWAY_CONFIG_DIR="${MI_GATEWAY_CONFIG_DIR:-$HOME/.pi/agent}" "$NODE_BIN" "$BASELINE_SOURCE"
install -d -m 700 "$TARGET_DIR"
install -m 700 "$SOURCE" "$TARGET"
# Files only. Reloading or restarting the web service needs separate approval.
echo "Installed Mi gateway client at $TARGET without activating services"
