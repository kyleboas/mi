#!/usr/bin/env node
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const config = readFileSync(resolve(root, 'gateway/litellm-config.yaml'), 'utf8');
const installer = readFileSync(resolve(root, 'scripts/install-mi-subscription-gateway-root.sh'), 'utf8');
const wrapper = readFileSync(resolve(root, 'gateway/start-llm-gateway'), 'utf8');
const dropin = readFileSync(resolve(root, 'gateway/llm-gateway.service.d/20-codex-subscription.conf'), 'utf8');
const healthWaiter = resolve(root, 'gateway/wait-for-llm-gateway-health');
const handler = readFileSync(resolve(root, 'gateway/pi_subscription_handler.py'), 'utf8');
const entrypoint = '/home/kyle/install-mi-subscription-gateway.sh';

assert.match(config, /model_name: coding-main/);
assert.match(config, /model: pi-subscription\/coding-main/);
for (const alias of ['mi-eval-luna-low', 'mi-eval-sol-low', 'mi-eval-terra-low', 'mi-eval-sol-medium', 'mi-eval-sol-high']) {
  assert.match(config, new RegExp(`model_name: ${alias}\\n\\s+litellm_params:\\n\\s+model: pi-subscription/${alias}`), `${alias} must be an explicit gateway alias`);
}
assert.match(config, /custom_handler: pi_subscription_handler\.pi_subscription_llm/);
assert.doesNotMatch(config, /openrouter|cloudflare|coding-fast/i);
assert.match(installer, /gateway\/litellm-config\.yaml/);
assert.match(installer, /gateway\/pi_subscription_handler\.py/);
assert.match(installer, /gateway\/start-llm-gateway/);
assert.match(installer, /gateway\/wait-for-llm-gateway-health/);
assert.match(installer, /wait-for-llm-gateway-health \/home\/kyle\/bin\/llm-gateway-health/);
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
assert.match(handler, /mi-eval-luna-low/);
assert.match(handler, /subscription profile does not accept effort overrides/);
assert.match(handler, /env=PI_ENV/);

// systemctl considers the service active as soon as LiteLLM execs, before Uvicorn
// binds 127.0.0.1:4000. Exercise the exact tracked wait helper with two initial
// connection-refused-equivalent failures, without touching systemd or port 4000.
const temp = mkdtempSync(resolve(tmpdir(), 'mi-gateway-health-'));
try {
  const count = resolve(temp, 'count');
  const fakeHealth = resolve(temp, 'health');
  const fakeRunuser = resolve(temp, 'runuser');
  writeFileSync(fakeHealth, `#!/bin/sh\ncount_file=${JSON.stringify(count)}\ncount=0\n[ -f "$count_file" ] && count=$(cat "$count_file")\ncount=$((count + 1))\nprintf '%s\\n' "$count" > "$count_file"\n[ "$count" -ge 3 ]\n`);
  writeFileSync(fakeRunuser, '#!/bin/sh\nshift 3\nexec "$@"\n');
  chmodSync(fakeHealth, 0o755);
  chmodSync(fakeRunuser, 0o755);
  const result = spawnSync('sh', [healthWaiter, fakeHealth], { encoding: 'utf8', timeout: 8_000, env: { ...process.env, PATH: `${temp}:/usr/bin:/bin` } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(count, 'utf8').trim(), '3', 'waiter must retry transient refused connections');
} finally {
  rmSync(temp, { recursive: true, force: true });
}

assert.ok(existsSync(entrypoint), 'root deployment entrypoint missing');
assert.equal(statSync(entrypoint).mode & 0o777, 0o700, 'root deployment entrypoint must be mode 0700');
assert.match(readFileSync(entrypoint, 'utf8'), /install-mi-subscription-gateway-root\.sh/);

console.log('subscription gateway installer/config tests passed');
