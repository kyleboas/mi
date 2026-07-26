#!/usr/bin/env node
// Exact-byte regression for the one-time live migration of Mi's private user
// units. It reproduces the complete installer predicate against owner-only
// temporary copies of the real bundle - the daemon base and its resource-limit
// drop-in, plus the tick service, tick timer, and their two staged drop-ins -
// and never reads, writes, activates, or otherwise touches the live unit tree.
import assert from 'node:assert/strict';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const repo = path.resolve(import.meta.dirname, '..');
const home = '/home/kyle';
const root = '/home/kyle/assistant';
const node = '/home/kyle/.nvm/versions/node/v24.15.0/bin/node';
const mi = '/home/kyle/.nvm/versions/node/v24.15.0/bin/mi';
const liveUnitDir = path.join(home, '.config', 'systemd', 'user');

const daemonBytes = `[Unit]
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
const daemonDropinBytes = `[Service]
MemoryMax=600M
MemoryHigh=450M
CPUQuota=75%
Environment=NODE_OPTIONS=--max-old-space-size=384
OOMPolicy=stop
`;
// The legacy tick base still runs the old NVM `mi tick` with the proactive
// iMessage notice on and a one-minute timer. The two reviewed drop-ins are the
// only reason the live tick is safe today: they force the v2 path, turn both
// notice switches off, and stretch the interval to five minutes. The hardened
// replacement base carries those switches itself, which is what makes the
// drop-ins obsolete rather than merely redundant.
const tickServiceBytes = `[Unit]
Description=Mi scheduled tick (reminders, configured monitor health, daily brief)

[Service]
Type=oneshot
ExecStart=/home/kyle/.nvm/versions/node/v24.15.0/bin/mi tick
WorkingDirectory=/home/kyle/assistant
Environment=HOME=/home/kyle
Environment=MI_PROACTIVE_IMESSAGE_NOTIFY=true
Environment=MI_PHOTON_NOTIFY_PORT=8788
Nice=5
IOSchedulingClass=best-effort
IOSchedulingPriority=6
`;
const tickTimerBytes = `[Unit]
Description=Run Mi scheduled tick

[Timer]
OnCalendar=*:0/1
AccuracySec=30s
Persistent=true

