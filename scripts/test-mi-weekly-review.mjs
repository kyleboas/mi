import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { enqueueProposal } from '../dist/src/proposals.js';
import { renderWeeklyReview, weeklyReviewDue } from '../dist/src/weekly-review.js';

const root = await mkdtemp(join(tmpdir(), 'mi-weekly-review-'));
try {
  process.env.MI_ROOT = join(root, 'assistant');
  process.env.MI_PROPOSALS_PATH = join(root, 'assistant', 'state', 'proposals.json');
  await mkdir(join(root, 'assistant', 'state'), { recursive: true });
  await enqueueProposal({ source: 'deadline-radar', title: 'Decide launch checkpoint', action: 'Reply 1 and I will draft the checklist', dedupeKey: 'weekly-test' });
  const projectsStatusPath = join(root, 'projects-status.md');
  await writeFile(projectsStatusPath, `# Projects Status\n\n| Repo | Local Path | Branch | Open PRs | Stale Branches | Monitor Health | Plan Status | Purpose |\n|---|---|---|---:|---:|---|---|---|\n| kyleboas/example | ${root}/repo | main | not checked | 2 | unknown | none | Example |\n`);
  assert.equal(weeklyReviewDue(undefined, new Date('2026-07-05T15:00:00Z')), true, 'weekly review is due on Sunday');
  assert.equal(weeklyReviewDue('2026-07-05', new Date('2026-07-05T15:00:00Z')), false, 'weekly review sends once per local day');
  assert.equal(weeklyReviewDue(undefined, new Date('2026-07-06T15:00:00Z')), false, 'weekly review skips non-review days');
  const message = await renderWeeklyReview({ projectsStatusPath, maxProposals: 3 });
  assert.match(message, /^Weekly review/);
  assert.match(message, /WHAT MOVED[\s\S]*STUCK OR RISKY[\s\S]*DECISIONS[\s\S]*SELF-AUDIT/);
  assert.match(message, /1\. Decide launch checkpoint - Reply 1 and I will draft the checklist/);
  assert.match(message, /kyleboas\/example/);
  assert.doesNotMatch(message, /[\p{Extended_Pictographic}\uFE0F]/u, 'weekly review has no emoji');
} finally {
  delete process.env.MI_ROOT;
  delete process.env.MI_PROPOSALS_PATH;
  await rm(root, { recursive: true, force: true });
}

console.log('Mi weekly review checks passed.');
