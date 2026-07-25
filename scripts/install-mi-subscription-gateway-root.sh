#!/bin/sh
# Install only the durable production Pi/Codex LiteLLM gateway artifacts.
set -eu

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
# shellcheck source=lib-mi-gateway-install.sh
. "$repo_dir/scripts/lib-mi-gateway-install.sh"
mi_gateway_require_root
mi_gateway_load_config

config_source="$repo_dir/gateway/litellm-config.yaml"
handler_source="$repo_dir/gateway/pi_subscription_handler.py"
wrapper_source="$repo_dir/gateway/start-llm-gateway"
waiter_source="$repo_dir/gateway/wait-for-llm-gateway-health"
dropin_template="$repo_dir/gateway/llm-gateway.service.d/20-codex-subscription.conf"
for source in "$config_source" "$handler_source" "$wrapper_source" "$waiter_source" "$dropin_template"; do
  mi_gateway_require_file "$source"
done

config=$(mi_gateway_path /etc/litellm/config.yaml)
handler=$(mi_gateway_path /etc/litellm/pi_subscription_handler.py)
eval_handler=$(mi_gateway_path /etc/litellm/pi_subscription_eval_handler.py)
wrapper=$(mi_gateway_path /usr/local/libexec/start-llm-gateway)
waiter=$(mi_gateway_path /usr/local/libexec/wait-for-llm-gateway-health)
dropin=$(mi_gateway_path /etc/systemd/system/llm-gateway.service.d/20-codex-subscription.conf)
install -d -m 0755 "$(dirname -- "$config")" "$(dirname -- "$dropin")" "$(dirname -- "$wrapper")"
for destination in "$config" "$handler" "$wrapper" "$waiter" "$dropin"; do
  mi_gateway_backup "$destination"
done
mi_gateway_atomic_install "$config_source" "$config" 0644
mi_gateway_atomic_install "$handler_source" "$handler" 0644
mi_gateway_atomic_install "$wrapper_source" "$wrapper" 0755
mi_gateway_atomic_install "$waiter_source" "$waiter" 0755
mi_gateway_render_dropin "$dropin"
rm -f "$eval_handler"

mi_gateway_restart_and_wait
echo "Mi production subscription gateway installed and healthy"
