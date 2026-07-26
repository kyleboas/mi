#!/usr/bin/env bash
# Internal non-secret readiness wait. Gateway health helper performs authentication.
set -euo pipefail
TIMEOUT="${MI_STACK_READINESS_TIMEOUT:-30}"
INTERVAL="${MI_STACK_READINESS_INTERVAL:-1}"
USER_NAME="${MI_SERVICE_USER:-kyle}"
HEALTH_USER="${MI_GATEWAY_HEALTH_USER:-$USER_NAME}"
USER_ID="$(id -u "$USER_NAME")"
REQUIRE_ACTIVE="${MI_STACK_READINESS_REQUIRE_ACTIVE:-0}"
deadline=$((SECONDS + TIMEOUT))
ready() {
  runuser -u "$HEALTH_USER" -- "${MI_GATEWAY_HEALTH_COMMAND:-/home/kyle/bin/llm-gateway-health}" >/dev/null 2>&1 || return 1
  [[ "$REQUIRE_ACTIVE" == 1 ]] || return 0
  systemctl is-active --quiet llm-gateway.service mi-photon-bridge.service || return 1
  runuser -u "$USER_NAME" -- env XDG_RUNTIME_DIR="/run/user/$USER_ID" systemctl --user is-active --quiet mi-web-chat.service mi-daemon.service || return 1
  ! runuser -u "$USER_NAME" -- env XDG_RUNTIME_DIR="/run/user/$USER_ID" systemctl --user is-active --quiet mi-tick.timer || return 1
}
until ready; do
  if (( SECONDS >= deadline )); then
    echo 'Mi stack readiness timed out (gateway/system/user service health)' >&2
    exit 1
  fi
  sleep "$INTERVAL"
done
echo 'Mi stack readiness passed (authenticated gateway and services active)'
