#!/usr/bin/env bash
# Internal user-level daemon/timer installer.
set -euo pipefail
ROOT="${MI_APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
HOME_DIR="${HOME:?}"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME_DIR/.config}/systemd/user"
EXT_DIR="$HOME_DIR/.pi/agent/extensions"
NODE_BIN="${MI_NODE_BIN:-/home/kyle/.nvm/versions/node/v24.15.0/bin/node}"
MI_BIN="${MI_BIN:-/home/kyle/.nvm/versions/node/v24.15.0/bin/mi}"
install -d -m 700 "$UNIT_DIR" "$EXT_DIR"
install -m 700 "$ROOT/pi/extensions/mi-daemon.mjs" "$EXT_DIR/mi-daemon.mjs"
cat > "$UNIT_DIR/mi-daemon.service" <<EOF
[Unit]
Description=Mi background task daemon
After=network-online.target

[Service]
Type=simple
WorkingDirectory=$ROOT
Environment=HOME=$HOME_DIR
ExecStart=$NODE_BIN $EXT_DIR/mi-daemon.mjs
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF
cat > "$UNIT_DIR/mi-tick.service" <<EOF
[Unit]
Description=Mi scheduled tick

[Service]
Type=oneshot
WorkingDirectory=$ROOT
Environment=HOME=$HOME_DIR
Environment=MI_PROACTIVE_IMESSAGE_NOTIFY=true
Environment=MI_PHOTON_NOTIFY_PORT=8788
ExecStart=$MI_BIN tick
Nice=5
EOF
cat > "$UNIT_DIR/mi-tick.timer" <<'EOF'
[Unit]
Description=Run Mi scheduled tick

[Timer]
OnCalendar=*:0/1
AccuracySec=30s
Persistent=true

[Install]
WantedBy=timers.target
EOF
if [[ ${MI_USER_UNITS_NO_SYSTEMD:-0} != 1 ]]; then
  systemctl --user daemon-reload
  systemctl --user enable --now mi-daemon.service mi-tick.timer
fi
echo 'Installed Mi daemon and tick user units'
