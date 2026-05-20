#!/usr/bin/env bash
set -euo pipefail

SERVICE_NAME="${MI_CRON_SERVICE_NAME:-mi-cron-tick}"
SERVICE="/etc/systemd/system/${SERVICE_NAME}.service"
TIMER="/etc/systemd/system/${SERVICE_NAME}.timer"
MI_USER="${MI_USER:-${USER}}"
MI_WORKDIR="${MI_WORKDIR:-$(pwd)}"
MI_BIN="${MI_BIN:-$(command -v mi)}"

if [[ -z "${MI_BIN}" ]]; then
  echo "mi binary not found; set MI_BIN=/path/to/mi" >&2
  exit 1
fi

sudo tee "$SERVICE" >/dev/null <<UNIT
[Unit]
Description=Mi cron tick
Wants=network-online.target
After=network-online.target

[Service]
Type=oneshot
User=${MI_USER}
WorkingDirectory=${MI_WORKDIR}
ExecStart=${MI_BIN} cron tick
UNIT

sudo tee "$TIMER" >/dev/null <<UNIT
[Unit]
Description=Run Mi cron tick every minute

[Timer]
OnBootSec=1min
OnUnitActiveSec=1min
AccuracySec=10s
Persistent=true
Unit=${SERVICE_NAME}.service

[Install]
WantedBy=timers.target
UNIT

sudo systemctl daemon-reload
sudo systemctl enable --now "${SERVICE_NAME}.timer"

if command -v crontab >/dev/null 2>&1; then
  (crontab -l 2>/dev/null | grep -v "${SERVICE_NAME}" || true) | crontab -
fi

sudo systemctl list-timers "${SERVICE_NAME}.timer" --no-pager
