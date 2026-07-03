#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHermeticMiEnv, runCli } from './mi-test-harness.mjs';

const fixture = await createHermeticMiEnv('mi-approvals-status-');
try {
  const env = { ...fixture.env, MI_TACTICS_HEALTH_STEPS: '', MI_PROJECT_STATUS_ENABLED: 'false' };
  const cwd = fixture.root;
  await mkdir(join(cwd, 'state'), { recursive: true });
  await writeFile(join(cwd, 'state', 'approvals.json'), JSON.stringify([
    { id: 'abc12345', createdAt: new Date().toISOString(), status: 'pending', prompt: 'deploy now?', reason: 'deploy requires approval' },
    { id: 'cap99999', createdAt: new Date().toISOString(), status: 'pending', prompt: 'edit file', reason: 'missing write grant', resource: 'file:///tmp/example', rights: ['write'], principal: { type: 'user', id: 'Kyle' } }
  ], null, 2));

  let result = runCli(['approvals'], { env, cwd });
  assert.match(result.stdout, /1\. abc12345 - deploy requires approval/);
  assert.match(result.stdout, /2\. cap99999 - missing write grant/);

  result = runCli(['approvals', 'reject', 'abc'], { env, cwd });
  assert.match(result.stdout, /Rejected abc12345/);
  let approvals = JSON.parse(await readFile(join(cwd, 'state', 'approvals.json'), 'utf8'));
  assert.equal(approvals.find((item) => item.id === 'abc12345').status, 'rejected');

  result = runCli(['approvals', 'approve', 'cap'], { env, cwd });
  assert.match(result.stdout, /Approved cap99999/);
  assert.match(result.stdout, /minted capability/);
  approvals = JSON.parse(await readFile(join(cwd, 'state', 'approvals.json'), 'utf8'));
  assert.equal(approvals.find((item) => item.id === 'cap99999').status, 'approved');

  result = runCli(['approvals'], { env, cwd });
  assert.match(result.stdout, /No pending approvals/);

  await writeFile(join(cwd, 'state', 'approvals.json'), JSON.stringify([{ id: 'pending1', createdAt: new Date().toISOString(), status: 'pending', prompt: 'merge?', reason: 'merge requires approval' }], null, 2));
  await mkdir(join(fixture.miRoot, 'state'), { recursive: true });
  await writeFile(join(fixture.miRoot, 'state', 'proposals.json'), JSON.stringify({ version: 1, proposals: [{ id: 'p1', createdAt: new Date().toISOString(), source: 'test', title: 'Review proposal', action: 'Reply 1', status: 'queued', dedupeKey: 'p1' }] }, null, 2));
  result = runCli(['proposals'], { env, cwd });
  assert.match(result.stdout, /1\. p1 - Review proposal: Reply 1/);
  result = runCli(['proposals', 'accept', '1'], { env, cwd });
  assert.match(result.stdout, /Accepted p1/);
  let proposals = JSON.parse(await readFile(join(fixture.miRoot, 'state', 'proposals.json'), 'utf8'));
  assert.equal(proposals.proposals[0].status, 'accepted');
  await writeFile(join(fixture.miRoot, 'state', 'proposals.json'), JSON.stringify({ version: 1, proposals: [{ id: 'p2', createdAt: new Date().toISOString(), source: 'test', title: 'Reject proposal', action: 'Reply 1', status: 'queued', dedupeKey: 'p2' }] }, null, 2));
  result = runCli(['proposals', 'reject', 'p2'], { env, cwd });
  assert.match(result.stdout, /Rejected p2/);

  result = runCli(['status'], { env, cwd });
  assert.match(result.stdout, /^Mi status/);
  assert.match(result.stdout, /Pending approvals: 1/);
  assert.match(result.stdout, /Queued proposals: 0/);
  assert.match(result.stdout, /Standing delegations:/);

  result = runCli(['delegations'], { env, cwd });
  assert.match(result.stdout, /No standing delegations configured|budget \d+\/day/);
} finally {
  await fixture.cleanup();
}

console.log('Mi approvals/status checks passed.');
