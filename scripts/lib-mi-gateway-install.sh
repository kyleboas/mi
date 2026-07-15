#!/bin/sh
# Shared fail-closed deployment primitives. This file is sourced by root entrypoints.

mi_gateway_require_root() {
  if [ -z "${MI_GATEWAY_ROOT:-}" ] && [ "$(id -u)" -ne 0 ]; then
    echo "Run as root: sudo $0" >&2
    exit 1
  fi
}

mi_gateway_path() {
  printf '%s%s\n' "${MI_GATEWAY_ROOT:-}" "$1"
}

mi_gateway_require_file() {
  if [ ! -f "$1" ]; then
    echo "Missing tracked gateway artifact" >&2
    exit 1
  fi
}

mi_gateway_atomic_install() {
  source=$1
  destination=$2
  mode=$3
  directory=$(dirname -- "$destination")
  temporary=$(mktemp "$directory/.mi-gateway.XXXXXX") || exit 1
  if ! install -m "$mode" "$source" "$temporary" || ! mv -f "$temporary" "$destination"; then
    rm -f "$temporary"
    echo "Gateway artifact installation failed" >&2
    exit 1
  fi
}

mi_gateway_backup() {
  source=$1
  [ -f "$source" ] || return 0
  backup_dir=$(mi_gateway_path /var/backups/mi-gateway)
  install -d -m 0700 "$backup_dir"
  name=$(basename -- "$source")
  temporary=$(mktemp "$backup_dir/.${name}.XXXXXX") || exit 1
  if ! cp -p "$source" "$temporary"; then
    rm -f "$temporary"
    echo "Gateway backup failed" >&2
    exit 1
  fi
  mv -f "$temporary" "$backup_dir/${name}.previous"
}

mi_gateway_restart_and_wait() {
  systemctl daemon-reload
  systemctl restart llm-gateway.service
  systemctl is-active --quiet llm-gateway.service
  waiter=$(mi_gateway_path /usr/local/libexec/wait-for-llm-gateway-health)
  health_command=${MI_GATEWAY_HEALTH_COMMAND:-/home/kyle/bin/llm-gateway-health}
  "$waiter" "$health_command"
}
