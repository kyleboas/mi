#!/usr/bin/env node
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const repo = resolve(import.meta.dirname, '..');
const aliases = (yaml) => [...yaml.matchAll(/^\s*- model_name: (\S+)$/gm)].map((match) => match[1]);
const productionAliases = ['coding-main', 'mi-concierge'];
const evalAliases = ['mi-eval-luna-low', 'mi-eval-sol-low', 'mi-eval-sol-medium', 'mi-eval-terra-low', 'mi-eval-sol-high'];
const productionConfig = readFileSync(resolve(repo, 'gateway/litellm-config.yaml'));
const productionHandler = readFileSync(resolve(repo, 'gateway/pi_subscription_handler.py'), 'utf8');
const dropinTemplate = readFileSync(resolve(repo, 'gateway/llm-gateway.service.d/20-codex-subscription.conf'), 'utf8');
const overlayConfig = readFileSync(resolve(repo, 'gateway/mi-model-eval/litellm-config.yaml'), 'utf8');
const overlayHandler = readFileSync(resolve(repo, 'gateway/mi-model-eval/pi_subscription_eval_handler.py'), 'utf8');
const installLibrary = readFileSync(resolve(repo, 'scripts/lib-mi-gateway-install.sh'), 'utf8');

for (const reviewedDefault of [
  'MI_GATEWAY_SERVICE_USER:-kyle',
  'MI_GATEWAY_SERVICE_HOME:-/home/kyle',
  'MI_GATEWAY_PI_BINARY:-/home/kyle/.nvm/versions/node/v24.15.0/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js',
  'MI_GATEWAY_PI_COMMAND_DIR:-/home/kyle/.nvm/versions/node/v24.15.0/bin',
  'MI_GATEWAY_PI_AGENT_DIR:-/home/kyle/.pi/agent',
  'MI_GATEWAY_WORK_DIR:-/var/lib/llm-gateway',
  'MI_GATEWAY_HEALTH_COMMAND:-/home/kyle/bin/llm-gateway-health',
]) assert.ok(installLibrary.includes(reviewedDefault), `missing reviewed current-host default: ${reviewedDefault}`);

