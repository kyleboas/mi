#!/usr/bin/env bash
set -euo pipefail

SYSTEM_ROOT="${MI_SYSTEM_ROOT:-}"
if [[ -z "$SYSTEM_ROOT" && ${EUID} -ne 0 ]]; then
  echo "Run with sudo: sudo ./scripts/install-mi-imessage-stack-root.sh" >&2
  exit 1
fi

APP_DIR="${MI_APP_DIR:-/home/kyle/assistant}"

cd "$APP_DIR"

./scripts/install-mi-photon-service-root.sh

# Files only. Do not reload or restart Photon as part of installation.
echo "Installed Mi iMessage bridge files without activating services."
echo "Status: sudo systemctl status mi-photon-bridge"
echo "Logs:   sudo journalctl -u mi-photon-bridge -f"
