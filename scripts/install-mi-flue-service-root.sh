#!/usr/bin/env bash
set -euo pipefail

if [[ ${EUID} -ne 0 ]]; then
  echo "Run with sudo: sudo ./scripts/install-mi-flue-service-root.sh" >&2
  exit 1
fi

APP_DIR="${MI_APP_DIR:-/home/kyle/assistant}"
USER_NAME="${MI_SERVICE_USER:-kyle}"
UNIT_PATH="/etc/systemd/system/mi-flue.service"
TSX_BIN="${MI_TSX_BIN:-$APP_DIR/node_modules/.bin/tsx}"
FLUE_HOST_VALUE="${FLUE_HOST:-127.0.0.1}"
FLUE_PORT_VALUE="${FLUE_PORT:-3583}"

if [[ ! -x "$TSX_BIN" ]]; then
  echo "Missing tsx binary: $TSX_BIN" >&2
  echo "Run npm install in $APP_DIR first." >&2
  exit 1
fi

install -d -m 0755 /etc/systemd/system
cat > "$UNIT_PATH" <<EOF_UNIT
[Unit]
Description=Mi Flue no-tool assistant orchestrator
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$USER_NAME
WorkingDirectory=$APP_DIR
Environment=FLUE_HOST=$FLUE_HOST_VALUE
Environment=FLUE_PORT=$FLUE_PORT_VALUE
Environment=NODE_ENV=production
ExecStart=$TSX_BIN $APP_DIR/scripts/flue-persistent.ts start
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=$APP_DIR/state /tmp

[Install]
WantedBy=multi-user.target
EOF_UNIT

chmod 0644 "$UNIT_PATH"
systemctl daemon-reload
systemctl enable mi-flue.service

echo "Installed $UNIT_PATH"
echo "Start with: sudo systemctl start mi-flue"
echo "Logs: sudo journalctl -u mi-flue -f"
