import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { enqueueProposal, queuedProposals, readProposalQueue, renderNumberedProposals } from '../dist/src/proposals.js';
import { dailyBrief } from '../dist/src/proactive.js';

const root = await mkdtemp(join(tmpdir(), 'mi-proposals-'));
try {
  const queuePath = join(root, 'state', 'proposals.json');
  const first = await enqueueProposal({ source: 'stale-work', title: 'Review stale Tactics Journal PR', action: 'Reply 1 and I will open a scoped repair PR', detail: 'untouched for 8 days', dedupeKey: 'stale-pr-1' }, queuePath);
  const duplicate = await enqueueProposal({ source: 'stale-work', title: 'Review stale Tactics Journal PR', action: 'Reply 1 and I will open a scoped repair PR', dedupeKey: 'stale-pr-1' }, queuePath);
  assert.equal(duplicate.id, first.id, 'queued proposals dedupe by key');
  await enqueueProposal({ source: 'deadline-radar', title: 'Decide TJ Pro launch checkpoint', action: 'Reply 2 and I will draft the launch checklist' }, queuePath);
  const queue = await readProposalQueue(queuePath);
  assert.equal(queue.proposals.length, 2, 'proposal queue stores unique queued proposals');
  const lines = renderNumberedProposals(queuedProposals(queue, 1));
  assert.deepEqual(lines, ['1. Review stale Tactics Journal PR - Reply 1 and I will open a scoped repair PR (untouched for 8 days)']);

  process.env.MI_ROOT = root;
  process.env.MI_PROPOSALS_PATH = queuePath;
  process.env.MI_DAILY_BRIEF_NOTIFY = 'false';
  process.env.MI_OWNER_NAME = 'Kyle';
  process.env.MI_CRONS_PATH = join(root, 'state', 'crons.json');
  process.env.MI_CRON_LOG_PATH = join(root, 'state', 'cron.log');
  await mkdir(join(root, 'state'), { recursive: true });
  await writeFile(process.env.MI_CRONS_PATH, '[]');
  await writeFile(join(root, 'state', 'approvals.json'), '[]');
  await writeFile(join(root, 'state', 'web-workers.json'), '[]');
  const brief = await dailyBrief();
  assert.ok(brief, 'daily brief renders with proposal queue');
  assert.match(brief.message, /PROPOSALS[\s\S]*1\. Review stale Tactics Journal PR/, 'daily brief includes numbered proposals');
  assert.doesNotMatch(brief.message, /[\p{Extended_Pictographic}\uFE0F]/u, 'brief proposal rendering has no emoji');
} finally {
  delete process.env.MI_ROOT;
  delete process.env.MI_PROPOSALS_PATH;
  delete process.env.MI_DAILY_BRIEF_NOTIFY;
  delete process.env.MI_OWNER_NAME;
  delete process.env.MI_CRONS_PATH;
  delete process.env.MI_CRON_LOG_PATH;
  await rm(root, { recursive: true, force: true });
}

console.log('Mi proposal queue checks passed.');
