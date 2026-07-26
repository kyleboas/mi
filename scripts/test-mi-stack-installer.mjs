#!/usr/bin/env node
import assert from 'node:assert/strict';
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
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
const sudoCalls = path.join(tmp, 'sudo-calls');
const systemctlCalls = path.join(tmp, 'systemctl-calls');
const serviceState = path.join(tmp, 'service-state');
const initialServiceState = [
  'llm-gateway.service|active=inactive|enabled=disabled',
  'mi-photon-bridge.service|active=inactive|enabled=disabled',
  'mi-web-chat.service|active=inactive|enabled=disabled',
  'mi-daemon.service|active=inactive|enabled=disabled',
  'mi-tick.timer|active=inactive|enabled=disabled',
].join('\n').concat('\n');
await writeFile(serviceState, initialServiceState);
await writeFile(systemctlCalls, '');
await writeFile(path.join(bin, 'sudo'), `#!/bin/bash\necho sudo >> ${JSON.stringify(sudoCount)}\nprintf '%s\\n' "$*" >> ${JSON.stringify(sudoCalls)}\n[[ $1 == -- ]] && shift\nexec "$@"\n`);
await writeFile(path.join(bin, 'systemctl'), `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(systemctlCalls)}\nexit 0\n`);
await chmod(path.join(bin, 'sudo'), 0o700);
await chmod(path.join(bin, 'systemctl'), 0o700);
const stageNames = ['production-gateway', 'gateway-client', 'production-registry', 'tailscale-web', 'user-units', 'photon-loopback', 'generated-entrypoints', 'readiness'];
const userStages = new Set(['gateway-client', 'production-registry', 'tailscale-web', 'user-units']);
const stageLog = path.join(tmp, 'stage-log');
const stageEnvLog = path.join(tmp, 'stage-env-log');
for (const name of stageNames.filter((name) => name !== 'generated-entrypoints')) {
  const gatewayValues = name === 'production-gateway'
    ? `printf '%s\\n' "$MI_GATEWAY_NO_SYSTEMD|$MI_GATEWAY_SERVICE_USER|$MI_GATEWAY_SERVICE_HOME|$MI_GATEWAY_PI_BINARY|$MI_GATEWAY_PI_COMMAND_DIR|$MI_GATEWAY_PI_AGENT_DIR|$MI_GATEWAY_WORK_DIR|$MI_GATEWAY_HEALTH_COMMAND|$MI_GATEWAY_HEALTH_USER" > ${JSON.stringify(path.join(tmp, 'gateway-values'))}\n`
    : '';
  const recordedEnvironment = userStages.has(name)
    ? `printf '%s|%s|%s|%s|%s|%s\\n' ${name} "$HOME" "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$PATH" "\${ROOT_XDG_LEAK-unset}" >> ${JSON.stringify(stageEnvLog)}\n`
    : '';
  await writeFile(path.join(stages, name), `#!/bin/sh\necho ${name} >> ${JSON.stringify(stageLog)}\n${gatewayValues}${recordedEnvironment}`);
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
  MI_SERVICE_USER: 'other-user',
  MI_GATEWAY_SERVICE_USER: 'other-user',
  MI_GATEWAY_SERVICE_HOME: home,
  MI_GATEWAY_PI_BINARY: path.join(tmp, 'pi-real'),
  MI_GATEWAY_PI_COMMAND_DIR: bin,
  MI_GATEWAY_PI_AGENT_DIR: path.join(home, '.pi/agent'),
  MI_GATEWAY_WORK_DIR: path.join(tmp, 'gateway-work'),
  MI_GATEWAY_HEALTH_COMMAND: path.join(tmp, 'other-health-command'),
  MI_GATEWAY_HEALTH_USER: 'other-health',
  MI_NODE_BIN: process.execPath,
  HOME: '/root/inherited-home',
  XDG_CONFIG_HOME: '/root/inherited-config',
  XDG_DATA_HOME: '/root/inherited-data',
  ROOT_XDG_LEAK: 'must-not-reach-service-stage',
};
const run = (args = [], extra = {}) => spawnSync('bash', [path.join(repo, 'scripts/install-mi-stack.sh'), ...args], { env: { ...env, ...extra }, encoding: 'utf8' });

