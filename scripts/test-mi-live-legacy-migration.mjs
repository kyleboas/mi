#!/usr/bin/env node
import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const repo = path.resolve(import.meta.dirname, '..');
const home = '/home/kyle';
const root = '/home/kyle/assistant';
const node = '/home/kyle/.nvm/versions/node/v24.15.0/bin/node';
const mi = '/home/kyle/.nvm/versions/node/v24.15.0/bin/mi';
const unitBytes = `[Unit]
Description=Mi daemon (task/socket worker supervisor)
After=network-online.target

[Service]
Type=simple
WorkingDirectory=/home/kyle/assistant
ExecStart=/home/kyle/.nvm/versions/node/v24.15.0/bin/node /home/kyle/.pi/agent/extensions/mi-daemon.mjs
Restart=on-failure
RestartSec=5
Environment=MI_SOCKET_PATH=/home/kyle/.pi/agent/mi/main.sock
Environment=MI_RUNTIME_DIR=/home/kyle/.pi/agent/mi
Environment=MI_ROOT=/home/kyle/assistant
Environment=PATH=/home/kyle/.local/bin:/home/kyle/.nvm/versions/node/v24.15.0/bin:/usr/local/bin:/usr/bin:/bin
PrivateTmp=true
ProtectSystem=full

[Install]
WantedBy=default.target
`;
const dropinBytes = `[Service]
MemoryMax=600M
MemoryHigh=450M
CPUQuota=75%
Environment=NODE_OPTIONS=--max-old-space-size=384
OOMPolicy=stop
`;
const sha256 = (value) => spawnSync('sha256sum', { input: value, encoding: 'utf8' }).stdout.split(' ')[0];
assert.equal(sha256(unitBytes), '40d4ac150ab908f1935b954ac30624b678f7ca67e7fd1464287cbb33064fb375');
assert.equal(sha256(dropinBytes), 'aaed2d6c33eda381c1c950aad6baf566ccdd28304525333be0f5598c09eed7bc');

const scratch = await mkdtemp(path.join(home, '.mi-live-legacy-test.'));
const unitDir = path.join(scratch, 'systemd', 'user');
const unit = path.join(unitDir, 'mi-daemon.service');
const dropinDir = path.join(unitDir, 'mi-daemon.service.d');
const dropin = path.join(dropinDir, 'resource-limits.conf');
const calls = path.join(scratch, 'systemctl-calls');
const bin = path.join(scratch, 'bin');
const baseEnv = {
  HOME: home,
  XDG_CONFIG_HOME: scratch,
  MI_APP_DIR: root,
  MI_NODE_BIN: node,
  MI_BIN: mi,
  MI_USER_UNITS_SKIP_SYSTEMD_VERIFY: '1',
  PATH: `${bin}:/usr/local/bin:/usr/bin:/bin`,
};
const run = (extra = {}) => spawnSync('bash', ['scripts/install-mi-user-units.sh'], {
  cwd: repo, env: { ...baseEnv, ...extra }, encoding: 'utf8',
});
const seed = async () => {
  await rm(unitDir, { recursive: true, force: true });
  await mkdir(dropinDir, { recursive: true, mode: 0o755 });
  await chmod(dropinDir, 0o755);
  await writeFile(unit, unitBytes, { mode: 0o644 });
  await chmod(unit, 0o644);
  await writeFile(dropin, dropinBytes, { mode: 0o644 });
  await chmod(dropin, 0o644);
};
const assertLegacyUnchanged = async (message) => {
  assert.equal(await readFile(unit, 'utf8'), unitBytes, `${message}: base bytes`);
  assert.equal(await readFile(dropin, 'utf8'), dropinBytes, `${message}: drop-in bytes`);
};
const reject = async (name, prepare, extra = {}) => {
  await seed();
  await prepare();
  const beforeCalls = await readFile(calls, 'utf8');
  const result = run(extra);
  assert.notEqual(result.status, 0, `${name} must fail`);
  assert.equal(await readFile(calls, 'utf8'), beforeCalls, `${name} makes no systemctl call`);
  return result;
};

