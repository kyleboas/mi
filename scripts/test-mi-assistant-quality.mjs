#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import webpush from 'web-push';
import { v2RiskClassification, v2RouteDecision } from './mi-web-chat-v2-route.mjs';
import { createHermeticMiEnv, httpJson, startFakeDaemon, startWebChat, waitFor } from './mi-test-harness.mjs';

assert.equal(v2RiskClassification('delete all data').kind, 'never-delegate');
assert.equal(v2RiskClassification('send Kyle a message').kind, 'confirm');
assert.equal(v2RouteDecision({ message: 'ordinary question', workspace: { root: '/tmp', cwd: '/tmp' } }).kind, 'coordinator');
assert.equal(v2RouteDecision({ message: 'cancel', workspace: { root: '/tmp', cwd: '/tmp' } }).kind, 'cancel');

function assertAckQuality(text, label) {
  assert.ok(text && text.length <= 180, `${label}: acknowledgement should be short`);
  assert.doesNotMatch(text, /\b(?:socket|polling|json|thread id|session file|context forwarding|prompt)\b/i, `${label}: acknowledgement leaks internals`);
  assert.doesNotMatch(text, /[—–]/, `${label}: acknowledgement must avoid em or en dashes`);
}

const fixture = await createHermeticMiEnv('mi-quality-');
let daemon;
let web;
try {
  const token = 'quality-webhook-token';
  const keys = webpush.generateVAPIDKeys();
  await mkdir(join(fixture.miRoot, 'state', 'web-push'), { recursive: true });
  await writeFile(join(fixture.miRoot, 'state', 'web-push', 'vapid.json'), JSON.stringify({ ...keys, subject: 'mailto:test@example.invalid' }));
  let runCount = 0;
  daemon = await startFakeDaemon(fixture.env.MI_SOCKET_PATH, (request) => {
    if (request.type === 'run_worker') { runCount += 1; return { text: 'Started quality worker', taskId: `quality-task-${runCount}`, sessionFile: `/tmp/quality-${runCount}.jsonl`, sessionName: request.name || `quality-${runCount}` }; }
    if (request.type === 'list_tasks') return { tasks: [] };
    if (request.type === 'health') return { pi: true };
    return { text: 'ok' };
  });
  web = await startWebChat({ ...fixture.env, MI_WEB_CHAT_WEBHOOK_TOKEN: token, MI_WEB_WORKER_THRESHOLD_SECONDS: '1' });
  const base = web.baseUrl;
  let json = (await httpJson(base, '/api/send', { method: 'POST', body: { thread: 'main', message: 'hi there' } })).json;
  assert.equal(json.queued, true, JSON.stringify(json));
  await waitFor(async () => (await httpJson(base, '/api/thread-state?thread=main')).json.messages.some((message) => message.role === 'assistant' && /^(Hello\.|Got it\.)$/.test(message.text || '')), { message: 'plain chat reply' });
  assert.equal(runCount, 0, 'plain chat must not start a worker');
  json = (await httpJson(base, '/api/send', { method: 'POST', body: { thread: 'main', message: 'fix the broken tests in this repo and report back with details' } })).json;
  assert.equal(json.queued, true);
  await waitFor(() => runCount === 1, { message: 'initial worker start' });
  const messages = await waitFor(async () => {
    const current = (await httpJson(base, '/api/thread-state?thread=main')).json.messages;
    return current.some((message) => message.source === 'web-worker-ack') ? current : false;
  }, { message: 'worker acknowledgement' });
  assertAckQuality(messages.filter((message) => message.source === 'web-worker-ack').at(-1)?.text || '', 'worker acknowledgement');
  const unauthorized = await httpJson(base, '/api/notify', { method: 'POST', body: { text: 'blocked' } });
  assert.equal(unauthorized.status, 401);
  const notified = await httpJson(base, '/api/notify', { method: 'POST', token, body: { text: 'webhook note', source: 'test' } });
  assert.equal(notified.status, 200);
  console.log('Mi assistant quality tests passed.');
} finally {
  if (web) await web.close();
  if (daemon) await daemon.close();
  await fixture.cleanup();
}