assert.deepEqual(aliases(productionConfig.toString()), productionAliases, 'production config contains only durable aliases');
assert.doesNotMatch(productionConfig.toString(), /mi-eval-/);
assert.doesNotMatch(productionHandler, /mi-eval-/);
assert.match(productionHandler, /"coding-main": \(PI_MODEL, None\)/, 'coding-main remains implicit high');
assert.match(productionHandler, /"mi-concierge": \(PI_MODEL, "medium"\)/, 'concierge remains Sol medium');
assert.deepEqual(aliases(overlayConfig), [...productionAliases, ...evalAliases], 'overlay adds the exact eval allowlist');
for (const alias of evalAliases) assert.match(overlayHandler, new RegExp(`"${alias}"`));
assert.equal((overlayHandler.match(/"mi-eval-/g) || []).length, evalAliases.length);
const temp = mkdtempSync(resolve(tmpdir(), 'mi-gateway-overlay-'));
try {
  const templateCases = new Map([
    ['missing', dropinTemplate.replace('User=@SERVICE_USER@\n', '')],
    ['duplicate', `${dropinTemplate}User=@SERVICE_USER@\n`],
    ['unknown', dropinTemplate.replace('@SERVICE_USER@', '@OTHER_USER@')],
    ['malformed', dropinTemplate.replace('@SERVICE_USER@', '@BAD-X@@SERVICE_USER@')],
  ]);
  for (const [name, content] of templateCases) {
    const templatePath = resolve(temp, `dropin-${name}`);
    writeFileSync(templatePath, content);
    const checked = spawnSync('sh', ['-c', '. "$1"; mi_gateway_validate_dropin_template "$2"', 'sh', resolve(repo, 'scripts/lib-mi-gateway-install.sh'), templatePath], { encoding: 'utf8' });
    assert.notEqual(checked.status, 0, `${name} template placeholder fails closed`);
    assert.match(checked.stderr, /malformed, missing, duplicate, or unknown/);
  }

  const target = resolve(temp, 'root');
  const bin = resolve(temp, 'bin');
  const count = resolve(temp, 'health-count');
  const health = resolve(temp, 'health');
  const serviceHome = resolve(temp, 'service-home');
  const agentDir = resolve(serviceHome, '.pi/agent');
  const workDir = resolve(temp, 'gateway-work');
  const pi = resolve(temp, 'pi-real');
  const passwd = resolve(temp, 'passwd');
  const groups = resolve(temp, 'group');
  const uid = process.getuid();
  const gid = process.getgid();
  mkdirSync(target, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(workDir);
  mkdirSync(bin, { recursive: true });
  writeFileSync(resolve(bin, 'systemctl'), `#!/bin/sh\necho systemctl >> ${JSON.stringify(resolve(temp, 'systemctl-log'))}\nexit 0\n`);
  writeFileSync(resolve(bin, 'runuser'), '#!/bin/sh\nshift 3\nexec "$@"\n');
  writeFileSync(pi, '#!/bin/sh\nexit 0\n');
  writeFileSync(passwd, `miworker:x:${uid}:${gid}::${serviceHome}:/bin/sh\n`);
  writeFileSync(groups, `gatewaygroup:x:${gid}:\n`);
  writeFileSync(health, `#!/bin/sh\ncount=0\n[ -f ${JSON.stringify(count)} ] && count=$(cat ${JSON.stringify(count)})\ncount=$((count + 1))\nprintf '%s\\n' "$count" > ${JSON.stringify(count)}\n[ "$count" -ge 3 ]\n`);
  for (const path of [resolve(bin, 'systemctl'), resolve(bin, 'runuser'), health, pi]) chmodSync(path, 0o700);
  const env = {
    ...process.env,
    PATH: `${bin}:/usr/bin:/bin`,
    MI_GATEWAY_ROOT: target,
    MI_GATEWAY_SERVICE_USER: 'miworker',
    MI_GATEWAY_SERVICE_HOME: serviceHome,
    MI_GATEWAY_PI_BINARY: pi,
    MI_GATEWAY_PI_COMMAND_DIR: temp,
    MI_GATEWAY_PI_AGENT_DIR: agentDir,
    MI_GATEWAY_WORK_DIR: workDir,
    MI_GATEWAY_HEALTH_COMMAND: health,
    MI_GATEWAY_HEALTH_USER: 'miworker',
    MI_GATEWAY_PASSWD_FILE: passwd,
    MI_GATEWAY_GROUP_FILE: groups,
  };
  const run = (name, extraEnv = {}, args = []) => {
    const result = spawnSync('sh', [resolve(repo, 'scripts', name), ...args], {
      encoding: 'utf8', env: { ...env, ...extraEnv }, timeout: 10_000,
    });
    assert.equal(result.status, 0, `${name} ${args.join(' ')}: ${result.stderr}`);
  };
  const liveConfig = resolve(target, 'etc/litellm/config.yaml');
  const liveHandler = resolve(target, 'etc/litellm/pi_subscription_handler.py');
  const evalHandler = resolve(target, 'etc/litellm/pi_subscription_eval_handler.py');

  run('install-mi-subscription-gateway-root.sh');
  assert.deepEqual(readFileSync(liveConfig), productionConfig);
  assert.deepEqual(readFileSync(liveHandler, 'utf8'), productionHandler);
  const dropinPath = resolve(target, 'etc/systemd/system/llm-gateway.service.d/20-codex-subscription.conf');
  const dropin = readFileSync(dropinPath, 'utf8');
  const expectedDropin = dropinTemplate
    .replaceAll('@SERVICE_USER@', 'miworker')
    .replaceAll('@SERVICE_GROUP@', 'gatewaygroup')
    .replaceAll('@SERVICE_HOME@', serviceHome)
    .replaceAll('@PI_BINARY@', pi)
    .replaceAll('@PI_COMMAND_DIR@', temp)
    .replaceAll('@PI_AGENT_DIR@', agentDir)
    .replaceAll('@WORK_DIR@', workDir);
  assert.equal(dropin, expectedDropin, 'drop-in output is exact template substitution for a non-Kyle account and primary group');
  assert.doesNotMatch(dropin, /@[A-Z][A-Z0-9_]*@/, 'rendered drop-in has no placeholders');
  for (const [path, mode] of [[liveConfig, 0o644], [liveHandler, 0o644], [dropinPath, 0o644]]) {
    assert.equal(statSync(path).mode & 0o777, mode, `${path} has its reviewed mode`);
    assert.equal(statSync(path).uid, uid, `${path} is owned by the fixture installer account`);
  }
  for (const path of [resolve(target, 'usr/local/libexec/start-llm-gateway'), resolve(target, 'usr/local/libexec/wait-for-llm-gateway-health')]) {
    assert.equal(statSync(path).mode & 0o777, 0o755, `${path} is executable but not writable by other users`);
    assert.equal(statSync(path).uid, uid, `${path} is owned by the fixture installer account`);
  }
  const generatedFiles = readdirSync(target, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile()).map((entry) => readFileSync(resolve(entry.parentPath, entry.name), 'utf8')).join('\n');
  assert.doesNotMatch(generatedFiles, /\/home\/kyle/, 'portable artifacts contain no current-host home');
  assert.equal(readFileSync(count, 'utf8').trim(), '3', 'authenticated readiness retries transient failures');

  const linkedPi = resolve(temp, 'linked-pi');
  symlinkSync(pi, linkedPi);
  const badCases = [
    ['placeholder home', { MI_GATEWAY_SERVICE_HOME: '<service-home>' }],
    ['newline user', { MI_GATEWAY_SERVICE_USER: 'miworker\nother' }],
    ['relative Pi path', { MI_GATEWAY_PI_BINARY: 'pi' }],
    ['symlink Pi path', { MI_GATEWAY_PI_BINARY: linkedPi }],
    ['unsafe provider path', { MI_GATEWAY_PI_COMMAND_DIR: `${temp}&other` }],
    ['newline provider path', { MI_GATEWAY_PI_AGENT_DIR: `${agentDir}\nother` }],
    ['unexpanded provider path', { MI_GATEWAY_PI_AGENT_DIR: `${serviceHome}/@AGENT_DIR@` }],
  ];
  const systemctlBefore = readFileSync(resolve(temp, 'systemctl-log'), 'utf8');
  for (const [name, changedEnv] of badCases) {
    const badRoot = resolve(temp, `bad-root-${name.replaceAll(' ', '-')}`);
    mkdirSync(badRoot);
    const bad = spawnSync('sh', [resolve(repo, 'scripts/install-mi-subscription-gateway-root.sh')], {
      encoding: 'utf8', env: { ...env, MI_GATEWAY_ROOT: badRoot, ...changedEnv },
    });
    assert.notEqual(bad.status, 0, `${name} fails`);
    assert.deepEqual(readdirSync(badRoot), [], `${name} fails before artifact writes`);
  }
  assert.equal(readFileSync(resolve(temp, 'systemctl-log'), 'utf8'), systemctlBefore, 'bad configuration does not restart');

  const destinationNames = [
    'etc/litellm/config.yaml',
    'etc/litellm/pi_subscription_handler.py',
    'usr/local/libexec/start-llm-gateway',
    'usr/local/libexec/wait-for-llm-gateway-health',
    'etc/systemd/system/llm-gateway.service.d/20-codex-subscription.conf',
  ];
  const basename = (path) => path.slice(path.lastIndexOf('/') + 1);
  for (let boundary = 1; boundary <= destinationNames.length; boundary += 1) {
    const failureRoot = resolve(temp, `failure-existing-${boundary}`);
    const prior = new Map();
    for (const relative of destinationNames) {
      const destination = resolve(failureRoot, relative);
      mkdirSync(resolve(destination, '..'), { recursive: true });
      const content = Buffer.from(`old-${boundary}-${relative}\n`);
      writeFileSync(destination, content);
      prior.set(relative, content);
    }
    const logBefore = readFileSync(resolve(temp, 'systemctl-log'));
    const failed = spawnSync('sh', [resolve(repo, 'scripts/install-mi-subscription-gateway-root.sh')], {
      encoding: 'utf8', env: { ...env, MI_GATEWAY_ROOT: failureRoot, MI_GATEWAY_FAIL_AFTER_WRITE: String(boundary) },
    });
    assert.notEqual(failed.status, 0, `write boundary ${boundary} fails`);
    assert.match(failed.stderr, new RegExp(`failure after write ${boundary}`));
    for (const relative of destinationNames) {
      assert.deepEqual(readFileSync(resolve(failureRoot, relative)), prior.get(relative), `boundary ${boundary} restores ${relative}`);
      assert.deepEqual(
        readFileSync(resolve(failureRoot, 'var/backups/mi-gateway', `${basename(relative)}.previous`)),
        prior.get(relative),
        `boundary ${boundary} keeps a byte-exact explicit backup for ${relative}`,
      );
    }
    assert.deepEqual(readFileSync(resolve(temp, 'systemctl-log')), logBefore, `boundary ${boundary} does not restart`);
    assert.deepEqual(readFileSync(resolve(failureRoot, destinationNames[1])), prior.get(destinationNames[1]), 'handler is not mixed with a new drop-in');
    assert.deepEqual(readFileSync(resolve(failureRoot, destinationNames[4])), prior.get(destinationNames[4]), 'drop-in is not mixed with a new handler');
    writeFileSync(count, '2\n');
    run('install-mi-subscription-gateway-root.sh', { MI_GATEWAY_ROOT: failureRoot });
    assert.deepEqual(readFileSync(resolve(failureRoot, destinationNames[1])), Buffer.from(productionHandler), `boundary ${boundary} reruns successfully`);
  }

  for (let boundary = 1; boundary <= destinationNames.length; boundary += 1) {
    const failureRoot = resolve(temp, `failure-absent-${boundary}`);
    mkdirSync(failureRoot);
    const logBefore = readFileSync(resolve(temp, 'systemctl-log'));
    const failed = spawnSync('sh', [resolve(repo, 'scripts/install-mi-subscription-gateway-root.sh')], {
      encoding: 'utf8', env: { ...env, MI_GATEWAY_ROOT: failureRoot, MI_GATEWAY_FAIL_AFTER_WRITE: String(boundary) },
    });
    assert.notEqual(failed.status, 0, `absent write boundary ${boundary} fails`);
    for (const relative of destinationNames) {
      assert.throws(() => readFileSync(resolve(failureRoot, relative)), /ENOENT/, `boundary ${boundary} removes new ${relative}`);
      readFileSync(resolve(failureRoot, 'var/backups/mi-gateway', `${basename(relative)}.previous.absent`));
    }
    assert.deepEqual(readFileSync(resolve(temp, 'systemctl-log')), logBefore, `absent boundary ${boundary} does not restart`);
    writeFileSync(count, '2\n');
    run('install-mi-subscription-gateway-root.sh', { MI_GATEWAY_ROOT: failureRoot });
  }

  const rollbackRoot = resolve(temp, 'explicit-rollback');
  const rollbackPrior = new Map();
  for (const relative of destinationNames) {
    const destination = resolve(rollbackRoot, relative);
    mkdirSync(resolve(destination, '..'), { recursive: true });
    const content = Buffer.from(relative.endsWith('wait-for-llm-gateway-health')
      ? '#!/bin/sh\nexit 0\n'
      : `rollback-before-${relative}\n`);
    writeFileSync(destination, content);
    if (relative.includes('usr/local/libexec/')) chmodSync(destination, 0o700);
    rollbackPrior.set(relative, content);
  }
  writeFileSync(count, '2\n');
  run('install-mi-subscription-gateway-root.sh', { MI_GATEWAY_ROOT: rollbackRoot });
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    writeFileSync(count, '2\n');
    run('install-mi-subscription-gateway-root.sh', { MI_GATEWAY_ROOT: rollbackRoot }, ['--rollback']);
    for (const relative of destinationNames) {
      assert.deepEqual(readFileSync(resolve(rollbackRoot, relative)), rollbackPrior.get(relative), `rollback ${attempt} restores ${relative}`);
    }
  }

  const absentRollbackRoot = resolve(temp, 'explicit-absent-rollback');
  mkdirSync(absentRollbackRoot);
  writeFileSync(count, '2\n');
  run('install-mi-subscription-gateway-root.sh', { MI_GATEWAY_ROOT: absentRollbackRoot });
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    writeFileSync(count, '2\n');
    run('install-mi-subscription-gateway-root.sh', { MI_GATEWAY_ROOT: absentRollbackRoot }, ['--rollback']);
    for (const relative of destinationNames) {
      assert.throws(() => readFileSync(resolve(absentRollbackRoot, relative)), /ENOENT/, `absent rollback ${attempt} removes ${relative}`);
    }
  }

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
