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
SERVICE_HOME="${MI_SERVICE_HOME:-/home/$USER_NAME}"
MI_WORKFLOWS_DIR_VALUE="${MI_WORKFLOWS_DIR:-$SERVICE_HOME/workflows}"
MI_RUNTIME_DIR_VALUE="${MI_RUNTIME_DIR:-$APP_DIR/state/imessage/runtime}"
safe_path() { [[ "$1" =~ ^/[A-Za-z0-9._/-]+$ && "$1" != *//* && "$1" != */../* && "$1" != */./* ]]; }
[[ "$USER_NAME" =~ ^[a-z_][a-z0-9_-]*$ ]] || { echo 'Unsafe Photon service user' >&2; exit 1; }
for checked_path in "$APP_DIR" "$SECRET_ENV" "$UNIT_PATH" "$NODE_BIN" "$SERVICE_HOME" "$MI_WORKFLOWS_DIR_VALUE" "$MI_RUNTIME_DIR_VALUE"; do
  safe_path "$checked_path" || { echo "Unsafe Photon path: $checked_path" >&2; exit 1; }
done

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
Environment=MI_ROOT=$APP_DIR
Environment=MI_RUNTIME_DIR=$MI_RUNTIME_DIR_VALUE
Environment=MI_IMESSAGE_WORKSPACE_ROOT=$MI_WORKFLOWS_DIR_VALUE
Environment=MI_IMESSAGE_WORKSPACE_CWD=$MI_WORKFLOWS_DIR_VALUE
Environment=MI_DAEMON_PATH=$APP_DIR/pi/extensions/mi-daemon.mjs
Environment=NODE_ENV=production
ExecStart=$NODE_BIN $APP_DIR/scripts/mi-photon-bridge.mjs
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=$APP_DIR/state $MI_WORKFLOWS_DIR_VALUE $MI_RUNTIME_DIR_VALUE /tmp

[Install]
WantedBy=multi-user.target
EOF_UNIT

chmod 0644 "$UNIT_PATH"
# Files only. An operator must reload and start the Photon bridge separately.
echo "Installed $UNIT_PATH without activating services"
echo "Start later with: sudo systemctl start mi-photon-bridge"
echo "Logs: sudo journalctl -u mi-photon-bridge -f"
