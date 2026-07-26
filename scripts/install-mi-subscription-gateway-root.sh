#!/bin/sh
# Install or roll back durable production Pi/Codex LiteLLM gateway files.
# This installer is files-only: an operator reloads and starts services later.
set -eu

repo_dir=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
# shellcheck source=lib-mi-gateway-install.sh
. "$repo_dir/scripts/lib-mi-gateway-install.sh"
mi_gateway_require_root
mi_gateway_load_config

case "${MI_GATEWAY_NO_SYSTEMD:-1}" in
  1) ;;
  *) echo 'Gateway install is files-only; MI_GATEWAY_NO_SYSTEMD must be 1 when set' >&2; exit 2 ;;
esac

mode=install
case "${1:-}" in
  '') ;;
  --rollback) mode=rollback ;;
  *) echo 'Usage: install-mi-subscription-gateway-root.sh [--rollback]' >&2; exit 2 ;;
esac

config_source="$repo_dir/gateway/litellm-config.yaml"
handler_source="$repo_dir/gateway/pi_subscription_handler.py"
wrapper_source="$repo_dir/gateway/start-llm-gateway"
waiter_source="$repo_dir/gateway/wait-for-llm-gateway-health"
dropin_template="$repo_dir/gateway/llm-gateway.service.d/20-codex-subscription.conf"
for source in "$config_source" "$handler_source" "$wrapper_source" "$waiter_source" "$dropin_template"; do
  mi_gateway_require_file "$source"
done
mi_gateway_validate_dropin_template "$dropin_template"

case "${MI_GATEWAY_FAIL_AFTER_WRITE:-}" in
  '') ;;
  1|2|3|4|5) [ -n "${MI_GATEWAY_ROOT:-}" ] || { echo 'Gateway failure injection requires a fixture root' >&2; exit 1; } ;;
  *) echo 'Gateway preflight failed: invalid fixture failure boundary' >&2; exit 1 ;;
esac

config=$(mi_gateway_path /etc/litellm/config.yaml)
handler=$(mi_gateway_path /etc/litellm/pi_subscription_handler.py)
eval_handler=$(mi_gateway_path /etc/litellm/pi_subscription_eval_handler.py)
wrapper=$(mi_gateway_path /usr/local/libexec/start-llm-gateway)
waiter=$(mi_gateway_path /usr/local/libexec/wait-for-llm-gateway-health)
dropin=$(mi_gateway_path /etc/systemd/system/llm-gateway.service.d/20-codex-subscription.conf)

if [ "$mode" = rollback ]; then
  for destination in "$config" "$handler" "$wrapper" "$waiter" "$dropin"; do
    mi_gateway_require_previous "$destination"
  done
fi

# All account, path, template, source, rollback, and test-hook checks finish before mutation.
install -d -m 0755 "$(dirname -- "$config")" "$(dirname -- "$dropin")" "$(dirname -- "$wrapper")"
transaction_parent=$(mi_gateway_path /var/backups/mi-gateway)
install -d -m 0700 "$transaction_parent"
transaction=$(mktemp -d "$transaction_parent/.transaction.XXXXXX") || exit 1
chmod 0700 "$transaction"
transaction_paths="$transaction/paths"
: > "$transaction_paths"
index=0
for destination in "$config" "$handler" "$wrapper" "$waiter" "$dropin" "$eval_handler"; do
  index=$((index + 1))
  if [ -f "$destination" ]; then
    cp -p "$destination" "$transaction/$index"
    printf 'present\t%s\t%s\n' "$index" "$destination" >> "$transaction_paths"
  else
    printf 'absent\t%s\t%s\n' "$index" "$destination" >> "$transaction_paths"
  fi
done

committed=0
restore_transaction() {
  status=$?
  trap - 0 HUP INT TERM
  if [ "$committed" -eq 0 ]; then
    while IFS="$(printf '\t')" read -r state key destination; do
      if [ "$state" = present ]; then
        temporary=$(mktemp "$(dirname -- "$destination")/.mi-gateway-restore.XXXXXX") || continue
        if cp -p "$transaction/$key" "$temporary"; then mv -f "$temporary" "$destination"; else rm -f "$temporary"; fi
      else
        rm -f "$destination"
      fi
    done < "$transaction_paths"
  fi
  rm -rf "$transaction"
  exit "$status"
}
trap restore_transaction 0
trap 'exit 1' HUP INT TERM

if [ "$mode" = rollback ]; then
  for destination in "$config" "$handler" "$wrapper" "$waiter" "$dropin"; do
    mi_gateway_restore_previous "$destination"
  done
  rm -f "$eval_handler"
  # Rollback restores files only. It deliberately preserves gateway activity
  # and enablement rather than restarting a service that may be inactive.
  committed=1
  trap - 0 HUP INT TERM
  rm -rf "$transaction"
  echo 'Mi production subscription gateway rolled back to the saved previous state'
  exit 0
fi

for destination in "$config" "$handler" "$wrapper" "$waiter" "$dropin"; do
  mi_gateway_backup "$destination"
done

write_number=0
fail_after_write() {
  write_number=$((write_number + 1))
  if [ "${MI_GATEWAY_FAIL_AFTER_WRITE:-}" = "$write_number" ]; then
    echo "Injected gateway fixture failure after write $write_number" >&2
    return 1
  fi
}
mi_gateway_atomic_install "$config_source" "$config" 0644
fail_after_write
mi_gateway_atomic_install "$handler_source" "$handler" 0644
fail_after_write
mi_gateway_atomic_install "$wrapper_source" "$wrapper" 0755
fail_after_write
mi_gateway_atomic_install "$waiter_source" "$waiter" 0755
fail_after_write
mi_gateway_render_dropin "$dropin_template" "$dropin"
fail_after_write
rm -f "$eval_handler"

# Installation ends after every file is committed. Do not daemon-reload or
# change service state here; activation is an explicit operator operation.
committed=1
trap - 0 HUP INT TERM
rm -rf "$transaction"
echo 'Mi production subscription gateway installed and healthy'
