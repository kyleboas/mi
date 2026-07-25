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
  await mkdir(join(fixture.miRoot, 'pi', 'extensions'), { recursive: true });
  await writeFile(join(fixture.miRoot, 'pi', 'extensions', 'mi-capability-guard.ts'), 'export default function () {}\n');
  await writeFile(fixture.fakePi, String.raw`#!/usr/bin/node
import { appendFileSync } from 'node:fs';
let input = '';
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  let request; try { request = JSON.parse(input); } catch { process.exit(8); }
  appendFileSync(${JSON.stringify(piLog)}, JSON.stringify({ argv: process.argv.slice(2), request }) + '\n');
  if (request.type === 'prompt') {
    process.stdout.write(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Terra finished the review.' }] } }) + '\n');
    process.stdout.write(JSON.stringify({ type: 'agent_settled' }) + '\n');
    return;
  }
  const prompt = request.messages.map((message) => message.content).join('\n');
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
      if (runCount <= 2) return { tasks: [{ id: 'daemon-listed-id', sessionFile: runCount === 1 ? '/tmp/v2-correlation.jsonl' : '/tmp/v2-2.jsonl', status: 'complete', text: 'Done.' }] };
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
  assert.equal(result.handoff, true, 'actionable checks go directly to the Pi worker path');
  assert.equal(daemon.requests.filter((item) => item.type === 'run_worker').length, 1);
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
  assert.equal(daemon.requests.filter((item) => item.type === 'run_worker').length, 2, 'each distinct task starts one worker');
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

  const workersBeforeScopedWrite = runCount;
  result = (await httpJson(web.baseUrl, '/api/imessage', { method: 'POST', body: { message: 'Fix the workflow readme wording.' } })).json;
  assert.equal(result.handoff, true, 'safe scoped writing work reaches Pi instead of being refused');
  assert.equal(runCount, workersBeforeScopedWrite + 1);
  assert.equal(daemon.requests.filter((item) => item.type === 'run_worker').at(-1).capabilityProfile, 'worker-write-scoped', 'safe writes use the narrow write profile');

  const workersBeforeRisk = runCount;
  result = (await httpJson(web.baseUrl, '/api/imessage', { method: 'POST', body: { message: 'Deploy the garden-plan change now.' } })).json;
  assert.equal(result.handoff, false, 'risky work remains pending confirmation');
  assert.ok(result.confirmationId, 'risky request receives a clear confirmation id');
  assert.equal(runCount, workersBeforeRisk, 'risky request starts no worker before confirmation');

  const duplicateMessage = 'Check the duplicate delivery status.';
  const firstDuplicate = (await httpJson(web.baseUrl, '/api/imessage', { method: 'POST', body: { message: duplicateMessage, deliveryId: 'delivery-1' } })).json;
  const duplicate = (await httpJson(web.baseUrl, '/api/imessage', { method: 'POST', body: { message: duplicateMessage, deliveryId: 'delivery-1' } })).json;
  assert.equal(duplicate.taskId, firstDuplicate.taskId, 'duplicate delivery returns the correlated original response');
  assert.equal(runCount, workersBeforeRisk + 1, 'duplicate delivery starts only one worker');
  messages = (await httpJson(web.baseUrl, '/api/messages?thread=main')).json.messages;
  assert.equal(messages.filter((item) => item.role === 'user' && item.text === duplicateMessage).length, 1, 'duplicate delivery appends the user message once');

  result = (await httpJson(web.baseUrl, '/api/imessage', { method: 'POST', body: { message: 'INTERNAL_CASE' } })).json;
  assert.equal(result.handoff, false);
  assert.doesNotMatch(result.reply, /Pi|worker|Photon/i, 'internal model output is replaced safely');



  console.log('Mi iMessage V2 checks passed.');
} finally {
  if (web) await web.close();
  if (daemon) await daemon.close();
  await fixture.cleanup();
}
