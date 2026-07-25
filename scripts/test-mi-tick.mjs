import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const cli = await readFile(new URL('../src/cli.ts', import.meta.url), 'utf8');
const tick = await readFile(new URL('../src/tick.ts', import.meta.url), 'utf8');
const crons = await readFile(new URL('../src/crons.ts', import.meta.url), 'utf8');
const installer = await readFile(new URL('../scripts/install-mi-tick-systemd.sh', import.meta.url), 'utf8');
const deployScript = await readFile(new URL('../scripts/deploy-mi.sh', import.meta.url), 'utf8');

assert.match(cli, /if \(command === 'tick'\) return tickCommand\(\);/, 'CLI exposes mi tick as the single scheduled entrypoint');
assert.match(tick, /tickReminderCrons\(\)/, 'mi tick runs written reminder and prompt crons');
assert.match(tick, /runImessageMonitor\(\)/, 'mi tick runs the iMessage bridge monitor');
assert.match(tick, /runDreamConsolidation\(\)/, 'mi tick runs bounded memory upkeep');
assert.match(tick, /runCapabilityGrantGc\(\)/, 'mi tick cleans expired worker capability grants');
assert.doesNotMatch(tick, /chief-of-staff|proactive|runMiCheck|loopDiscovery|loopFactory|opportunity|projectQuestion|weeklyReview|verification_required/, 'mi tick does not run the removed nag and inference stack');
assert.match(tick, /open\(lockPath, 'wx', 0o600\)/, 'mi tick uses an exclusive lock file');
assert.match(crons, /MI_TICK_NOTIFICATION_LIMIT \|\| 10/, 'scheduled notification delivery has a fixed default limit');
assert.match(crons, /options\.remindersOnly && cron\.command/, 'scheduled ticking skips legacy command crons');
assert.match(installer, /ExecStart=\$\{MI_BIN\} tick/, 'systemd installer uses mi tick');
assert.match(installer, /enable-linger/, 'systemd installer enables user lingering for scheduled user timer reliability');
assert.match(deployScript, /git diff --quiet[\s\S]*git status --short/, 'deploy script refuses dirty trees and shows status');
assert.match(deployScript, /npm test[\s\S]*install -m 600 pi\/extensions\/mi\.ts[\s\S]*install -m 700 pi\/extensions\/mi-daemon\.mjs/, 'deploy script runs tests before copying extension files');

const root = await mkdtemp(join(tmpdir(), 'mi-tick-'));
try {
  await mkdir(join(root, 'mi', 'state'), { recursive: true });
  const capabilityDir = join(root, '.pi', 'agent', 'mi', 'capabilities');
  await mkdir(capabilityDir, { recursive: true });
  await writeFile(join(capabilityDir, 'expired.json'), JSON.stringify({ grants: [{ expiresAt: new Date(Date.now() - 1000).toISOString() }] }));
  await writeFile(join(capabilityDir, 'fresh.json'), JSON.stringify({ grants: [{ expiresAt: new Date(Date.now() + 60_000).toISOString() }] }));
  await writeFile(join(root, 'mi', 'state', 'crons.json'), JSON.stringify([
    { name: 'first-reminder', enabled: true, at: new Date(Date.now() - 1000).toISOString(), message: 'First reminder' },
    { name: 'second-reminder', enabled: true, at: new Date(Date.now() - 1000).toISOString(), message: 'Second reminder' },
    { name: 'legacy-command', enabled: true, at: new Date(Date.now() - 1000).toISOString(), command: 'node --version' }
  ], null, 2));
  const runner = join(root, 'run-tick.mjs');
  await writeFile(runner, `
    import { runMiTick } from ${JSON.stringify(new URL('../src/tick.ts', import.meta.url).href)};
    const first = await runMiTick();
    const second = await runMiTick();
    console.log(JSON.stringify({ first, second }));
  `);
  const tsx = new URL('../node_modules/.bin/tsx', import.meta.url).pathname;
  const result = spawnSync(process.execPath, [tsx, runner], {
    cwd: root,
    env: {
      ...process.env,
      HOME: root,
      MI_ROOT: join(root, 'assistant'),
      MI_TASK_STATE_DIR: join(root, 'mi', 'state'),
      MI_TICK_NOTIFICATION_LIMIT: '1',
      MI_DREAM_ENABLED: 'false',
      MI_IMESSAGE_MONITOR_ENABLED: 'false',
      MI_PROACTIVE_IMESSAGE_NOTIFY: 'false',
      MI_PUSHOVER_NOTIFY: 'false',
      PUSHOVER_USER: '',
      PUSHOVER_TOKEN: ''
    },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const { first, second } = JSON.parse(result.stdout.trim());
  assert.deepEqual(first.reminders.map((item) => item.status), ['ok', 'skipped', 'skipped'], 'tick sends at most one due notification and skips command crons');
  assert.deepEqual(second.reminders.map((item) => item.status), ['ok', 'skipped'], 'the next tick sends the next written reminder without running command crons');
  assert.equal(first.memory.status, 'skipped', 'memory upkeep can be disabled for a fixture');
  assert.equal(first.imessageMonitor.status, 'skipped', 'iMessage monitor can be disabled for a fixture');
  assert.equal(first.capabilityGrantGc.deleted, 1, 'tick deletes expired capability grants');
  assert.equal(first.capabilityGrantGc.kept, 1, 'tick keeps fresh capability grants');
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log('Mi tick checks passed.');
