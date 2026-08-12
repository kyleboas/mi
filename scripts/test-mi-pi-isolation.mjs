#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { miDaemonPath } from '../dist/src/mi-runtime-paths.js';
import { miCoordinatorLaunch } from './mi-imessage-coordinator.mjs';
import { reviewedMiExtensionPaths } from '../pi/extensions/mi-reviewed-paths.mjs';

const repo = path.resolve(import.meta.dirname, '..');
const temp = await mkdtemp(path.join(tmpdir(), 'mi-pi-isolation-'));
const home = path.join(temp, 'home');
const config = path.join(home, 'config');
const autoLoad = path.join(home, '.pi', 'agent', 'extensions');
const projectAutoLoad = path.join(temp, 'ordinary-project', '.pi', 'extensions');
const unitDir = path.join(config, 'systemd', 'user');

try {
  assert.equal(
    miDaemonPath({ MI_ROOT: '/reviewed/mi' }, '/ordinary-home'),
    '/reviewed/mi/pi/extensions/mi-daemon.mjs',
    'the default daemon path stays under MI_ROOT',
  );
  assert.equal(
    miDaemonPath({ MI_ROOT: '/reviewed/mi', MI_DAEMON_PATH: '/chosen/daemon.mjs' }, '/ordinary-home'),
    '/chosen/daemon.mjs',
    'MI_DAEMON_PATH remains an explicit override',
  );

  await mkdir(autoLoad, { recursive: true });
  await mkdir(projectAutoLoad, { recursive: true });
  await mkdir(path.join(home, 'workflows'), { recursive: true });
  await mkdir(path.join(home, '.pi', 'agent', 'mi'), { recursive: true });
  await mkdir(path.join(home, 'mi'), { recursive: true });
  const privateRoot = path.join(temp, 'private-mi');
  const privateExtensions = path.join(privateRoot, 'pi', 'extensions');
  await mkdir(privateExtensions, { recursive: true });
  for (const file of ['mi-daemon.mjs', 'mi-capability-guard.ts', 'mi-orchestrator-adapter.ts', 'mi-diver-notes.ts']) await writeFile(path.join(privateExtensions, file), 'export {};\n');
  const reviewed = reviewedMiExtensionPaths({ root: privateRoot, requireDaemon: true, requireGuard: true, requireAdapter: true, requireDiverNotes: true });
  assert.equal(reviewed.daemonPath, path.join(privateExtensions, 'mi-daemon.mjs'));
  const outsideDaemon = path.join(temp, 'outside.mjs');
  await writeFile(outsideDaemon, 'export {};\n');
  await assert.rejects(async () => reviewedMiExtensionPaths({ root: privateRoot, daemonPath: outsideDaemon, requireDaemon: true }), /reviewed file/);
  await rm(path.join(privateExtensions, 'mi-capability-guard.ts'));
  await assert.rejects(async () => reviewedMiExtensionPaths({ root: privateRoot, requireGuard: true }), /unavailable/);
  await writeFile(path.join(temp, 'guard-target.ts'), 'export {};\n');
  await (await import('node:fs/promises')).symlink(path.join(temp, 'guard-target.ts'), path.join(privateExtensions, 'mi-capability-guard.ts'));
  await assert.rejects(async () => reviewedMiExtensionPaths({ root: privateRoot, requireGuard: true }), /symlink/);
  await rm(path.join(privateExtensions, 'mi-capability-guard.ts'));
  await writeFile(path.join(privateExtensions, 'mi-capability-guard.ts'), 'export {};\n');
  await writeFile(path.join(autoLoad, 'ordinary-pi-extension.ts'), 'export default function () {}\n');
  await writeFile(path.join(projectAutoLoad, 'ordinary-project-extension.ts'), 'export default function () {}\n');
  const install = spawnSync('bash', ['scripts/install-mi-user-units.sh'], {
    cwd: repo,
    env: {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: config,
      MI_APP_DIR: repo,
      MI_NODE_BIN: process.execPath,
      MI_BIN: process.execPath,
      MI_USER_UNITS_NO_SYSTEMD: '1',
    },
    encoding: 'utf8',
  });
  assert.equal(install.status, 0, install.stderr);
  assert.deepEqual(
    await readdir(autoLoad),
    ['ordinary-pi-extension.ts'],
    'the portable installer leaves Pi global auto-load files alone',
  );
  assert.deepEqual(
    await readdir(projectAutoLoad),
    ['ordinary-project-extension.ts'],
    'the portable installer leaves project Pi auto-load files alone',
  );
  const daemonUnit = await readFile(path.join(unitDir, 'mi-daemon.service'), 'utf8');
  assert.match(daemonUnit, new RegExp(`ExecStart=${process.execPath.replace(/[./]/g, '\\$&')} ${path.join(repo, 'pi/extensions/mi-daemon.mjs').replace(/[./]/g, '\\$&')}`), 'the daemon unit uses the reviewed explicit source path');
  assert.doesNotMatch(daemonUnit, /\.pi\/agent\/extensions/, 'the daemon unit cannot launch from Pi auto-load extensions');

  const guide = await readFile(path.join(repo, 'docs/second-vps-setup.md'), 'utf8');
  const commands = [...guide.matchAll(/```(?:bash|sh)?\n([\s\S]*?)```/g)].map((match) => match[1]).join('\n');
  assert.doesNotMatch(commands, /(?:install|cp)\s+[^\n]*(?:mi\.ts|mi-daemon\.mjs|mi-capability-guard\.ts|mi-orchestrator-adapter\.ts)[^\n]*(?:\.pi\/agent\/extensions|\.pi\/extensions)/, 'setup commands cannot place Mi execution files in Pi auto-load folders');
  assert.match(commands, /MI_ROOT="\$MI_ROOT" pi --extension "\$MI_ROOT\/pi\/extensions\/mi\.ts"/, 'the optional Mi TUI uses an explicit reviewed path');

  const guard = path.join(repo, 'pi/extensions/mi-capability-guard.ts');
  const adapter = path.join(repo, 'pi/extensions/mi-orchestrator-adapter.ts');
  const diverNotes = path.join(repo, 'pi/extensions/mi-diver-notes.ts');
  const sessionPath = path.join(temp, 'state', 'imessage', 'conversations', 'imessage-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'session.jsonl');
  const coordinator = miCoordinatorLaunch({ piCommand: 'pi', cwd: repo, sessionPath, model: 'test', capabilityGuardPath: guard, capabilityAdapterPath: adapter, diverNotesPath: diverNotes });
  assert.ok(coordinator.args.includes('--no-extensions'), 'the coordinator disables ambient extensions');
  assert.ok(coordinator.args.includes('--session') && coordinator.args.includes(sessionPath), 'the coordinator uses one durable session path');
  assert.ok(!coordinator.args.includes('--session-dir') && !coordinator.args.includes('--no-session'), 'the coordinator has no session fallback');
  assert.deepEqual(coordinator.args.filter((entry) => entry === '--extension'), ['--extension', '--extension', '--extension'], 'the coordinator adds exactly three reviewed extensions');
  assert.deepEqual(coordinator.args.slice(-6), ['--extension', guard, '--extension', adapter, '--extension', diverNotes], 'the coordinator loads only the reviewed private extensions');

  const daemonSource = await readFile(path.join(repo, 'pi/extensions/mi-daemon.mjs'), 'utf8');
  assert.doesNotMatch(daemonSource, /"--no-extensions"/, 'Mi background workers allow normal Pi extension discovery');
  assert.doesNotMatch(daemonSource, /"--tools", tools/, 'Mi background workers do not filter extension tools with a global allowlist');
  assert.match(daemonSource, /"--extension", MI_CAPABILITY_GUARD/, 'Mi background workers retain the capability guard');

  const packageJson = JSON.parse(await readFile(path.join(repo, 'package.json'), 'utf8'));
  const packageText = JSON.stringify(packageJson);
  assert.doesNotMatch(packageText, /\.pi\/agent\/extensions\/mi(?:\.ts|-daemon\.mjs|-capability-guard\.ts|-orchestrator-adapter\.ts)/, 'package settings cannot globally auto-load Mi');

  console.log('Mi Pi isolation checks passed.');
} finally {
  await rm(temp, { recursive: true, force: true });
}
