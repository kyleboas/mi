#!/usr/bin/env node
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { classifyCoordinatorFailure, COORDINATOR_FAILURE_CLASSES, runMiCoordinatorRpc } from './mi-imessage-coordinator.mjs';

const root = await mkdtemp(path.join(tmpdir(), 'mi-coordinator-rpc-'));
const record = path.join(root, 'record.jsonl');
const good = path.join(root, 'good.mjs');
const stalled = path.join(root, 'stalled.mjs');
const exited = path.join(root, 'exited.mjs');
const stdoutLimit = path.join(root, 'stdout-limit.mjs');
const malformed = path.join(root, 'malformed.mjs');
const rejected = path.join(root, 'rejected.mjs');
const noAssistant = path.join(root, 'no-assistant.mjs');

function launch(command) {
  return { command, args: [], cwd: root, env: { ...process.env, RECORD: record } };
}

try {
  await writeFile(good, String.raw`#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
process.stdin.on('data', (chunk) => {
  const request = JSON.parse(chunk.toString('utf8'));
  appendFileSync(process.env.RECORD, JSON.stringify({ phase: 'prompt', request, stdinEnded: process.stdin.readableEnded }) + '\n');
  process.stderr.write('x'.repeat(200000));
  process.stdout.write('not-json\n');
  process.stdout.write(JSON.stringify({ type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: 'PRIVATE INTERNAL PROMPT' }] } }) + '\n');
  process.stdout.write(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Only this assistant result is safe.' }] } }) + '\n');
  process.stdout.write(JSON.stringify({ type: 'agent_settled' }) + '\n');
});
process.stdin.on('end', () => appendFileSync(process.env.RECORD, JSON.stringify({ phase: 'end' }) + '\n'));
`, { mode: 0o755 });
  await writeFile(stalled, String.raw`#!/usr/bin/env node
process.stdin.on('data', () => { process.stderr.write('still alive\n'); });
setInterval(() => {}, 1000);
`, { mode: 0o755 });
  await writeFile(exited, String.raw`#!/usr/bin/env node
process.stdin.on('data', () => process.exit(3));
`, { mode: 0o755 });
  await writeFile(stdoutLimit, String.raw`#!/usr/bin/env node
process.stdin.on('data', () => process.stdout.write('x'.repeat(4096)));
`, { mode: 0o755 });
  await writeFile(malformed, String.raw`#!/usr/bin/env node
process.stdin.on('data', () => process.stdout.write('x'.repeat(4096)));
`, { mode: 0o755 });
  await writeFile(rejected, String.raw`#!/usr/bin/env node
process.stdin.on('data', (chunk) => { const request = JSON.parse(chunk.toString()); process.stderr.write('provider authentication failed: PRIVATE_PROMPT /home/kyle/private/session.jsonl test-token-not-secret\\n'); process.stdout.write(JSON.stringify({ type: 'response', id: request.id, success: false, error: 'unclassified detail' }) + '\n'); });
`, { mode: 0o755 });
  await writeFile(noAssistant, String.raw`#!/usr/bin/env node
process.stdin.on('data', () => process.stdout.write(JSON.stringify({ type: 'agent_settled' }) + '\n'));
`, { mode: 0o755 });
  await Promise.all([good, stalled, exited, stdoutLimit, malformed, rejected, noAssistant].map((file) => chmod(file, 0o755)));

  assert.deepEqual(COORDINATOR_FAILURE_CLASSES, [
    'prompt-rejected', 'provider-unavailable', 'provider-auth-failed', 'model-unavailable',
    'session-invalid', 'rpc-protocol-error', 'unknown',
  ], 'diagnostics expose only the reviewed static classes');
  const recognized = [
    [{ response: { type: 'response', success: false, error: 'prompt was rejected' } }, 'prompt-rejected'],
    [{ stderr: 'upstream provider is unavailable' }, 'provider-unavailable'],
    [{ response: { error: 'provider authentication failed' } }, 'provider-auth-failed'],
    [{ stderr: 'model was not found' }, 'model-unavailable'],
    [{ response: { error: 'session file is corrupt' } }, 'session-invalid'],
    [{ stderr: 'RPC protocol parse error' }, 'rpc-protocol-error'],
  ];
  for (const [input, expected] of recognized) assert.equal(classifyCoordinatorFailure(input), expected, `${expected} is recognized safely`);
  assert.equal(classifyCoordinatorFailure({ response: { error: 'PRIVATE_PROMPT /home/kyle/private/session.jsonl test-token-not-secret' } }), 'unknown', 'unclassified detail falls back to unknown');

  const result = await runMiCoordinatorRpc({
    launch: launch(good), requestId: 'turn-1', prompt: 'safe request', stderrCap: 64, timeoutMs: 3000,
  });
  assert.equal(result.ok, true, 'assistant turn settles while RPC stdin remains open');
  assert.equal(result.text, 'Only this assistant result is safe.', 'user message_end content never becomes the completion');
  assert.equal(result.stderr, undefined, 'raw stderr is not returned in the RPC result');
  await new Promise((resolve) => setTimeout(resolve, 40));
  const events = (await readFile(record, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(events.find((event) => event.phase === 'prompt').stdinEnded, false, 'stdin was not ended before agent_settled');
  assert.ok(events.some((event) => event.phase === 'end'), 'stdin closes after settlement for process cleanup');

  const timeout = await runMiCoordinatorRpc({ launch: launch(stalled), requestId: 'turn-2', prompt: 'wait', timeoutMs: 1050, killGraceMs: 20 });
  assert.equal(timeout.ok, false, 'unsettled process fails closed');
  assert.equal(timeout.reason, 'timeout', 'unsettled process is timed out and killed');

  const failed = await runMiCoordinatorRpc({ launch: launch(exited), requestId: 'turn-3', prompt: 'exit', timeoutMs: 3000 });
  assert.equal(failed.ok, false, 'child exit before settlement is a failure');
  assert.match(failed.reason, /^exited-/, 'exit failure is correlated to the current turn');

  const capped = await runMiCoordinatorRpc({ launch: launch(stdoutLimit), requestId: 'turn-4', prompt: 'cap', stdoutCap: 1024, timeoutMs: 3000 });
  assert.equal(capped.reason, 'stdout-limit', 'oversized coordinator stdout is killed and rejected');
  const badRecord = await runMiCoordinatorRpc({ launch: launch(malformed), requestId: 'turn-5', prompt: 'bad', stdoutCap: 8192, recordCap: 1024, timeoutMs: 3000 });
  assert.equal(badRecord.reason, 'malformed-output', 'oversized unterminated output record is rejected');
  const promptRejected = await runMiCoordinatorRpc({ launch: launch(rejected), requestId: 'turn-6', prompt: 'reject', timeoutMs: 3000 });
  assert.equal(promptRejected.reason, 'prompt-rejected', 'explicit RPC prompt rejection fails immediately');
  assert.equal(promptRejected.failureClass, 'provider-auth-failed', 'RPC rejection diagnostics classify bounded stderr');
  assert.equal(promptRejected.stderr, undefined, 'RPC rejection results do not expose raw stderr');
  assert.doesNotMatch(JSON.stringify(promptRejected), /PRIVATE_PROMPT|session\.jsonl|test-token-not-secret|unclassified detail/, 'raw rejection detail cannot reach the result');
  const settledWithoutAssistant = await runMiCoordinatorRpc({ launch: launch(noAssistant), requestId: 'turn-7', prompt: 'empty', timeoutMs: 3000 });
  assert.equal(settledWithoutAssistant.reason, 'settled-without-assistant', 'settlement without a final assistant response fails closed');

  console.log('Mi coordinator RPC lifecycle checks passed.');
} finally {
  await rm(root, { recursive: true, force: true });
}
