#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import webpush from 'web-push';
import { createHermeticMiEnv, httpJson, startFakeDaemon, startWebChat, waitFor } from './mi-test-harness.mjs';

const fixture = await createHermeticMiEnv('mi-web-api-');
let daemon;
let web;
try {
  const token = 'test-webhook-token';
  const keys = webpush.generateVAPIDKeys();
  await mkdir(join(fixture.miRoot, 'state', 'web-push'), { recursive: true });
  await writeFile(join(fixture.miRoot, 'state', 'web-push', 'vapid.json'), JSON.stringify({ ...keys, subject: 'mailto:test@example.invalid' }));

  daemon = await startFakeDaemon(fixture.env.MI_SOCKET_PATH, (request) => {
    if (request.type === 'run_worker') return { text: 'Started web worker', taskId: 'web-task-1', sessionFile: '/tmp/web-task.jsonl', sessionName: request.name || 'web task' };
    if (request.type === 'continue_worker') return { text: 'Continued web worker', taskId: request.taskId || 'web-task-1' };
    if (request.type === 'list_tasks') return { tasks: [] };
    if (request.type === 'health') return { pi: true };
    return { text: 'ok' };
  });

  web = await startWebChat({
    ...fixture.env,
    MI_WEB_CHAT_WEBHOOK_TOKEN: token,
    MI_TWILIO_ENABLED: '1',
    MI_TWILIO_CONFIRMATION_TOKEN: 'twilio-confirmation-token',
    MI_TWILIO_CONFIRMATION_USER_ID: 'web-user-1',
    TWILIO_ACCOUNT_SID: 'ACtest',
    TWILIO_API_KEY_SID: 'SKtest',
    TWILIO_API_KEY_SECRET: 'test-secret',
    TWILIO_AUTH_TOKEN: 'auth-token',
    MI_TWILIO_FROM_NUMBER: '+15551234567',
    MI_TWILIO_ALLOWED_COUNTRY_CODES: '1',
    MI_WEB_MAX_UPLOAD_BYTES: '8',
    MI_WEB_UPLOAD_DIR: join(fixture.miRoot, 'state', 'web-uploads'),
    MI_WEB_WORKER_THRESHOLD_SECONDS: '1',
  });
  const base = web.baseUrl;

  let res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Mi/);

  res = await fetch(`${base}/sw.js`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /install|fetch|notification|Mi/i);

  res = await fetch(`${base}/manifest.json`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Mi/);

  let json = (await httpJson(base, '/api/health')).json;
  assert.equal(json.ok, true);
  assert.equal(json.maintenance, true);

  json = (await httpJson(base, '/api/threads')).json;
  assert.ok(json.threads.some((thread) => thread.id === 'main'));

  json = (await httpJson(base, '/api/thread-state?thread=main')).json;
  assert.deepEqual(json.jobs, []);

  let unauthorized = await httpJson(base, '/api/notify', { method: 'POST', body: { text: 'secretless note' } });
  assert.equal(unauthorized.status, 401);

  let twilioUnauthorized = await httpJson(base, '/api/twilio/confirmation', { method: 'POST', body: { confirm: true, to: '+15551234568', purpose: 'test', script: 'AI assistant test call.' } });
  assert.equal(twilioUnauthorized.status, 401, 'Twilio confirmation requires authentication');
  let twilioNoCsrf = await httpJson(base, '/api/twilio/confirmation', { method: 'POST', token: 'twilio-confirmation-token', body: { confirm: true, to: '+15551234568', purpose: 'test', script: 'AI assistant test call.' } });
  assert.equal(twilioNoCsrf.status, 403, 'Twilio confirmation requires same-origin CSRF protections');
  const twilioHeaders = { Origin: base, 'X-Mi-Confirmation-CSRF': 'mi-web-confirmation', 'X-Mi-Confirmation-Nonce': 'cross-user-request-0001' };
  let twilioCrossUser = await httpJson(base, '/api/twilio/confirmation', { method: 'POST', token: 'twilio-confirmation-token', headers: twilioHeaders, body: { confirm: true, userId: 'web-user-2', to: '+15551234568', purpose: 'test', script: 'AI assistant test call.' } });
  assert.equal(twilioCrossUser.status, 403, 'confirmation identity is bound to the authenticated user');
  const validTwilioHeaders = { ...twilioHeaders, 'X-Mi-Confirmation-Nonce': 'valid-request-0000001' };
  let twilioConfirmation = await httpJson(base, '/api/twilio/confirmation', { method: 'POST', token: 'twilio-confirmation-token', headers: validTwilioHeaders, body: { confirm: true, to: '+15551234568', purpose: 'test', script: 'AI assistant test call.' } });
  assert.equal(twilioConfirmation.status, 201, twilioConfirmation.text);
  assert.equal(twilioConfirmation.json.confirmation.userId, undefined, 'confirmation response does not expose the user identity');
  const replay = await httpJson(base, '/api/twilio/confirmation', { method: 'POST', token: 'twilio-confirmation-token', headers: validTwilioHeaders, body: { confirm: true, to: '+15551234568', purpose: 'test', script: 'AI assistant test call.' } });
  assert.equal(replay.status, 409, 'confirmation request nonce rejects replay');

  json = (await httpJson(base, '/api/notify', { method: 'POST', token, body: { text: 'webhook note', source: 'test' } })).json;
  assert.equal(json.ok, true);
  assert.ok(json.messages.some((message) => message.text === 'webhook note' && message.source === 'test'));

  let photo = await httpJson(base, '/api/photo', { method: 'POST', body: { name: '../evil.png', type: 'image/png', dataUrl: 'data:image/png;base64,AAECAw==' } });
  assert.equal(photo.status, 200);
  assert.equal(photo.json.attached, true);
  assert.ok(photo.json.filePath.startsWith(join(fixture.miRoot, 'state', 'web-uploads')));
  assert.doesNotMatch(photo.json.filePath, /\.\.\//);

  let invalidPhoto = await httpJson(base, '/api/photo', { method: 'POST', body: { name: 'bad.txt', dataUrl: 'not-a-data-url' } });
  assert.equal(invalidPhoto.status, 500);
  assert.match(invalidPhoto.json.error, /invalid photo upload/);

  let tooLargePhoto = await httpJson(base, '/api/photo', { method: 'POST', body: { name: 'large.png', type: 'image/png', dataUrl: `data:image/png;base64,${Buffer.alloc(9).toString('base64')}` } });
  assert.equal(tooLargePhoto.status, 500);
  assert.match(tooLargePhoto.json.error, /photo too large/);

  let badPhotoSend = await httpJson(base, '/api/send', { method: 'POST', body: { message: 'look', photoPath: '/tmp/outside.png' } });
  assert.equal(badPhotoSend.status, 400);
  assert.match(badPhotoSend.json.error, /invalid photo path/);

  json = (await httpJson(base, '/api/send', { method: 'POST', body: { message: 'hi' } })).json;
  assert.equal(json.queued, true, JSON.stringify(json));
  await waitFor(async () => {
    const messages = (await httpJson(base, '/api/thread-state?thread=main')).json.messages
    return messages.some((message) => message.role === 'assistant' && message.text === 'Hello.');
  }, { message: 'web chat direct reply' });

  json = (await httpJson(base, '/api/send', { method: 'POST', body: { message: 'fix the broken tests in this repo and report back with details' } })).json;
  assert.equal(json.queued, true);
  await waitFor(() => daemon.requests.some((request) => request.type === 'run_worker' && /fix the broken tests/.test(request.lastInput || request.message || '')), { message: 'web chat worker handoff' });

  json = (await httpJson(base, '/api/push/public-key')).json;
  assert.equal(json.publicKey, keys.publicKey);

  json = (await httpJson(base, '/api/push/subscribe', { method: 'POST', body: { subscription: { endpoint: 'https://example.invalid/push-test' } } })).json;
  assert.equal(json.ok, true);
  assert.equal(json.subscriptions, 1);
  await rm(join(fixture.miRoot, 'state', 'web-push', 'subscriptions.json'), { force: true });

  console.log('mi web API e2e tests passed');
} finally {
  if (web) await web.close();
  if (daemon) await daemon.close();
  await fixture.cleanup();
}