[Install]
WantedBy=timers.target
`;
const tickServiceDropinBytes = `[Service]
Environment=MI_IMESSAGE_V2=1
Environment=MI_PROACTIVE_IMESSAGE_NOTIFY=false
Environment=MI_IMESSAGE_MONITOR_ENABLED=false
`;
const tickTimerDropinBytes = `[Timer]
OnCalendar=
OnCalendar=*:0/5
`;

const sha256 = (value) => spawnSync('sha256sum', { input: value, encoding: 'utf8' }).stdout.split(' ')[0];
const sha256Path = (target) => spawnSync('sha256sum', ['--', target], { encoding: 'utf8' }).stdout.split(' ')[0];

// Every accepted member, with the exact live mode the installer pins and the
// live path the fixture is taken from. Keeping the hashes here as literals
// makes the fixtures pinned rather than generated: a fixture rendered from the
// current environment would drift with the caller and could not detect the
// content change that this migration exists to accept.
const members = [
  { key: 'daemon', unit: 'mi-daemon.service', bytes: daemonBytes, mode: 0o644, sha: '40d4ac150ab908f1935b954ac30624b678f7ca67e7fd1464287cbb33064fb375' },
  { key: 'daemonDropin', unit: 'mi-daemon.service.d/resource-limits.conf', bytes: daemonDropinBytes, mode: 0o644, dirMode: 0o755, sha: 'aaed2d6c33eda381c1c950aad6baf566ccdd28304525333be0f5598c09eed7bc' },
  { key: 'tickService', unit: 'mi-tick.service', bytes: tickServiceBytes, mode: 0o644, sha: '84bc7112f6eca73c81e392e0f7716107f2e6d240524825fab8db105e5366e464' },
  { key: 'tickTimer', unit: 'mi-tick.timer', bytes: tickTimerBytes, mode: 0o644, sha: '34931c182422d14de7fe5526a8e8e621e7b990ba1fe4d622f2e18f5af2674723' },
  { key: 'tickServiceDropin', unit: 'mi-tick.service.d/90-mi-staged-activation.conf', bytes: tickServiceDropinBytes, mode: 0o600, dirMode: 0o700, sha: 'b77c29ea99903d3e27ec9ab21a1328c5182a21bfb4163d9861a184346713a8dd' },
  { key: 'tickTimerDropin', unit: 'mi-tick.timer.d/50-interval.conf', bytes: tickTimerDropinBytes, mode: 0o644, dirMode: 0o755, sha: 'fb4a14fe38ed9b1bec2974409c421286296cd549031112805848603aa33bec15' },
];
for (const member of members) assert.equal(sha256(member.bytes), member.sha, `${member.key} fixture matches the pinned hash`);
const dropinDirs = ['mi-daemon.service.d', 'mi-tick.service.d', 'mi-tick.timer.d'];

const scratch = await mkdtemp(path.join(home, '.mi-live-legacy-test.'));
const unitDir = path.join(scratch, 'systemd', 'user');
const at = (unit) => path.join(unitDir, unit);
const byKey = Object.fromEntries(members.map((member) => [member.key, { ...member, path: at(member.unit) }]));
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

// Seed from the actual live file whenever it is still the reviewed byte
// sequence, so this regression is a copy of the real installed bundle rather
// than a lookalike. Once the migration has been applied the live path no
// longer matches, and the pinned literal keeps the case running unchanged.
const sources = {};
const seed = async () => {
  await rm(unitDir, { recursive: true, force: true });
  await mkdir(unitDir, { recursive: true });
  for (const directory of dropinDirs) await mkdir(at(directory));
  for (const member of members) {
    const live = path.join(liveUnitDir, member.unit);
    if (sha256Path(live) === member.sha) {
      await copyFile(live, at(member.unit));
      sources[member.key] = 'live';
    } else {
      await writeFile(at(member.unit), member.bytes);
      sources[member.key] = 'pinned';
    }
    await chmod(at(member.unit), member.mode);
    if (member.dirMode) await chmod(path.dirname(at(member.unit)), member.dirMode);
  }
  for (const member of members) {
    assert.equal(sha256Path(at(member.unit)), member.sha, `${member.key} copy is the reviewed byte sequence`);
    assert.equal((await lstat(at(member.unit))).mode & 0o777, member.mode, `${member.key} copy has the reviewed mode`);
  }
};
const assertBundleUnchanged = async (message, { modes = true } = {}) => {
  for (const member of members) {
    assert.equal(await readFile(at(member.unit), 'utf8'), member.bytes, `${message}: ${member.key} bytes`);
    if (!modes) continue;
    assert.equal((await lstat(at(member.unit))).mode & 0o777, member.mode, `${message}: ${member.key} mode`);
    if (member.dirMode) {
      assert.equal((await lstat(path.dirname(at(member.unit)))).mode & 0o777, member.dirMode, `${message}: ${member.key} directory mode`);
    }
  }
};
// Every rejection must leave the whole accepted bundle byte-for-byte intact
// and must not reach a single systemctl call. Cases that deliberately alter a
// mode or a member's shape still assert the bytes of every other member.
const reject = async (name, prepare, { extra = {}, intact = 'full' } = {}) => {
  await seed();
  await prepare();
  const beforeCalls = await readFile(calls, 'utf8');
  const result = run(extra);
  assert.notEqual(result.status, 0, `${name} must fail`);
  assert.equal(await readFile(calls, 'utf8'), beforeCalls, `${name} makes no systemctl call`);
  if (intact !== false) await assertBundleUnchanged(name, { modes: intact === 'full' });
  return result;
};
const rejectMember = async (name, key, prepare, options) => {
  const result = await reject(name, () => prepare(byKey[key].path), { ...options, intact: false });
  for (const member of members) {
    if (member.key === key) continue;
    assert.equal(await readFile(at(member.unit), 'utf8'), member.bytes, `${name}: ${member.key} stays unchanged`);
  }
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

  // The complete live copy migrates in one run, on the actual canonical paths.
  await seed();
  let result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /without activating them/);
  assert.equal(await readFile(calls, 'utf8'), '', 'exact migration is files-only');
  assert.match(await readFile(byKey.daemon.path, 'utf8'), /Description=Mi background task daemon/);
  const migratedTick = await readFile(byKey.tickService.path, 'utf8');
  assert.match(migratedTick, /Environment=MI_PROACTIVE_IMESSAGE_NOTIFY=false/);
  assert.match(migratedTick, /Environment=MI_IMESSAGE_MONITOR_ENABLED=false/);
  assert.match(migratedTick, /ExecStart=\/home\/kyle\/\.nvm\/versions\/node\/v24\.15\.0\/bin\/mi tick/);
  assert.match(migratedTick, /NoNewPrivileges=true/);
  assert.doesNotMatch(migratedTick, /MI_PROACTIVE_IMESSAGE_NOTIFY=true/);
  for (const directory of dropinDirs) {
    assert.deepEqual(await readdir(at(directory)), [], `${directory} obsolete drop-ins are removed`);
    assert.equal((await lstat(at(directory))).mode & 0o777, 0o700, `${directory} is republished owner-only`);
  }
  for (const unit of ['mi-daemon.service', 'mi-tick.service', 'mi-tick.timer']) {
    assert.equal((await lstat(at(unit))).mode & 0o777, 0o600, `${unit} is published owner-only`);
  }

  // Re-running over the published bundle is accepted and stays files-only.
  const published = await Promise.all(['mi-daemon.service', 'mi-tick.service', 'mi-tick.timer'].map((unit) => readFile(at(unit), 'utf8')));
  result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(await Promise.all(['mi-daemon.service', 'mi-tick.service', 'mi-tick.timer'].map((unit) => readFile(at(unit), 'utf8'))), published, 're-run is idempotent');
  assert.equal(await readFile(calls, 'utf8'), '');

  // A published bundle only stays acceptable while its drop-in directories are
  // empty and owner-only. Anything reintroduced there fails closed.
  for (const [name, directory, prepare] of [
    ['republished daemon drop-in', 'mi-daemon.service.d', async (target) => writeFile(path.join(target, 'extra.conf'), '[Service]\n')],
    ['republished tick service drop-in', 'mi-tick.service.d', async (target) => writeFile(path.join(target, 'extra.conf'), '[Service]\n')],
    ['republished tick timer drop-in', 'mi-tick.timer.d', async (target) => writeFile(path.join(target, 'extra.conf'), '[Timer]\n')],
    ['loosened tick service drop-in directory', 'mi-tick.service.d', async (target) => chmod(target, 0o755)],
    ['loosened tick timer drop-in directory', 'mi-tick.timer.d', async (target) => chmod(target, 0o755)],
  ]) {
    await prepare(at(directory));
    result = run();
    assert.notEqual(result.status, 0, `${name} is rejected`);
    assert.match(result.stderr, /hardened .*drop-in directory/);
    await rm(at(directory), { recursive: true, force: true });
    await mkdir(at(directory), { mode: 0o700 });
    await chmod(at(directory), 0o700);
  }

  // Near-miss content: one byte anywhere in any of the six reviewed members.
  for (const [name, key, mutate] of [
    ['daemon base', 'daemon', (bytes) => bytes.replace('Mi daemon', 'Xi daemon')],
    ['daemon drop-in', 'daemonDropin', (bytes) => bytes.replace('600M', '601M')],
    ['tick service base', 'tickService', (bytes) => bytes.replace('daily brief', 'daily briefs')],
    ['tick service base switch', 'tickService', (bytes) => bytes.replace('MI_PROACTIVE_IMESSAGE_NOTIFY=true', 'MI_PROACTIVE_IMESSAGE_NOTIFY=false')],
    ['tick timer base', 'tickTimer', (bytes) => bytes.replace('*:0/1', '*:0/2')],
    ['tick service drop-in', 'tickServiceDropin', (bytes) => bytes.replace('MI_IMESSAGE_V2=1', 'MI_IMESSAGE_V2=2')],
    ['tick timer drop-in', 'tickTimerDropin', (bytes) => bytes.replace('*:0/5', '*:0/6')],
    ['tick service trailing newline', 'tickService', (bytes) => `${bytes}\n`],
    ['tick timer drop-in trailing newline', 'tickTimerDropin', (bytes) => `${bytes}\n`],
  ]) {
    await rejectMember(`one-byte ${name} change`, key, (target) => writeFile(target, mutate(byKey[key].bytes)));
  }
  await rejectMember('NUL-suffixed tick service base', 'tickService', (target) => writeFile(target, Buffer.concat([Buffer.from(tickServiceBytes), Buffer.from([0])])));

  // Near-miss modes: each member's mode is pinned exactly, and a mode that is
  // group or other writable is refused before the bytes are consulted at all.
  for (const [name, key, mode, pattern] of [
    ['daemon base', 'daemon', 0o600, /legacy daemon unit has an unexpected mode/],
    ['tick service base', 'tickService', 0o600, /legacy tick service has an unexpected mode/],
    ['tick timer base', 'tickTimer', 0o600, /legacy tick timer has an unexpected mode/],
    ['tick service drop-in file', 'tickServiceDropin', 0o644, /legacy tick service drop-in file has an unexpected mode/],
    ['tick timer drop-in file', 'tickTimerDropin', 0o600, /legacy tick timer drop-in file has an unexpected mode/],
    ['daemon drop-in file', 'daemonDropin', 0o600, /legacy daemon drop-in file has an unexpected mode/],
  ]) {
    result = await reject(`pinned ${name} mode`, () => chmod(byKey[key].path, mode), { intact: 'bytes' });
    assert.match(result.stderr, pattern, `pinned ${name} mode names the member`);
  }
  for (const key of ['daemon', 'daemonDropin', 'tickService', 'tickTimer', 'tickServiceDropin', 'tickTimerDropin']) {
    result = await reject(`unsafe ${key} mode`, () => chmod(byKey[key].path, 0o666), { intact: 'bytes' });
    assert.match(result.stderr, /writable by group or other/, `unsafe ${key} mode is refused`);
  }
  for (const [name, directory, mode] of [
    ['daemon drop-in directory', 'mi-daemon.service.d', 0o700],
    ['tick service drop-in directory', 'mi-tick.service.d', 0o755],
    ['tick timer drop-in directory', 'mi-tick.timer.d', 0o700],
  ]) {
    result = await reject(`pinned ${name} mode`, () => chmod(at(directory), mode), { intact: 'bytes' });
    assert.match(result.stderr, /drop-in directory has an unexpected mode/, `pinned ${name} mode is refused`);
    result = await reject(`unsafe ${name} mode`, () => chmod(at(directory), 0o777), { intact: 'bytes' });
    assert.match(result.stderr, /writable by group or other/, `unsafe ${name} mode is refused`);
  }

  // Near-miss bundle shape: extra, renamed, missing, and wrongly typed members.
  for (const [name, directory, filename, dirMode] of [
    ['daemon', 'mi-daemon.service.d', 'resource-limits.conf', 0o755],
    ['tick service', 'mi-tick.service.d', '90-mi-staged-activation.conf', 0o700],
    ['tick timer', 'mi-tick.timer.d', '50-interval.conf', 0o755],
  ]) {
    result = await reject(`extra ${name} drop-in`, () => writeFile(path.join(at(directory), '99-extra.conf'), '[Service]\n'), { intact: 'bytes' });
    assert.match(result.stderr, /refusing unknown legacy .*drop-in bundle/);
    result = await reject(`renamed ${name} drop-in`, async () => {
      const member = members.find((entry) => entry.unit === `${directory}/${filename}`);
      await writeFile(path.join(at(directory), 'renamed.conf'), member.bytes);
      await rm(at(member.unit));
    }, { intact: false });
    assert.match(result.stderr, /refusing unknown legacy .*drop-in bundle/);
    result = await reject(`missing ${name} drop-in directory`, () => rm(at(directory), { recursive: true }), { intact: false });
    assert.match(result.stderr, /is not a real directory|refusing/);
    result = await reject(`empty ${name} drop-in directory`, async () => {
      await rm(at(directory), { recursive: true });
      await mkdir(at(directory));
      await chmod(at(directory), dirMode);
    }, { intact: false });
    assert.match(result.stderr, /refusing unknown legacy .*drop-in bundle/);
  }
  await rejectMember('directory in place of the tick service drop-in file', 'tickServiceDropin', async (target) => {
    await rm(target);
    await mkdir(target);
  });
  await rejectMember('directory in place of the tick timer base', 'tickTimer', async (target) => {
    await rm(target);
    await mkdir(target);
  });

  // Links are never followed, for any member or drop-in directory.
  const linkTarget = path.join(scratch, 'link-target-file');
  const linkTargetDir = path.join(scratch, 'link-target-dir');
  await mkdir(linkTargetDir, { recursive: true });
  for (const key of ['daemon', 'tickService', 'tickTimer', 'tickServiceDropin', 'tickTimerDropin']) {
    await writeFile(linkTarget, byKey[key].bytes);
    result = await reject(`linked ${key}`, async () => {
      await rm(byKey[key].path);
      await symlink(linkTarget, byKey[key].path);
    }, { intact: false });
    assert.match(result.stderr, /symlink component|is not a regular file/, `linked ${key} is refused`);
    assert.equal(await readFile(linkTarget, 'utf8'), byKey[key].bytes, `linked ${key} target receives no write`);
  }
  for (const directory of dropinDirs) {
    result = await reject(`linked ${directory}`, async () => {
      await rm(at(directory), { recursive: true });
      await symlink(linkTargetDir, at(directory));
    }, { intact: false });
    assert.match(result.stderr, /symlink component/);
    assert.deepEqual(await readdir(linkTargetDir), [], `linked ${directory} target receives no write`);
  }

  // An unsafe owner on any member fails closed, simulated per member because
  // this suite must never create a file owned by another account.
  const statBin = path.join(scratch, 'stat-bin');
  await mkdir(statBin);
  for (const member of members) {
    await writeFile(path.join(statBin, 'stat'), `#!/bin/sh