const beforeServiceState = await readFile(serviceState, 'utf8');
assert.equal(beforeServiceState, initialServiceState, 'fixture captures inactive and disabled service state before installation');

let result = run(['--dry-run']);
assert.equal(result.status, 0, result.stderr);
assert.deepEqual(result.stdout.trim().split('\n').slice(1).map((line) => line.trim()), stageNames, 'dry-run lists the exact dependency order');
assert.equal(spawnSync('test', ['-e', path.join(home, 'install-mi-stack.sh')]).status, 1, 'dry-run does not mutate');
assert.equal(spawnSync('test', ['-e', sudoCount]).status, 1, 'dry-run does not cross sudo boundary');

// Cleanup is armed before the transaction directory. A failure at either
// setup checkpoint leaves no stack transaction directory or changed targets.
const transactionTmp = path.join(tmp, 'stack-transaction-tmp');
const setupRegistry = path.join(home, '.pi/agent');
await mkdir(transactionTmp);
await mkdir(setupRegistry, { recursive: true });
await writeFile(path.join(setupRegistry, 'settings.json'), '{"enabledModels":["other/model"]}\n');
await writeFile(path.join(setupRegistry, 'models.json'), '{"providers":{"other":{"models":[{"id":"model"}]}}}\n');
const setupSettingsBefore = await readFile(path.join(setupRegistry, 'settings.json'));
const setupModelsBefore = await readFile(path.join(setupRegistry, 'models.json'));
for (const setupStep of ['after-temp', 'after-manifest']) {
  result = run([], { MI_STACK_FAIL_SETUP: setupStep, TMPDIR: transactionTmp });
  assert.notEqual(result.status, 0, `injected ${setupStep} failure stops the stack`);
  assert.deepEqual(await readFile(path.join(setupRegistry, 'settings.json')), setupSettingsBefore, `${setupStep} leaves settings byte-for-byte unchanged`);
  assert.deepEqual(await readFile(path.join(setupRegistry, 'models.json')), setupModelsBefore, `${setupStep} leaves models byte-for-byte unchanged`);
  assert.deepEqual((await readdir(transactionTmp)).filter((name) => name.startsWith('mi-stack-rollback.')), [], `${setupStep} leaves no stack transaction directory`);
}
assert.equal(await readFile(serviceState, 'utf8'), beforeServiceState, 'setup failures preserve service state byte-for-byte');
assert.equal(await readFile(systemctlCalls, 'utf8'), '', 'setup failures make no systemctl call');
await writeFile(sudoCount, '');
await writeFile(sudoCalls, '');

result = run();
assert.equal(result.status, 0, result.stderr);
assert.equal((await readFile(sudoCount, 'utf8')).trim().split('\n').length, 1, 'normal install has one sudo boundary');
assert.deepEqual((await readFile(stageLog, 'utf8')).trim().split('\n'), stageNames.filter((name) => name !== 'generated-entrypoints'), 'fresh replacement-stage order');
assert.equal(
  (await readFile(path.join(tmp, 'gateway-values'), 'utf8')).trim(),
  `1|other-user|${home}|${path.join(tmp, 'pi-real')}|${bin}|${path.join(home, '.pi/agent')}|${path.join(tmp, 'gateway-work')}|${path.join(tmp, 'other-health-command')}|other-health`,
  'stack forwards its files-only gateway contract and portable settings',
);
const recordedUserStages = (await readFile(stageEnvLog, 'utf8')).trim().split('\n');
assert.equal(recordedUserStages.length, userStages.size, 'every service-user stage records its clean environment');
for (const line of recordedUserStages) {
  const [name, recordedHome, recordedConfig, recordedData, recordedPath, inherited] = line.split('|');
  assert.ok(userStages.has(name));
  assert.equal(recordedHome, home);
  assert.equal(recordedConfig, path.join(home, '.config'));
  assert.equal(recordedData, path.join(home, '.local/share'));
  assert.equal(recordedPath, `${path.dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`);
  assert.equal(inherited, 'unset', `${name} must not inherit root caller variables`);
}
assert.equal((await stat(path.join(home, 'install-mi-stack.sh'))).mode & 0o777, 0o700);
assert.match(await readFile(path.join(home, 'install-mi-stack.sh'), 'utf8'), /MI-GENERATED: install-mi-stack-v1/);
assert.equal(await readFile(serviceState, 'utf8'), beforeServiceState, 'successful stack install preserves active and enabled service states byte-for-byte');
assert.equal(await readFile(systemctlCalls, 'utf8'), '', 'successful stack install makes no systemctl call');
result = run();
assert.equal(result.status, 0, result.stderr);
assert.equal((await readFile(sudoCount, 'utf8')).trim().split('\n').length, 2, 'idempotent rerun still uses only one boundary per run');
assert.equal(await readFile(serviceState, 'utf8'), beforeServiceState, 'idempotent stack install preserves active and enabled service states byte-for-byte');
assert.equal(await readFile(systemctlCalls, 'utf8'), '', 'idempotent stack install makes no systemctl call');

