#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run as root: sudo $0" >&2
  exit 1
fi

MI_USER="${MI_USER:-kyle}"
SUDOERS_PATH="/etc/sudoers.d/mi-imessage-repair"
SYSTEMCTL="$(command -v systemctl)"

cat >"${SUDOERS_PATH}" <<EOF
# Allow Mi tick's iMessage repair monitor to restart only the Photon bridge.
${MI_USER} ALL=(root) NOPASSWD: ${SYSTEMCTL} restart mi-photon-bridge.service
EOF
chmod 0440 "${SUDOERS_PATH}"
visudo -cf "${SUDOERS_PATH}" >/dev/null

echo "Installed ${SUDOERS_PATH}."
