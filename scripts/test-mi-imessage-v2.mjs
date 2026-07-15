#!/usr/bin/env node
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildImessageV2Prompt, IMESSAGE_V2_LIMITS, parseImessageV2Envelope } from './mi-imessage-v2.mjs';
import { createHermeticMiEnv, httpJson, readJsonl, startFakeDaemon, startWebChat, waitFor } from './mi-test-harness.mjs';

const hugeSecret = `sk-${'x'.repeat(40)}`;
const webSource = await readFile(new URL('./mi-web-chat.mjs', import.meta.url), 'utf8');
assert.match(webSource, /const miGatewayClient = process\.env\.MI_GATEWAY_CLIENT/, 'V2 uses the fixed local gateway client');
const v2InvocationSource = webSource.slice(webSource.indexOf('async function runImessageV2'), webSource.indexOf('async function handleImessageV2'));
assert.doesNotMatch(v2InvocationSource, /PI_CMD|--print|--model|spawn\(pi/, 'V2 never starts an outer Pi CLI');
assert.match(v2InvocationSource, /invokeMiGateway/, 'V2 sends bounded role messages through the local client');
assert.match(webSource, /aliases\.get\(configured\) \|\| ''/, 'unsupported model overrides fail closed');
assert.match(webSource, /IMESSAGE_V2_LIMITS\.output/, 'V2 bounds local-client output');
assert.match(webSource, /loadLegacyImessageRouting\(\)/, 'V1 routing is lazy-loaded only after the V2 gate');
const prompt = buildImessageV2Prompt({
  timestamp: '2026-07-14T12:00:00.000Z',
  userMessage: 'Can you check it?',
  preferences: `short replies ${hugeSecret}`,
  memory: 'Remember the garden plan.',
  threadMessages: [{ role: 'assistant', source: 'mi-worker-result', ts: '2026-07-14T11:00:00.000Z', text: 'Garden plan is drafted.' }],
  workers: 'running garden planning',
  snapshot: 'state/tick.json: healthy',
});
assert.ok(prompt.length <= IMESSAGE_V2_LIMITS.prompt, 'V2 prompt is globally capped');
assert.doesNotMatch(prompt, new RegExp(hugeSecret), 'V2 prompt redacts secret-like values');
assert.match(prompt, /Recent thread \[thread JSONL/, 'V2 prompt labels thread provenance');
assert.match(prompt, /mi-worker-result/, 'V2 context retains worker results');
assert.match(prompt, /cannot inspect live state/, 'V2 contract makes foreground context-only');
assert.match(prompt, /read-only task/, 'V2 contract delegates live verification to controlled work');
assert.doesNotMatch(prompt, /inspect it with the read-only tools/, 'V2 contract never directs the tool-free foreground call to inspect');
assert.deepEqual(parseImessageV2Envelope('```json\n{"kind":"reply","reply":"All good."}\n```'), { kind: 'reply', reply: 'All good.' });
assert.deepEqual(parseImessageV2Envelope('{"kind":"task","capability":"read","objective":"Check the garden plan status and report the result.","ack":"I’ll check the garden plan.","continueTaskId":"task-17"}'), { kind: 'task', capability: 'read', objective: 'Check the garden plan status and report the result.', ack: 'I’ll check the garden plan.', continueTaskId: 'task-17' });
assert.equal(parseImessageV2Envelope('{"kind":"task","objective":"Check it.","ack":"I’ll check it.","continueTaskId":"../bad"}').fallback, true, 'invalid continuation ids fall back safely');
assert.equal(parseImessageV2Envelope('not json').kind, 'reply', 'malformed output safely falls back');
assert.equal(parseImessageV2Envelope('{"kind":"reply","reply":"I used Pi workers."}').fallback, true, 'internal terms never reach the user');

const fixture = await createHermeticMiEnv('mi-imessage-v2-');
let daemon;
let web;
try {
  const piLog = join(fixture.root, 'pi.jsonl');
  await writeFile(fixture.fakePi, String.raw`#!/usr/bin/node
import { appendFileSync } from 'node:fs';
let input = '';
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  let request; try { request = JSON.parse(input); } catch { process.exit(8); }
  const prompt = request.messages.map((message) => message.content).join('\n');
  appendFileSync(${JSON.stringify(piLog)}, JSON.stringify({ argv: process.argv.slice(2), request }) + '\n');
  if (prompt.includes('NONZERO_CASE')) { process.stderr.write('gateway failed\n'); process.exit(7); }
  if (prompt.includes('EMPTY_CASE')) return;
  if (prompt.includes('HUGE_OUTPUT_CASE')) return process.stdout.write('x'.repeat(IMESSAGE_V2_LIMITS.output + 1));
  if (prompt.includes('TIMEOUT_CASE')) return setTimeout(() => {}, 2000);
  if (prompt.includes('MALFORMED_PLAIN_CASE')) return process.stdout.write('not an envelope\n');
  if (prompt.includes('You format one completed')) return process.stdout.write('The check is complete.');
  let envelope = { kind: 'reply', reply: 'The current status looks good.' };
  if (prompt.includes('CORRELATION_TASK')) envelope = { kind: 'task', capability: 'read', objective: 'Check the garden plan status and report a concise update.', ack: 'I’ll check the garden plan.' };
  if (prompt.includes('ACTIVE_TASK')) envelope = { kind: 'task', capability: 'read', objective: 'Read the notebook sync status and report the result.', ack: 'I’ll repair notebook sync.' };
  if (prompt.includes('UNRELATED_TASK')) envelope = { kind: 'task', capability: 'read', objective: 'Read the quarterly travel plan and report it.', ack: 'I’ll draft the travel plan.' };
  if (prompt.includes('FOLLOWUP_TASK')) { const match = prompt.match(/Read the notebook sync[^\n]*\| continuation ([A-Za-z0-9._:-]{1,200})/); envelope = { kind: 'task', capability: 'read', objective: 'Read the notebook sync status using the latest feedback.', ack: 'I’ll correct the notebook sync repair.', continueTaskId: match && match[1] }; }
  if (prompt.includes('CONFIRM_CASE')) envelope = { kind: 'confirm', reply: 'Should I deploy the garden-plan change now.?' };
  if (prompt.includes('INTERNAL_CASE')) envelope = { kind: 'reply', reply: 'I will ask a Pi worker through Photon.' };
  if (prompt.includes('CURRENT_STATE_TASK')) envelope = { kind: 'task', capability: 'read', objective: 'Read-only verify the current status and report the result.', ack: 'I’ll check the current status.' };
  if (prompt.includes('MALICIOUS_RESTART_READ')) envelope = { kind: 'task', capability: 'read', objective: 'Restart mi-web-chat.service now.', ack: 'I’ll restart it.' };
  if (prompt.includes('MISSING_CAP_DEPLOY')) envelope = { kind: 'task', objective: 'Deploy the service now.', ack: 'I’ll deploy it.' };
  process.stdout.write(JSON.stringify(envelope) + '\n');
});
`, { mode: 0o755 });
  await chmod(fixture.fakePi, 0o755);
  await mkdir(join(fixture.miRoot, 'state'), { recursive: true });
  await writeFile(join(fixture.home, 'mi', 'memory.md'), `garden plan context\n${hugeSecret}`);
  await writeFile(join(fixture.miRoot, 'state', 'tick.json'), JSON.stringify({ checkedAt: '2026-07-14T11:59:00.000Z', status: 'ok' }));

  let runCount = 0;
  daemon = await startFakeDaemon(fixture.env.MI_SOCKET_PATH, (request) => {
    if (request.type === 'run_worker') {
      runCount += 1;
      if (runCount === 1) return { text: 'started', taskId: 'daemon-start-id', sessionFile: '/tmp/v2-correlation.jsonl', sessionName: 'garden-plan' };
      return { text: 'started', taskId: `daemon-task-${runCount}`, sessionFile: `/tmp/v2-${runCount}.jsonl`, sessionName: request.name };
    }
    if (request.type === 'continue_worker') return { text: 'continued', taskId: request.taskId, sessionFile: '/tmp/v2-2.jsonl' };
    if (request.type === 'list_tasks') {
      if (runCount === 1) return { tasks: [{ id: 'daemon-listed-id', sessionFile: '/tmp/v2-correlation.jsonl', status: 'complete', text: 'Done.' }] };
      return { tasks: [] };
    }
    return { text: 'ok' };
  });
  web = await startWebChat({ ...fixture.env, MI_IMESSAGE_V2: '1', MI_IMESSAGE_MODEL: 'mi-concierge', MI_GATEWAY_CLIENT: fixture.fakePi, MI_IMESSAGE_CHAT_TIMEOUT_MS: '1000', MI_WEB_WORKER_POLL_MS: '25' });

  let result = (await httpJson(web.baseUrl, '/api/imessage', { method: 'POST', body: { message: 'What is the current status?' } })).json;
  assert.equal(result.handoff, false, 'conversational state question starts no worker');
  assert.equal(result.reply, 'The current status looks good.', 'plain fake Pi envelope reaches /api/imessage');
  assert.equal(daemon.requests.filter((item) => item.type === 'run_worker').length, 0);

  result = (await httpJson(web.baseUrl, '/api/imessage', { method: 'POST', body: { message: 'We decided on the garden plan.' } })).json;
  assert.equal(result.handoff, false);
  result = (await httpJson(web.baseUrl, '/api/imessage', { method: 'POST', body: { message: 'Can you check it?' } })).json;
  assert.equal(result.handoff, false);
  const piCalls = await readJsonl(piLog);
  assert.ok(piCalls.every((call) => call.argv.length === 0), 'prompts and configuration are never passed in argv');
  assert.ok(piCalls.every((call) => call.request.model === 'mi-concierge'), 'only the immutable concierge alias reaches the helper');
  assert.ok(piCalls.every((call) => call.request.messages.length === 1), 'V2 uses one bounded role message');
  assert.equal(existsSync(join(fixture.runtime, 'capabilities')), false, 'V2 creates no capability grant directory');
  assert.ok(piCalls.every((call) => !/openai-codex|gpt-5\.6-sol/.test(JSON.stringify(call.request))), 'V2 never injects stale external models');
  assert.ok(piCalls.at(-1).request.messages[0].content.includes('We decided on the garden plan.'), 'pronoun follow-up receives prior thread context');
  assert.doesNotMatch(piCalls.at(-1).request.messages[0].content, new RegExp(hugeSecret), 'local client receives redacted context only');

  result = (await httpJson(web.baseUrl, '/api/imessage', { method: 'POST', body: { message: 'CORRELATION_TASK' } })).json;
  assert.equal(result.handoff, true);
  const correlationId = result.taskId;
  assert.match(correlationId, /^[0-9a-f-]{36}$/i, 'V2 exposes a generated stable correlation id, not a daemon id');
  assert.equal(result.reply, 'I’ll check that and get back to you.');
  assert.equal(daemon.requests.filter((item) => item.type === 'run_worker').length, 1, 'task starts exactly one worker');
  let messages = (await httpJson(web.baseUrl, '/api/messages?thread=main')).json.messages;
  assert.ok(messages.some((item) => item.source === 'imessage-v2-task-ack' && item.taskId === correlationId), 'V2 acknowledgement carries the stable correlation id');
  await waitFor(async () => {
    const current = (await httpJson(web.baseUrl, '/api/messages?thread=main')).json.messages;
    return current.some((item) => item.source === 'mi-worker-result' && item.taskId === correlationId) ? current : false;
  }, { timeoutMs: 3000, message: 'correlated completion' });
  messages = (await httpJson(web.baseUrl, '/api/messages?thread=main')).json.messages;
  assert.ok(messages.some((item) => item.source === 'mi-worker-result' && item.taskId === correlationId), 'completion retains the original correlation id after daemon id changes');
  const completionCalls = await readJsonl(piLog);
  assert.ok(completionCalls.some((call) => call.request.model === 'mi-concierge' && call.request.messages[0].content.includes('You format one completed')), 'V2 completion presentation uses the same immutable concierge helper route');

  result = (await httpJson(web.baseUrl, '/api/imessage', { method: 'POST', body: { message: 'ACTIVE_TASK' } })).json;
  const activeCorrelationId = result.taskId;
  assert.equal(runCount, 2, 'active task starts a second daemon worker after the completed correlation test');
  result = (await httpJson(web.baseUrl, '/api/imessage', { method: 'POST', body: { message: 'UNRELATED_TASK' } })).json;
  assert.equal(result.handoff, true);
  assert.equal(runCount, 3, 'unrelated V2 task starts a new worker instead of continuing the active one');
  result = (await httpJson(web.baseUrl, '/api/imessage', { method: 'POST', body: { message: 'FOLLOWUP_TASK: use the new notes' } })).json;
  assert.equal(result.handoff, true);
  assert.equal(result.taskId, activeCorrelationId, 'explicit continuation retains the active task correlation id');
  assert.equal(daemon.requests.filter((item) => item.type === 'continue_worker').length, 1, 'explicit continuation uses the matching active worker');
  messages = (await httpJson(web.baseUrl, '/api/messages?thread=main')).json.messages;
  assert.equal(messages.filter((item) => item.role === 'user' && item.text === 'FOLLOWUP_TASK: use the new notes').length, 1, 'continuation persists Kyle’s natural wording exactly once');
  assert.equal(messages.filter((item) => item.role === 'user' && /Read the notebook sync status using/.test(item.text)).length, 0, 'continuation does not persist the model objective as the user message');

  result = (await httpJson(web.baseUrl, '/api/imessage', { method: 'POST', body: { message: 'CONFIRM_CASE' } })).json;
  assert.equal(result.handoff, false);
  assert.equal(result.reply, 'Should I deploy the garden-plan change now?');
  assert.equal(runCount, 3, 'confirm starts no worker');

  result = (await httpJson(web.baseUrl, '/api/imessage', { method: 'POST', body: { message: 'INTERNAL_CASE' } })).json;
  assert.equal(result.handoff, false);
  assert.doesNotMatch(result.reply, /Pi|worker|Photon/i, 'internal model output is replaced safely');

  result = (await httpJson(web.baseUrl, '/api/imessage', { method: 'POST', body: { message: 'CURRENT_STATE_TASK: What is the current status right now?' } })).json;
  assert.equal(result.handoff, true, 'current-state uncertainty can hand off instead of fabricating a live reply');
  assert.equal(result.reply, 'I’ll check that and get back to you.');
  assert.equal(runCount, 4, 'current-state task starts the controlled worker path');

  const workersBeforeBlockedTasks = runCount;
  result = (await httpJson(web.baseUrl, '/api/imessage', { method: 'POST', body: { message: 'MALICIOUS_RESTART_READ' } })).json;
  assert.equal(result.handoff, false, 'restart mislabeled read never starts a worker');
  assert.equal(result.reply, 'What exactly should I act on?');
  assert.equal(result.confirmationId, undefined, 'ambiguous model task creates no pending confirmation');
  assert.equal(runCount, workersBeforeBlockedTasks, 'blocked restart emits no worker');
  result = (await httpJson(web.baseUrl, '/api/imessage', { method: 'POST', body: { message: 'MISSING_CAP_DEPLOY' } })).json;
  assert.equal(result.handoff, false, 'missing capability never starts a worker');
  assert.equal(result.confirmationId, undefined, 'missing capability creates no pending confirmation');
  assert.equal(result.reply, 'What exactly should I act on?');
  assert.equal(runCount, workersBeforeBlockedTasks, 'missing capability emits no worker');

  result = (await httpJson(web.baseUrl, '/api/imessage', { method: 'POST', body: { message: 'MALFORMED_PLAIN_CASE' } })).json;
  assert.equal(result.ok, true);
  assert.equal(result.handoff, false);
  assert.match(result.reply, /Could you say that another way/i, 'malformed plain stdout keeps the safe reply fallback');

  const unavailableBefore = (await httpJson(web.baseUrl, '/api/messages?thread=main')).json.messages
    .filter((item) => item.source === 'imessage-v2-unavailable').length;
  for (const failureCase of ['NONZERO_CASE', 'EMPTY_CASE', 'TIMEOUT_CASE', 'HUGE_OUTPUT_CASE']) {
    result = (await httpJson(web.baseUrl, '/api/imessage', { method: 'POST', body: { message: failureCase } })).json;
    assert.equal(result.ok, false, `${failureCase} reports invocation failure`);
    assert.equal(result.handoff, false, `${failureCase} starts no worker`);
    assert.equal(result.temporary, true, `${failureCase} is marked temporary`);
    assert.match(result.reply, /temporarily unable to reach my assistant service/i, `${failureCase} has a truthful reply`);
  }
  assert.equal(runCount, 4, 'invocation failures start no workers');
  messages = (await httpJson(web.baseUrl, '/api/messages?thread=main')).json.messages;
  assert.equal(messages.filter((item) => item.source === 'imessage-v2-unavailable').length, unavailableBefore + 4, 'failure replies are durably categorized');

  // Exercise the API default with no model override. This remains hermetic: the
  // disposable fake Pi only records argv and no message is sent through Photon.
  await web.close();
  web = undefined;
  await rm(join(fixture.miRoot, 'state'), { recursive: true, force: true });
  await mkdir(join(fixture.miRoot, 'state'), { recursive: true });
  const defaultEnv = { ...fixture.env, MI_IMESSAGE_V2: '1', MI_GATEWAY_CLIENT: fixture.fakePi, MI_IMESSAGE_CHAT_TIMEOUT_MS: '1000', MI_WEB_WORKER_POLL_MS: '25' };
  delete defaultEnv.MI_IMESSAGE_MODEL;
  web = await startWebChat(defaultEnv);
  result = (await httpJson(web.baseUrl, '/api/imessage', { method: 'POST', body: { message: 'Default concierge route check.' } })).json;
  assert.equal(result.ok, true, 'default V2 API request succeeds through the local route');
  const defaultCall = (await readJsonl(piLog)).at(-1);
  assert.equal(defaultCall.request.model, 'mi-concierge', 'V2 API default selects the immutable Mi-only concierge alias');

  console.log('Mi iMessage V2 checks passed.');
} finally {
  if (web) await web.close();
  if (daemon) await daemon.close();
  await fixture.cleanup();
}
