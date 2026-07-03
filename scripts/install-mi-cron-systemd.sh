#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
echo "install-mi-cron-systemd.sh is deprecated; installing the unified mi tick timer instead." >&2
exec "${SCRIPT_DIR}/install-mi-tick-systemd.sh" "$@"
