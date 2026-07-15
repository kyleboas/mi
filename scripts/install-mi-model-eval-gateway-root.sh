#!/bin/sh
# Install the explicit temporary Mi model-evaluation gateway overlay.
set -eu

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
# shellcheck source=lib-mi-gateway-install.sh
. "$repo_dir/scripts/lib-mi-gateway-install.sh"
mi_gateway_require_root

config_source="$repo_dir/gateway/mi-model-eval/litellm-config.yaml"
handler_source="$repo_dir/gateway/pi_subscription_handler.py"
eval_handler_source="$repo_dir/gateway/mi-model-eval/pi_subscription_eval_handler.py"
waiter_source="$repo_dir/gateway/wait-for-llm-gateway-health"
for source in "$config_source" "$handler_source" "$eval_handler_source" "$waiter_source"; do
  mi_gateway_require_file "$source"
done

config=$(mi_gateway_path /etc/litellm/config.yaml)
handler=$(mi_gateway_path /etc/litellm/pi_subscription_handler.py)
eval_handler=$(mi_gateway_path /etc/litellm/pi_subscription_eval_handler.py)
install -d -m 0755 "$(dirname -- "$config")" "$(mi_gateway_path /usr/local/libexec)"
mi_gateway_backup "$config"
mi_gateway_backup "$handler"
mi_gateway_atomic_install "$config_source" "$config" 0644
mi_gateway_atomic_install "$handler_source" "$handler" 0644
mi_gateway_atomic_install "$eval_handler_source" "$eval_handler" 0644
mi_gateway_atomic_install "$waiter_source" "$(mi_gateway_path /usr/local/libexec/wait-for-llm-gateway-health)" 0755

mi_gateway_restart_and_wait
echo "Temporary Mi model-evaluation gateway overlay installed and healthy"
