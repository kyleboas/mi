#!/usr/bin/env bash
set -euo pipefail

SYSTEM_ROOT="${MI_SYSTEM_ROOT:-}"
if [[ -z "$SYSTEM_ROOT" && ${EUID} -ne 0 ]]; then
  echo "Run with sudo: sudo ./scripts/install-mi-photon-service-root.sh" >&2
  exit 1
fi

APP_DIR="${MI_APP_DIR:-/home/kyle/assistant}"
USER_NAME="${MI_SERVICE_USER:-kyle}"
SECRET_ENV="${MI_PHOTON_SECRET_ENV:-$SYSTEM_ROOT/etc/agent-secrets/projects/assistant/photon.secret}"
UNIT_PATH="$SYSTEM_ROOT/etc/systemd/system/mi-photon-bridge.service"
NODE_BIN="${MI_NODE_BIN:-/home/kyle/.nvm/versions/node/v24.15.0/bin/node}"
MI_WEB_URL_VALUE="${MI_WEB_URL:-http://127.0.0.1:8787}"
MI_PHOTON_THREAD_VALUE="${MI_PHOTON_THREAD:-main}"

if [[ ! -r "$SECRET_ENV" ]]; then
  echo "Missing secret env file: $SECRET_ENV" >&2
  echo "Create it with: sudo secret assistant photon" >&2
  exit 1
fi

if ! grep -q '^PHOTON_PROJECT_ID=' "$SECRET_ENV" || ! grep -q '^PHOTON_PROJECT_SECRET=' "$SECRET_ENV" || ! grep -q '^PHOTON_ALLOWED_USERS=' "$SECRET_ENV"; then
  echo "$SECRET_ENV must contain PHOTON_PROJECT_ID, PHOTON_PROJECT_SECRET, and PHOTON_ALLOWED_USERS assignments." >&2
  exit 1
fi

install -d -m 0755 "$SYSTEM_ROOT/etc/systemd/system"
cat > "$UNIT_PATH" <<EOF_UNIT
[Unit]
Description=Mi Photon iMessage bridge
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$USER_NAME
WorkingDirectory=$APP_DIR
EnvironmentFile=$SECRET_ENV
Environment=MI_WEB_URL=$MI_WEB_URL_VALUE
Environment=MI_PHOTON_THREAD=$MI_PHOTON_THREAD_VALUE
Environment=NODE_ENV=production
ExecStart=$NODE_BIN $APP_DIR/scripts/mi-photon-bridge.mjs
Restart=always
RestartSec=5
RuntimeMaxSec=4h
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=$APP_DIR/state /tmp

[Install]
WantedBy=multi-user.target
EOF_UNIT

chmod 0644 "$UNIT_PATH"
if [[ ${MI_PHOTON_NO_SYSTEMD:-0} != 1 ]]; then
  systemctl daemon-reload
  systemctl enable mi-photon-bridge.service
fi

echo "Installed $UNIT_PATH"
echo "Start with: sudo systemctl start mi-photon-bridge"
echo "Logs: sudo journalctl -u mi-photon-bridge -f"
