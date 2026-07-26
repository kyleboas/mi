#!/usr/bin/env node
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const repo = path.resolve(import.meta.dirname, '..');
const node = process.execPath;
const temp = await mkdtemp(path.join(os.tmpdir(), 'mi-user-units-'));
const run = (home, extra = {}) => spawnSync('bash', ['scripts/install-mi-user-units.sh'], {
  cwd: repo,
  env: {
    ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), MI_APP_DIR: repo,
    MI_NODE_BIN: node, MI_BIN: node, MI_USER_UNITS_SKIP_SYSTEMD_VERIFY: '1', ...extra,
  },
  encoding: 'utf8',
});
const file = async (name) => readFile(name, 'utf8');

try {
  const home = path.join(temp, 'home');
  const unitDir = path.join(home, '.config', 'systemd', 'user');
  await mkdir(path.join(home, 'workflows'), { recursive: true });
  await mkdir(path.join(home, '.pi', 'agent', 'mi'), { recursive: true });
  await mkdir(path.join(home, 'mi'), { recursive: true });
  const bin = path.join(temp, 'bin');
  const calls = path.join(temp, 'systemctl-calls');
  await mkdir(bin);
  await writeFile(path.join(bin, 'systemctl'), `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(calls)}\n`);
  await chmod(path.join(bin, 'systemctl'), 0o700);

  // The file installer has no systemctl side effects, even with old activation
  // switches set. Activation is a later documented operator operation.
  let result = run(home, { PATH: `${bin}:${process.env.PATH}`, MI_USER_UNITS_ACTIVATE_DAEMON: '1', MI_USER_UNITS_ACTIVATE_TIMER: '1' });
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

  // A unit that points into Pi's automatic extension folder is never silently
  // replaced, even when it has Mi's old description.
  await writeFile(path.join(unitDir, 'mi-daemon.service'), '[Unit]\nDescription=Mi background task daemon\n[Service]\nExecStart=/home/user/.pi/agent/extensions/mi-daemon.mjs\n');
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
  // present drop-ins, and leaves no installer temporary folders. Repeating the
  // same rollback is safe.
  const dropin = path.join(unitDir, 'mi-daemon.service.d');
  await mkdir(dropin, { recursive: true });
  await writeFile(path.join(dropin, 'operator.conf'), '[Service]\nEnvironment=KEEP=1\n');
  const failingBin = path.join(temp, 'failing-bin');
  const mvCount = path.join(temp, 'mv-count');
  const rollbackTmp = path.join(temp, 'rollback-tmp');
  await mkdir(failingBin);
  await mkdir(rollbackTmp);
  await writeFile(path.join(failingBin, 'mv'), `#!/bin/sh\nn=0; [ -f ${JSON.stringify(mvCount)} ] && n=$(cat ${JSON.stringify(mvCount)})\nn=$((n + 1)); echo "$n" > ${JSON.stringify(mvCount)}\n[ "$n" -eq 2 ] && exit 91\nexec /bin/mv "$@"\n`);
  await chmod(path.join(failingBin, 'mv'), 0o700);
  const beforeFailure = await Promise.all(['mi-daemon.service', 'mi-tick.service', 'mi-tick.timer', 'mi-daemon.service.d/operator.conf'].map((name) => file(path.join(unitDir, name))));
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await rm(mvCount, { force: true });
    result = run(home, { PATH: `${failingBin}:${process.env.PATH}`, TMPDIR: rollbackTmp });
    assert.notEqual(result.status, 0);
    assert.deepEqual(await Promise.all(['mi-daemon.service', 'mi-tick.service', 'mi-tick.timer', 'mi-daemon.service.d/operator.conf'].map((name) => file(path.join(unitDir, name)))), beforeFailure);
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
