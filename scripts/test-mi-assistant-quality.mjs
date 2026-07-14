#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import webpush from 'web-push';
import {
  imessageWorkDecision,
  imessageLooksLikePriorWorkStatusQuestion,
  imessagePriorWorkStatusReply,
  imessageWorkAck,
} from './mi-imessage-routing.mjs';
import { createHermeticMiEnv, httpJson, startFakeDaemon, startWebChat, waitFor } from './mi-test-harness.mjs';

function user(text) {
  return { role: 'user', source: 'imessage', text, ts: new Date().toISOString() };
}

function assistant(text, source, ts) {
  return { role: 'assistant', source, text, ts };
}

function assertDecision(message, expected, history = [], options = {}) {
  const decision = imessageWorkDecision(message, history, options);
  assert.equal(decision.action, expected.action, `${message}: expected action ${expected.action}, got ${JSON.stringify(decision)}`);
  if (expected.kind) assert.equal(decision.kind, expected.kind, `${message}: expected kind ${expected.kind}`);
  if (expected.target) assert.match(decision.targetMessage || '', expected.target, `${message}: target mismatch`);
  if (expected.reason) assert.match(decision.reason || '', expected.reason, `${message}: reason mismatch`);
  return decision;
}

const pendingHistory = [user('check the current detect candidates')];
assertDecision('hi', { action: 'chat', reason: /chat/ });
assertDecision('https://example.invalid/item', { action: 'chat', reason: /bare url/ });
assertDecision('what time is it?', { action: 'chat', reason: /question/ });
assertDecision('can you check cron status?', { action: 'chat', reason: /question/ });
assertDecision('check detect status', { action: 'start', reason: /clear directive/, target: /check detect status/ });
assertDecision('show me the detct canidates', { action: 'fetch', kind: 'detect-candidates' });
assertDecision('add that detect candidate', { action: 'start', reason: /clear directive/ });
assertDecision('yes', { action: 'start', reason: /confirmation of pending work/, target: /detect candidates/ }, pendingHistory);
assertDecision('go ahead', { action: 'start', reason: /confirmation of pending work/, target: /detect candidates/ }, pendingHistory);
assertDecision('yes', { action: 'chat', reason: /confirmation without pending/ });
assertDecision('no', { action: 'chat' });
assertDecision('stop', { action: 'chat' });
assertDecision('never mind', { action: 'chat' });
assertDecision('actually check the logs instead', { action: 'start', reason: /clear directive/, target: /check the logs/ });
assertDecision('check the logs', { action: 'ask', reason: /ask-first/ }, [], { askFirst: true });
assertDecision('yes please do', { action: 'start', reason: /explicit go-ahead/ }, [], { askFirst: true });
assertDecision('https://example.invalid/candidate', { action: 'ask', reason: /URL attached/, target: /example.invalid\/candidate/ }, pendingHistory);

assert.equal(imessageLooksLikePriorWorkStatusQuestion('did you do it?'), true);
assert.equal(imessageLooksLikePriorWorkStatusQuestion('why is it pending?'), true);
assert.equal(imessageLooksLikePriorWorkStatusQuestion('what are we doing later?'), false);

const t0 = new Date('2026-01-01T00:00:00.000Z').toISOString();
const t1 = new Date('2026-01-01T00:00:10.000Z').toISOString();
const t2 = new Date('2026-01-01T00:00:20.000Z').toISOString();
assert.equal(imessagePriorWorkStatusReply([assistant(imessageWorkAck(), 'imessage-work-ack', t0)], 'did you do it?'), 'Not yet, I’m still on it and will follow up here.');
assert.equal(imessagePriorWorkStatusReply([assistant(imessageWorkAck(), 'imessage-work-ack', t0), assistant('Changed files and tests passed.', 'mi-worker-result', t1)], 'did you do it?'), 'Yes. Changed files and tests passed.');
assert.equal(imessagePriorWorkStatusReply([assistant(imessageWorkAck(), 'imessage-work-ack', t1), assistant('Old result.', 'mi-worker-result', t0)], 'did you do it?'), 'Not yet, I’m still on it and will follow up here.');
assert.equal(imessagePriorWorkStatusReply([assistant(imessageWorkAck(), 'imessage-work-ack', t0), assistant('Changed files.', 'mi-worker-result', t1), assistant('boom', 'mi-worker-error', t2)], 'did you do it?'), 'It hit an error. I’ll need another pass to finish it.');
assert.equal(imessagePriorWorkStatusReply([], 'why is it pending?'), 'Pending means it is saved for review and report consideration. It does not mean the request failed.');

function assertAckQuality(text, label) {
  assert.ok(text && text.length <= 180, `${label}: ack should be short: ${text}`);
  assert.doesNotMatch(text, /\b(?:socket|polling|json|thread id|session file|context forwarding|prompt)\b/i, `${label}: ack leaks internals: ${text}`);
  assert.doesNotMatch(text, /[—–]/, `${label}: ack must avoid em/en dashes: ${text}`);
  assert.doesNotMatch(text, /^I sent that context|sent that context/i, `${label}: ack mentions internal forwarding: ${text}`);
}
assertAckQuality(imessageWorkAck(), 'iMessage work ack');

