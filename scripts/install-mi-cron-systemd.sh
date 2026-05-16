#!/usr/bin/env bash
set -euo pipefail

SERVICE=/etc/systemd/system/mi-cron-tick.service
TIMER=/etc/systemd/system/mi-cron-tick.timer

sudo tee "$SERVICE" >/dev/null <<'UNIT'
[Unit]
Description=Mi cron tick
Wants=network-online.target
After=network-online.target

[Service]
Type=oneshot
User=kyle
WorkingDirectory=/home/kyle/assistant
ExecStart=/home/kyle/.nvm/versions/node/v24.15.0/bin/mi cron tick
UNIT

sudo tee "$TIMER" >/dev/null <<'UNIT'
[Unit]
Description=Run Mi cron tick every minute

[Timer]
OnBootSec=1min
OnUnitActiveSec=1min
AccuracySec=10s
Persistent=true
Unit=mi-cron-tick.service

[Install]
WantedBy=timers.target
UNIT

sudo systemctl daemon-reload
sudo systemctl enable --now mi-cron-tick.timer

# Remove temporary user crontab fallback after systemd is active.
if command -v crontab >/dev/null 2>&1; then
  (crontab -l 2>/dev/null | grep -v 'mi-cron-tick' || true) | crontab -
fi

sudo systemctl list-timers mi-cron-tick.timer --no-pager
