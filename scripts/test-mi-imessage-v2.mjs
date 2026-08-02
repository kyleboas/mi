#!/usr/bin/env node
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { v2RiskClassification, v2RouteDecision } from './mi-web-chat-v2-route.mjs';

assert.equal(v2RouteDecision({ message: 'hello', workspace: { root: '/tmp', cwd: '/tmp' } }).kind, 'coordinator', 'ordinary nonempty text uses the guarded coordinator');
assert.equal(v2RiskClassification('delete the database').kind, 'never-delegate');
assert.equal(v2RiskClassification('send Kyle a message').kind, 'confirm');

const repoRoot = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const root = await mkdtemp(join(tmpdir(), 'mi-imessage-runtime-test-'));
const miRoot = join(root, 'assistant');
const stateRoot = join(root, 'state-root');
const workspace = join(root, 'workspace');
try {
  await mkdir(join(miRoot, 'pi', 'extensions'), { recursive: true, mode: 0o700 });
  await cp(join(repoRoot, 'pi', 'extensions'), join(miRoot, 'pi', 'extensions'), { recursive: true });
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  process.env.MI_ROOT = miRoot;
  process.env.MI_IMESSAGE_WORKSPACE_ROOT = workspace;
  process.env.MI_IMESSAGE_WORKSPACE_CWD = workspace;
  const { conversationIdFor, createImessageRuntime: createRuntime, deliveryIdFor, requestDigestFor } = await import('./mi-imessage-runtime.mjs');
  assert.match(conversationIdFor({ id: 'SPACE A' }, { sender: { id: '+1' } }), /^imessage-[a-f0-9]{32}$/);
  assert.notEqual(conversationIdFor({ id: 'SPACE A' }, { sender: { id: '+1' } }), conversationIdFor({ id: 'SPACE B' }, { sender: { id: '+1' } }), 'space identity separates conversations');
  assert.equal(conversationIdFor({}, { sender: { id: '+1 555' } }), conversationIdFor({}, { sender: { id: '+1  555' } }), 'sender fallback is normalized');
  let prompts = 0;
  const spawnRpc = async ({ onEvent }) => {
    prompts += 1;
    onEvent?.({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: `reply ${prompts}` }] } });
    return { ok: true, text: `reply ${prompts}`, reason: 'settled' };
  };
  const runtime = await createRuntime({ stateRoot, spawnRpc });
  const event = (space, id, text, timestamp = '2026-01-01T00:00:00Z') => ({ space: { id: space }, message: { id, timestamp, direction: 'inbound', sender: { id: '+1' }, content: { type: 'text', text } } });
  const sent = [];
  const send = async (text) => { sent.push(text); return true; };
  const first = await runtime.handleEvent({ ...event('thread-a', 'one', 'inspect this'), sendReply: send });
  const duplicate = await runtime.handleEvent({ ...event('thread-a', 'one', 'inspect this'), sendReply: send });
  const second = await runtime.handleEvent({ ...event('thread-a', 'two', 'inspect that'), sendReply: send });
  const separate = await runtime.handleEvent({ ...event('thread-b', 'three', 'inspect other'), sendReply: send });
  assert.equal(first.status, 'sent');
  assert.equal(duplicate.duplicate, true, 'duplicate after completion does not start Pi');
  assert.equal(second.status, 'sent');
  assert.equal(separate.status, 'sent');
  assert.equal(prompts, 3, 'each distinct delivery gets one Pi prompt');
  const conversationDirectory = join(stateRoot, 'imessage', 'conversations', conversationIdFor({ id: 'thread-a' }, { sender: { id: '+1' } }));
  assert.equal((await stat(join(conversationDirectory, 'session.jsonl'))).mode & 0o777, 0o600, 'Pi session file is private');
  const restartedRuntime = await createRuntime({ stateRoot, spawnRpc: async () => { prompts += 1; return { ok: true, text: 'unexpected restart prompt', reason: 'settled' }; } });
  const afterRestart = await restartedRuntime.handleEvent({ ...event('thread-a', 'one', 'inspect this'), sendReply: send });
  assert.equal(afterRestart.duplicate, true, 'duplicate delivery after restart does not start Pi');
  assert.equal(prompts, 3, 'restart does not rerun a sent delivery');

  const pendingEvent = event('pending', 'pending', 'resume this');
  const pendingConversation = conversationIdFor(pendingEvent.space, pendingEvent.message);
  const pendingDirectory = join(stateRoot, 'imessage', 'conversations', pendingConversation, 'deliveries');
  const pendingDelivery = deliveryIdFor(pendingConversation, pendingEvent.message);
  await mkdir(pendingDirectory, { recursive: true, mode: 0o700 });
  await writeFile(join(pendingDirectory, `${pendingDelivery}.json`), JSON.stringify({
    schemaVersion: 1,
    deliveryId: pendingDelivery,
    conversationId: pendingConversation,
    requestDigest: requestDigestFor(pendingConversation, pendingEvent.message, 'resume this', '2026-01-01T00:00:00.000Z'),
    status: 'received',
    receivedAt: '2026-01-01T00:00:00.000Z',
    rawMessage: 'resume this',
    taskIds: [],
  }), { mode: 0o600 });
  const resumed = await restartedRuntime.handleEvent({ ...pendingEvent, sendReply: send });
  assert.equal(resumed.status, 'sent', 'a received delivery resumes after restart');

  const conflict = await runtime.handleEvent({ ...event('thread-a', 'one', 'changed payload'), sendReply: send });
  assert.equal(conflict.reason, 'payload-conflict');
  assert.equal(prompts, 4, 'payload conflict starts no new Pi prompt');

  const missing = await runtime.handleEvent({ space: { id: 'thread-a' }, message: { timestamp: '2026-01-01T00:00:00Z', content: { type: 'text', text: 'missing id' } }, sendReply: send });
  assert.equal(missing.reason, 'missing-identity');
  assert.equal(prompts, 4);

  const delegatedCalls = [];
  const delegatedRuntime = await createRuntime({
    stateRoot: join(root, 'delegated'),
    spawnRpc: async ({ onEvent }) => {
      onEvent?.({ type: 'tool_execution_end', toolName: 'mi_orchestrator_delegate', result: { details: { taskId: 'delegated-1' } } });
      return { ok: true, text: 'delegate acknowledgement', reason: 'settled' };
    },
    daemonRequest: async (_socket, request) => {
      delegatedCalls.push(request.type);
      if (request.type === 'health') return { ok: true };
      if (request.type === 'list_tasks') return { ok: true, tasks: [{ id: 'delegated-1', status: 'complete', text: 'The delegated result.' }] };
      return { ok: true };
    },
  });
  const delegated = await delegatedRuntime.handleEvent({ ...event('thread-delegated', 'delegated', 'inspect the delegated result'), sendReply: send });
  assert.equal(delegated.reply, 'The delegated result.', 'delegated completion uses terminal task evidence');
  assert.deepEqual(delegatedCalls, ['health', 'list_tasks']);

  let firstSend = true;
  const replayed = [];
  const unsentRuntime = await createRuntime({ stateRoot: join(root, 'unsent'), spawnRpc: async () => ({ ok: true, text: 'old reply', reason: 'settled' }) });
  const unsent = await unsentRuntime.handleEvent({ ...event('thread-c', 'old', 'old'), sendReply: async (text) => { replayed.push(text); if (firstSend) { firstSend = false; return false; } return true; } });
  assert.equal(unsent.status, 'completed', 'failed Photon send retains a completed unsent delivery');
  const later = await unsentRuntime.handleEvent({ ...event('thread-c', 'new', 'new'), sendReply: async (text) => { replayed.push(text); return true; } });
  assert.equal(later.status, 'sent');
  assert.equal(replayed[1], 'old reply', 'unsent reply is sent before a later turn');

  const confirmation = await runtime.handleEvent({ ...event('thread-confirm', 'confirm-request', 'send Kyle a message'), sendReply: send });
  assert.equal(confirmation.status, 'sent');
  const confirmationId = sent.at(-1).match(/confirm ([a-f0-9]{32})/)?.[1];
  assert.ok(confirmationId, 'confirmation has an exact token');
  const wrongConversation = await runtime.handleEvent({ ...event('other-confirm', 'wrong-conversation', `confirm ${confirmationId}`), sendReply: send });
  assert.equal(wrongConversation.status, 'sent');
  assert.equal(sent.at(-1), 'I cannot find a pending action for that confirmation.');
  const approved = await runtime.handleEvent({ ...event('thread-confirm', 'approve', `confirm ${confirmationId}`), sendReply: send });
  assert.equal(approved.status, 'sent');
  const replay = await runtime.handleEvent({ ...event('thread-confirm', 'replay', `confirm ${confirmationId}`), sendReply: send });
  assert.equal(replay.status, 'sent');
  assert.equal(sent.at(-1), 'I cannot find a pending action for that confirmation.', 'confirmation replay does not repeat the action');

  const corruptConversation = conversationIdFor({ id: 'corrupt' }, { sender: { id: '+1' } });
  const corruptDirectory = join(stateRoot, 'imessage', 'conversations', corruptConversation);
  await mkdir(corruptDirectory, { recursive: true, mode: 0o700 });
  await writeFile(join(corruptDirectory, 'session.jsonl'), 'not json\n', { mode: 0o600 });
  const beforeCorrupt = prompts;
  const corrupt = await runtime.handleEvent({ ...event('corrupt', 'corrupt-turn', 'inspect'), sendReply: send });
  assert.equal(sent.at(-1), 'I could not reopen this conversation safely. Please try again.');
  assert.equal(prompts, beforeCorrupt, 'corrupted session does not start Pi');

  const order = [];
  let concurrent = 0;
  let maximumConcurrent = 0;
  const orderedRuntime = await createRuntime({
    stateRoot: join(root, 'ordered'),
    spawnRpc: async ({ prompt }) => {
      order.push(prompt.match(/Current user request:\n([^\n]+)/)?.[1] || 'unknown');
      concurrent += 1;
      maximumConcurrent = Math.max(maximumConcurrent, concurrent);
      await new Promise((resolve) => setTimeout(resolve, 20));
      concurrent -= 1;
      return { ok: true, text: `ordered ${order.at(-1)}`, reason: 'settled' };
    },
  });
  const orderedFirst = orderedRuntime.handleEvent({ ...event('ordered', 'first', 'first request', '2026-01-01T00:00:00Z'), sendReply: send });
  const orderedSecond = orderedRuntime.handleEvent({ ...event('ordered', 'second', 'second request', '2026-01-01T00:00:01Z'), sendReply: send });
  await Promise.all([orderedFirst, orderedSecond]);
  assert.deepEqual(order, ['first request', 'second request'], 'same-conversation turns stay ordered');
  const parallelRuntime = await createRuntime({
    stateRoot: join(root, 'parallel'),
    spawnRpc: async () => {
      concurrent += 1;
      maximumConcurrent = Math.max(maximumConcurrent, concurrent);
      await new Promise((resolve) => setTimeout(resolve, 20));
      concurrent -= 1;
      return { ok: true, text: 'parallel reply', reason: 'settled' };
    },
  });
  await Promise.all(Array.from({ length: 5 }, (_, index) => parallelRuntime.handleEvent({ ...event(`parallel-${index}`, `parallel-${index}`, `parallel ${index}`), sendReply: send })));
  assert.ok(maximumConcurrent <= 4, 'cross-conversation work respects the concurrency limit');

  const staleConversation = conversationIdFor({ id: 'stale' }, { sender: { id: '+1' } });
  const staleDirectory = join(stateRoot, 'imessage', 'conversations', staleConversation, 'deliveries');
  await mkdir(staleDirectory, { recursive: true, mode: 0o700 });
  const staleEvent = event('stale', 'stale', 'stale request');
  const staleId = deliveryIdFor(staleConversation, staleEvent.message);
  const staleDigest = requestDigestFor(staleConversation, staleEvent.message, 'stale request', '2026-01-01T00:00:00.000Z');
  await writeFile(join(staleDirectory, `${staleId}.json`), JSON.stringify({ schemaVersion: 1, conversationId: staleConversation, deliveryId: staleId, requestDigest: staleDigest, status: 'running', receivedAt: '2026-01-01T00:00:00Z', runningAt: '2026-01-01T00:00:00Z', rawMessage: 'stale request', taskIds: [] }), { mode: 0o600 });
  const restartedWithStale = await createRuntime({ stateRoot, spawnRpc });
  const recovered = JSON.parse(await readFile(join(staleDirectory, `${staleId}.json`), 'utf8'));
  assert.equal(recovered.status, 'interrupted', 'startup converts stale running work to interrupted');
  const interrupted = await restartedWithStale.handleEvent({ ...staleEvent, sendReply: send });
  assert.equal(interrupted.status, 'interrupted', 'interrupted work does not rerun automatically');
  assert.equal(sent.at(-1), 'That request was interrupted before it finished. Please try again.');
  console.log('Mi iMessage runtime safety and recovery checks passed.');
} finally {
  await rm(root, { recursive: true, force: true });
}
