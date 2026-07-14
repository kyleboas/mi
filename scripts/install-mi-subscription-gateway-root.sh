#!/bin/sh
# Install the tracked Pi/Codex LiteLLM gateway artifacts. Run as root only.
set -eu

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root: sudo $0" >&2
  exit 1
fi

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
for source in \
  "$repo_dir/gateway/litellm-config.yaml" \
  "$repo_dir/gateway/pi_subscription_handler.py" \
  "$repo_dir/gateway/start-llm-gateway" \
  "$repo_dir/gateway/llm-gateway.service.d/20-codex-subscription.conf"; do
  if [ ! -f "$source" ]; then
    echo "Missing tracked gateway artifact: $source" >&2
    exit 1
  fi
done

install -d -m 0755 /etc/litellm /etc/systemd/system/llm-gateway.service.d
install -m 0644 "$repo_dir/gateway/litellm-config.yaml" /etc/litellm/config.yaml
install -m 0644 "$repo_dir/gateway/pi_subscription_handler.py" /etc/litellm/pi_subscription_handler.py
install -m 0755 "$repo_dir/gateway/start-llm-gateway" /usr/local/libexec/start-llm-gateway
install -m 0644 "$repo_dir/gateway/llm-gateway.service.d/20-codex-subscription.conf" \
  /etc/systemd/system/llm-gateway.service.d/20-codex-subscription.conf

systemctl daemon-reload
systemctl restart llm-gateway.service
systemctl is-active --quiet llm-gateway.service
runuser -u kyle -- /home/kyle/bin/llm-gateway-health
echo "Mi subscription gateway installed and healthy"
