import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'mi-chief-'));
process.chdir(root);
process.env.HOME = root;
process.env.MI_ROOT = join(root, 'assistant');
process.env.MI_CHIEF_OF_STAFF_DB = join(root, 'assistant', 'state', 'chief.sqlite');
process.env.MI_LEGACY_MEMORY_PATH = join(root, 'mi', 'memory.md');
process.env.PUSHOVER_USER = '';
process.env.PUSHOVER_TOKEN = '';
await mkdir(join(root, 'mi'), { recursive: true });
await writeFile(process.env.MI_LEGACY_MEMORY_PATH, '# Old memory\n\n- Legacy preference.\n');

const chief = await import('../dist/src/chief-of-staff.js');
const ingest = await import('../dist/src/chief-of-staff-ingest.js');
const proactive = await import('../dist/src/chief-of-staff-proactive.js');
const checks = await import('../dist/src/proactive.js');
const weekly = await import('../dist/src/weekly-review.js');
const threads = await import('../dist/src/threads.js');
const memory = await import('../dist/src/memory.js');
const tick = await import('../dist/src/tick.js');
const notifications = await import('../dist/src/notify.js');

try {
  const store = new chief.ChiefOfStaffStore({ path: process.env.MI_CHIEF_OF_STAFF_DB, now: () => new Date('2026-07-01T12:00:00Z') });
  assert.equal(store.schemaVersion(), 1);
  const first = store.createCommitment({ title: 'Submit the report', status: 'active', sourceKey: 'thread:1', sourceType: 'test', sourceExcerpt: 'I will submit the report' });
  assert.equal(store.createCommitment({ title: 'duplicate', sourceKey: 'thread:1' }).id, first.id, 'source keys are idempotent');
  assert.equal(store.listCommitments().length, 1);

  const falsePositives = ['I will not deploy this.', 'The assistant said: I will fix it.', 'Can you explain this?', 'I need to know why this happened.'];
  for (const text of falsePositives) assert.equal(ingest.extractCommitmentsFromUserText(text).length, 0, `does not infer commitment from: ${text}`);
  assert.equal(ingest.extractCommitmentsFromUserText('I will send the draft by 2026-07-05.')[0].status, 'active');
  assert.equal(ingest.extractCommitmentsFromUserText('Maybe I should call Sam.')[0].status, 'needs_clarification');
  assert.equal(ingest.extractCommitmentsFromUserText('Please organize my private launch notes.')[0].status, 'proposed');
  assert.equal(ingest.extractRelationshipsFromUserText('Sam is my friend.').length, 1);
  assert.equal(ingest.extractRelationshipsFromUserText('Sam has a medical diagnosis.').length, 0, 'sensitive attributes are not inferred');

  let externalRuns = 0;
  chief.registerActionHandler('test_external', () => { externalRuns += 1; return { result: 'sent', verified: true }; });
  const external = store.createAction({ kind: 'test_external', title: 'Send a message to Sam', riskClass: 'external', idempotencyKey: 'external-1' });
  await assert.rejects(() => store.dispatchAction(external.id), /approval required/);
  assert.throws(() => store.transitionAction(external.id, 'executing'), /approval required/, 'lifecycle state cannot bypass dispatch policy');
  assert.equal(externalRuns, 0, 'handler is not reached before policy approval');
  store.approveAction(external.id, 'test approval');
  const completed = await store.dispatchAction(external.id);
  assert.equal(completed.status, 'completed');
  assert.ok(completed.approvalConsumedAt, 'executor consumes approval');
  assert.equal(externalRuns, 1);
  const internal = store.createAction({ kind: 'organize', title: 'Organize private notes', idempotencyKey: 'internal-1' });
  assert.equal((await store.dispatchAction(internal.id)).status, 'completed', 'internal organization auto-executes');
  const verifyCommitment = store.createCommitment({ title: 'Verify delegated result', status: 'active', sourceKey: 'verify-com' });
  const verifyAction = store.createAction({ kind: 'delegated_task', title: 'Verify delegated result', commitmentId: verifyCommitment.id, idempotencyKey: 'verify-action' });
  store.transitionAction(verifyAction.id, 'verification_required', { result: 'daemon says done' });
  assert.equal(store.verifyAction(verifyAction.id, 'checked output').status, 'completed');
  assert.equal(store.getCommitment(verifyCommitment.id).completionVerified, true, 'verification closes the linked commitment');

  const due = store.createCommitment({ title: 'Overdue item', status: 'active', dueAt: '2026-06-30T12:00:00Z', sourceKey: 'due-1' });
  const review1 = await proactive.runChiefOfStaffReview({ store, now: new Date('2026-07-01T12:00:00Z'), notify: false });
  assert.match(review1.message, /Overdue item/);
  const review2 = await proactive.runChiefOfStaffReview({ store, now: new Date('2026-07-01T13:00:00Z'), notify: false });
  assert.doesNotMatch(review2.message, /Overdue item/, 'delivery is durably deduped');
  assert.ok(due.id);

  store.upsertMemoryFact({ subject: 'Kyle', fact: 'Prefers concise summaries', confidence: 0.9, sourceKey: 'fact-1' });
  const exported = await store.export(join(root, 'export'));
  assert.match(await readFile(exported.markdownPath, 'utf8'), /Prefers concise summaries/);
  const backup = await store.backup(join(root, 'backup.sqlite'));
  assert.ok((await readFile(backup)).length > 0);
  assert.ok(store.recentAudit().length >= 1);
  const brief = await checks.dailyBrief();
  assert.match(brief.message, /Here’s what I’m keeping an eye on today\.[\s\S]*Priorities[\s\S]*Overdue item/, 'morning brief includes chief-of-staff priorities in a human voice');
  assert.doesNotMatch(brief.message, /TODAY’S|DECISIONS NEEDED|DELEGATED WORK|ACTION ITEMS/, 'morning brief avoids dashboard-style headings');
  const beforeDry = (await threads.readThreadMessages('main')).length;
  const evening = proactive.renderEveningReconciliation(store, new Date('2026-07-01T20:00:00Z'));
  assert.match(evening, /^Good evening\. Here’s the short version/);
  assert.doesNotMatch(evening, /COMPLETED|OPEN \/ BLOCKED|DECISIONS \/ VERIFICATION|\[blocked\]|\[active\]/, 'evening review uses human headings and hides lifecycle labels');
  const dryEvening = await proactive.deliverChiefOfStaffReconciliation('evening', evening, { store, dryRun: true, notify: false, dateKey: '2026-07-01' });
  assert.equal(dryEvening.delivered, false);
  assert.equal((await threads.readThreadMessages('main')).length, beforeDry, 'dry-run review is not delivered');
  const weeklyDry = await weekly.deliverWeeklyReview({ now: new Date('2026-07-05T15:00:00Z'), dryRun: true, notify: false });
  assert.equal(weeklyDry.delivered, false, 'weekly review dry-run does not deliver');
  store.close();

  const blockedFixtures = [
    {
      name: 'legacy-truncated',
      subject: 'Compare the enterprise backup providers',
      full: 'Compare the enterprise backup providers: Review restore speed, regional retention, encryption ownership, support response times, and the migration path. The final recommendation must include the disaster-recovery tradeoff.',
      legacy: true,
      tail: 'The final recommendation must include the disaster-recovery tradeoff.',
    },
    {
      name: 'structured-detail',
      subject: 'Ask the contractor to review the kitchen plans',
      full: 'Ask the contractor to review the kitchen plans: Confirm the appliance clearances, vent route, cabinet measurements, delivery sequence, and whether the island outlet placement meets the revised drawing. Keep the permit timing in the final answer.',
      legacy: false,
      tail: 'Keep the permit timing in the final answer.',
    },
  ];
  for (const fixture of blockedFixtures) {
    const fixtureStore = new chief.ChiefOfStaffStore({ path: join(root, `${fixture.name}-format.sqlite`), now: () => new Date('2026-07-03T12:00:00Z') });
    fixtureStore.createCommitment({
      title: fixture.legacy ? `${fixture.full.slice(0, 145)}…` : fixture.subject,
      detail: fixture.legacy ? undefined : fixture.full,
      status: 'blocked',
      sourceKey: `blocked-${fixture.name}`,
      sourceType: 'thread',
      sourceExcerpt: fixture.full,
    });
    const followUp = await proactive.runChiefOfStaffReview({ store: fixtureStore, now: new Date('2026-07-03T12:00:00Z'), dryRun: true, notify: false });
    assert.equal(followUp.messages.length, 1, `${fixture.name} renders as one conversational message`);
    assert.match(followUp.message, new RegExp(fixture.tail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${fixture.name} preserves its complete actionable tail`);
    assert.equal(followUp.message.toLowerCase().split(fixture.subject.toLowerCase()).length - 1, 1, `${fixture.name} does not repeat its title in the detail`);
    assert.doesNotMatch(followUp.message, /…|Chief-of-staff follow-up|Blocked:|^- |daemon|worker|verification_required/im, `${fixture.name} has no silent truncation, raw status, bullet, or implementation label`);
    assert.match(followUp.message, /What would you like me to do with it\?/, `${fixture.name} ends with an actionable question`);
    fixtureStore.close();
  }

  const multiStore = new chief.ChiefOfStaffStore({ path: join(root, 'multi-format.sqlite'), now: () => new Date('2026-07-01T12:00:00Z') });
  multiStore.createCommitment({ title: 'Call Sam about the launch', status: 'needs_clarification', reviewAt: '2026-07-01T13:00:00Z', sourceKey: 'format-clarify' });
  multiStore.createCommitment({ title: 'Review the pricing draft', status: 'blocked', sourceKey: 'format-blocked' });
  multiStore.createCommitment({ title: 'Finish the launch checklist', status: 'active', dueAt: '2026-07-01T10:00:00Z', sourceKey: 'format-overdue' });
  const failedFormat = multiStore.createAction({ kind: 'organize', title: 'Organize the launch notes', idempotencyKey: 'format-failed' });
  multiStore.transitionAction(failedFormat.id, 'failed', { error: 'worker daemon internal failure' });
  const verifyFormat = multiStore.createAction({ kind: 'organize', title: 'Review the completed launch draft', idempotencyKey: 'format-verify' });
  multiStore.transitionAction(verifyFormat.id, 'verification_required', { result: 'done' });
  multiStore.createAction({ kind: 'requested_action', title: 'Send Sam the approved launch note', riskClass: 'external', idempotencyKey: 'format-approval' });
  const stalledFormat = multiStore.createAction({ kind: 'organize', title: 'Prepare the launch handoff', idempotencyKey: 'format-stalled' });
  multiStore.transitionAction(stalledFormat.id, 'executing');
  multiStore.createFollowUp({ reason: 'ask Sam how the launch went', dueAt: '2026-07-01T11:00:00Z', sourceKey: 'format-follow-up' });
  const multipleFollowUps = await proactive.runChiefOfStaffReview({ store: multiStore, now: new Date('2026-07-03T12:00:00Z'), dryRun: true, notify: false });
  assert.match(multipleFollowUps.message, /things need your attention/i, 'multiple items get a natural opener');
  assert.match(multipleFollowUps.message, /not sure you wanted me to keep tracking it/i);
  assert.match(multipleFollowUps.message, /still have this paused/i);
  assert.match(multipleFollowUps.message, /planned to do this by/i);
  assert.match(multipleFollowUps.message, /couldn’t finish this/i);
  assert.match(multipleFollowUps.message, /haven’t checked the result yet/i);
  assert.match(multipleFollowUps.message, /waiting for your go-ahead/i);
  assert.match(multipleFollowUps.message, /haven’t seen progress on this/i);
  assert.match(multipleFollowUps.message, /Is now a good time/i);
  assert.doesNotMatch(multipleFollowUps.message, /Chief-of-staff|Blocked:|Needs clarification|Verification required|verification_required|needs_clarification|daemon|worker|act_/i, 'user-facing copy hides raw state and implementation jargon');
  assert.ok((multipleFollowUps.message.match(/\?/g) || []).length >= 8, 'each independent item asks for a clear next step');
  multiStore.close();

  const veryLongContext = `Review this complete brief: ${'The archive plan covers retention, restore drills, ownership, and a careful migration sequence. '.repeat(28)}The final tail must survive transport.`;
  const longStore = new chief.ChiefOfStaffStore({ path: join(root, 'long-format.sqlite'), now: () => new Date('2026-07-03T12:00:00Z') });
  longStore.createCommitment({ title: `${veryLongContext.slice(0, 170)}…`, status: 'blocked', sourceKey: 'very-long-blocked', sourceExcerpt: veryLongContext });
  const longFollowUp = await proactive.runChiefOfStaffReview({ store: longStore, now: new Date('2026-07-03T12:00:00Z'), dryRun: true, notify: false });
  assert.ok(longFollowUp.messages.length > 1, 'transport-sized long content is split deliberately');
  assert.match(longFollowUp.message, /part 1 of \d+/i);
  assert.match(longFollowUp.message, /The final tail must survive transport/);
  assert.doesNotMatch(longFollowUp.message, /…/, 'long content never ends in a silent ellipsis');
  assert.ok(longFollowUp.messages.every((message) => message.length <= 820), 'every iMessage chunk stays inside the dedicated safety bound');

  const deliveredBodies = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    deliveredBodies.push(JSON.parse(body));
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"ok":true}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  process.env.MI_PROACTIVE_IMESSAGE_NOTIFY = 'true';
  process.env.MI_PHOTON_NOTIFY_URL = `http://127.0.0.1:${address.port}/notify`;
  for (const message of longFollowUp.messages) await notifications.notifyImessage('Mi', message);
  await new Promise((resolve) => server.close(resolve));
  delete process.env.MI_PROACTIVE_IMESSAGE_NOTIFY;
  delete process.env.MI_PHOTON_NOTIFY_URL;
  assert.deepEqual(deliveredBodies.map((body) => body.message), longFollowUp.messages, 'local notify boundary preserves every chunk without sending a real message');
  longStore.close();

  const createdThreads = await Promise.all(Array.from({ length: 8 }, (_, index) => threads.createTempThread(`Concurrent ${index}`)));
  assert.equal(new Set(createdThreads.map((item) => item.id)).size, 8);
  assert.equal((await threads.listThreads()).filter((item) => item.kind === 'temporary').length, 8, 'concurrent index writes retain every thread');
  const artifactPath = join(root, 'PLAN.md');
  const daemonTasksPath = join(root, 'daemon-tasks.json');
  process.env.MI_CHIEF_OF_STAFF_ARTIFACTS = artifactPath;
  process.env.MI_TASKS_PATH = daemonTasksPath;
  await writeFile(artifactPath, '# Plan\n\n- [ ] Prepare the launch brief\n');
  await writeFile(daemonTasksPath, JSON.stringify([{ id: 'daemon-1', lastInput: 'Inspect the daemon result', status: 'running', progress: 'working' }]));
  await threads.appendThreadMessage('main', 'user', 'I will review the launch plan.', { source: 'test' });
  const ingestStore = new chief.ChiefOfStaffStore({ path: process.env.MI_CHIEF_OF_STAFF_DB });
  const one = await ingest.ingestChiefOfStaffSources(ingestStore);
  assert.ok(one.messagesScanned >= 1);
  assert.equal(one.artifactsScanned, 1);
  assert.equal(ingestStore.getAction('daemon-task:daemon-1').status, 'executing');
  const two = await ingest.ingestChiefOfStaffSources(ingestStore);
  assert.equal(two.messagesScanned, 0, 'unchanged thread cursors skip all old messages');
  assert.equal(two.artifactsScanned, 0, 'unchanged artifact digests skip reparsing');
  assert.equal(two.tasksReconciled, 0, 'unchanged daemon task state skips reconciliation');
  assert.equal(two.commitmentsCreated, 0, 'unchanged ingestion does not duplicate inferred records');

  const currentCursor = ingestStore.getCursor('thread:main');
  assert.ok(currentCursor);
  ingestStore.setCursor('thread:main', currentCursor.replace(/:[^:]+$/, ':zzzz-missing-after-compaction'));
  await new Promise((resolve) => setTimeout(resolve, 5));
  await threads.appendThreadMessage('main', 'user', 'I will send the launch summary.', { source: 'test' });
  const appended = await ingest.ingestChiefOfStaffSources(ingestStore);
  assert.equal(appended.messagesScanned, 1, 'a message newer than a missing compacted cursor target is ingested once');
  const appendedAgain = await ingest.ingestChiefOfStaffSources(ingestStore);
  assert.equal(appendedAgain.messagesScanned, 0, 'the appended message is not reprocessed');

  await writeFile(artifactPath, '# Plan moved around\n\nSome context.\n\n- [ ] Prepare the launch brief\n');
  await writeFile(daemonTasksPath, JSON.stringify([{ id: 'daemon-1', lastInput: 'Inspect the daemon result', status: 'complete', finishedAt: new Date().toISOString(), text: 'Result is ready' }]));
  const changed = await ingest.ingestChiefOfStaffSources(ingestStore);
  assert.equal(changed.messagesScanned, 0);
  assert.equal(changed.artifactsScanned, 1, 'changed artifact content is reparsed once');
  assert.equal(ingestStore.listCommitments({ limit: 1000 }).filter((item) => item.title === 'Prepare the launch brief').length, 1, 'moving an artifact task does not duplicate its commitment');
  assert.equal(ingestStore.getAction('daemon-task:daemon-1').status, 'verification_required', 'finished daemon task advances the existing action');
  assert.equal(ingestStore.listActions({ limit: 1000 }).filter((item) => item.sourceKey === 'daemon-task:daemon-1').length, 1);
  assert.equal(ingestStore.listCommitments({ limit: 1000 }).filter((item) => item.sourceKey === 'daemon-task:daemon-1:commitment').length, 1);

  await writeFile(daemonTasksPath, JSON.stringify([{ id: 'daemon-1', lastInput: 'Inspect the daemon result', status: 'failed', error: 'worker failed' }]));
  await ingest.ingestChiefOfStaffSources(ingestStore);
  assert.equal(ingestStore.getAction('daemon-task:daemon-1').status, 'failed', 'failed daemon state updates the same action');
  assert.equal(ingestStore.listActions({ limit: 1000 }).filter((item) => item.sourceKey === 'daemon-task:daemon-1').length, 1);
  assert.equal(ingestStore.listCommitments({ limit: 1000 }).filter((item) => item.sourceKey === 'daemon-task:daemon-1:commitment').length, 1);
  ingestStore.close();

  assert.match(await memory.readMemory(), /Legacy preference/, 'legacy markdown is imported into canonical memory');
  assert.match(await memory.memorySystemBlock(), /Structured chief-of-staff context/, 'bounded context includes structured state');
  assert.ok((await readFile(process.env.MI_LEGACY_MEMORY_PATH, 'utf8')).includes('Legacy preference'), 'legacy source is preserved');

  const staleLock = join(root, 'stale-tick.lock');
  process.env.MI_TICK_LOCK_PATH = staleLock;
  // tick.ts captured its lock path at import, so test stale recovery in a fresh process.
  await writeFile(staleLock, JSON.stringify({ pid: 99999999, startedAt: '2020-01-01T00:00:00Z' }));
  const lockRunner = join(root, 'lock-runner.mjs');
  await writeFile(lockRunner, `import { withTickLock } from ${JSON.stringify(new URL('../dist/src/tick.js', import.meta.url).href)}; console.log(await withTickLock(async () => 'recovered'));`);
  const lockResult = spawnSync(process.execPath, [lockRunner], { env: { ...process.env, MI_TICK_LOCK_PATH: staleLock, MI_TICK_LOCK_STALE_MS: '1' }, encoding: 'utf8' });
  assert.equal(lockResult.status, 0, lockResult.stderr);
  assert.match(lockResult.stdout, /recovered/);

  const cli = new URL('../dist/src/cli.js', import.meta.url).pathname;
  const cliResult = spawnSync(process.execPath, [cli, 'chief', 'status'], { env: process.env, encoding: 'utf8' });
  assert.equal(cliResult.status, 0, cliResult.stderr);
  assert.match(cliResult.stdout, /schemaVersion/);
  const createResult = spawnSync(process.execPath, [cli, 'commitments', 'add', 'CLI commitment', '--owner', 'kyle'], { env: process.env, encoding: 'utf8' });
  assert.equal(createResult.status, 0, createResult.stderr);
  assert.match(createResult.stdout, /CLI commitment/);
} finally {
  await rm(root, { recursive: true, force: true });
}
console.log('Mi chief-of-staff checks passed.');
