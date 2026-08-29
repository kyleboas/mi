#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { v2RiskClassification, v2RouteDecision } from './mi-web-chat-v2-route.mjs';

assert.equal(v2RouteDecision({ message: 'hello', workspace: { root: '/tmp', cwd: '/tmp' } }).kind, 'coordinator', 'ordinary nonempty text uses the guarded coordinator');
assert.equal(v2RiskClassification('delete the database').kind, 'never-delegate');
assert.equal(v2RiskClassification('send Kyle a message').kind, 'confirm');
assert.equal(v2RouteDecision({ message: 'Reply exactly: iMessage check passed.', workspace: { root: '/tmp', cwd: '/tmp' } }).kind, 'coordinator', 'same-conversation exact replies do not require confirmation');
assert.equal(v2RouteDecision({ message: 'reply to Alice: iMessage check passed.', workspace: { root: '/tmp', cwd: '/tmp' } }).kind, 'confirm', 'external-recipient replies still require confirmation');

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
  const { conversationIdFor, createImessageRuntime: createRuntime, deliveryIdFor, IMESSAGE_REPLIES, requestDigestFor } = await import('./mi-imessage-runtime.mjs');
  const { readPendingConfirmation } = await import('../dist/src/pending-confirmations.js');
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
  assert.equal(resumed.status, 'interrupted', 'a received delivery does not replay after restart');
  assert.equal(prompts, 3, 'an interrupted received delivery starts no Pi prompt');
  const interruptedPending = JSON.parse(await readFile(join(pendingDirectory, `${pendingDelivery}.json`), 'utf8'));
  assert.equal('rawMessage' in interruptedPending, false, 'interrupted received state erases the raw message');
  assert.equal(interruptedPending.interruptionReason, 'recovered-incomplete-delivery', 'interrupted received state keeps a fixed internal reason');

  const conflict = await runtime.handleEvent({ ...event('thread-a', 'one', 'changed payload'), sendReply: send });
  assert.equal(conflict.reason, 'payload-conflict');
  assert.equal(prompts, 3, 'payload conflict starts no new Pi prompt');

  const missing = await runtime.handleEvent({ space: { id: 'thread-a' }, message: { timestamp: '2026-01-01T00:00:00Z', content: { type: 'text', text: 'missing id' } }, sendReply: send });
  assert.equal(missing.reason, 'missing-identity');
  assert.equal(prompts, 3);

  const previousAllowedSenders = process.env.PHOTON_ALLOWED_USERS;
  const previousAllowAll = process.env.PHOTON_ALLOW_ALL_USERS;
  process.env.PHOTON_ALLOWED_USERS = '+1';
  process.env.PHOTON_ALLOW_ALL_USERS = 'true';
  const divernoteLaunches = [];
  const divernoteRuntime = await createRuntime({
    stateRoot: join(root, 'divernote'),
    spawnRpc: async ({ launch, prompt }) => {
      divernoteLaunches.push({ prompt, grants: JSON.parse(await readFile(launch.env.MI_CAPABILITY_GRANTS_FILE, 'utf8')) });
      return { ok: true, text: 'Divernote response', reason: 'settled' };
    },
  });
  const allowedDivernote = await divernoteRuntime.handleEvent({
    ...event('divernote-allowed', 'allowed', 'List my Divernote tasks'),
    senderAuthorized: true,
    sendReply: send,
  });
  const allowedDivernoteWrite = await divernoteRuntime.handleEvent({
    ...event('divernote-write', 'write', 'Add a task to Divernote: call the dentist'),
    senderAuthorized: true,
    sendReply: send,
  });
  const unverifiedDivernote = await divernoteRuntime.handleEvent({
    ...event('divernote-unverified', 'unverified', 'List my Divernote tasks'),
    senderAuthorized: false,
    sendReply: send,
  });
  const otherSenderEvent = event('divernote-other', 'other', 'List my Divernote tasks');
  otherSenderEvent.message.sender.id = '+2';
  const otherDivernote = await divernoteRuntime.handleEvent({ ...otherSenderEvent, senderAuthorized: true, sendReply: send });
  assert.equal(allowedDivernote.status, 'sent');
  assert.equal(allowedDivernoteWrite.status, 'sent');
  assert.equal(unverifiedDivernote.status, 'sent');
  assert.equal(otherDivernote.status, 'sent');
  assert.match(divernoteLaunches[0].prompt, /Divernote access for this request: read/, 'a bridge-verified named sender receives a read grant');
  assert.ok(divernoteLaunches[0].grants.grants.some((grant) => grant.resource === 'diver-notes://vault' && grant.rights.includes('read')), 'the allowed sender gets only the required Divernote read capability');
  assert.match(divernoteLaunches[1].prompt, /Divernote access for this request: write/, 'a bridge-verified named sender receives a scoped Divernote write grant for an explicit write');
  assert.ok(divernoteLaunches[1].grants.grants.some((grant) => grant.resource === 'diver-notes://vault' && grant.rights.includes('read') && grant.rights.includes('write')), 'the allowed sender gets only the reviewed Divernote write capability');
  for (const launch of divernoteLaunches.slice(2)) {
    assert.match(launch.prompt, /Divernote access for this request: none/, 'unverified and unmatched senders remain default-deny');
    assert.ok(!launch.grants.grants.some((grant) => grant.resource === 'diver-notes://vault'), 'unverified and unmatched senders receive no Divernote capability even when transport allow-all is set');
  }
  if (previousAllowedSenders === undefined) delete process.env.PHOTON_ALLOWED_USERS;
  else process.env.PHOTON_ALLOWED_USERS = previousAllowedSenders;
  if (previousAllowAll === undefined) delete process.env.PHOTON_ALLOW_ALL_USERS;
  else process.env.PHOTON_ALLOW_ALL_USERS = previousAllowAll;

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
  const wrongDeny = await runtime.handleEvent({ ...event('thread-confirm', 'wrong-deny', 'deny 00000000000000000000000000000000'), sendReply: send });
  assert.equal(wrongDeny.status, 'sent');
  assert.equal(sent.at(-1), 'I cannot find a pending action for that confirmation.', 'wrong denial token does not clear a pending action');
  const approved = await runtime.handleEvent({ ...event('thread-confirm', 'approve', `confirm ${confirmationId}`), sendReply: send });
  assert.equal(approved.status, 'sent');
  const replay = await runtime.handleEvent({ ...event('thread-confirm', 'replay', `confirm ${confirmationId}`), sendReply: send });
  assert.equal(replay.status, 'sent');
  assert.equal(sent.at(-1), 'I cannot find a pending action for that confirmation.', 'confirmation replay does not repeat the action');

  const denyPromptsBefore = prompts;
  const denyRequest = await runtime.handleEvent({ ...event('thread-deny', 'deny-request', 'send Kyle a message'), sendReply: send });
  assert.equal(denyRequest.status, 'sent');
  const denialId = sent.at(-1).match(/deny ([a-f0-9]{32})/)?.[1];
  assert.ok(denialId, 'confirmation has an exact denial token');
  const wrongDenialConversation = await runtime.handleEvent({ ...event('other-deny', 'wrong-deny-conversation', `deny ${denialId}`), sendReply: send });
  assert.equal(wrongDenialConversation.status, 'sent');
  assert.equal(sent.at(-1), 'I cannot find a pending action for that confirmation.', 'wrong-conversation denial does not clear a pending action');
  assert.ok(await readPendingConfirmation(conversationIdFor({ id: 'thread-deny' }, { sender: { id: '+1' } }), { statePath: join(stateRoot, 'pending-confirmations.json') }), 'wrong-conversation denial preserves pending state');
  const denied = await runtime.handleEvent({ ...event('thread-deny', 'deny', `deny ${denialId}`), sendReply: send });
  assert.equal(denied.status, 'sent');
  assert.equal(sent.at(-1), 'Okay, I will not proceed with that action.');
  assert.equal(prompts, denyPromptsBefore, 'valid denial does not start Pi');
  assert.equal(await readPendingConfirmation(conversationIdFor({ id: 'thread-deny' }, { sender: { id: '+1' } }), { statePath: join(stateRoot, 'pending-confirmations.json') }), null, 'valid denial clears pending state');
  const denialReplay = await runtime.handleEvent({ ...event('thread-deny', 'deny-replay', `deny ${denialId}`), sendReply: send });
  assert.equal(denialReplay.status, 'sent');
  assert.equal(sent.at(-1), 'I cannot find a pending action for that confirmation.', 'denial replay does not repeat cancellation');

  const corruptConversation = conversationIdFor({ id: 'corrupt' }, { sender: { id: '+1' } });
  const corruptDirectory = join(stateRoot, 'imessage', 'conversations', corruptConversation);
  await mkdir(corruptDirectory, { recursive: true, mode: 0o700 });
  await writeFile(join(corruptDirectory, 'session.jsonl'), 'not json\n', { mode: 0o600 });
  const beforeCorrupt = prompts;
  const corrupt = await runtime.handleEvent({ ...event('corrupt', 'corrupt-turn', 'inspect'), sendReply: send });
  assert.equal(sent.at(-1), 'I could not reopen this conversation safely. Please try again.');
  assert.equal(prompts, beforeCorrupt, 'corrupted session does not start Pi');

  const ordinaryTermRuntime = await createRuntime({
    stateRoot: join(root, 'ordinary-term'),
    spawnRpc: async () => ({ ok: true, text: 'Found the saved power outages prompt.', reason: 'settled' }),
  });
  const ordinaryTerm = await ordinaryTermRuntime.handleEvent({ ...event('ordinary-term', 'ordinary-term', 'find the saved note'), sendReply: send });
  assert.equal(ordinaryTerm.reply, 'Found the saved power outages prompt.', 'ordinary note text is not mistaken for internal prompt leakage');

  const diagnosticRawDetail = 'PRIVATE_PROMPT /home/kyle/private/session.jsonl task-secret test-token-not-secret';
  const diagnosticLogs = [];
  const originalConsoleError = console.error;
  console.error = (...args) => diagnosticLogs.push(args.map(String).join(' '));
  let diagnostic;
  try {
    const diagnosticRuntime = await createRuntime({
      stateRoot: join(root, 'diagnostics'),
      spawnRpc: async () => ({ ok: false, reason: 'prompt-rejected', failureClass: 'provider-auth-failed', stderr: diagnosticRawDetail }),
    });
    diagnostic = await diagnosticRuntime.handleEvent({ ...event('diagnostics', 'failed-turn', 'inspect the failure'), sendReply: send });
  } finally {
    console.error = originalConsoleError;
  }
  assert.equal(diagnostic.status, 'sent');
  assert.equal(sent.at(-1), IMESSAGE_REPLIES.startFailure, 'diagnostics keep the generic user-facing reply');
  assert.doesNotMatch(JSON.stringify(diagnostic), /PRIVATE_PROMPT|session\.jsonl|task-secret|test-token-not-secret/, 'raw rejection detail cannot reach runtime results');
  assert.deepEqual(diagnosticLogs, ['Diver iMessage coordinator failed: provider-auth-failed'], 'runtime logs the allowlisted failure class without untrusted detail when none is present');
  assert.doesNotMatch(diagnosticLogs.join('\n'), /PRIVATE_PROMPT|session\.jsonl|task-secret|test-token-not-secret/, 'raw rejection detail cannot reach runtime logs');

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
  const staleFile = join(staleDirectory, `${staleId}.json`);
  await writeFile(staleFile, JSON.stringify({ schemaVersion: 1, conversationId: staleConversation, deliveryId: staleId, requestDigest: staleDigest, status: 'running', receivedAt: '2026-01-01T00:00:00Z', runningAt: '2026-01-01T00:00:00Z', rawMessage: 'stale request', taskIds: [] }), { mode: 0o600 });
  await mkdir(`${staleFile}.lock`, { mode: 0o700 });
  await writeFile(join(`${staleFile}.lock`, 'owner'), JSON.stringify({ pid: 4_000_000, createdAt: '2026-01-01T00:00:00.000Z', nonce: 'stale-lock' }), { mode: 0o600 });
  const restartedWithStale = await createRuntime({ stateRoot, spawnRpc });
  const recovered = JSON.parse(await readFile(join(staleDirectory, `${staleId}.json`), 'utf8'));
  assert.equal(recovered.status, 'interrupted', 'startup converts stale running work to interrupted');
  assert.equal('rawMessage' in recovered, false, 'startup recovery erases the stale running raw message');
  assert.equal(recovered.interruptionReason, 'recovered-incomplete-delivery', 'startup recovery keeps a fixed internal reason');
  const interrupted = await restartedWithStale.handleEvent({ ...staleEvent, sendReply: send });
  assert.equal(interrupted.status, 'interrupted', 'interrupted work does not rerun automatically');
  assert.equal(sent.at(-1), 'That request was interrupted before it finished. Please try again.');

  const orderingStateRoot = join(root, 'ordering-recovery');
  const orderingRecoveryRuntime = await createRuntime({ stateRoot: orderingStateRoot, spawnRpc });
  const orderingOldEvent = event('ordering-recovery', 'old', 'old request', '2026-01-01T00:00:00Z');
  const orderingConversation = conversationIdFor(orderingOldEvent.space, orderingOldEvent.message);
  const orderingDirectory = join(orderingStateRoot, 'imessage', 'conversations', orderingConversation);
  const orderingDeliveries = join(orderingDirectory, 'deliveries');
  const orderingOldId = deliveryIdFor(orderingConversation, orderingOldEvent.message);
  await mkdir(orderingDeliveries, { recursive: true, mode: 0o700 });
  await writeFile(join(orderingDeliveries, `${orderingOldId}.json`), JSON.stringify({
    schemaVersion: 1,
    deliveryId: orderingOldId,
    conversationId: orderingConversation,
    requestDigest: requestDigestFor(orderingConversation, orderingOldEvent.message, 'old request', '2026-01-01T00:00:00.000Z'),
    status: 'received',
    receivedAt: '2026-01-01T00:00:00.000Z',
    rawMessage: 'old request',
    taskIds: [],
  }), { mode: 0o600 });
  const orderingNew = await orderingRecoveryRuntime.handleEvent({ ...event('ordering-recovery', 'new', 'new request', '2026-01-01T00:00:01Z'), sendReply: send });
  assert.equal(orderingNew.status, 'sent', 'newer work proceeds after stale earlier state is resolved');
  const orderingRecovered = JSON.parse(await readFile(join(orderingDeliveries, `${orderingOldId}.json`), 'utf8'));
  assert.equal(orderingRecovered.status, 'interrupted', 'newer work resolves an earlier received delivery first');
  assert.equal('rawMessage' in orderingRecovered, false, 'ordering recovery erases the earlier raw message');

  const multiProcessRoot = join(root, 'multi-process');
  const multiProcessWorkspace = join(root, 'multi-process-workspace');
  const launches = join(root, 'multi-process-launches');
  await mkdir(multiProcessWorkspace, { recursive: true, mode: 0o700 });
  const runner = join(root, 'duplicate-runtime.mjs');
  await writeFile(runner, `
    import { appendFile } from 'node:fs/promises';
    import { createImessageRuntime } from ${JSON.stringify(new URL('./mi-imessage-runtime.mjs', import.meta.url).href)};
    const event = { space: { id: 'multi-process' }, message: { id: 'same-delivery', timestamp: '2026-01-01T00:00:00Z', direction: 'inbound', sender: { id: '+1' }, content: { type: 'text', text: 'one launch only' } } };
    const runtime = await createImessageRuntime({
      stateRoot: process.env.TEST_STATE_ROOT,
      spawnRpc: async ({ onEvent }) => {
        await appendFile(process.env.TEST_LAUNCHES, 'launch\\n');
        await new Promise((resolve) => setTimeout(resolve, 80));
        onEvent?.({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'one reply' }] } });
        return { ok: true, text: 'one reply', reason: 'settled' };
      },
    });
    const result = await runtime.handleEvent({ ...event, sendReply: async () => true });
    if (!['sent', 'completed'].includes(result.status)) throw new Error(JSON.stringify(result));
  `);
  const childEnvironment = {
    ...process.env,
    HOME: root,
    MI_ROOT: miRoot,
    MI_IMESSAGE_WORKSPACE_ROOT: multiProcessWorkspace,
    MI_IMESSAGE_WORKSPACE_CWD: multiProcessWorkspace,
    TEST_STATE_ROOT: multiProcessRoot,
    TEST_LAUNCHES: launches,
  };
  const runChild = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [runner], { cwd: repoRoot, env: childEnvironment, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('exit', (status) => status === 0 ? resolve() : reject(new Error(`duplicate runtime exited ${status}: ${stderr}`)));
  });
  await Promise.all([runChild(), runChild()]);
  assert.equal((await readFile(launches, 'utf8')).trim().split('\\n').filter(Boolean).length, 1, 'independent runtimes launch Pi once for a duplicate delivery');
  console.log('Mi iMessage runtime safety and recovery checks passed.');
} finally {
  await rm(root, { recursive: true, force: true });
}
