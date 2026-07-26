#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHermeticMiEnv, runCli } from './mi-test-harness.mjs';

const fixture = await createHermeticMiEnv('mi-approvals-status-');
try {
  const env = fixture.env;
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

} finally {
  await fixture.cleanup();
}

console.log('Mi approval checks passed.');
