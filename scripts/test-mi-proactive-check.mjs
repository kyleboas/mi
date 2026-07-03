import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const proactive = await readFile(new URL('../src/proactive.ts', import.meta.url), 'utf8');
const cli = await readFile(new URL('../src/cli.ts', import.meta.url), 'utf8');
const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
const monitorRegistry = await readFile(new URL('../assistants/monitors.md', import.meta.url), 'utf8');

assert.match(proactive, /export type ProactiveCheck = \{[\s\S]*run: \(\) => Promise<null \| ProactiveNotice>/, 'proactive checks use the minimal check contract');
assert.match(proactive, /export type ProactiveNotice = \{[\s\S]*message: string;[\s\S]*notify\?: boolean;[\s\S]*dedupeKey\?: string;[\s\S]*repairPrompt\?: string;[\s\S]*suppressActionFooter\?: boolean;/, 'notices support optional repair worker prompts and footer suppression');
assert.match(proactive, /export const checks: ProactiveCheck\[] = \[[\s\S]*id: 'pendingApprovals'[\s\S]*id: 'failedCrons'[\s\S]*id: 'dailyBrief'/, 'default proactive checks stay small and fixed');
assert.match(proactive, /export const checks: ProactiveCheck\[] = \[\n  \{ id: 'pendingApprovals', run: pendingApprovals \},\n  \{ id: 'failedCrons', run: failedCrons \},\n  \{ id: 'dailyBrief', run: dailyBrief \},\n\];/, 'dynamic project questions are registry-only, not default checks');
assert.match(proactive, /\['question', \{ id: 'projectQuestion', run: projectQuestion \}\][\s\S]*\['questions', \{ id: 'projectQuestion', run: projectQuestion \}\][\s\S]*\['ask', \{ id: 'projectQuestion', run: projectQuestion \}\]/, 'question aliases are registered');
assert.match(proactive, /appendThreadMessage\('main', 'assistant', message, \{ unread: true, source: 'mi:check' \}\)/, 'mi check appends one summary to the main thread');
assert.match(proactive, /sendNotification\('Mi check', message\)/, 'mi check may notify after appending the summary');
assert.match(proactive, /No action taken\./, 'non-repair proactive messages explicitly say no action was taken');
assert.match(proactive, /if \(!needsFooter\) return String\(redactSecrets\(body\)\)/, 'question notices can suppress the action footer');
assert.match(proactive, /Starting a background repair worker now\./, 'crashed check notices report that a repair worker is starting');
assert.match(proactive, /auto-actions\.json/, 'safe auto-actions persist a daily budget state');
assert.match(proactive, /process\.env\.MI_AUTO_ACTIONS_ENABLED !== 'false'/, 'safe auto-actions go live by default and can be disabled explicitly');
assert.match(proactive, /MI_AUTO_ACTION_INSPECT_MAX_PER_DAY/, 'safe read-only triage has a daily budget');
assert.match(proactive, /capabilityProfile: 'worker-read'/, 'automatic monitor triage explicitly uses read-only worker capability');
assert.match(proactive, /Do not edit files, deploy, merge, delete, change config, approve anything, or touch secrets\./, 'automatic monitor triage forbids mutation in the worker prompt');
assert.match(proactive, /Good morning, \$\{owner\}\. Here is your daily briefing for \$\{briefDate\(\)\}\./, 'daily brief includes the requested greeting and full date');
assert.match(proactive, /TODAY’S FOCUS[\s\S]*ACTION ITEMS[\s\S]*PROJECTS IN MOTION/, 'daily brief prioritizes current work, projects, and actionable items');
assert.match(proactive, /recentWorkTasks[\s\S]*tasks\.json[\s\S]*web-workers\.json/, 'daily brief draws from both Mi task state and web-chat worker state');
assert.match(proactive, /Pending approvals: \$\{pending\.length\}[\s\S]*pending\.slice\(0, 5\)\.map\(formatApprovalLine\)/, 'daily brief lists pending approval details');
assert.match(proactive, /Summary: \$\{failed\.length\} failed crons, \$\{enabledCrons\.length\} enabled crons, \$\{crons\.length\} total tracked\./, 'daily brief includes monitor health counts');
assert.match(proactive, /Recent monitor runs:/, 'daily brief includes recent monitor activity');
assert.match(proactive, /type: 'run_worker'/, 'error notices can request a background repair worker');
assert.match(proactive, /export async function configuredMonitorHealth\(\)/, 'configured monitor health check exists outside the default check list');
assert.match(proactive, /monitor-health\.json/, 'configured monitor health persists transition state');
assert.match(proactive, /monitorRegistryPath[\s\S]*assistants[\s\S]*monitors\.md/, 'configured monitor health reads the declarative monitor registry');
assert.match(proactive, /function parseMonitorRegistry[\s\S]*health_sidecar[\s\S]*mi_crons/, 'monitor registry parser supports sidecars and Mi cron monitors');
assert.match(proactive, /humanRequiredReasons[\s\S]*railway_auth_failed[\s\S]*cloudflare_ai_gateway_billing/, 'human-required monitor failures are classified without auto-repair');
assert.match(proactive, /repairableMonitorReasons[\s\S]*stale[\s\S]*rescore_degraded/, 'only allowlisted stale/degraded monitor reasons can request repair');
assert.match(proactive, /monitorRepairMaxAttempts[\s\S]*muted_pending_human/, 'configured monitors mute pending human after repeated failed repairs');
assert.match(proactive, /if \(\(error as NodeJS\.ErrnoException\)\?\.code === 'ENOENT'\) return null/, 'missing tactics sidecars are not registered as structurally stale monitors');
assert.doesNotMatch(proactive, /child_process|runWorker|pi\.inspect|pi\.repair|createApproval|ActionResult|ProactivePolicy|mi\.policy/, 'proactive loop does not import old policy/approval action machinery');

assert.match(cli, /import \{ runMiCheck \} from '\.\/proactive\.js';/, 'CLI imports the proactive check runner');
assert.match(cli, /mi check\s+Run one proactive Mi check-in/, 'usage exposes mi check as the proactive name');
assert.match(cli, /mi check health-check\s+Check configured monitors/, 'usage exposes configured monitor health check');
assert.match(cli, /mi check question\s+Ask one dynamic project or goal question/, 'usage exposes dynamic project question check');
assert.match(cli, /if \(command === 'check' &&[\s\S]*health-check[\s\S]*return proactiveCheckCommand\(args\);/, 'mi check health-check runs the proactive loop');
assert.match(readme, /## `mi check`[\s\S]*read state → run checks → dedupe → append message → maybe start safe read-only triage[\s\S]*maybe notify/, 'README documents the proactive loop');
assert.match(readme, /Dynamic project questions are the exception:[\s\S]*do not add a footer/, 'README documents question footer suppression');
assert.match(monitorRegistry, /\| tactics:detect \| Tactics Journal detect health \| health_sidecar \| \/home\/kyle\/code\/research\/\.logs\/detect-latest-health\.json \| 30h \|/, 'monitor registry declares the real Tactics Journal detect sidecar');
assert.match(monitorRegistry, /\| mi-crons:configured \| Mi reminder crons \| mi_crons \| state\/crons\.json \| n\/a \|/, 'monitor registry declares Mi cron health');
assert.match(monitorRegistry, /\| tactics:report-pr-queue-worker \| [^|]+ \| health_sidecar \| \/home\/kyle\/code\/research\/\.logs\/report-pr-queue-worker-latest-health\.json \| 30h \|/, 'monitor registry tracks the renamed report PR queue worker sidecar');
assert.doesNotMatch(monitorRegistry, /\| tactics:report-worker \||\| tactics:tune \||\| tactics:storage-prune \|/, 'monitors without a live sidecar producer are removed from the registry');
assert.match(proactive, /\$\{item\.id\}:\$\{item\.status\}:\$\{item\.reason\}/, 'monitor health dedupe key uses stable identity');
assert.doesNotMatch(proactive, /dedupeKey: `monitorHealth:[^\n]*item\.detail/, 'monitor health dedupe key excludes volatile detail text');

const root = await mkdtemp(join(tmpdir(), 'mi-proactive-'));
try {
  await mkdir(join(root, 'state'), { recursive: true });
  await writeFile(join(root, 'state', 'approvals.jsonl'), `${JSON.stringify({ id: 'approve-1', createdAt: new Date().toISOString(), status: 'pending', prompt: 'inspect', reason: 'needs review' })}\n`);

  const runner = join(root, 'run-proactive.mjs');
  await writeFile(runner, `
    import { runMiCheck } from ${JSON.stringify(new URL('../src/proactive.ts', import.meta.url).href)};
    const first = await runMiCheck({ checkIds: ['pendingApprovals'] });
    const second = await runMiCheck({ checkIds: ['pendingApprovals'] });
    console.log(JSON.stringify({ first, second }));
  `);
  const tsx = new URL('../node_modules/.bin/tsx', import.meta.url).pathname;
  const result = spawnSync(process.execPath, [tsx, runner], {
    cwd: root,
    env: { ...process.env, MI_ROOT: join(root, 'assistant'), HOME: root, MI_DAILY_BRIEF: 'false', PUSHOVER_USER: '', PUSHOVER_TOKEN: '' },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const { first, second } = JSON.parse(result.stdout.trim());
  assert.equal(first.notices.length, 1, 'first pending approval check creates one notice');
  assert.equal(first.appended, true, 'first pending approval check appends to main');
  assert.match(first.message, /No action taken\./, 'check result says no action was taken');
  const threadPath = join(root, 'assistant', 'state', 'threads', 'main.jsonl');
  const threadAfterFirstAndSecond = await readFile(threadPath, 'utf8');
  assert.match(threadAfterFirstAndSecond, /Mi noticed 1 pending approval/, 'main thread receives the proactive summary');
  assert.equal(second.notices.length, 0, 'second identical check is deduped');
  assert.equal(second.skipped.length, 1, 'dedupe reports skipped duplicate');
  assert.equal(threadAfterFirstAndSecond.trim().split('\n').filter(Boolean).length, 1, 'deduped notice does not append a second message');
} finally {
  await rm(root, { recursive: true, force: true });
}

const monitorRoot = await mkdtemp(join(tmpdir(), 'mi-monitor-'));
try {
  const healthDir = join(monitorRoot, 'tj', 'research', 'pipeline', '.logs');
  await mkdir(healthDir, { recursive: true });
  const oldDate = new Date(Date.now() - 48 * 60 * 60_000).toISOString();
  await writeFile(join(healthDir, 'detect-latest-health.json'), JSON.stringify({ checked_at: oldDate, step: 'detect', status: 'ok', reason: 'ok' }));
  const runner = join(monitorRoot, 'run-monitor.mjs');
  await writeFile(runner, `
    import { mkdir, readFile, writeFile } from 'node:fs/promises';
    import { join } from 'node:path';
    import { runMiCheck } from ${JSON.stringify(new URL('../src/proactive.ts', import.meta.url).href)};
    const stateDir = join(process.env.MI_ROOT, 'state');
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, 'monitor-health.json'), JSON.stringify({ version: 1, monitors: { 'tactics:detect': { status: 'ok', reason: 'ok', detail: 'seeded' } } }));
    const first = await runMiCheck({ checkIds: ['health-check'], dryRun: true });
    const second = await runMiCheck({ checkIds: ['health-check'], dryRun: true });
    await writeFile(join(process.env.MI_TACTICS_HEALTH_DIR, 'detect-latest-health.json'), JSON.stringify({ checked_at: new Date().toISOString(), step: 'detect', status: 'ok', reason: 'ok' }));
    const recovered = await runMiCheck({ checkIds: ['health-check'], dryRun: true });
    await writeFile(join(process.env.MI_TACTICS_HEALTH_DIR, 'detect-latest-health.json'), JSON.stringify({ checked_at: new Date(Date.now() + 60_000).toISOString(), step: 'detect', status: 'ok', reason: 'ok' }));
    const refreshed = await runMiCheck({ checkIds: ['health-check'], dryRun: true });
    console.log(JSON.stringify({ first, second, recovered, refreshed, state: JSON.parse(await readFile(join(stateDir, 'monitor-health.json'), 'utf8')) }));
  `);
  const tsx = new URL('../node_modules/.bin/tsx', import.meta.url).pathname;
  const result = spawnSync(process.execPath, [tsx, runner], {
    cwd: monitorRoot,
    env: { ...process.env, MI_ROOT: join(monitorRoot, 'assistant'), HOME: monitorRoot, MI_TASK_STATE_DIR: join(monitorRoot, 'mi-state'), MI_TACTICS_HEALTH_DIR: healthDir, MI_TACTICS_HEALTH_STEPS: 'detect', MI_TACTICS_HEALTH_STALE_MS: '1000', PUSHOVER_USER: '', PUSHOVER_TOKEN: '' },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const { first, second, recovered, refreshed } = JSON.parse(result.stdout.trim());
  assert.equal(first.notices.length, 1, 'stale configured monitor transition creates one notice');
  assert.match(first.message, /Starting safe read-only triage now\./, 'repairable stale monitor starts live safe read-only triage');
  assert.equal(first.notices[0].notice.repairName, 'repair-tactics-detect', 'repair worker name is scoped to the configured monitor');
  assert.equal(second.notices.length, 0, 'unchanged stale monitor is suppressed');
  assert.equal(recovered.notices.length, 1, 'recovered monitor reports once');
  assert.match(recovered.message, /healthy again/, 'recovery message is conversational');
  assert.equal(refreshed.notices.length, 0, 'healthy monitor with a fresh checked_at timestamp does not re-notify as recovered');
} finally {
  await rm(monitorRoot, { recursive: true, force: true });
}

const structuralRoot = await mkdtemp(join(tmpdir(), 'mi-monitor-structural-'));
try {
  const healthDir = join(structuralRoot, 'missing-health');
  const runner = join(structuralRoot, 'run-monitor-structural.mjs');
  await writeFile(runner, `
    import { mkdir, readFile, writeFile } from 'node:fs/promises';
    import { join } from 'node:path';
    import { runMiCheck } from ${JSON.stringify(new URL('../src/proactive.ts', import.meta.url).href)};
    const stateDir = join(process.env.MI_ROOT, 'state');
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, 'monitor-health.json'), JSON.stringify({ version: 1, monitors: { 'tactics:detect': { status: 'stale', reason: 'missing_health_sidecar', detail: 'old bad path', repairAttempts: 10 } } }));
    const result = await runMiCheck({ checkIds: ['health-check'], dryRun: true });
    const state = JSON.parse(await readFile(join(stateDir, 'monitor-health.json'), 'utf8'));
    console.log(JSON.stringify({ result, state }));
  `);
  const tsx = new URL('../node_modules/.bin/tsx', import.meta.url).pathname;
  const result = spawnSync(process.execPath, [tsx, runner], {
    cwd: structuralRoot,
    env: { ...process.env, MI_ROOT: join(structuralRoot, 'assistant'), HOME: structuralRoot, MI_TASK_STATE_DIR: join(structuralRoot, 'mi-state'), MI_TACTICS_HEALTH_DIR: healthDir, MI_TACTICS_HEALTH_STEPS: 'detect', PUSHOVER_USER: '', PUSHOVER_TOKEN: '' },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const { result: checkResult, state } = JSON.parse(result.stdout.trim());
  assert.equal(checkResult.notices.length, 0, 'missing structural tactics sidecar does not create a stale monitor notice');
  assert.equal(state.monitors['tactics:detect'], undefined, 'missing structural tactics sidecar removes the old stale monitor entry');
} finally {
  await rm(structuralRoot, { recursive: true, force: true });
}

const muteRoot = await mkdtemp(join(tmpdir(), 'mi-monitor-mute-'));
try {
  const healthDir = join(muteRoot, 'tj-health');
  await mkdir(healthDir, { recursive: true });
  const oldDate = new Date(Date.now() - 48 * 60 * 60_000).toISOString();
  await writeFile(join(healthDir, 'detect-latest-health.json'), JSON.stringify({ checked_at: oldDate, step: 'detect', status: 'ok', reason: 'ok' }));
  const runner = join(muteRoot, 'run-monitor-mute.mjs');
  await writeFile(runner, `
    import { mkdir, readFile, writeFile } from 'node:fs/promises';
    import { join } from 'node:path';
    import { runMiCheck } from ${JSON.stringify(new URL('../src/proactive.ts', import.meta.url).href)};
    const stateDir = join(process.env.MI_ROOT, 'state');
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, 'monitor-health.json'), JSON.stringify({ version: 1, monitors: { 'tactics:detect': { status: 'stale', reason: 'stale', detail: 'seeded', repairAttempts: 3 } } }));
    const first = await runMiCheck({ checkIds: ['health-check'], dryRun: true });
    const second = await runMiCheck({ checkIds: ['health-check'], dryRun: true });
    const state = JSON.parse(await readFile(join(stateDir, 'monitor-health.json'), 'utf8'));
    console.log(JSON.stringify({ first, second, state }));
  `);
  const tsx = new URL('../node_modules/.bin/tsx', import.meta.url).pathname;
  const result = spawnSync(process.execPath, [tsx, runner], {
    cwd: muteRoot,
    env: { ...process.env, HOME: muteRoot, MI_ROOT: join(muteRoot, 'assistant'), MI_TASK_STATE_DIR: join(muteRoot, 'mi-state'), MI_TACTICS_HEALTH_DIR: healthDir, MI_TACTICS_HEALTH_STEPS: 'detect', MI_TACTICS_HEALTH_STALE_MS: '1000', MI_MONITOR_REPAIR_MAX_ATTEMPTS: '3', PUSHOVER_USER: '', PUSHOVER_TOKEN: '' },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const { first, second, state } = JSON.parse(result.stdout.trim());
  assert.equal(first.notices.length, 1, 'monitor escalates once when repair attempt budget is exhausted');
  assert.match(first.message, /muted pending human/, 'exhausted monitor tells the user it muted pending human');
  assert.equal(first.notices[0].notice.repairPrompt, undefined, 'muted monitor does not start another repair worker');
  assert.equal(second.notices.length, 0, 'muted monitor stays quiet on unchanged failures');
  assert.equal(state.monitors['tactics:detect'].status, 'muted_pending_human', 'monitor state records muted pending human status');
} finally {
  await rm(muteRoot, { recursive: true, force: true });
}

const autoActionRoot = await mkdtemp(join(tmpdir(), 'mi-auto-action-budget-'));
try {
  const healthDir = join(autoActionRoot, 'tj-health');
  await mkdir(healthDir, { recursive: true });
  const oldDate = new Date(Date.now() - 48 * 60 * 60_000).toISOString();
  await writeFile(join(healthDir, 'detect-latest-health.json'), JSON.stringify({ checked_at: oldDate, step: 'detect', status: 'ok', reason: 'ok' }));
  const runner = join(autoActionRoot, 'run-auto-budget.mjs');
  await writeFile(runner, `
    import { mkdir, readFile, writeFile } from 'node:fs/promises';
    import { join } from 'node:path';
    import { runMiCheck } from ${JSON.stringify(new URL('../src/proactive.ts', import.meta.url).href)};
    const stateDir = join(process.env.MI_ROOT, 'state');
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, 'monitor-health.json'), JSON.stringify({ version: 1, monitors: { 'tactics:detect': { status: 'ok', reason: 'ok', detail: 'seeded' } } }));
    const result = await runMiCheck({ checkIds: ['health-check'], notify: false });
    const thread = await readFile(join(stateDir, 'threads', 'main.jsonl'), 'utf8');
    console.log(JSON.stringify({ result, thread }));
  `);
  const tsx = new URL('../node_modules/.bin/tsx', import.meta.url).pathname;
  const result = spawnSync(process.execPath, [tsx, runner], {
    cwd: autoActionRoot,
    env: { ...process.env, HOME: autoActionRoot, MI_ROOT: join(autoActionRoot, 'assistant'), MI_TASK_STATE_DIR: join(autoActionRoot, 'mi-state'), MI_TACTICS_HEALTH_DIR: healthDir, MI_TACTICS_HEALTH_STEPS: 'detect', MI_TACTICS_HEALTH_STALE_MS: '1000', MI_AUTO_ACTION_INSPECT_MAX_PER_DAY: '0', PUSHOVER_USER: '', PUSHOVER_TOKEN: '' },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const { result: checkResult, thread } = JSON.parse(result.stdout.trim());
  assert.equal(checkResult.notices.length, 1, 'budgeted live auto-action still reports the monitor transition');
  assert.match(thread, /Mi skipped safe read-only triage for configuredMonitorHealth: daily budget disabled\./, 'budget exhaustion skips the live worker before opening a socket');
} finally {
  await rm(autoActionRoot, { recursive: true, force: true });
}
