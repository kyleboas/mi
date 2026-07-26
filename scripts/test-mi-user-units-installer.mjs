#!/usr/bin/env node
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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

try {
  const home = path.join(temp, 'home');
  const unitDir = path.join(home, '.config', 'systemd', 'user');
  await mkdir(home, { recursive: true });
  const bin = path.join(temp, 'bin');
  const calls = path.join(temp, 'systemctl-calls');
  await mkdir(bin);
  await writeFile(path.join(bin, 'systemctl'), `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(calls)}\n`);
  await chmod(path.join(bin, 'systemctl'), 0o700);

  // A plain install reloads metadata only. It never enables or starts work.
  let result = run(home, { PATH: `${bin}:${process.env.PATH}` });
  assert.equal(result.status, 0, result.stderr);
  assert.equal((await readFile(calls, 'utf8')).trim(), '--user daemon-reload');
  const daemon = await readFile(path.join(unitDir, 'mi-daemon.service'), 'utf8');
  const tick = await readFile(path.join(unitDir, 'mi-tick.service'), 'utf8');
  assert.match(daemon, /PrivateTmp=true/);
  assert.match(daemon, /ProtectSystem=full/);
  assert.match(daemon, /ProtectHome=read-only/);
  assert.match(daemon, new RegExp(`Environment=PATH=${path.dirname(node).replace(/[./]/g, '\\$&')}`));
  assert.doesNotMatch(daemon, /Environment=PATH=.*root/);
  assert.match(tick, /MI_PROACTIVE_IMESSAGE_NOTIFY=false/);
  assert.match(tick, /MI_IMESSAGE_MONITOR_ENABLED=false/);

  // Timer activation is intentionally blocked until both outbound safety
  // choices are supplied by the operator, not inherited as defaults.
  result = run(home, { PATH: `${bin}:${process.env.PATH}`, MI_USER_UNITS_ACTIVATE_TIMER: '1' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /timer activation requires explicit notice and monitor values/);

  // Unsafe systemd paths fail before the installer makes its target directory.
  const unsafeHome = path.join(temp, 'unsafe home');
  result = run(unsafeHome);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unsafe path/);
  assert.equal(spawnSync('test', ['-e', path.join(unsafeHome, '.config', 'systemd', 'user')]).status, 1);

  // A unit that points into Pi's automatic extension folder is never silently
  // replaced, even when it has Mi's old description.
  await writeFile(path.join(unitDir, 'mi-daemon.service'), '[Unit]\nDescription=Mi background task daemon\n[Service]\nExecStart=/home/user/.pi/agent/extensions/mi-daemon.mjs\n');
  result = run(home, { MI_USER_UNITS_NO_SYSTEMD: '1' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /contaminated Pi auto-load unit/);

  // Restore safe old files, then fail the second atomic replacement. The
  // first replacement and all existing drop-ins must return exactly to before.
  await writeFile(path.join(unitDir, 'mi-daemon.service'), '[Unit]\nDescription=Mi background task daemon\nold daemon\n');
  await writeFile(path.join(unitDir, 'mi-tick.service'), '[Unit]\nDescription=Mi scheduled tick\nold tick\n');
  await writeFile(path.join(unitDir, 'mi-tick.timer'), '[Unit]\nDescription=Run Mi scheduled tick\nold timer\n');
  const dropin = path.join(unitDir, 'mi-daemon.service.d');
  await mkdir(dropin, { recursive: true });
  await writeFile(path.join(dropin, 'operator.conf'), '[Service]\nEnvironment=KEEP=1\n');
  const failingBin = path.join(temp, 'failing-bin');
  const mvCount = path.join(temp, 'mv-count');
  await mkdir(failingBin);
  await writeFile(path.join(failingBin, 'mv'), `#!/bin/sh\nn=0; [ -f ${JSON.stringify(mvCount)} ] && n=$(cat ${JSON.stringify(mvCount)})\nn=$((n + 1)); echo "$n" > ${JSON.stringify(mvCount)}\n[ "$n" -eq 2 ] && exit 91\nexec /bin/mv "$@"\n`);
  await chmod(path.join(failingBin, 'mv'), 0o700);
  result = run(home, { PATH: `${failingBin}:${process.env.PATH}`, MI_USER_UNITS_NO_SYSTEMD: '1' });
  assert.notEqual(result.status, 0);
  assert.equal(await readFile(path.join(unitDir, 'mi-daemon.service'), 'utf8'), '[Unit]\nDescription=Mi background task daemon\nold daemon\n');
  assert.equal(await readFile(path.join(unitDir, 'mi-tick.service'), 'utf8'), '[Unit]\nDescription=Mi scheduled tick\nold tick\n');
  assert.match(await readFile(path.join(dropin, 'operator.conf'), 'utf8'), /KEEP=1/);

  console.log('Mi user-unit installer checks passed.');
} finally {
  await rm(temp, { recursive: true, force: true });
}
