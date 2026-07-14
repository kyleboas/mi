#!/usr/bin/env node
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const config = readFileSync(resolve(root, 'gateway/litellm-config.yaml'), 'utf8');
const installer = readFileSync(resolve(root, 'scripts/install-mi-subscription-gateway-root.sh'), 'utf8');
const wrapper = readFileSync(resolve(root, 'gateway/start-llm-gateway'), 'utf8');
const dropin = readFileSync(resolve(root, 'gateway/llm-gateway.service.d/20-codex-subscription.conf'), 'utf8');
const handler = readFileSync(resolve(root, 'gateway/pi_subscription_handler.py'), 'utf8');
const entrypoint = '/home/kyle/install-mi-subscription-gateway.sh';

assert.match(config, /model_name: coding-main/);
assert.match(config, /model: pi-subscription\/coding-main/);
assert.match(config, /custom_handler: pi_subscription_handler\.pi_subscription_llm/);
assert.doesNotMatch(config, /openrouter|cloudflare|coding-fast/i);
assert.match(installer, /gateway\/litellm-config\.yaml/);
assert.match(installer, /gateway\/pi_subscription_handler\.py/);
assert.match(installer, /gateway\/start-llm-gateway/);
assert.match(installer, /systemctl daemon-reload/);
assert.match(installer, /systemctl restart llm-gateway\.service/);
assert.match(installer, /llm-gateway-health/);
assert.match(wrapper, /CREDENTIALS_DIRECTORY/);
assert.match(wrapper, /LITELLM_MASTER_KEY/);
assert.match(wrapper, /unset OPENROUTER_API_KEY/);
assert.doesNotMatch(wrapper, /read_credential openrouter/);
assert.match(dropin, /LoadCredential=gateway:\/etc\/agent-secrets\/local-agent-gateway\.token/);
assert.match(dropin, /ProtectHome=read-only/);
assert.match(handler, /--no-tools/);
assert.match(handler, /openai-codex\/gpt-5\.6-sol/);
assert.match(handler, /env=PI_ENV/);
assert.ok(existsSync(entrypoint), 'root deployment entrypoint missing');
assert.equal(statSync(entrypoint).mode & 0o777, 0o700, 'root deployment entrypoint must be mode 0700');
assert.match(readFileSync(entrypoint, 'utf8'), /install-mi-subscription-gateway-root\.sh/);

console.log('subscription gateway installer/config tests passed');
