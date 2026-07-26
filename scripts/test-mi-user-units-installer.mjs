#!/usr/bin/env node
import assert from 'node:assert/strict';
import { chmod, copyFile, mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const repo = path.resolve(import.meta.dirname, '..');
const node = process.execPath;
const temp = await mkdtemp(path.join(os.tmpdir(), 'mi-user-units-'));
const miRoot = path.join(temp, 'mi-root');
await mkdir(path.join(miRoot, 'pi', 'extensions'), { recursive: true });
await mkdir(path.join(miRoot, 'state'), { recursive: true });
await copyFile(path.join(repo, 'pi', 'extensions', 'mi-daemon.mjs'), path.join(miRoot, 'pi', 'extensions', 'mi-daemon.mjs'));
const run = (home, extra = {}) => spawnSync('bash', ['scripts/install-mi-user-units.sh'], {
  cwd: repo,
  env: {
    ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), MI_APP_DIR: miRoot,
    MI_NODE_BIN: node, MI_BIN: node, MI_USER_UNITS_SKIP_SYSTEMD_VERIFY: '1', ...extra,
  },
  encoding: 'utf8',
});
const file = async (name) => readFile(name, 'utf8');
const legacyRuntimeDir = (home) => path.join(home, '.pi', 'agent', 'mi');
const legacyNode = (home) => path.join(home, '.nvm', 'versions', 'node', 'v24.15.0', 'bin', 'node');
const legacyServicePath = (home) => `${path.join(home, '.local', 'bin')}:${path.dirname(legacyNode(home))}:/usr/local/bin:/usr/bin:/bin`;
const seedLegacyNode = async (home) => {
  await mkdir(path.dirname(legacyNode(home)), { recursive: true });
  await writeFile(legacyNode(home), '#!/bin/sh\nexit 0\n');
  await chmod(legacyNode(home), 0o700);
};
const legacyDaemon = (home) => `[Unit]
Description=Mi daemon (task/socket worker supervisor)
After=network-online.target

[Service]
Type=simple
WorkingDirectory=${miRoot}
ExecStart=${legacyNode(home)} ${path.join(home, '.pi', 'agent', 'extensions', 'mi-daemon.mjs')}
Restart=on-failure
RestartSec=5
Environment=MI_SOCKET_PATH=${legacyRuntimeDir(home)}/main.sock
Environment=MI_RUNTIME_DIR=${legacyRuntimeDir(home)}
Environment=MI_ROOT=${miRoot}
Environment=PATH=${legacyServicePath(home)}
PrivateTmp=true
ProtectSystem=full

[Install]
WantedBy=default.target
`;
const expectedLegacyDaemon = (home) => `[Unit]
Description=Mi daemon (task/socket worker supervisor)
After=network-online.target

[Service]
Type=simple
WorkingDirectory=${miRoot}
ExecStart=${legacyNode(home)} ${path.join(home, '.pi', 'agent', 'extensions', 'mi-daemon.mjs')}
Restart=on-failure
RestartSec=5
Environment=MI_SOCKET_PATH=${home}/.pi/agent/mi/main.sock
Environment=MI_RUNTIME_DIR=${home}/.pi/agent/mi
Environment=MI_ROOT=${miRoot}
Environment=PATH=${home}/.local/bin:${path.dirname(legacyNode(home))}:/usr/local/bin:/usr/bin:/bin
PrivateTmp=true
ProtectSystem=full

[Install]
WantedBy=default.target
`;

