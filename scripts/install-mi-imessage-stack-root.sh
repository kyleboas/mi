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

# A legacy one-setting drop-in can silently override the canonical loopback URL.
# Remove only that obsolete shape; preserve every operator drop-in containing
# any other setting.
PHOTON_OVERRIDE="$SYSTEM_ROOT/etc/systemd/system/mi-photon-bridge.service.d/override.conf"
if [[ -f "$PHOTON_OVERRIDE" ]]; then
  # This is the sole obsolete address shape Mi owns. Never remove an arbitrary
  # administrator override merely because it contains MI_WEB_URL.
  known_obsolete=$'[Service]\nEnvironment=MI_WEB_URL=http://localhost:8787'
  if [[ "$(cat "$PHOTON_OVERRIDE")" == "$known_obsolete" ]]; then
    rm -f "$PHOTON_OVERRIDE"
    rmdir --ignore-fail-on-non-empty "$(dirname "$PHOTON_OVERRIDE")"
    echo "Removed known obsolete Photon loopback spelling."
  else
    echo "Preserved unknown or modified Photon override." >&2
  fi
fi

if [[ ${MI_PHOTON_NO_SYSTEMD:-0} != 1 ]]; then
  systemctl daemon-reload
  systemctl restart mi-photon-bridge.service
fi

echo "Installed and restarted Mi iMessage bridge."
echo "Status: sudo systemctl status mi-photon-bridge"
echo "Logs:   sudo journalctl -u mi-photon-bridge -f"
