#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT_PATH="$UNIT_DIR/mi-web-chat.service"
DROPIN_DIR="$UNIT_DIR/mi-web-chat.service.d"
DROPIN_PATH="$DROPIN_DIR/10-nvm-pi-path.conf"
NVM_PI_PATH_DROPIN="$ROOT/systemd/mi-web-chat.service.d/10-nvm-pi-path.conf"
DNS_NAME="${1:-}"

if [ -z "$DNS_NAME" ]; then
  DNS_NAME="$(tailscale status --json | node -e '
let input = "";
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => {
  const name = String(JSON.parse(input).Self?.DNSName || "").replace(/\.$/, "");
  if (!name) process.exit(1);
  process.stdout.write(name);
});
')"
fi
DNS_NAME="${DNS_NAME%.}"
if [[ ! "$DNS_NAME" =~ ^[A-Za-z0-9][A-Za-z0-9.-]*[A-Za-z0-9]$ ]]; then
  echo "Invalid Tailscale DNS name: $DNS_NAME" >&2
  exit 1
fi

TLS_DIR="$ROOT/state/tls"
CERT_PATH="$TLS_DIR/$DNS_NAME.crt"
KEY_PATH="$TLS_DIR/$DNS_NAME.key"
install -d -m 700 "$UNIT_DIR" "$TLS_DIR" "$DROPIN_DIR"
install -m 644 "$NVM_PI_PATH_DROPIN" "$DROPIN_PATH"

cat > "$UNIT_PATH" <<EOF
[Unit]
Description=Mi web chat (private Tailscale UI)
Wants=llm-gateway.service
After=network-online.target llm-gateway.service

[Service]
Type=simple
WorkingDirectory=$ROOT
ExecStartPre=/usr/bin/tailscale cert --cert-file $CERT_PATH --key-file $KEY_PATH $DNS_NAME
ExecStart=/usr/bin/env node $ROOT/scripts/mi-web-chat.mjs
Restart=on-failure
RestartSec=5
PrivateTmp=true
ProtectSystem=full

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable mi-web-chat.service

echo "Installed $UNIT_PATH for $DNS_NAME"
