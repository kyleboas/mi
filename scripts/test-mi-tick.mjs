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
assert.match(tick, /tickReminderCrons\(\)/, 'mi tick runs reminder-only crons');
assert.match(tick, /runMiCheck\(\{ checkIds: \['health-check'\] \}\)/, 'mi tick runs configured monitor health');
assert.match(tick, /runImessageMonitor\(\)/, 'mi tick runs the iMessage bridge monitor');
assert.match(tick, /runCapabilityGrantGc\(\)/, 'mi tick garbage-collects expired capability grant files');
assert.match(tick, /lastDailyBriefDate/, 'mi tick guards the daily brief to once per local day');
assert.match(tick, /questionsToday[\s\S]*lastQuestionAt[\s\S]*nextQuestionAfter/, 'mi tick tracks dynamic project question cadence');
assert.match(tick, /normalizeQuestionSchedule[\s\S]*stableUnit[\s\S]*dynamicProjectQuestionDue/, 'mi tick uses deterministic dynamic question scheduling instead of fixed slots');
assert.match(tick, /runMiCheck\(\{ checkIds: \['question'\] \}\)/, 'mi tick can run the dynamic question check when due');
assert.match(tick, /loopDiscoveryDue\(\)[\s\S]*runLoopDiscovery\(\{ mode: 'scheduled', notify: true \}\)/, 'mi tick runs weekly loop discovery when due');
assert.match(tick, /runLoopFactoryTick\(\)/, 'mi tick runs Loop Factory for capture digest and build-ready checks');
assert.match(tick, /generateProjectsStatus\(\)/, 'mi tick regenerates the derived project status file');
assert.match(tick, /weeklyReviewDue[\s\S]*renderWeeklyReview/, 'mi tick can render the weekly review when due');
assert.match(tick, /open\(lockPath, 'wx', 0o600\)/, 'mi tick uses an exclusive lock file');
assert.match(crons, /export async function tickReminderCrons\(\)/, 'cron module exposes reminder-only ticking');
assert.match(crons, /options\.remindersOnly && cron\.command/, 'reminder-only ticking skips legacy command crons');
assert.match(installer, /ExecStart=\$\{MI_BIN\} tick/, 'systemd installer uses mi tick');
assert.match(installer, /enable-linger/, 'systemd installer enables user lingering for scheduled user timer reliability');
assert.match(deployScript, /git diff --quiet[\s\S]*git status --short/, 'deploy script refuses dirty trees and shows status');
assert.match(deployScript, /npm test[\s\S]*install -m 600 pi\/extensions\/mi\.ts[\s\S]*install -m 700 pi\/extensions\/mi-daemon\.mjs/, 'deploy script runs hermetic tests before copying extension artifacts');
assert.match(deployScript, /systemctl --user restart/, 'deploy script restarts user services through systemd when units exist');

