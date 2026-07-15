#!/usr/bin/env node
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const repo = resolve(import.meta.dirname, '..');
const aliases = (yaml) => [...yaml.matchAll(/^\s*- model_name: (\S+)$/gm)].map((match) => match[1]);
const productionAliases = ['coding-main', 'mi-concierge'];
const evalAliases = ['mi-eval-luna-low', 'mi-eval-sol-low', 'mi-eval-sol-medium', 'mi-eval-terra-low', 'mi-eval-sol-high'];
const productionConfig = readFileSync(resolve(repo, 'gateway/litellm-config.yaml'));
const productionHandler = readFileSync(resolve(repo, 'gateway/pi_subscription_handler.py'), 'utf8');
const overlayConfig = readFileSync(resolve(repo, 'gateway/mi-model-eval/litellm-config.yaml'), 'utf8');
const overlayHandler = readFileSync(resolve(repo, 'gateway/mi-model-eval/pi_subscription_eval_handler.py'), 'utf8');

assert.deepEqual(aliases(productionConfig.toString()), productionAliases, 'production config contains only durable aliases');
assert.doesNotMatch(productionConfig.toString(), /mi-eval-/);
assert.doesNotMatch(productionHandler, /mi-eval-/);
assert.match(productionHandler, /"coding-main": \(PI_MODEL, None\)/, 'coding-main remains implicit high');
assert.match(productionHandler, /"mi-concierge": \(PI_MODEL, "medium"\)/, 'concierge remains Sol medium');
assert.deepEqual(aliases(overlayConfig), [...productionAliases, ...evalAliases], 'overlay adds the exact eval allowlist');
for (const alias of evalAliases) assert.match(overlayHandler, new RegExp(`"${alias}"`));
assert.equal((overlayHandler.match(/"mi-eval-/g) || []).length, evalAliases.length);
for (const [path, tracked] of [
  ['/home/kyle/install-mi-model-eval-gateway.sh', 'install-mi-model-eval-overlay-root.sh'],
  ['/home/kyle/uninstall-mi-model-eval-gateway.sh', 'uninstall-mi-model-eval-overlay-root.sh'],
]) {
  assert.equal(statSync(path).mode & 0o777, 0o700, `${path} must be private`);
  assert.match(readFileSync(path, 'utf8'), new RegExp(tracked.replaceAll('.', '\\.')));
}

const temp = mkdtempSync(resolve(tmpdir(), 'mi-gateway-overlay-'));
try {
  const target = resolve(temp, 'root');
  const bin = resolve(temp, 'bin');
  const count = resolve(temp, 'health-count');
  const health = resolve(temp, 'health');
  mkdirSync(bin, { recursive: true });
  writeFileSync(resolve(bin, 'systemctl'), '#!/bin/sh\nexit 0\n');
  writeFileSync(resolve(bin, 'runuser'), '#!/bin/sh\nshift 3\nexec "$@"\n');
  writeFileSync(health, `#!/bin/sh\ncount=0\n[ -f ${JSON.stringify(count)} ] && count=$(cat ${JSON.stringify(count)})\ncount=$((count + 1))\nprintf '%s\\n' "$count" > ${JSON.stringify(count)}\n[ "$count" -ge 3 ]\n`);
  for (const path of [resolve(bin, 'systemctl'), resolve(bin, 'runuser'), health]) chmodSync(path, 0o700);
  const env = { ...process.env, PATH: `${bin}:/usr/bin:/bin`, MI_GATEWAY_ROOT: target, MI_GATEWAY_HEALTH_COMMAND: health };
  const run = (name) => {
    const result = spawnSync('sh', [resolve(repo, 'scripts', name)], { encoding: 'utf8', env, timeout: 10_000 });
    assert.equal(result.status, 0, `${name}: ${result.stderr}`);
  };
  const liveConfig = resolve(target, 'etc/litellm/config.yaml');
  const liveHandler = resolve(target, 'etc/litellm/pi_subscription_handler.py');
  const evalHandler = resolve(target, 'etc/litellm/pi_subscription_eval_handler.py');

  run('install-mi-subscription-gateway-root.sh');
  assert.deepEqual(readFileSync(liveConfig), productionConfig);
  assert.deepEqual(readFileSync(liveHandler, 'utf8'), productionHandler);
  assert.equal(readFileSync(count, 'utf8').trim(), '3', 'authenticated readiness retries transient failures');

  writeFileSync(count, '2\n');
  run('install-mi-model-eval-gateway-root.sh');
  assert.deepEqual(aliases(readFileSync(liveConfig, 'utf8')), [...productionAliases, ...evalAliases]);
  assert.equal(readFileSync(evalHandler, 'utf8'), overlayHandler);
  writeFileSync(count, '2\n');
  run('install-mi-model-eval-gateway-root.sh');

  writeFileSync(count, '2\n');
  run('uninstall-mi-model-eval-gateway-root.sh');
  assert.deepEqual(readFileSync(liveConfig), productionConfig, 'uninstall restores byte-equivalent production config');
  assert.equal(readFileSync(liveHandler, 'utf8'), productionHandler, 'uninstall restores canonical production handler');
  assert.throws(() => readFileSync(evalHandler), /ENOENT/);
  writeFileSync(count, '2\n');
  run('uninstall-mi-model-eval-gateway-root.sh');
  assert.deepEqual(readFileSync(liveConfig), productionConfig, 'repeated uninstall remains stable');
} finally {
  rmSync(temp, { recursive: true, force: true });
}

console.log('subscription gateway production/eval overlay tests passed');