// A clean registry starts without the gateway provider. The real client stage
// creates coding-main before the real production stage adds mi-concierge.
const registryHome = path.join(tmp, 'registry-home');
const registryRoot = path.join(tmp, 'registry-root');
const registryStages = path.join(tmp, 'registry-stages');
const registryDir = path.join(registryHome, '.pi/agent');
await Promise.all([mkdir(registryHome), mkdir(registryRoot), mkdir(registryStages), mkdir(registryDir, { recursive: true })]);
await writeFile(path.join(registryDir, 'settings.json'), JSON.stringify({ enabledModels: ['other/model'] }));
await writeFile(path.join(registryDir, 'models.json'), JSON.stringify({ providers: { other: { models: [{ id: 'model' }] } } }));
for (const name of stageNames.filter((name) => !['gateway-client', 'production-registry'].includes(name))) {
  await writeFile(path.join(registryStages, name), '#!/bin/sh\nexit 0\n');
  await chmod(path.join(registryStages, name), 0o700);
}
result = run([], { MI_STACK_HOME: registryHome, MI_SYSTEM_ROOT: registryRoot, MI_STACK_STAGE_COMMAND_DIR: registryStages });
assert.equal(result.status, 0, result.stderr);
assert.ok(result.stdout.indexOf('Mi stack stage: gateway-client') < result.stdout.indexOf('Mi stack stage: production-registry'), 'gateway baseline stage runs before production aliases');
const cleanSettings = JSON.parse(await readFile(path.join(registryDir, 'settings.json'), 'utf8'));
const cleanModels = JSON.parse(await readFile(path.join(registryDir, 'models.json'), 'utf8'));
assert.ok(cleanSettings.enabledModels.includes('vps-gateway/coding-main'), 'client stage creates the baseline model setting');
assert.ok(cleanSettings.enabledModels.includes('vps-gateway/mi-concierge'), 'production stage adds the production alias setting');
assert.ok(cleanModels.providers['vps-gateway'].models.some((model) => model.id === 'coding-main'), 'client stage creates the baseline model');
assert.ok(cleanModels.providers['vps-gateway'].models.some((model) => model.id === 'mi-concierge'), 'production stage adds the production alias');
assert.equal(await readFile(serviceState, 'utf8'), beforeServiceState, 'clean registry install preserves service state byte-for-byte');
assert.equal(await readFile(systemctlCalls, 'utf8'), '', 'clean registry install makes no systemctl call');