const fixture = await createHermeticMiEnv('mi-quality-');
let daemon;
let web;
try {
  const token = 'quality-webhook-token';
  const keys = webpush.generateVAPIDKeys();
  await mkdir(join(fixture.miRoot, 'state', 'web-push'), { recursive: true });
  await writeFile(join(fixture.miRoot, 'state', 'web-push', 'vapid.json'), JSON.stringify({ ...keys, subject: 'mailto:test@example.invalid' }));

  let runCount = 0;
  let continueCount = 0;
  daemon = await startFakeDaemon(fixture.env.MI_SOCKET_PATH, (request) => {
    if (request.type === 'run_worker') {
      runCount += 1;
      return { text: 'Started quality worker', taskId: `quality-task-${runCount}`, sessionFile: `/tmp/quality-${runCount}.jsonl`, sessionName: request.name || `quality-${runCount}` };
    }
    if (request.type === 'continue_worker') {
      continueCount += 1;
      return { text: 'Continued quality worker', taskId: request.taskId || `quality-task-${runCount}` };
    }
    if (request.type === 'list_tasks') return { tasks: [] };
    if (request.type === 'health') return { pi: true };
    if (request.type === 'prompt') return { text: 'Hello.' };
    return { text: 'ok' };
  });

  web = await startWebChat({
    ...fixture.env,
    MI_WEB_CHAT_WEBHOOK_TOKEN: token,
    MI_WEB_WORKER_THRESHOLD_SECONDS: '1',
    MI_IMESSAGE_ASK_FIRST: '0',
    MI_IMESSAGE_V2: '0', // Status assertions below exercise retained V1 semantics.
  });
  const base = web.baseUrl;

  let json = (await httpJson(base, '/api/send', { method: 'POST', body: { thread: 'main', message: 'hi there' } })).json;
  assert.equal(json.queued, true);
  await waitFor(async () => {
    const messages = (await httpJson(base, '/api/messages?thread=main')).json.messages;
    return messages.some((message) => message.role === 'assistant' && /^(Hello\.|Got it\.)$/.test(message.text || ''));
  }, { message: 'plain chat reply' });
  assert.equal(runCount, 0, 'plain chat must not start a worker');
  assert.equal(continueCount, 0, 'plain chat must not continue a worker');

  json = (await httpJson(base, '/api/send', { method: 'POST', body: { thread: 'main', message: 'fix the broken tests in this repo and report back with details' } })).json;
  assert.equal(json.queued, true);
  await waitFor(() => runCount === 1, { message: 'initial worker start' });
  let messages = await waitFor(async () => {
    const current = (await httpJson(base, '/api/messages?thread=main')).json.messages;
    return current.some((message) => message.source === 'web-worker-ack') ? current : false;
  }, { message: 'initial worker ack' });
  const firstAck = messages.filter((message) => message.source === 'web-worker-ack').at(-1)?.text || '';
  assertAckQuality(firstAck, 'web worker start ack');
  assert.doesNotMatch(firstAck, /fix the broken tests in this repo and report back with details/i, 'ack must not quote the whole raw request');

  await httpJson(base, '/api/send', { method: 'POST', body: { thread: 'main', message: 'actually make that less robotic too' } });
  await waitFor(() => continueCount === 1, { message: 'active worker follow-up' });
  messages = await waitFor(async () => {
    const current = (await httpJson(base, '/api/messages?thread=main')).json.messages;
    return current.filter((message) => message.source === 'web-worker-ack').length >= 2 ? current : false;
  }, { message: 'worker follow-up ack' });
  assertAckQuality(messages.filter((message) => message.source === 'web-worker-ack').at(-1)?.text || '', 'web worker follow-up ack');
  assert.equal(runCount, 1, 'follow-up should continue active worker rather than start a duplicate');

  await httpJson(base, '/api/send', { method: 'POST', body: { thread: 'main', message: 'what time is it?' } });
  await waitFor(async () => {
    const current = (await httpJson(base, '/api/messages?thread=main')).json.messages;
    return current.filter((message) => message.role === 'assistant' && /^(Hello\.|Got it\.)$/.test(message.text || '')).length >= 2;
  }, { message: 'unrelated conversational message while worker active' });
  assert.equal(runCount, 1, 'unrelated chat while worker active must not start another worker');
  assert.equal(continueCount, 1, 'unrelated chat while worker active must not be captured as a follow-up');

  await httpJson(base, '/api/send', { method: 'POST', body: { thread: 'main', message: 'tighten Mi routing so worker handoffs are not over eager' } });
  await waitFor(() => runCount === 2, { message: 'routing feedback worker start' });
  await httpJson(base, '/api/send', { method: 'POST', body: { thread: 'main', message: 'also make similar routing feedback dedupe old background workers' } });
  await waitFor(() => continueCount === 2, { message: 'similar routing feedback dedupe' });
  assert.equal(runCount, 2, 'similar routing feedback should continue the existing routing worker');

  await httpJson(base, '/api/notify', { method: 'POST', token, body: { thread: 'main', source: 'imessage-work-ack', text: imessageWorkAck(), unread: false } });
  let status = (await httpJson(base, '/api/imessage', { method: 'POST', body: { thread: 'main', message: 'did you do it?' } })).json;
  assert.equal(status.handoff, false);
  assert.match(status.reply, /Not yet/);
  await httpJson(base, '/api/notify', { method: 'POST', token, body: { thread: 'main', source: 'mi-worker-result', text: 'Quality worker finished with a concise summary.', unread: false } });
  status = (await httpJson(base, '/api/imessage', { method: 'POST', body: { thread: 'main', message: 'did you do it?' } })).json;
  assert.equal(status.handoff, false);
  assert.match(status.reply, /^Yes\. Quality worker finished/);
  assertAckQuality(status.reply, 'iMessage worker result status');

  console.log('Mi assistant quality tests passed.');
} finally {
  if (web) await web.close();
  if (daemon) await daemon.close();
  await fixture.cleanup();
}
