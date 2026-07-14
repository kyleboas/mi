#!/usr/bin/env node
import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildImessageV2Prompt, IMESSAGE_V2_LIMITS, parseImessageV2Envelope } from './mi-imessage-v2.mjs';
import { createHermeticMiEnv, httpJson, readJsonl, startFakeDaemon, startWebChat, waitFor } from './mi-test-harness.mjs';

const hugeSecret = `sk-${'x'.repeat(40)}`;
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
assert.deepEqual(parseImessageV2Envelope('```json\n{"kind":"reply","reply":"All good."}\n```'), { kind: 'reply', reply: 'All good.' });
assert.deepEqual(parseImessageV2Envelope('{"kind":"task","objective":"Check the garden plan status and report the result.","ack":"I’ll check the garden plan."}'), { kind: 'task', objective: 'Check the garden plan status and report the result.', ack: 'I’ll check the garden plan.' });
assert.equal(parseImessageV2Envelope('not json').kind, 'reply', 'malformed output safely falls back');
assert.equal(parseImessageV2Envelope('{"kind":"reply","reply":"I used Pi workers."}').fallback, true, 'internal terms never reach the user');

const fixture = await createHermeticMiEnv('mi-imessage-v2-');
let daemon;
let web;
try {
  const piLog = join(fixture.root, 'pi.jsonl');
  await writeFile(fixture.fakePi, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
const prompt = process.argv.at(-1) || '';
appendFileSync(${JSON.stringify(piLog)}, JSON.stringify(process.argv.slice(2)) + '\\n');
let envelope = { kind: 'reply', reply: 'The current status looks good.' };
if (prompt.includes('TASK_CASE')) envelope = { kind: 'task', objective: 'Check the garden plan status and report a concise update.', ack: 'I’ll check the garden plan.' };
if (prompt.includes('CONFIRM_CASE')) envelope = { kind: 'confirm', reply: 'Should I deploy the garden-plan change now?' };
if (prompt.includes('INTERNAL_CASE')) envelope = { kind: 'reply', reply: 'I will ask a Pi worker through Photon.' };
process.stdout.write(JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: JSON.stringify(envelope) } }) + '\\n');
`, { mode: 0o755 });
  await chmod(fixture.fakePi, 0o755);
  await mkdir(join(fixture.miRoot, 'state'), { recursive: true });
  await writeFile(join(fixture.home, 'mi', 'memory.md'), `garden plan context\n${hugeSecret}`);
  await writeFile(join(fixture.miRoot, 'state', 'tick.json'), JSON.stringify({ checkedAt: '2026-07-14T11:59:00.000Z', status: 'ok' }));

  daemon = await startFakeDaemon(fixture.env.MI_SOCKET_PATH, (request) => {
    if (request.type === 'run_worker') return { text: 'started', taskId: 'v2-task-17', sessionFile: '/tmp/v2-task.jsonl', sessionName: 'garden-plan' };
    if (request.type === 'list_tasks') return { tasks: [] };
    return { text: 'ok' };
  });
  web = await startWebChat({ ...fixture.env, MI_IMESSAGE_V2: '1', MI_IMESSAGE_MODEL: 'fake-model' });

  let result = (await httpJson(web.baseUrl, '/api/imessage', { method: 'POST', body: { message: 'What is the current status?' } })).json;
  assert.equal(result.handoff, false, 'conversational state question starts no worker');
  assert.equal(daemon.requests.filter((item) => item.type === 'run_worker').length, 0);

  result = (await httpJson(web.baseUrl, '/api/imessage', { method: 'POST', body: { message: 'We decided on the garden plan.' } })).json;
  assert.equal(result.handoff, false);
  result = (await httpJson(web.baseUrl, '/api/imessage', { method: 'POST', body: { message: 'Can you check it?' } })).json;
  assert.equal(result.handoff, false);
  const piCalls = await readJsonl(piLog);
  assert.ok(piCalls.at(-1).at(-1).includes('We decided on the garden plan.'), 'pronoun follow-up receives prior thread context');
  assert.doesNotMatch(piCalls.at(-1).at(-1), new RegExp(hugeSecret), 'fake Pi receives redacted context only');

  result = (await httpJson(web.baseUrl, '/api/imessage', { method: 'POST', body: { message: 'TASK_CASE' } })).json;
  assert.equal(result.handoff, true);
  assert.equal(result.taskId, 'v2-task-17');
  assert.equal(result.reply, 'I’ll check the garden plan.');
  assert.equal(daemon.requests.filter((item) => item.type === 'run_worker').length, 1, 'task starts exactly one worker');
  const messages = (await httpJson(web.baseUrl, '/api/messages?thread=main')).json.messages;
  assert.ok(messages.some((item) => item.source === 'imessage-v2-task-ack' && item.taskId === 'v2-task-17'), 'V2 acknowledgement carries exact task id');

  result = (await httpJson(web.baseUrl, '/api/imessage', { method: 'POST', body: { message: 'CONFIRM_CASE' } })).json;
  assert.equal(result.handoff, false);
  assert.match(result.reply, /Should I deploy/);
  assert.equal(daemon.requests.filter((item) => item.type === 'run_worker').length, 1, 'confirm starts no worker');

  result = (await httpJson(web.baseUrl, '/api/imessage', { method: 'POST', body: { message: 'INTERNAL_CASE' } })).json;
  assert.equal(result.handoff, false);
  assert.doesNotMatch(result.reply, /Pi|worker|Photon/i, 'internal model output is replaced safely');

  console.log('Mi iMessage V2 checks passed.');
} finally {
  if (web) await web.close();
  if (daemon) await daemon.close();
  await fixture.cleanup();
}