last=''
for arg do last="$arg"; done
if [ "$1" = -c ] && [ "$2" = %u ] && [ "$last" = ${JSON.stringify(at(member.unit))} ]; then echo 999; exit 0; fi
exec /usr/bin/stat "$@"
`, { mode: 0o700 });
    await chmod(path.join(statBin, 'stat'), 0o700);
    result = await reject(`unsafe ${member.key} owner`, async () => {}, { extra: { PATH: `${statBin}:${baseEnv.PATH}` } });
    assert.match(result.stderr, /unsafe owner/, `unsafe ${member.key} owner is refused`);
  }

  // Unrelated units beside the bundle are never silently replaced.
  result = await reject('contaminated unrelated unit', async () => {
    const unrelated = at('mi-signal-bridge.service');
    await writeFile(unrelated, '[Service]\nExecStart=/home/kyle/.pi/agent/extensions/not-mi.mjs\n');
    await chmod(unrelated, 0o644);
    await writeFile(byKey.tickService.path, `${tickServiceBytes}Environment=EXTRA=1\n`);
  }, { intact: false });
  assert.match(result.stderr, /altered or unrelated unit/);

  // The first-return preflight used to hide every blocker behind the first
  // one, so an operator learned about them a failed run at a time. Independent
  // rejections must now be reported together, in one run.
  result = await reject('two independent blockers', async () => {
    await writeFile(byKey.daemon.path, daemonBytes.replace('Mi daemon', 'Xi daemon'));
    await writeFile(byKey.tickService.path, tickServiceBytes.replace('daily brief', 'nightly brief'));
  }, { intact: false });
  assert.match(result.stderr, /blocker: refusing contaminated Pi auto-load unit/);
  assert.match(result.stderr, /blocker: refusing to replace altered or unrelated unit: .*mi-tick\.service/);
  // The reviewed timer base happens to be byte-identical to its replacement,
  // so once the tick bundle is refused the timer is judged on its own and its
  // still-legacy drop-in directory is a third, independent blocker.
  assert.match(result.stderr, /blocker: hardened tick timer drop-in directory has an unexpected mode/);
  assert.match(result.stderr, /3 preflight blocker\(s\); no unit was changed/);

  // The reviewed bytes only authorize migration in the reviewed account, under
  // the reviewed UID, Node, and Mi runtime. An exact copy elsewhere is refused.
  const altHome = path.join(scratch, 'alt-home');
  const altRoot = path.join(scratch, 'alt-root');
  const altConfig = path.join(altHome, '.config');
  const altUnitDir = path.join(altConfig, 'systemd', 'user');
  await mkdir(path.join(altHome, 'workflows'), { recursive: true });
  await mkdir(path.join(altHome, '.pi', 'agent', 'mi'), { recursive: true });
  await mkdir(path.join(altHome, 'mi'), { recursive: true });
  await mkdir(path.join(altRoot, 'pi', 'extensions'), { recursive: true });
  await mkdir(path.join(altRoot, 'state'), { recursive: true });
  await copyFile(path.join(repo, 'pi', 'extensions', 'mi-daemon.mjs'), path.join(altRoot, 'pi', 'extensions', 'mi-daemon.mjs'));
  await mkdir(altUnitDir, { recursive: true });
  for (const directory of dropinDirs) await mkdir(path.join(altUnitDir, directory));
  for (const member of members) {
    await writeFile(path.join(altUnitDir, member.unit), member.bytes);
    await chmod(path.join(altUnitDir, member.unit), member.mode);
    if (member.dirMode) await chmod(path.dirname(path.join(altUnitDir, member.unit)), member.dirMode);
  }
  const beforeAltCalls = await readFile(calls, 'utf8');
  result = run({ HOME: altHome, XDG_CONFIG_HOME: altConfig, MI_APP_DIR: altRoot });
  assert.notEqual(result.status, 0, 'exact reviewed bytes in another account are refused');
  assert.match(result.stderr, /contaminated Pi auto-load unit/);
  assert.match(result.stderr, /altered or unrelated unit: .*mi-tick\.service/);
  assert.equal(await readFile(calls, 'utf8'), beforeAltCalls, 'the refused account makes no systemctl call');
  for (const member of members) {
    assert.equal(await readFile(path.join(altUnitDir, member.unit), 'utf8'), member.bytes, `${member.key} is untouched in the refused account`);
  }

  // A failure after publication starts restores the exact accepted bundle -
  // every member's bytes, every file and directory mode - and activates
  // nothing. The injected failure walks each `mv` the publication performs.
  const failingBin = path.join(scratch, 'failing-bin');
  const mvCount = path.join(scratch, 'mv-count');
  await mkdir(failingBin);
  for (const failAt of [1, 2, 3, 4, 5, 6]) {
    await seed();
    await rm(mvCount, { force: true });
    await writeFile(path.join(failingBin, 'mv'), `#!/bin/sh