// Invalid source data cannot be turned into a baseline. The alias stage never
// runs, so its fail-closed registry checks remain the final guard.
const invalidHome = path.join(tmp, 'invalid-registry-home');
const invalidRoot = path.join(tmp, 'invalid-registry-root');
const invalidStages = path.join(tmp, 'invalid-registry-stages');
const invalidDir = path.join(invalidHome, '.pi/agent');
const productionReached = path.join(tmp, 'invalid-production-reached');
await Promise.all([mkdir(invalidHome), mkdir(invalidRoot), mkdir(invalidStages), mkdir(invalidDir, { recursive: true })]);
await writeFile(path.join(invalidDir, 'settings.json'), '{}\n');
await writeFile(path.join(invalidDir, 'models.json'), '{"providers":{}}\n');
for (const name of stageNames.filter((name) => !['gateway-client', 'production-registry'].includes(name))) {
  await writeFile(path.join(invalidStages, name), '#!/bin/sh\nexit 0\n');
  await chmod(path.join(invalidStages, name), 0o700);
}
await writeFile(path.join(invalidStages, 'production-registry'), `#!/bin/sh\nprintf reached > ${JSON.stringify(productionReached)}\n`);
await chmod(path.join(invalidStages, 'production-registry'), 0o700);
result = run([], { MI_STACK_HOME: invalidHome, MI_SYSTEM_ROOT: invalidRoot, MI_STACK_STAGE_COMMAND_DIR: invalidStages });
assert.notEqual(result.status, 0);
assert.match(result.stderr, /stage gateway-client; restoring/);
assert.equal(spawnSync('test', ['-e', productionReached]).status, 1, 'production aliases do not run when the client cannot establish its baseline');
assert.deepEqual(await readFile(path.join(invalidDir, 'settings.json')), Buffer.from('{}\n'), 'invalid settings stay exact after failed baseline setup');
assert.deepEqual(await readFile(path.join(invalidDir, 'models.json')), Buffer.from('{"providers":{}}\n'), 'invalid models stay exact after failed baseline setup');
assert.equal(await readFile(serviceState, 'utf8'), beforeServiceState, 'failed baseline setup preserves service state byte-for-byte');
assert.equal(await readFile(systemctlCalls, 'utf8'), '', 'failed baseline setup makes no systemctl call');

// A failure after both registry stages restores their exact original bytes.
const rollbackHome = path.join(tmp, 'registry-rollback-home');
const rollbackRoot = path.join(tmp, 'registry-rollback-root');
const rollbackStages = path.join(tmp, 'registry-rollback-stages');
const rollbackDir = path.join(rollbackHome, '.pi/agent');
await Promise.all([mkdir(rollbackHome), mkdir(rollbackRoot), mkdir(rollbackStages), mkdir(rollbackDir, { recursive: true })]);
const rollbackSettingsBefore = Buffer.from('{\n  "enabledModels": ["other/model"]\n}\n');
const rollbackModelsBefore = Buffer.from('{\n  "providers": {"other": {"models": [{"id": "model"}]}}\n}\n');
await writeFile(path.join(rollbackDir, 'settings.json'), rollbackSettingsBefore);
await writeFile(path.join(rollbackDir, 'models.json'), rollbackModelsBefore);
for (const name of stageNames.filter((name) => !['gateway-client', 'production-registry', 'tailscale-web'].includes(name))) {
  await writeFile(path.join(rollbackStages, name), '#!/bin/sh\nexit 0\n');
  await chmod(path.join(rollbackStages, name), 0o700);
}
await writeFile(path.join(rollbackStages, 'tailscale-web'), `#!/bin/sh\nprintf 'changed\\n' > ${JSON.stringify(path.join(rollbackDir, 'settings.json'))}\nprintf 'changed\\n' > ${JSON.stringify(path.join(rollbackDir, 'models.json'))}\nexit 24\n`);
await chmod(path.join(rollbackStages, 'tailscale-web'), 0o700);
result = run([], { MI_STACK_HOME: rollbackHome, MI_SYSTEM_ROOT: rollbackRoot, MI_STACK_STAGE_COMMAND_DIR: rollbackStages });
assert.notEqual(result.status, 0);
assert.match(result.stderr, /stage tailscale-web; restoring/);
assert.deepEqual(await readFile(path.join(rollbackDir, 'settings.json')), rollbackSettingsBefore, 'post-registry failure restores settings byte-for-byte');
assert.deepEqual(await readFile(path.join(rollbackDir, 'models.json')), rollbackModelsBefore, 'post-registry failure restores models byte-for-byte');
assert.equal(await readFile(serviceState, 'utf8'), beforeServiceState, 'post-registry rollback preserves service state byte-for-byte');
assert.equal(await readFile(systemctlCalls, 'utf8'), '', 'post-registry rollback makes no systemctl call');

