#!/usr/bin/env node
import assert from 'node:assert/strict';
import { chmod, copyFile, mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

const repo = path.resolve(import.meta.dirname, '..');
const tmp = await mkdtemp(path.join(tmpdir(), 'mi-stack-'));
const home = path.join(tmp, 'home');
const root = path.join(tmp, 'root');
const bin = path.join(tmp, 'bin');
const stages = path.join(tmp, 'stages');
await Promise.all([mkdir(home, { recursive: true }), mkdir(root), mkdir(bin), mkdir(stages)]);
const sudoCount = path.join(tmp, 'sudo-count');
await writeFile(path.join(bin, 'sudo'), `#!/bin/bash\necho sudo >> ${JSON.stringify(sudoCount)}\n[[ $1 == -- ]] && shift\nexec "$@"\n`);
await chmod(path.join(bin, 'sudo'), 0o700);
const stageNames = ['production-gateway', 'production-registry', 'gateway-client', 'tailscale-web', 'user-units', 'photon-loopback', 'readiness'];
const stageLog = path.join(tmp, 'stage-log');
for (const name of stageNames) {
  await writeFile(path.join(stages, name), `#!/bin/sh\necho ${name} >> ${JSON.stringify(stageLog)}\n`);
  await chmod(path.join(stages, name), 0o700);
}
const env = {
  ...process.env,
  PATH: `${bin}:${process.env.PATH}`,
  MI_APP_DIR: repo,
  MI_STACK_HOME: home,
  MI_SYSTEM_ROOT: root,
  MI_STACK_STAGE_COMMAND_DIR: stages,
  MI_STACK_NO_RUNUSER: '1',
};
const run = (args = [], extra = {}) => spawnSync('bash', [path.join(repo, 'scripts/install-mi-stack.sh'), ...args], { env: { ...env, ...extra }, encoding: 'utf8' });

let result = run(['--dry-run']);
assert.equal(result.status, 0, result.stderr);
assert.match(result.stdout, /production-gateway[\s\S]*readiness/);
assert.equal(spawnSync('test', ['-e', path.join(home, 'install-mi-stack.sh')]).status, 1, 'dry-run does not mutate');
assert.equal(spawnSync('test', ['-e', sudoCount]).status, 1, 'dry-run does not cross sudo boundary');

result = run();
assert.equal(result.status, 0, result.stderr);
assert.equal((await readFile(sudoCount, 'utf8')).trim().split('\n').length, 1, 'normal install has one sudo boundary');
assert.deepEqual((await readFile(stageLog, 'utf8')).trim().split('\n'), stageNames, 'fresh orchestration order');
assert.equal((await stat(path.join(home, 'install-mi-stack.sh'))).mode & 0o777, 0o700);
assert.match(await readFile(path.join(home, 'install-mi-stack.sh'), 'utf8'), /MI-GENERATED: install-mi-stack-v1/);
result = run();
assert.equal(result.status, 0, result.stderr);
assert.equal((await readFile(sudoCount, 'utf8')).trim().split('\n').length, 2, 'idempotent rerun still uses only one boundary per run');

// Partial failure restores an existing generated file and removes partial output.
const mutation = path.join(home, '.local/share/mi/mi-gateway-client.py');
await mkdir(path.dirname(mutation), { recursive: true });
await writeFile(mutation, 'before\n');
await writeFile(path.join(stages, 'gateway-client'), `#!/bin/sh\nprintf 'partial\\n' > ${JSON.stringify(mutation)}\nexit 23\n`);
await chmod(path.join(stages, 'gateway-client'), 0o700);
result = run();
assert.notEqual(result.status, 0);
assert.match(result.stderr, /stage gateway-client; restoring/);
assert.equal(await readFile(mutation, 'utf8'), 'before\n', 'atomic rollback restores pre-transaction file');

// Marker/checksum safety: unknown obsolete wrappers are never deleted.
const unknown = path.join(home, 'fix-mi-gateway.sh');
await writeFile(unknown, '#!/bin/sh\necho operator-owned\n');
result = spawnSync('bash', [path.join(repo, 'scripts/install-mi-home-entrypoints.sh')], { env: { ...process.env, MI_STACK_HOME: home }, encoding: 'utf8' });
assert.equal(result.status, 0, result.stderr);
assert.match(result.stderr, /Preserved unknown or modified obsolete entrypoint/);
assert.match(await readFile(unknown, 'utf8'), /operator-owned/);

// Photon is forced to loopback and removes only its exact known predecessor.
const photonSecret = path.join(root, 'etc/agent-secrets/projects/assistant/photon.secret');
const photonOverride = path.join(root, 'etc/systemd/system/mi-photon-bridge.service.d/override.conf');
await mkdir(path.dirname(photonSecret), { recursive: true });
await mkdir(path.dirname(photonOverride), { recursive: true });
await writeFile(photonSecret, 'PHOTON_PROJECT_ID=test-project\nPHOTON_PROJECT_SECRET=test-secret\nPHOTON_ALLOWED_USERS=test-user\n');
await writeFile(photonOverride, '[Service]\nEnvironment=MI_WEB_URL=http://localhost:8787\n');
result = spawnSync('bash', [path.join(repo, 'scripts/install-mi-imessage-stack-root.sh')], {
  env: { ...process.env, MI_APP_DIR: repo, MI_SYSTEM_ROOT: root, MI_PHOTON_NO_SYSTEMD: '1' }, encoding: 'utf8',
});
assert.equal(result.status, 0, result.stderr);
assert.match(await readFile(path.join(root, 'etc/systemd/system/mi-photon-bridge.service'), 'utf8'), /MI_WEB_URL=http:\/\/127\.0\.0\.1:8787/);
assert.equal(spawnSync('test', ['-e', photonOverride]).status, 1, 'exact obsolete Photon override is removed');
await mkdir(path.dirname(photonOverride), { recursive: true });
await writeFile(photonOverride, '[Service]\nEnvironment=OPERATOR_SETTING=preserve\n');
result = spawnSync('bash', [path.join(repo, 'scripts/install-mi-imessage-stack-root.sh')], {
  env: { ...process.env, MI_APP_DIR: repo, MI_SYSTEM_ROOT: root, MI_PHOTON_NO_SYSTEMD: '1' }, encoding: 'utf8',
});
assert.equal(result.status, 0, result.stderr);
assert.match(await readFile(photonOverride, 'utf8'), /OPERATOR_SETTING/, 'unknown Photon override is preserved');

// --check reports only fixed non-secret expectations and succeeds on a fixture.
await mkdir(path.join(home, '.config/systemd/user/mi-web-chat.service.d'), { recursive: true });
await copyFile(path.join(repo, 'systemd/mi-web-chat.service.d/10-mi-runtime.conf'), path.join(home, '.config/systemd/user/mi-web-chat.service.d/10-mi-runtime.conf'));
await mkdir(path.join(root, 'etc/systemd/system'), { recursive: true });
await writeFile(path.join(root, 'etc/systemd/system/mi-photon-bridge.service'), '[Service]\nEnvironment=MI_WEB_URL=http://127.0.0.1:8787\n');
const registry = path.join(home, '.pi/agent');
await mkdir(registry, { recursive: true });
await writeFile(path.join(registry, 'settings.json'), JSON.stringify({ enabledModels: ['vps-gateway/coding-main', 'vps-gateway/mi-concierge'] }));
await writeFile(path.join(registry, 'models.json'), JSON.stringify({ providers: { 'vps-gateway': { models: [{ id: 'coding-main' }, { id: 'mi-concierge' }] } } }));
result = run(['--check'], { MI_GATEWAY_CONFIG_DIR: registry, MI_NODE_BIN: process.execPath });
assert.equal(result.status, 0, result.stderr);
assert.match(result.stdout, /Mi stack check passed/);
assert.doesNotMatch(result.stdout, /example\.ts\.net|EnvironmentFile|TOKEN|SECRET/);

const failedHealth = path.join(tmp, 'failed-health');
await writeFile(failedHealth, '#!/bin/sh\nexit 1\n');
await chmod(failedHealth, 0o700);
result = spawnSync('bash', [path.join(repo, 'scripts/check-mi-stack-readiness.sh')], {
  env: { ...process.env, MI_GATEWAY_HEALTH_COMMAND: failedHealth, MI_STACK_READINESS_TIMEOUT: '0' },
  encoding: 'utf8',
});
assert.notEqual(result.status, 0);
assert.match(result.stderr, /readiness timed out/);

console.log('Mi stack installer tests passed');
