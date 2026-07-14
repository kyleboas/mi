#!/usr/bin/env bash
set -euo pipefail

if [[ ${EUID} -ne 0 ]]; then
  echo "Run with sudo: sudo ./scripts/install-mi-imessage-stack-root.sh" >&2
  exit 1
fi

APP_DIR="${MI_APP_DIR:-/home/kyle/assistant}"

cd "$APP_DIR"

./scripts/install-mi-photon-service-root.sh

# A legacy one-setting drop-in can silently override the canonical loopback URL.
# Remove only that obsolete shape; preserve every operator drop-in containing
# any other setting.
PHOTON_OVERRIDE=/etc/systemd/system/mi-photon-bridge.service.d/override.conf
if [[ -f "$PHOTON_OVERRIDE" ]]; then
  mapfile -t override_lines < <(grep -Ev '^[[:space:]]*(#|$)' "$PHOTON_OVERRIDE")
  if [[ ${#override_lines[@]} -eq 2 \
    && "${override_lines[0]}" == '[Service]' \
    && "${override_lines[1]}" == Environment=MI_WEB_URL=* \
    && "${override_lines[1]}" != 'Environment=MI_WEB_URL=http://127.0.0.1:8787' ]]; then
    rm -f "$PHOTON_OVERRIDE"
    rmdir --ignore-fail-on-non-empty "$(dirname "$PHOTON_OVERRIDE")"
    echo "Removed obsolete Photon MI_WEB_URL override."
  fi
fi

systemctl daemon-reload
systemctl restart mi-photon-bridge.service

echo "Installed and restarted Mi iMessage bridge."
echo "Status: sudo systemctl status mi-photon-bridge"
echo "Logs:   sudo journalctl -u mi-photon-bridge -f"