// Partial failure restores an existing generated file and removes partial output.
const mutation = path.join(home, '.local/share/mi/mi-gateway-client.py');
const gatewayWrapper = path.join(root, 'usr/local/libexec/start-llm-gateway');
await mkdir(path.dirname(mutation), { recursive: true });
await mkdir(path.dirname(gatewayWrapper), { recursive: true });
await writeFile(mutation, 'before\n');
await writeFile(gatewayWrapper, 'old wrapper\n');
await writeFile(path.join(stages, 'gateway-client'), `#!/bin/sh\nprintf 'partial\\n' > ${JSON.stringify(mutation)}\nprintf 'new wrapper\\n' > ${JSON.stringify(gatewayWrapper)}\nexit 23\n`);
await chmod(path.join(stages, 'gateway-client'), 0o700);
result = run();
assert.notEqual(result.status, 0);
assert.match(result.stderr, /stage gateway-client; restoring/);
assert.equal(await readFile(mutation, 'utf8'), 'before\n', 'atomic rollback restores pre-transaction file');
assert.equal(await readFile(gatewayWrapper, 'utf8'), 'old wrapper\n', 'rollback restores the gateway wrapper');
assert.equal(await readFile(serviceState, 'utf8'), beforeServiceState, 'forced post-gateway rollback leaves inactive gateway and Photon states byte-for-byte unchanged');
assert.equal(await readFile(systemctlCalls, 'utf8'), '', 'forced post-gateway rollback makes no systemctl call');

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
  env: { ...env, MI_APP_DIR: repo, MI_SYSTEM_ROOT: root }, encoding: 'utf8',
});
assert.equal(result.status, 0, result.stderr);
assert.match(await readFile(path.join(root, 'etc/systemd/system/mi-photon-bridge.service'), 'utf8'), /MI_WEB_URL=http:\/\/127\.0\.0\.1:8787/);
assert.equal(spawnSync('test', ['-e', photonOverride]).status, 1, 'exact obsolete Photon override is removed');
assert.equal(await readFile(serviceState, 'utf8'), beforeServiceState, 'Photon file install preserves active and enabled states byte-for-byte');
assert.equal(await readFile(systemctlCalls, 'utf8'), '', 'Photon file install makes no systemctl call');
await mkdir(path.dirname(photonOverride), { recursive: true });
await writeFile(photonOverride, '[Service]\nEnvironment=OPERATOR_SETTING=preserve\n');
result = spawnSync('bash', [path.join(repo, 'scripts/install-mi-imessage-stack-root.sh')], {
  env: { ...env, MI_APP_DIR: repo, MI_SYSTEM_ROOT: root }, encoding: 'utf8',
});
assert.equal(result.status, 0, result.stderr);
assert.match(await readFile(photonOverride, 'utf8'), /OPERATOR_SETTING/, 'unknown Photon override is preserved');
assert.equal(await readFile(serviceState, 'utf8'), beforeServiceState, 'repeat Photon file install preserves active and enabled states byte-for-byte');
assert.equal(await readFile(systemctlCalls, 'utf8'), '', 'repeat Photon file install makes no systemctl call');

result = spawnSync('bash', [path.join(repo, 'scripts/install-mi-gateway-client.sh')], {
  env: { ...env, HOME: home, XDG_DATA_HOME: path.join(home, '.local/share') }, encoding: 'utf8',
});
assert.equal(result.status, 0, result.stderr);
assert.equal(await readFile(serviceState, 'utf8'), beforeServiceState, 'gateway client file install preserves active and enabled states byte-for-byte');
assert.equal(await readFile(systemctlCalls, 'utf8'), '', 'gateway client file install makes no systemctl call');

