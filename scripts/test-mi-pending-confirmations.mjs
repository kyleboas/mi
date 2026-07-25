#!/usr/bin/env node
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  classifyConfirmationReply,
  clearPendingConfirmation,
  createPendingConfirmation,
  readPendingConfirmation,
} from '../dist/src/pending-confirmations.js';

const root = await mkdtemp(join(tmpdir(), 'mi-pending-confirmations-'));
const statePath = join(root, 'state', 'pending-confirmations.json');
const at = (value) => new Date(value);
const lockPath = `${statePath}.lock`;
await mkdir(join(root, 'state'), { recursive: true });
try {
  // A live owner and a fresh malformed file are both fail-closed. Neither is
  // old enough to justify recovery.
  await writeFile(lockPath, JSON.stringify({ pid: process.pid, createdAt: Date.now(), nonce: 'a'.repeat(32) }), { mode: 0o600 });
  await assert.rejects(() => createPendingConfirmation({ threadId: 'live-lock', summary: 'safe', riskReason: 'test' }, { statePath }), /Could not lock/);
  await rm(lockPath, { force: true });
  await writeFile(lockPath, '{not metadata', { mode: 0o600 });
  await assert.rejects(() => createPendingConfirmation({ threadId: 'fresh-malformed-lock', summary: 'safe', riskReason: 'test' }, { statePath }), /Could not lock/);
  await rm(lockPath, { force: true });

  // A stale recovery marker from a dead owner is reclaimed before the old
  // lock. This covers a crash after the marker directory was created.
  const staleTime = Date.now() - 120_000;
  const recoveryPath = `${lockPath}.recovery`;
  await mkdir(recoveryPath, { mode: 0o700 });
  await writeFile(join(recoveryPath, 'owner'), JSON.stringify({ pid: 4_000_000, createdAt: staleTime, nonce: 'c'.repeat(32) }), { mode: 0o600 });
  await utimes(recoveryPath, staleTime / 1000, staleTime / 1000);
  await writeFile(lockPath, JSON.stringify({ pid: 4_000_000, createdAt: staleTime, nonce: 'b'.repeat(32) }), { mode: 0o600 });
  await utimes(lockPath, staleTime / 1000, staleTime / 1000);
  const first = await createPendingConfirmation({ threadId: 'thread-a', summary: 'Send the approved reply', riskReason: 'This sends an external message', continuationRef: 'resume-1', objective: 'Deploy the garden plan change', actionClass: 'confirmed-high-impact' }, { statePath, now: at('2026-01-01T00:00:00Z') });
  assert.equal(await stat(lockPath).then(() => true, () => false), false, 'recovered lock is cleaned after the normal path');
  assert.equal(await stat(recoveryPath).then(() => true, () => false), false, 'stale recovery marker is cleaned');
  const storedFirst = await readPendingConfirmation('thread-a', { statePath, now: at('2026-01-01T00:01:00Z') });
  assert.equal(storedFirst.id, first.id);
  assert.equal(storedFirst.objective, 'Deploy the garden plan change', 'bounded approved objective persists for one confirmation');
  assert.equal(storedFirst.actionClass, 'confirmed-high-impact');
  let second = await createPendingConfirmation({ threadId: 'thread-a', summary: 'Send the replacement reply', riskReason: 'This sends an external message' }, { statePath, now: at('2026-01-01T00:02:00Z') });
  assert.notEqual(second.id, first.id);
  assert.equal((await readPendingConfirmation('thread-a', { statePath, now: at('2026-01-01T00:02:01Z') })).id, second.id);
  assert.equal((await readPendingConfirmation('thread-b', { statePath, now: at('2026-01-01T00:02:01Z') })), null);

  assert.equal((await classifyConfirmationReply({ threadId: 'thread-b', reply: `confirm ${second.id}` }, { statePath, now: at('2026-01-01T00:02:01Z') })).kind, 'not_found');
  assert.equal((await classifyConfirmationReply({ threadId: 'thread-a', reply: 'okay maybe' }, { statePath, now: at('2026-01-01T00:02:01Z') })).kind, 'unclear');

  const concurrentRecord = await createPendingConfirmation({ threadId: 'thread-concurrent', summary: 'Send the approved reply', riskReason: 'This sends an external message' }, { statePath, now: at('2026-01-01T00:02:20Z') });
  const concurrent = await Promise.all([
    classifyConfirmationReply({ threadId: 'thread-concurrent', reply: `confirm ${concurrentRecord.id}` }, { statePath, now: at('2026-01-01T00:02:30Z') }),
    classifyConfirmationReply({ threadId: 'thread-concurrent', reply: `confirm ${concurrentRecord.id}` }, { statePath, now: at('2026-01-01T00:02:30Z') }),
  ]);
  assert.deepEqual(concurrent.map((result) => result.kind).sort(), ['confirm', 'not_found'], 'concurrent resolution authorizes a record only once');

  const replay = await createPendingConfirmation({ threadId: 'thread-replay', summary: 'Send the approved reply', riskReason: 'This sends an external message' }, { statePath, now: at('2026-01-01T00:02:45Z') });
  assert.equal((await classifyConfirmationReply({ threadId: 'thread-replay', reply: `confirm ${replay.id}` }, { statePath, now: at('2026-01-01T00:02:46Z') })).kind, 'confirm');
  assert.equal((await classifyConfirmationReply({ threadId: 'thread-replay', reply: `confirm ${replay.id}` }, { statePath, now: at('2026-01-01T00:02:47Z') })).kind, 'not_found', 'replayed confirmation cannot authorize again');
  assert.equal((await classifyConfirmationReply({ threadId: 'thread-a', reply: `confirm ${second.id}` }, { statePath, now: at('2026-01-01T00:03:00Z') })).kind, 'confirm');
  assert.equal((await classifyConfirmationReply({ threadId: 'thread-a', reply: `confirm ${second.id}` }, { statePath, now: at('2026-01-01T00:03:01Z') })).kind, 'not_found');

  const denied = await createPendingConfirmation({ threadId: 'thread-deny', summary: 'Remove the old draft', riskReason: 'This deletes user data' }, { statePath, now: at('2026-01-01T00:04:00Z') });
  assert.equal((await classifyConfirmationReply({ threadId: 'thread-deny', reply: `deny ${denied.id}` }, { statePath, now: at('2026-01-01T00:04:01Z') })).kind, 'deny');
  assert.equal((await classifyConfirmationReply({ threadId: 'thread-deny', reply: `deny ${denied.id}` }, { statePath, now: at('2026-01-01T00:04:01Z') })).kind, 'not_found');

  const expired = await createPendingConfirmation({ threadId: 'thread-expired', summary: 'Run the approved task', riskReason: 'This changes data' }, { statePath, now: at('2026-01-01T00:00:00Z'), ttlMs: 1000 });
  assert.equal((await readPendingConfirmation('thread-expired', { statePath, now: at('2026-01-01T00:00:02Z') })), null);
  assert.equal((await classifyConfirmationReply({ threadId: 'thread-expired', reply: `confirm ${expired.id}` }, { statePath, now: at('2026-01-01T00:00:02Z') })).kind, 'expired');

  await assert.rejects(() => createPendingConfirmation({ threadId: 'secret', summary: 'Use the API key abc', riskReason: 'reason' }, { statePath }));
  await assert.rejects(() => createPendingConfirmation({ threadId: 'secret', summary: 'safe', riskReason: 'Read the model prompt' }, { statePath }));
  await writeFile(statePath, '{corrupt', { mode: 0o600 });
  assert.equal((await classifyConfirmationReply({ threadId: 'thread-a', reply: `confirm ${second.id}` }, { statePath, now: at('2026-01-01T00:05:00Z') })).kind, 'not_found');
  const repaired = await createPendingConfirmation({ threadId: 'thread-repaired', summary: 'Read a report', riskReason: 'No external side effect' }, { statePath });
  assert.equal((await readPendingConfirmation('thread-repaired', { statePath, now: at('2026-01-01T00:06:00Z') })).id, repaired.id);
  assert.equal((await clearPendingConfirmation('thread-repaired', { statePath })), true);
  assert.equal((await clearPendingConfirmation('thread-repaired', { statePath })), false);
  assert.equal((await stat(statePath)).mode & 0o777, 0o600);
  assert.equal((await stat(join(root, 'state'))).mode & 0o777, 0o700);
  JSON.parse(await readFile(statePath, 'utf8'));
} finally {
  // The temporary directory is intentionally left for the OS test cleanup; no live MI state is touched.
}
console.log('Mi pending confirmation checks passed.');
