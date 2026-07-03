#!/usr/bin/env bash
set -euo pipefail

if [[ ${EUID} -ne 0 ]]; then
  echo "Run with sudo: sudo ./scripts/install-mi-imessage-stack-root.sh" >&2
  exit 1
fi

APP_DIR="${MI_APP_DIR:-/home/kyle/assistant}"

cd "$APP_DIR"

./scripts/install-mi-photon-service-root.sh

systemctl daemon-reload
systemctl restart mi-photon-bridge.service

echo "Installed and restarted Mi iMessage bridge."
echo "Status: sudo systemctl status mi-photon-bridge"
echo "Logs:   sudo journalctl -u mi-photon-bridge -f"
