#!/usr/bin/env bash
set -euo pipefail

ROOT="${MI_APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT_PATH="$UNIT_DIR/mi-web-chat.service"
DROPIN_DIR="$UNIT_DIR/mi-web-chat.service.d"
DROPIN_PATH="$DROPIN_DIR/10-mi-runtime.conf"
RUNTIME_DROPIN="$ROOT/systemd/mi-web-chat.service.d/10-mi-runtime.conf"
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
# Substitute only the home prefix in the tracked non-secret runtime drop-in.
sed "s|/home/kyle|$HOME|g" "$RUNTIME_DROPIN" > "$DROPIN_PATH.tmp"
chmod 644 "$DROPIN_PATH.tmp"
mv -f "$DROPIN_PATH.tmp" "$DROPIN_PATH"

# Remove only byte-for-byte known Mi-owned predecessors. Modified and unrelated
# operator drop-ins are preserved and reported.
old_nvm=$'# Mi V2 invokes /home/kyle/bin/pi-gateway, which execs `pi` via PATH.\n# Keep it on the supported NVM Pi binary rather than the distro-global Pi.\n[Service]\nEnvironment=PATH=/home/kyle/.nvm/versions/node/v24.15.0/bin:/usr/local/bin:/usr/bin:/bin'
old_helper="[Service]"$'\n'"Environment=MI_GATEWAY_CLIENT=${XDG_DATA_HOME:-$HOME/.local/share}/mi/mi-gateway-client.py"
old_pi="[Service]"$'\n'"Environment=PI_CMD=$HOME/bin/pi-gateway"
for candidate in 10-nvm-pi-path.conf 20-mi-gateway-client.conf 20-pi-gateway.conf 30-nvm-pi-path.conf; do
  path="$DROPIN_DIR/$candidate"
  [[ -f "$path" ]] || continue
  content="$(cat "$path")"
  if [[ "$content" == "$old_nvm" || "$content" == "$old_helper" || "$content" == "$old_pi" ]]; then
    rm -f "$path"
    echo "Removed known superseded Mi drop-in: $candidate"
  else
    echo "Preserved modified or unknown drop-in: $candidate" >&2
  fi
done

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

if [[ ${MI_WEB_NO_SYSTEMD:-0} != 1 ]]; then
  systemctl --user daemon-reload
  systemctl --user enable --now mi-web-chat.service
fi

echo "Installed $UNIT_PATH for $DNS_NAME"