n=0
[ -f ${JSON.stringify(mvCount)} ] && n=$(/bin/cat ${JSON.stringify(mvCount)})
n=$((n + 1))
printf '%s\\n' "$n" > ${JSON.stringify(mvCount)}
[ "$n" -eq ${failAt} ] && exit 91
exec /bin/mv "$@"
`, { mode: 0o700 });
    await chmod(path.join(failingBin, 'mv'), 0o700);
    result = run({ PATH: `${failingBin}:${baseEnv.PATH}` });
    assert.notEqual(result.status, 0, `injected mv failure ${failAt} fails the run`);
    await assertBundleUnchanged(`rollback at mv ${failAt}`);
    assert.equal(await readFile(calls, 'utf8'), '', `rollback at mv ${failAt} activates nothing`);
  }

  // A signal during publication uses the same transaction and rolls back.
  await seed();
  const signalBin = path.join(scratch, 'signal-bin');
  await mkdir(signalBin);
  await writeFile(path.join(signalBin, 'mv'), '#!/bin/sh\nkill -TERM "$PPID"\nexit 99\n', { mode: 0o700 });
  await chmod(path.join(signalBin, 'mv'), 0o700);
  result = run({ PATH: `${signalBin}:${baseEnv.PATH}` });
  assert.notEqual(result.status, 0, 'a signal during publication fails the run');
  await assertBundleUnchanged('signal rollback');
  assert.equal(await readFile(calls, 'utf8'), '', 'signal rollback activates nothing');

  // Nothing in this suite may reach the live unit tree.
  assert.equal((await stat(liveUnitDir)).uid, process.getuid(), 'the live unit tree is still the running account\'s');
  console.log(`Exact live legacy bundle migration checks passed (${Object.entries(sources).map(([key, source]) => `${key}:${source}`).join(' ')}).`);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