const root = await mkdtemp(join(tmpdir(), 'mi-tick-'));
try {
  const healthDir = join(root, 'tj-health');
  await mkdir(healthDir, { recursive: true });
  await writeFile(join(healthDir, 'detect-latest-health.json'), JSON.stringify({ checked_at: new Date().toISOString(), step: 'detect', status: 'ok', reason: 'ok' }));
  await mkdir(join(root, 'mi', 'state'), { recursive: true });
  const capabilityDir = join(root, '.pi', 'agent', 'mi', 'capabilities');
  await mkdir(capabilityDir, { recursive: true });
  await writeFile(join(capabilityDir, 'expired.json'), JSON.stringify({ grants: [{ expiresAt: new Date(Date.now() - 1000).toISOString() }] }));
  await writeFile(join(capabilityDir, 'fresh.json'), JSON.stringify({ grants: [{ expiresAt: new Date(Date.now() + 60_000).toISOString() }] }));
  await writeFile(join(root, 'mi', 'state', 'crons.json'), JSON.stringify([
    { name: 'reminder-test', enabled: true, at: new Date(Date.now() - 1000).toISOString(), message: 'Reminder from test' },
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
    env: { ...process.env, HOME: root, MI_ROOT: join(root, 'assistant'), MI_TASK_STATE_DIR: join(root, 'mi', 'state'), MI_TACTICS_HEALTH_DIR: healthDir, MI_TACTICS_HEALTH_STEPS: 'detect', MI_DAILY_BRIEF: 'false', MI_TICK_DAILY_BRIEF: 'false', MI_IMESSAGE_MONITOR_ENABLED: 'false', MI_LOOP_DISCOVERY_ENABLED: 'false', MI_LOOP_FACTORY_ENABLED: 'false', MI_PROJECT_STATUS_ENABLED: 'false', MI_WEEKLY_REVIEW_ENABLED: 'false', PUSHOVER_USER: '', PUSHOVER_TOKEN: '' },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const { first, second } = JSON.parse(result.stdout.trim());
  assert.deepEqual(first.reminders.map((item) => item.status), ['ok', 'skipped'], 'mi tick runs reminder crons and skips legacy command crons');
  assert.equal(first.health.checked[0], 'configuredMonitorHealth', 'mi tick ran configured monitor health');
  assert.equal(first.imessageMonitor.status, 'skipped', 'mi tick can skip the iMessage monitor when disabled for tests');
  assert.equal(first.capabilityGrantGc.deleted, 1, 'mi tick deletes expired capability grant files');
  assert.equal(first.capabilityGrantGc.kept, 1, 'mi tick keeps fresh capability grant files');
  assert.equal(first.skippedLoopFactory, true, 'mi tick can skip Loop Factory when disabled for tests');
  assert.equal(first.skippedProjectStatus, true, 'mi tick can skip project status generation when disabled for tests');
  assert.equal(first.skippedWeeklyReview, true, 'mi tick can skip weekly review when disabled for tests');
  assert.equal(second.reminders.length, 1, 'skipped legacy command cron remains due until migrated, while one-shot reminder is disabled');
  assert.equal(second.reminders[0].status, 'skipped', 'legacy command cron is not executed by mi tick');
} finally {
  await rm(root, { recursive: true, force: true });
}

const scheduleRoot = await mkdtemp(join(tmpdir(), 'mi-question-schedule-'));
try {
  const runner = join(scheduleRoot, 'run-schedule.mjs');
  await writeFile(runner, `
    import assert from 'node:assert/strict';
    process.env.MI_QUESTIONS_MAX_PER_DAY = '2';
    process.env.MI_QUESTIONS_QUIET_BEFORE = '9';
    process.env.MI_QUESTIONS_QUIET_AFTER = '21';
    process.env.MI_QUESTIONS_MIN_GAP_HOURS = '2';
    const tick = await import(${JSON.stringify(new URL('../src/tick.ts', import.meta.url).href)});
    const morning = new Date('2026-06-22T14:00:00Z');
    const night = new Date('2026-06-23T02:00:00Z');
    const state = tick.normalizeQuestionSchedule({}, morning);
    assert.equal(state.questionDate, '2026-06-22', 'schedule initializes the NY day');
    assert.ok(state.nextQuestionAfter, 'schedule computes a dynamic next question time');
    state.nextQuestionAfter = morning.toISOString();
    assert.equal(tick.dynamicProjectQuestionDue(state, morning), true, 'question is due inside quiet-hour window when next time has arrived');
    assert.equal(tick.dynamicProjectQuestionDue(state, night), false, 'question is not due during quiet hours');
    tick.recordQuestionTick(state, true, morning);
    assert.equal(state.questionsToday, 1, 'sent question increments daily count');
    assert.equal(tick.dynamicProjectQuestionDue({ ...state, nextQuestionAfter: morning.toISOString() }, morning), false, 'minimum gap blocks immediate repeat');
    assert.equal(tick.dynamicProjectQuestionDue({ ...state, questionsToday: 2, lastQuestionAt: undefined, nextQuestionAfter: morning.toISOString() }, morning), false, 'daily max is respected');
    const tomorrow = tick.normalizeQuestionSchedule({ ...state }, new Date('2026-06-23T14:00:00Z'));
    assert.equal(tomorrow.questionDate, '2026-06-23', 'new NY day resets question state');
    assert.equal(tomorrow.questionsToday, 0, 'new day resets count');
  `);
  const tsx = new URL('../node_modules/.bin/tsx', import.meta.url).pathname;
  const result = spawnSync(process.execPath, [tsx, runner], {
    cwd: scheduleRoot,
    env: { ...process.env, HOME: scheduleRoot, MI_ROOT: join(scheduleRoot, 'assistant') },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
} finally {
  await rm(scheduleRoot, { recursive: true, force: true });
}

console.log('Mi tick checks passed.');
