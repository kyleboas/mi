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

mi_gateway_safe_path() {
  value=$1
  label=$2
  case "$value" in
    ''|*[!A-Za-z0-9_./@+-]*|*//*|*/./*|*/../*|*/.|*/..|*/)
      echo "Gateway preflight failed: $label must be a normalized absolute path" >&2; exit 1 ;;
    /*) ;;
    *) echo "Gateway preflight failed: $label must be a normalized absolute path" >&2; exit 1 ;;
  esac
}

mi_gateway_account_line() {
  if [ -n "${MI_GATEWAY_PASSWD_FILE:-}" ]; then
    [ -n "${MI_GATEWAY_ROOT:-}" ] || { echo 'Gateway preflight failed: fixture account file requires MI_GATEWAY_ROOT' >&2; exit 1; }
    awk -F: -v user="$1" '$1 == user { print; found=1 } END { if (!found) exit 1 }' "$MI_GATEWAY_PASSWD_FILE"
  else
    getent passwd "$1"
  fi
}

mi_gateway_group_name() {
  if [ -n "${MI_GATEWAY_GROUP_FILE:-}" ]; then
    awk -F: -v gid="$1" '$3 == gid { print $1; found=1; exit } END { if (!found) exit 1 }' "$MI_GATEWAY_GROUP_FILE"
  else
    getent group "$1" | cut -d: -f1
  fi
}

mi_gateway_check_owned_directory() {
  path=$1 label=$2 uid=$3
  [ -d "$path" ] && [ ! -L "$path" ] && [ "$(readlink -f -- "$path")" = "$path" ] || { echo "Gateway preflight failed: $label must be an existing real directory" >&2; exit 1; }
  owner=$(stat -c %u "$path")
  [ "$owner" = "$uid" ] || { echo "Gateway preflight failed: $label has the wrong owner" >&2; exit 1; }
}

mi_gateway_check_executable() {
  path=$1 label=$2 uid=$3
  [ -f "$path" ] && [ -x "$path" ] && [ ! -L "$path" ] && [ "$(readlink -f -- "$path")" = "$path" ] || { echo "Gateway preflight failed: $label must be an existing non-symlink executable" >&2; exit 1; }
  owner=$(stat -c %u "$path")
  [ "$owner" = 0 ] || [ "$owner" = "$uid" ] || { echo "Gateway preflight failed: $label has an unexpected owner" >&2; exit 1; }
}

# Defaults below are the reviewed current-host settings. Portable installs pass every
# value explicitly; no value is taken from root's HOME or PATH.
mi_gateway_load_config() {
  MI_GATEWAY_SERVICE_USER=${MI_GATEWAY_SERVICE_USER:-kyle}
  MI_GATEWAY_SERVICE_HOME=${MI_GATEWAY_SERVICE_HOME:-/home/kyle}
  MI_GATEWAY_PI_BINARY=${MI_GATEWAY_PI_BINARY:-/home/kyle/.nvm/versions/node/v24.15.0/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js}
  MI_GATEWAY_PI_COMMAND_DIR=${MI_GATEWAY_PI_COMMAND_DIR:-/home/kyle/.nvm/versions/node/v24.15.0/bin}
  MI_GATEWAY_PI_AGENT_DIR=${MI_GATEWAY_PI_AGENT_DIR:-/home/kyle/.pi/agent}
  MI_GATEWAY_WORK_DIR=${MI_GATEWAY_WORK_DIR:-/var/lib/llm-gateway}
  MI_GATEWAY_HEALTH_COMMAND=${MI_GATEWAY_HEALTH_COMMAND:-/home/kyle/bin/llm-gateway-health}
  MI_GATEWAY_HEALTH_USER=${MI_GATEWAY_HEALTH_USER:-$MI_GATEWAY_SERVICE_USER}
  export MI_GATEWAY_SERVICE_USER MI_GATEWAY_SERVICE_HOME MI_GATEWAY_PI_BINARY MI_GATEWAY_PI_COMMAND_DIR \
    MI_GATEWAY_PI_AGENT_DIR MI_GATEWAY_WORK_DIR MI_GATEWAY_HEALTH_COMMAND MI_GATEWAY_HEALTH_USER

  for user_name in "$MI_GATEWAY_SERVICE_USER" "$MI_GATEWAY_HEALTH_USER"; do
    case "$user_name" in
      ''|*[!A-Za-z0-9_.-]*|-*) echo 'Gateway preflight failed: invalid service or health user' >&2; exit 1 ;;
    esac
  done
  for pair in \
    "$MI_GATEWAY_SERVICE_HOME|service home" \
    "$MI_GATEWAY_PI_BINARY|Pi binary" \
    "$MI_GATEWAY_PI_COMMAND_DIR|Pi command directory" \
    "$MI_GATEWAY_PI_AGENT_DIR|Pi agent directory" \
    "$MI_GATEWAY_WORK_DIR|gateway work directory" \
    "$MI_GATEWAY_HEALTH_COMMAND|health command"; do
    mi_gateway_safe_path "${pair%%|*}" "${pair#*|}"
  done
  if [ -n "${MI_GATEWAY_ROOT:-}" ]; then
    mi_gateway_safe_path "$MI_GATEWAY_ROOT" 'fixture root'
    [ -d "$MI_GATEWAY_ROOT" ] && [ ! -L "$MI_GATEWAY_ROOT" ] && [ "$(readlink -f -- "$MI_GATEWAY_ROOT")" = "$MI_GATEWAY_ROOT" ] || { echo 'Gateway preflight failed: fixture root must be a real directory' >&2; exit 1; }
  fi

  account=$(mi_gateway_account_line "$MI_GATEWAY_SERVICE_USER") || { echo 'Gateway preflight failed: service user does not exist' >&2; exit 1; }
  old_ifs=$IFS; IFS=:; set -- $account; IFS=$old_ifs
  service_uid=$3 service_gid=$4 account_home=$6
  [ "$account_home" = "$MI_GATEWAY_SERVICE_HOME" ] || { echo 'Gateway preflight failed: service home does not match the account database' >&2; exit 1; }
  health_account=$(mi_gateway_account_line "$MI_GATEWAY_HEALTH_USER") || { echo 'Gateway preflight failed: health user does not exist' >&2; exit 1; }
  service_group=$(mi_gateway_group_name "$service_gid") || { echo 'Gateway preflight failed: primary service group does not exist' >&2; exit 1; }
  case "$service_group" in ''|*[!A-Za-z0-9_.-]*) echo 'Gateway preflight failed: invalid primary service group' >&2; exit 1;; esac
  export service_uid service_group

  mi_gateway_check_owned_directory "$MI_GATEWAY_SERVICE_HOME" 'service home' "$service_uid"
  mi_gateway_check_owned_directory "$MI_GATEWAY_PI_COMMAND_DIR" 'Pi command directory' "$service_uid"
  mi_gateway_check_owned_directory "$MI_GATEWAY_PI_AGENT_DIR" 'Pi agent directory' "$service_uid"
  mi_gateway_check_owned_directory "$MI_GATEWAY_WORK_DIR" 'gateway work directory' "$service_uid"
  mi_gateway_check_executable "$MI_GATEWAY_PI_BINARY" 'Pi binary' "$service_uid"
  # The health command may belong to its user or root. Find that user's numeric ID.
  old_ifs=$IFS; IFS=:; set -- $health_account; IFS=$old_ifs
  mi_gateway_check_executable "$MI_GATEWAY_HEALTH_COMMAND" 'health command' "$3"
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

mi_gateway_render_dropin() {
  destination=$1
  directory=$(dirname -- "$destination")
  temporary=$(mktemp "$directory/.mi-gateway-dropin.XXXXXX") || exit 1
  chmod 0600 "$temporary"
  if ! printf '%s\n' \
    '# Rendered by install-mi-subscription-gateway-root.sh after path and account checks.' \
    '[Service]' \
    "User=$MI_GATEWAY_SERVICE_USER" \
    "Group=$service_group" \
    "Environment=HOME=$MI_GATEWAY_SERVICE_HOME" \
    "Environment=MI_GATEWAY_SERVICE_HOME=$MI_GATEWAY_SERVICE_HOME" \
    "Environment=MI_GATEWAY_PI_BINARY=$MI_GATEWAY_PI_BINARY" \
    "Environment=MI_GATEWAY_PI_COMMAND_DIR=$MI_GATEWAY_PI_COMMAND_DIR" \
    "Environment=MI_GATEWAY_PI_AGENT_DIR=$MI_GATEWAY_PI_AGENT_DIR" \
    "Environment=MI_GATEWAY_WORK_DIR=$MI_GATEWAY_WORK_DIR" \
    'LoadCredential=' \
    'LoadCredential=gateway:/etc/agent-secrets/local-agent-gateway.token' \
    'ProtectHome=read-only' \
    "ReadWritePaths=$MI_GATEWAY_PI_AGENT_DIR $MI_GATEWAY_WORK_DIR" > "$temporary"; then
    rm -f "$temporary"; exit 1
  fi
  chmod 0644 "$temporary"
  mv -f "$temporary" "$destination"
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
  "$waiter" "$MI_GATEWAY_HEALTH_COMMAND" "$MI_GATEWAY_HEALTH_USER"
}
