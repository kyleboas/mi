import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runOpportunityScans } from '../dist/src/opportunity-scans.js';
import { readProposalQueue } from '../dist/src/proposals.js';

const root = await mkdtemp(join(tmpdir(), 'mi-opportunity-scans-'));
try {
  const plans = join(root, 'plans');
  const state = join(root, 'assistant', 'state');
  await mkdir(plans, { recursive: true });
  await mkdir(state, { recursive: true });
  const stale = join(plans, 'stale-plan.md');
  await writeFile(stale, '# Stale Plan\n\nStill relevant.');
  const old = new Date(Date.now() - 9 * 24 * 60 * 60_000);
  await utimes(stale, old, old);
  await writeFile(join(plans, 'deadline-plan.md'), '# Deadline Plan\n\nLaunch target 2026-08-15.');
  await writeFile(join(plans, 'README.md'), '# Plans index\n');

  process.env.MI_ROOT = join(root, 'assistant');
  process.env.MI_PLANS_DIR = plans;
  process.env.MI_PROPOSALS_PATH = join(state, 'proposals.json');
  process.env.MI_OPPORTUNITY_SCAN_MAX_PROPOSALS = '3';
  const result = await runOpportunityScans();
  assert.equal(result.status, 'ok');
  assert.equal(result.proposals, 2);
  const queue = await readProposalQueue(process.env.MI_PROPOSALS_PATH);
  assert.equal(queue.proposals.length, 2, 'scan writes proposal queue entries');
  assert.ok(queue.proposals.some((proposal) => proposal.source === 'stale-work-sweep'), 'scan detects stale work');
  assert.ok(queue.proposals.some((proposal) => proposal.source === 'deadline-radar'), 'scan detects dated commitments');

  const again = await runOpportunityScans();
  assert.equal(again.status, 'ok');
  assert.equal((await readProposalQueue(process.env.MI_PROPOSALS_PATH)).proposals.length, 2, 'scan dedupes repeat findings');
} finally {
  delete process.env.MI_ROOT;
  delete process.env.MI_PLANS_DIR;
  delete process.env.MI_PROPOSALS_PATH;
  delete process.env.MI_OPPORTUNITY_SCAN_MAX_PROPOSALS;
  await rm(root, { recursive: true, force: true });
}

console.log('Mi opportunity scan checks passed.');