// --check reports only fixed non-secret expectations and succeeds on a fixture.
await mkdir(path.join(home, '.config/systemd/user/mi-web-chat.service.d'), { recursive: true });
await copyFile(path.join(repo, 'systemd/mi-web-chat.service.d/10-mi-runtime.conf'), path.join(home, '.config/systemd/user/mi-web-chat.service.d/10-mi-runtime.conf'));
await writeFile(path.join(home, '.config/systemd/user/mi-daemon.service'), `[Service]\nExecStart=${process.execPath} ${path.join(repo, 'pi/extensions/mi-daemon.mjs')}\nPrivateTmp=true\nProtectSystem=full\nEnvironment=PATH=${path.dirname(process.execPath)}:/usr/bin:/bin\n`);
await writeFile(path.join(home, '.config/systemd/user/mi-tick.service'), '[Service]\nEnvironment=MI_PROACTIVE_IMESSAGE_NOTIFY=false\nEnvironment=MI_IMESSAGE_MONITOR_ENABLED=false\n');
await mkdir(path.join(root, 'etc/systemd/system'), { recursive: true });
await writeFile(path.join(root, 'etc/systemd/system/mi-photon-bridge.service'), '[Service]\nEnvironment=MI_WEB_URL=http://127.0.0.1:8787\n');
const registry = path.join(home, '.pi/agent');
await mkdir(registry, { recursive: true });
await writeFile(path.join(registry, 'settings.json'), JSON.stringify({ enabledModels: ['vps-gateway/coding-main', 'vps-gateway/mi-concierge'] }));
await writeFile(path.join(registry, 'models.json'), JSON.stringify({ providers: { 'vps-gateway': { models: [{ id: 'coding-main' }, { id: 'mi-concierge' }] } } }));
const sudoChecksBefore = (await readFile(sudoCount, 'utf8')).trim().split('\n').filter(Boolean).length;
result = run(['--check'], { MI_GATEWAY_CONFIG_DIR: registry, MI_NODE_BIN: process.execPath });
assert.equal(result.status, 0, result.stderr);
assert.equal((await readFile(sudoCount, 'utf8')).trim().split('\n').filter(Boolean).length, sudoChecksBefore + 1, 'non-root check crosses sudo exactly once');
const checkSudoCall = (await readFile(sudoCalls, 'utf8')).trim().split('\n').at(-1);
assert.match(checkSudoCall, /env -i MI_APP_DIR=\/home\/kyle\/.pi\/worktrees\/mi-pi-clean-integration/);
assert.match(checkSudoCall, /MI_STACK_HOME=/);
assert.match(checkSudoCall, /PATH=\/usr\/local\/sbin:.*install-mi-stack-root\.sh --check$/);
assert.doesNotMatch(checkSudoCall, /ROOT_XDG_LEAK|inherited-home|inherited-config/);
assert.match(result.stdout, /Mi stack check passed/);
assert.doesNotMatch(result.stdout, /example\.ts\.net|EnvironmentFile|TOKEN|SECRET/);

const sudoCallsAfterCheck = await readFile(sudoCount, 'utf8');
result = spawnSync('bash', [path.join(repo, 'scripts/install-mi-stack-root.sh'), '--check'], {
  env: { ...env, MI_GATEWAY_CONFIG_DIR: registry, MI_NODE_BIN: process.execPath }, encoding: 'utf8',
});
assert.equal(result.status, 0, result.stderr);
assert.equal(await readFile(sudoCount, 'utf8'), sudoCallsAfterCheck, 'direct root check does not invoke sudo');
for (const [args, extra, expectedStatus] of [
  [['--bad'], {}, 2],
  [['--check', 'extra'], {}, 2],
  [[], { MI_STACK_HOME: `${home}/bad space` }, 1],
  [[], { MI_GATEWAY_WORK_DIR: `${tmp}/bad;command` }, 1],
]) {
  result = run(args, extra);
  assert.equal(result.status, expectedStatus, `wrapper rejects invalid input: ${args.join(' ') || JSON.stringify(extra)}`);
}

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