try {
  const home = path.join(temp, 'home');
  const unitDir = path.join(home, '.config', 'systemd', 'user');
  await mkdir(path.join(home, 'workflows'), { recursive: true });
  await mkdir(path.join(home, '.pi', 'agent', 'mi'), { recursive: true });
  await mkdir(path.join(home, 'mi'), { recursive: true });
  await seedLegacyNode(home);
  const bin = path.join(temp, 'bin');
  const calls = path.join(temp, 'systemctl-calls');
  await mkdir(bin);
  await writeFile(path.join(bin, 'systemctl'), `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(calls)}\n`);
  await chmod(path.join(bin, 'systemctl'), 0o700);
  await writeFile(calls, '');

  // Sol reproduction: cleanup is armed before the one temporary transaction
  // root exists. An injected failure immediately after that creation leaves
  // neither that root nor a partial unit tree behind.
  const firstTempScratch = path.join(temp, 'first-temp-scratch');
  await mkdir(firstTempScratch);
  let result = run(home, { TMPDIR: firstTempScratch, MI_USER_UNITS_FAIL_AFTER_TEMP: '1' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /injected failure after transaction temporary directory creation/);
  assert.deepEqual(await readdir(firstTempScratch), [], 'failed first temporary step leaves no mi-user-units residue');
  assert.equal(spawnSync('test', ['-e', path.join(home, '.config')]).status, 1, 'failed first temporary step does not create units');

  // Existing path components that link outside the chosen service home fail
  // before rendering, backup, target writes, or any systemctl operation.
  const makeServiceHome = async (name) => {
    const isolated = path.join(temp, name);
    await mkdir(path.join(isolated, 'workflows'), { recursive: true });
    await mkdir(path.join(isolated, '.pi', 'agent', 'mi'), { recursive: true });
    await mkdir(path.join(isolated, 'mi'), { recursive: true });
    return isolated;
  };
  const runLinkedPathCase = async (name, prepare, extra = {}) => {
    const isolated = await makeServiceHome(`linked-${name}`);
    const outside = path.join(temp, `outside-${name}`);
    await mkdir(outside);
    await writeFile(path.join(outside, 'marker'), `${name} outside marker\n`);
    await prepare(isolated, outside);
    const beforeCalls = await file(calls);
    const linked = run(isolated, { PATH: `${bin}:${process.env.PATH}`, ...extra });
    assert.notEqual(linked.status, 0, `${name} link fails closed`);
    assert.match(linked.stderr, /symlink component/);
    assert.deepEqual(await readdir(outside), ['marker'], `${name} link receives no outside writes`);
    assert.equal(spawnSync('test', ['-e', path.join(isolated, '.config', 'systemd', 'user', 'mi-daemon.service')]).status, 1, `${name} link leaves units unchanged`);
    assert.equal(await file(calls), beforeCalls, `${name} link makes no systemctl call`);
  };
  await runLinkedPathCase('config', async (isolated, outside) => {
    await symlink(outside, path.join(isolated, '.config'));
  });
  await runLinkedPathCase('systemd', async (isolated, outside) => {
    await mkdir(path.join(isolated, '.config'));
    await symlink(outside, path.join(isolated, '.config', 'systemd'));
  });
  await runLinkedPathCase('workflows', async (isolated, outside) => {
    await rm(path.join(isolated, 'workflows'), { recursive: true });
    await symlink(outside, path.join(isolated, 'workflows'));
  });
  await runLinkedPathCase('runtime', async (isolated, outside) => {
    await rm(path.join(isolated, '.pi', 'agent', 'mi'), { recursive: true });
    await symlink(outside, path.join(isolated, '.pi', 'agent', 'mi'));
  });
  const linkedRoot = path.join(temp, 'linked-mi-root');
  const linkedRootOutside = path.join(temp, 'outside-mi-root');
  await mkdir(path.join(linkedRoot, 'pi', 'extensions'), { recursive: true });
  await mkdir(linkedRootOutside);
  await writeFile(path.join(linkedRootOutside, 'marker'), 'mi root outside marker\n');
  await copyFile(path.join(repo, 'pi', 'extensions', 'mi-daemon.mjs'), path.join(linkedRoot, 'pi', 'extensions', 'mi-daemon.mjs'));
  await symlink(linkedRootOutside, path.join(linkedRoot, 'state'));
  const rootHome = await makeServiceHome('linked-mi-root-home');
  const rootCalls = await file(calls);
  result = run(rootHome, { PATH: `${bin}:${process.env.PATH}`, MI_APP_DIR: linkedRoot });
  assert.notEqual(result.status, 0, 'Mi-root state link fails closed');
  assert.match(result.stderr, /symlink component/);
  assert.deepEqual(await readdir(linkedRootOutside), ['marker'], 'Mi-root link receives no outside writes');
  assert.equal(spawnSync('test', ['-e', path.join(rootHome, '.config', 'systemd', 'user', 'mi-daemon.service')]).status, 1, 'Mi-root link leaves units unchanged');
  assert.equal(await file(calls), rootCalls, 'Mi-root link makes no systemctl call');

  // The file installer has no systemctl side effects, even with old activation
  // switches set. Activation is a later documented operator operation.
  result = run(home, { PATH: `${bin}:${process.env.PATH}`, MI_USER_UNITS_ACTIVATE_DAEMON: '1', MI_USER_UNITS_ACTIVATE_TIMER: '1' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal((await file(calls).catch(() => '')).trim(), '');
  const daemon = await file(path.join(unitDir, 'mi-daemon.service'));
  const tick = await file(path.join(unitDir, 'mi-tick.service'));
  assert.match(daemon, /PrivateTmp=true/);
  assert.match(daemon, /ProtectSystem=full/);
  assert.match(daemon, /ProtectHome=read-only/);
  assert.match(daemon, /ReadWritePaths=.*\.pi\/agent\/mi/);
  assert.doesNotMatch(daemon, /ReadWritePaths=.*\.pi\/agent(?:\s|$)/);
  assert.match(daemon, new RegExp(`Environment=MI_WORKFLOWS_DIR=${path.join(home, 'workflows').replace(/[./]/g, '\\$&')}`));
  assert.match(daemon, new RegExp(`Environment=PATH=${path.dirname(node).replace(/[./]/g, '\\$&')}`));
  assert.doesNotMatch(daemon, /Environment=PATH=.*root/);
  assert.match(tick, /MI_PROACTIVE_IMESSAGE_NOTIFY=false/);
  assert.match(tick, /MI_IMESSAGE_MONITOR_ENABLED=false/);

  // Every unsafe systemd/PATH character is rejected before temporary or target
  // mutation. A normal absolute path remains accepted.
  const rejected = ['$', '%', ':', '\n', '\r', '\t', ' ', '"', "'", '\\', ';', '|', '*', '?', '[', ']'];
  for (const character of rejected) {
    const isolated = path.join(temp, `unsafe-${Buffer.from(character).toString('hex') || 'empty'}`);
    await mkdir(path.join(isolated, 'workflows'), { recursive: true });
    await mkdir(path.join(isolated, '.pi', 'agent', 'mi'), { recursive: true });
    await mkdir(path.join(isolated, 'mi'), { recursive: true });
    const scratch = path.join(isolated, 'scratch');
    await mkdir(scratch);
    result = run(isolated, { MI_WORKFLOWS_DIR: `${isolated}/workflows${character}bad`, TMPDIR: scratch });
    assert.notEqual(result.status, 0, `reject ${JSON.stringify(character)}`);
    assert.match(result.stderr, /unsafe path/);
    assert.deepEqual(await readdir(scratch), [], `no temporary state for ${JSON.stringify(character)}`);
    assert.equal(spawnSync('test', ['-e', path.join(isolated, '.config', 'systemd', 'user')]).status, 1);
  }

  // The exact reviewed legacy daemon and resource-limit drop-in are migrated
  // without activation. The auto-load path is accepted only as this complete
  // known bundle; an absent drop-in directory fails before mutation.
  const legacyPath = path.join(unitDir, 'mi-daemon.service');
  const legacyDropin = path.join(unitDir, 'mi-daemon.service.d');
  // Keep this fixture independently pinned to the observed legacy bytes.
  assert.equal(legacyDaemon(home), expectedLegacyDaemon(home), 'accepted legacy fixture exactly matches the observed unit');
  assert.match(legacyDaemon(home), new RegExp(`Environment=MI_RUNTIME_DIR=${legacyRuntimeDir(home).replace(/[./]/g, '\\$&')}`));
  assert.match(legacyDaemon(home), new RegExp(`ExecStart=${legacyNode(home).replace(/[./]/g, '\\$&')} `));
  assert.match(legacyDaemon(home), new RegExp(`Environment=PATH=${path.join(home, '.local', 'bin').replace(/[./]/g, '\\$&')}:${path.dirname(legacyNode(home)).replace(/[./]/g, '\\$&')}:`));
  await writeFile(legacyPath, legacyDaemon(home));
  const beforeMissingDropin = await readFile(legacyPath);
  result = run(home);
  assert.notEqual(result.status, 0, 'missing legacy drop-in directory is rejected');
  assert.deepEqual(await readFile(legacyPath), beforeMissingDropin, 'missing drop-in rejection preserves legacy unit bytes');
  await rm(legacyDropin, { recursive: true, force: true });
  await mkdir(legacyDropin, { recursive: true });
  await chmod(legacyDropin, 0o755);
  await writeFile(path.join(legacyDropin, 'resource-limits.conf'), '[Service]\nMemoryMax=600M\nMemoryHigh=450M\nCPUQuota=75%\nEnvironment=NODE_OPTIONS=--max-old-space-size=384\nOOMPolicy=stop\n');
  await chmod(path.join(legacyDropin, 'resource-limits.conf'), 0o644);
  const callsBeforeLegacyMigration = await file(calls);
  result = run(home);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await file(calls), callsBeforeLegacyMigration, 'legacy migration does not start or reload units');
  assert.match(await file(legacyPath), /Description=Mi background task daemon/);
  assert.doesNotMatch(await file(legacyPath), /\.pi\/agent\/extensions/);
  result = run(home);
  assert.equal(result.status, 0, `safe hardened rerun succeeds: ${result.stderr}`);

  for (const changedLegacy of [
    legacyDaemon(home).replace('task/socket worker supervisor', 'changed daemon'),
    legacyDaemon(home).replace('extensions/mi-daemon.mjs', 'extensions/other-daemon.mjs'),
    legacyDaemon(home).replace(legacyNode(home), '/usr/bin/node'),
    legacyDaemon(home).replace(legacyNode(home), path.join(home, '.nvm', 'versions', 'node', 'v22.0.0', 'bin', 'node')),
    legacyDaemon(home).replace('Restart=on-failure', 'ExecStartPre=/bin/true\nRestart=on-failure'),
    legacyDaemon(home).replace('Environment=PATH=', 'Environment=HOME=${home}\nEnvironment=PATH='),
    legacyDaemon(home)
      .replace(`Environment=MI_SOCKET_PATH=${legacyRuntimeDir(home)}/main.sock`, `Environment=MI_SOCKET_PATH=/run/user/${process.getuid()}/mi/main.sock`)
      .replace(`Environment=MI_RUNTIME_DIR=${legacyRuntimeDir(home)}`, `Environment=MI_RUNTIME_DIR=/run/user/${process.getuid()}/mi`),
    legacyDaemon(home).replace(`Environment=PATH=${legacyServicePath(home)}`, `Environment=PATH=${path.dirname(legacyNode(home))}:${path.join(home, '.local', 'bin')}:/usr/local/bin:/usr/bin:/bin`),
    legacyDaemon(home).replace('PrivateTmp=true\n', ''),
    legacyDaemon(home).replace('ProtectSystem=full', 'ProtectSystem=false'),
    `${legacyDaemon(home)}\n`,
  ]) {
    await writeFile(legacyPath, changedLegacy);
    const beforeRejectedLegacy = await file(legacyPath);
    result = run(home);
    assert.notEqual(result.status, 0, 'near-miss legacy unit is rejected');
    assert.equal(await file(legacyPath), beforeRejectedLegacy, 'rejected legacy unit stays byte-for-byte unchanged');
  }

  await writeFile(legacyPath, Buffer.concat([Buffer.from(legacyDaemon(home)), Buffer.from([0])]));
  const nulLegacy = await readFile(legacyPath);
  result = run(home);
  assert.notEqual(result.status, 0, 'NUL bytes cannot be recognized as a legacy unit');
  assert.deepEqual(await readFile(legacyPath), nulLegacy, 'NUL legacy unit stays byte-for-byte unchanged');

  // Every legacy daemon drop-in must match the reviewed whole bundle. Unknown,
  // extra, altered, and linked entries all fail before any target mutation.
  for (const [name, prepare] of [
    ['empty', async () => {}],
    ['unknown', async () => { await writeFile(path.join(legacyDropin, 'operator.conf'), '[Service]\nEnvironment=KEEP=1\n'); }],
    ['extra', async () => { await writeFile(path.join(legacyDropin, 'resource-limits.conf'), '[Service]\nMemoryMax=600M\nMemoryHigh=450M\nCPUQuota=75%\nEnvironment=NODE_OPTIONS=--max-old-space-size=384\nOOMPolicy=stop\n'); await writeFile(path.join(legacyDropin, '20-extra.conf'), '[Service]\n'); }],
    ['altered', async () => { await writeFile(path.join(legacyDropin, 'resource-limits.conf'), '[Service]\nMemoryMax=601M\nMemoryHigh=450M\nCPUQuota=75%\nEnvironment=NODE_OPTIONS=--max-old-space-size=384\nOOMPolicy=stop\n'); }],
    ['mode', async () => { await writeFile(path.join(legacyDropin, 'resource-limits.conf'), '[Service]\nMemoryMax=600M\nMemoryHigh=450M\nCPUQuota=75%\nEnvironment=NODE_OPTIONS=--max-old-space-size=384\nOOMPolicy=stop\n'); await chmod(path.join(legacyDropin, 'resource-limits.conf'), 0o600); }],
  ]) {
    await rm(legacyDropin, { recursive: true, force: true });
    await mkdir(legacyDropin, { recursive: true });
    await prepare();
    await writeFile(legacyPath, legacyDaemon(home));
    const beforeRejectedBundle = await readFile(legacyPath);
    result = run(home);
    assert.notEqual(result.status, 0, `${name} legacy drop-in bundle is rejected`);
    assert.deepEqual(await readFile(legacyPath), beforeRejectedBundle, `${name} rejection preserves legacy unit bytes`);
  }
  const linkedDropinTarget = path.join(temp, 'linked-dropin-target');
  await mkdir(linkedDropinTarget);
  await rm(legacyDropin, { recursive: true, force: true });
  await symlink(linkedDropinTarget, legacyDropin);
  await writeFile(legacyPath, legacyDaemon(home));
  result = run(home);
  assert.notEqual(result.status, 0, 'symlinked legacy drop-in directory is rejected');
  assert.deepEqual(await readdir(linkedDropinTarget), [], 'linked drop-in target receives no mutation');
  await rm(legacyDropin, { force: true });
  await mkdir(legacyDropin, { recursive: true });
  const linkedDropinFileTarget = path.join(temp, 'linked-dropin-file-target');
  await writeFile(linkedDropinFileTarget, '[Service]\n');
  await symlink(linkedDropinFileTarget, path.join(legacyDropin, 'linked.conf'));
  await writeFile(legacyPath, legacyDaemon(home));
  result = run(home);
  assert.notEqual(result.status, 0, 'symlinked legacy drop-in file is rejected');
  await rm(legacyDropin, { recursive: true, force: true });
  await mkdir(legacyDropin, { recursive: true });
  await writeFile(path.join(legacyDropin, 'resource-limits.conf'), '[Service]\nMemoryMax=600M\nMemoryHigh=450M\nCPUQuota=75%\nEnvironment=NODE_OPTIONS=--max-old-space-size=384\nOOMPolicy=stop\n');
  await chmod(legacyDropin, 0o777);
  await writeFile(legacyPath, legacyDaemon(home));
  result = run(home);
  assert.notEqual(result.status, 0, 'unsafe legacy drop-in mode is rejected');
  await chmod(legacyDropin, 0o755);
  await rm(legacyDropin, { recursive: true, force: true });

  // A unit that points into Pi's automatic extension folder is never silently
  // replaced, even when it has Mi's current description.
  await writeFile(legacyPath, '[Unit]\nDescription=Mi background task daemon\n[Service]\nExecStart=/home/user/.pi/agent/extensions/mi-daemon.mjs\n');
  result = run(home);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /contaminated Pi auto-load unit/);

  // Sol reproduction: old units plus invalid timer values must stay byte-for-
  // byte unchanged. Validation is before backup/temp/target mutation.
  await writeFile(path.join(unitDir, 'mi-daemon.service'), '[Unit]\nDescription=Mi background task daemon\nold daemon\n');
  await writeFile(path.join(unitDir, 'mi-tick.service'), '[Unit]\nDescription=Mi scheduled tick\nold tick\n');
  await writeFile(path.join(unitDir, 'mi-tick.timer'), '[Unit]\nDescription=Run Mi scheduled tick\nold timer\n');
  const old = await Promise.all(['mi-daemon.service', 'mi-tick.service', 'mi-tick.timer'].map((name) => file(path.join(unitDir, name))));
  result = run(home, { MI_PROACTIVE_IMESSAGE_NOTIFY: 'not-a-boolean' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must be a boolean/);
  assert.deepEqual(await Promise.all(['mi-daemon.service', 'mi-tick.service', 'mi-tick.timer'].map((name) => file(path.join(unitDir, name)))), old);

  // An explicit failing command after the first replacement restores files,
  // including the exact legacy daemon, present drop-ins, and leaves no
  // installer temporary folders. Repeating the same rollback is safe.
  await writeFile(legacyPath, legacyDaemon(home));
  const dropin = path.join(unitDir, 'mi-daemon.service.d');
  await mkdir(dropin, { recursive: true });
  await chmod(dropin, 0o755);
  await writeFile(path.join(dropin, 'resource-limits.conf'), '[Service]\nMemoryMax=600M\nMemoryHigh=450M\nCPUQuota=75%\nEnvironment=NODE_OPTIONS=--max-old-space-size=384\nOOMPolicy=stop\n');
  await chmod(path.join(dropin, 'resource-limits.conf'), 0o644);
  const failingBin = path.join(temp, 'failing-bin');
  const mvCount = path.join(temp, 'mv-count');
  const rollbackTmp = path.join(temp, 'rollback-tmp');
  await mkdir(failingBin);
  await mkdir(rollbackTmp);
  await writeFile(path.join(failingBin, 'mv'), `#!/bin/sh\nn=0; [ -f ${JSON.stringify(mvCount)} ] && n=$(cat ${JSON.stringify(mvCount)})\nn=$((n + 1)); echo "$n" > ${JSON.stringify(mvCount)}\n[ "$n" -eq 5 ] && exit 91\nexec /bin/mv "$@"\n`);
  await chmod(path.join(failingBin, 'mv'), 0o700);
  const beforeFailure = await Promise.all(['mi-daemon.service', 'mi-tick.service', 'mi-tick.timer'].map((name) => readFile(path.join(unitDir, name))));
  const beforeFailureDropin = await readFile(path.join(dropin, 'resource-limits.conf'));
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await rm(mvCount, { force: true });
    result = run(home, { PATH: `${failingBin}:${process.env.PATH}`, TMPDIR: rollbackTmp });
    assert.notEqual(result.status, 0);
    assert.deepEqual(await Promise.all(['mi-daemon.service', 'mi-tick.service', 'mi-tick.timer'].map((name) => readFile(path.join(unitDir, name)))), beforeFailure, 'rollback restores every legacy unit byte-for-byte');
    assert.deepEqual(await readdir(dropin), ['resource-limits.conf'], 'rollback restores the complete legacy drop-in directory');
    assert.deepEqual(await readFile(path.join(dropin, 'resource-limits.conf')), beforeFailureDropin, 'rollback restores legacy drop-in bytes');
    assert.equal((await stat(dropin)).mode & 0o777, 0o755, 'rollback restores legacy drop-in directory mode');
    assert.equal((await stat(path.join(dropin, 'resource-limits.conf'))).mode & 0o777, 0o644, 'rollback restores legacy drop-in file mode');
  }
  assert.deepEqual(await readdir(rollbackTmp), [], 'rollback removes temporary folders');

  // A signal during a partial write uses the same EXIT transaction and removes
  // a previously absent unit directory rather than leaving a half-install.
  const signalHome = path.join(temp, 'signal-home');
  await mkdir(path.join(signalHome, 'workflows'), { recursive: true });
  await mkdir(path.join(signalHome, '.pi', 'agent', 'mi'), { recursive: true });
  await mkdir(path.join(signalHome, 'mi'), { recursive: true });
  const signalBin = path.join(temp, 'signal-bin');
  await mkdir(signalBin);
  await writeFile(path.join(signalBin, 'mv'), '#!/bin/sh\nkill -TERM "$PPID"\nexit 99\n');
  await chmod(path.join(signalBin, 'mv'), 0o700);
  result = run(signalHome, { PATH: `${signalBin}:${process.env.PATH}` });
  assert.notEqual(result.status, 0);
  assert.equal(spawnSync('test', ['-e', path.join(signalHome, '.config', 'systemd', 'user')]).status, 1, 'signal rollback removes absent unit directory');
  assert.equal(spawnSync('test', ['-e', path.join(signalHome, '.config')]).status, 1, 'signal rollback removes absent parent directories');

  console.log('Mi user-unit installer checks passed.');
} finally {
  await rm(temp, { recursive: true, force: true });
}
