#!/usr/bin/env bash
set -euo pipefail

USER_NAME="${MI_USER:-kyle}"
UNIT_DIR="/home/${USER_NAME}/.config/systemd/user"
SERVICE_NAME="${MI_TICK_SERVICE_NAME:-mi-tick}"
MI_BIN="${MI_BIN:-/home/${USER_NAME}/.nvm/versions/node/v24.15.0/bin/mi}"

install -d -m 700 -o "${USER_NAME}" -g "${USER_NAME}" "${UNIT_DIR}"

cat >"${UNIT_DIR}/${SERVICE_NAME}.service" <<UNIT
[Unit]
Description=Mi scheduled tick (reminders, configured monitor health, daily brief)

[Service]
Type=oneshot
ExecStart=${MI_BIN} tick
WorkingDirectory=/home/${USER_NAME}/assistant
Environment=HOME=/home/${USER_NAME}
Environment=MI_PROACTIVE_IMESSAGE_NOTIFY=${MI_PROACTIVE_IMESSAGE_NOTIFY:-true}
Environment=MI_PHOTON_NOTIFY_PORT=${MI_PHOTON_NOTIFY_PORT:-8788}
Nice=5
IOSchedulingClass=best-effort
IOSchedulingPriority=6
UNIT

cat >"${UNIT_DIR}/${SERVICE_NAME}.timer" <<UNIT
[Unit]
Description=Run Mi scheduled tick

[Timer]
OnCalendar=${MI_TICK_CALENDAR:-*:0/1}
AccuracySec=30s
Persistent=true

[Install]
WantedBy=timers.target
UNIT

chown "${USER_NAME}:${USER_NAME}" "${UNIT_DIR}/${SERVICE_NAME}.service" "${UNIT_DIR}/${SERVICE_NAME}.timer"
sudo -u "${USER_NAME}" XDG_RUNTIME_DIR="/run/user/$(id -u "${USER_NAME}")" systemctl --user daemon-reload
sudo -u "${USER_NAME}" XDG_RUNTIME_DIR="/run/user/$(id -u "${USER_NAME}")" systemctl --user enable --now "${SERVICE_NAME}.timer"
loginctl enable-linger "${USER_NAME}" >/dev/null 2>&1 || true

echo "Installed ${SERVICE_NAME}.timer for ${USER_NAME}."
echo "Retire older units if present:"
echo "  systemctl disable --now mi-cron-tick.timer mi-cron-tick.service || true"
echo "  systemctl mask mi-cron-tick.timer mi-cron-tick.service || true"
echo "  sudo -u ${USER_NAME} XDG_RUNTIME_DIR=/run/user/$(id -u "${USER_NAME}") systemctl --user disable --now mi-cron-tick.timer mi-morning-briefing.timer || true"
