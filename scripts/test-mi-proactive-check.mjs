import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const proactive = await readFile(new URL('../src/proactive.ts', import.meta.url), 'utf8');
const cli = await readFile(new URL('../src/cli.ts', import.meta.url), 'utf8');
const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');

assert.match(proactive, /export type ProactiveCheck = \{[\s\S]*run: \(\) => Promise<null \| ProactiveNotice>/, 'proactive checks use the minimal check contract');
assert.match(proactive, /export type ProactiveNotice = \{[\s\S]*message: string;[\s\S]*notify\?: boolean;[\s\S]*dedupeKey\?: string;/, 'notices use the minimal notice contract');
assert.match(proactive, /export const checks: ProactiveCheck\[] = \[[\s\S]*id: 'pendingApprovals'[\s\S]*id: 'failedCrons'[\s\S]*id: 'dailyBrief'/, 'default proactive checks stay small and fixed');
assert.match(proactive, /appendThreadMessage\('main', 'assistant', message, \{ unread: true, source: 'mi:check' \}\)/, 'mi check appends one summary to the main thread');
assert.match(proactive, /sendNotification\('Mi check', message\)/, 'mi check may notify after appending the summary');
assert.match(proactive, /No action taken\./, 'proactive messages explicitly say no action was taken');
assert.doesNotMatch(proactive, /child_process|runWorker|pi\.inspect|pi\.repair|createApproval|ActionResult|ProactivePolicy|mi\.policy/, 'proactive loop does not import or model autonomous actions');

assert.match(cli, /import \{ runMiCheck \} from '\.\/proactive\.js';/, 'CLI imports the proactive check runner');
assert.match(cli, /mi check\s+Run one proactive Mi check-in/, 'usage exposes mi check as the proactive name');
assert.match(cli, /if \(command === 'check' &&[\s\S]*return proactiveCheckCommand\(args\);/, 'mi check runs the proactive loop');
assert.match(readme, /## `mi check`[\s\S]*read state → run checks → dedupe → append message → maybe notify/, 'README documents the minimal proactive loop');
assert.match(readme, /Every proactive message ends with `No action taken\.`/, 'README documents the no-action invariant');

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
