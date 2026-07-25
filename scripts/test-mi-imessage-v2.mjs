#!/usr/bin/env node
import assert from 'node:assert/strict';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildImessageV2Prompt, IMESSAGE_V2_LIMITS, parseImessageV2Envelope } from './mi-imessage-v2.mjs';
import { createHermeticMiEnv, httpJson, readJsonl, startFakeDaemon, startWebChat, waitFor } from './mi-test-harness.mjs';

assert.equal(parseImessageV2Envelope('not json').kind, 'reply', 'malformed old foreground output stays safe');
assert.equal(parseImessageV2Envelope('{"kind":"reply","reply":"I used Pi workers."}').fallback, true, 'internal old foreground output stays safe');
const prompt = buildImessageV2Prompt({ userMessage: 'hello', preferences: 'short replies' });
assert.ok(prompt.length <= IMESSAGE_V2_LIMITS.prompt, 'bounded legacy fallback prompt remains capped');

const fixture = await createHermeticMiEnv('mi-imessage-v2-');
let daemon;
let web;
try {
  const piLog = join(fixture.root, 'pi.jsonl');
  await writeFile(fixture.fakePi, String.raw`#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
let input = '';
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  const request = JSON.parse(input);
  appendFileSync(${JSON.stringify(piLog)}, JSON.stringify({ argv: process.argv.slice(2), request }) + '\n');
  if (request.type === 'prompt') {
    process.stdout.write(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'The requested work is complete.' }] } }) + '\n');
    process.stdout.write(JSON.stringify({ type: 'agent_settled' }) + '\n');
    return;
  }
  process.stdout.write('The requested work is complete.');
});
`, { mode: 0o755 });
  await chmod(fixture.fakePi, 0o755);
  await mkdir(join(fixture.miRoot, 'state'), { recursive: true });
  await mkdir(join(fixture.miRoot, 'pi', 'extensions'), { recursive: true });
  await writeFile(join(fixture.miRoot, 'pi', 'extensions', 'mi-capability-guard.ts'), 'export default function () {}\n');
  daemon = await startFakeDaemon(fixture.env.MI_SOCKET_PATH);
  web = await startWebChat({ ...fixture.env, MI_IMESSAGE_V2: '1', PI_CMD: fixture.fakePi, MI_GATEWAY_CLIENT: fixture.fakePi, MI_WEB_WORKER_POLL_MS: '20' });

  async function coordinatorTurn(message) {
    const result = (await httpJson(web.baseUrl, '/api/imessage', { method: 'POST', body: { message } })).json;
    assert.equal(result.handoff, true, `${message}: uses the Pi coordinator`);
    await waitFor(async () => {
      const messages = (await httpJson(web.baseUrl, '/api/messages?thread=main')).json.messages;
      return messages.some((entry) => entry.source === 'mi-worker-result' && entry.taskId === result.taskId);
    }, { timeoutMs: 3000, message: `${message} coordinator completion` });
    return result;
  }

  for (const message of ['Hello Mi.', 'Ask Seth how I should position this.', '/skill:advisor ask Seth about the offer.', 'Ask Terra to inspect the workflow.']) await coordinatorTurn(message);
  let coordinatorCalls = (await readJsonl(piLog)).filter((entry) => entry.request.type === 'prompt');
  assert.equal(coordinatorCalls.length, 4, 'ordinary, advisor, skill, and named-worker requests all use the coordinator');
  for (const call of coordinatorCalls) {
    assert.ok(!call.argv.includes('--no-extensions') && !call.argv.includes('--no-skills') && !call.argv.includes('--no-context-files'), 'coordinator keeps normal Pi resource discovery');
    assert.ok(call.argv.includes('--extension') && call.argv.some((arg) => /mi-capability-guard\.ts$/.test(arg)), 'coordinator adds only the Mi capability guard');
  }
  assert.equal(daemon.requests.filter((entry) => entry.type === 'run_worker').length, 0, 'coordinator does not turn normal foreground messages into restricted children');

  const denied = (await httpJson(web.baseUrl, '/api/imessage', { method: 'POST', body: { message: 'Deploy the garden-plan change now.' } })).json;
  const deny = (await httpJson(web.baseUrl, '/api/imessage', { method: 'POST', body: { message: `deny ${denied.confirmationId}` } })).json;
  assert.notEqual(deny.handoff, true, 'deny consumes without execution');

  const risky = (await httpJson(web.baseUrl, '/api/imessage', { method: 'POST', body: { message: 'Deploy the garden-plan change now.' } })).json;
  assert.equal(risky.handoff, false, 'high-impact request waits for confirmation');
  assert.match(risky.reply, new RegExp(`confirm ${risky.confirmationId}`), 'confirmation is bound to one record');
  const beforeConfirm = coordinatorCalls.length;
  const wrongThread = (await httpJson(web.baseUrl, '/api/imessage', { method: 'POST', body: { thread: 'other', message: `confirm ${risky.confirmationId}` } })).json;
  assert.notEqual(wrongThread.handoff, true, 'wrong-thread confirmation cannot launch work');
  const confirmed = await coordinatorTurn(`confirm ${risky.confirmationId}`);
  coordinatorCalls = (await readJsonl(piLog)).filter((entry) => entry.request.type === 'prompt');
  assert.equal(coordinatorCalls.length, beforeConfirm + 1, 'exact confirmation starts exactly one coordinator turn');
  const confirmedPrompt = coordinatorCalls.at(-1).request.message;
  assert.match(confirmedPrompt, /one confirmed confirmed-high-impact objective/i, 'confirmed coordinator prompt is explicitly single-use');
  assert.match(confirmedPrompt, /Deploy the garden-plan change now/, 'confirmed objective is bound into the coordinator prompt');
  const replay = (await httpJson(web.baseUrl, '/api/imessage', { method: 'POST', body: { message: `confirm ${risky.confirmationId}` } })).json;
  assert.equal(replay.handoff, false, 'replay is fail-closed');
  assert.equal((await readJsonl(piLog)).filter((entry) => entry.request.type === 'prompt').length, beforeConfirm + 1, 'replay starts no extra coordinator');
  assert.ok(confirmed.taskId, 'confirmed action retains a correlation id');

  console.log('Mi iMessage V2 checks passed.');
} finally {
  if (web) await web.close();
  if (daemon) await daemon.close();
  await fixture.cleanup();
}