try {
  for (const required of [root, node, mi, path.join(home, 'workflows'), path.join(home, '.pi', 'agent', 'mi'), path.join(home, 'mi')]) {
    assert.equal(spawnSync('test', ['-e', required]).status, 0, `missing canonical test prerequisite: ${required}`);
  }
  await mkdir(bin);
  await writeFile(calls, '');
  await writeFile(path.join(bin, 'systemctl'), `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(calls)}\n`, { mode: 0o700 });
  await chmod(path.join(bin, 'systemctl'), 0o700);

  await seed();
  let result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /without activating them/);
  assert.equal(await readFile(calls, 'utf8'), '', 'exact migration is files-only');
  assert.match(await readFile(unit, 'utf8'), /Description=Mi background task daemon/);
  assert.deepEqual(await readdir(dropinDir), [], 'the complete legacy drop-in directory is replaced');
  assert.equal((await lstat(dropinDir)).mode & 0o777, 0o700);

  await reject('one-byte base change', async () => writeFile(unit, unitBytes.replace('Mi daemon', 'Xi daemon')));
  await reject('one-byte drop-in change', async () => writeFile(dropin, dropinBytes.replace('600M', '601M')));
  await reject('extra drop-in', async () => writeFile(path.join(dropinDir, 'extra.conf'), '[Service]\n'));
  await reject('unsafe base mode', async () => chmod(unit, 0o666));
  await reject('unsafe drop-in mode', async () => chmod(dropin, 0o666));
  await reject('unsafe drop-in type', async () => { await rm(dropin); await mkdir(dropin); });

  const linkedUnit = path.join(scratch, 'linked-unit');
  await writeFile(linkedUnit, unitBytes);
  result = await reject('linked base', async () => { await rm(unit); await symlink(linkedUnit, unit); });
  assert.match(result.stderr, /symlink component/);
  const linkedDropins = path.join(scratch, 'linked-dropins');
  await mkdir(linkedDropins);
  result = await reject('linked drop-in directory', async () => { await rm(dropinDir, { recursive: true }); await symlink(linkedDropins, dropinDir); });
  assert.match(result.stderr, /symlink component/);

  const statBin = path.join(scratch, 'stat-bin');
  await mkdir(statBin);
  await writeFile(path.join(statBin, 'stat'), `#!/bin/sh
last=''
for arg do last="$arg"; done
if [ "$1" = -c ] && [ "$2" = %u ] && [ "$last" = ${JSON.stringify(unit)} ]; then echo 999; exit 0; fi
exec /usr/bin/stat "$@"
`, { mode: 0o700 });
  await chmod(path.join(statBin, 'stat'), 0o700);
  result = await reject('unsafe owner simulation', async () => {}, { PATH: `${statBin}:${baseEnv.PATH}` });
  assert.match(result.stderr, /unsafe owner/);

  result = await reject('contaminated unrelated unit', async () => {
    const unrelated = path.join(unitDir, 'mi-tick.service');
    await writeFile(unrelated, '[Service]\nExecStart=/home/kyle/.pi/agent/extensions/not-mi.mjs\n');
    await chmod(unrelated, 0o644);
  });
  assert.match(result.stderr, /altered or unrelated unit/);
  await assertLegacyUnchanged('unrelated-unit rejection');

  // A failure after publication starts restores the exact accepted bundle,
  // including directory and file modes, and does not activate anything.
  await seed();
  const failingBin = path.join(scratch, 'failing-bin');
  const mvCount = path.join(scratch, 'mv-count');
  await mkdir(failingBin);
  await writeFile(path.join(failingBin, 'mv'), `#!/bin/sh
n=0
[ -f ${JSON.stringify(mvCount)} ] && n=$(/bin/cat ${JSON.stringify(mvCount)})
n=$((n + 1))
printf '%s\\n' "$n" > ${JSON.stringify(mvCount)}
[ "$n" -eq 2 ] && exit 91
exec /bin/mv "$@"
`, { mode: 0o700 });
  await chmod(path.join(failingBin, 'mv'), 0o700);
  result = run({ PATH: `${failingBin}:${baseEnv.PATH}` });
  assert.notEqual(result.status, 0);
  await assertLegacyUnchanged('rollback');
  assert.equal((await lstat(unit)).mode & 0o777, 0o644);
  assert.equal((await lstat(dropinDir)).mode & 0o777, 0o755);
  assert.equal((await lstat(dropin)).mode & 0o777, 0o644);
  assert.equal(await readFile(calls, 'utf8'), '');

  console.log('Exact live legacy bundle migration checks passed.');
} finally {
  await rm(scratch, { recursive: true, force: true });
}
