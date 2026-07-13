#!/usr/bin/env node
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const root = await mkdtemp(join(tmpdir(), 'mi-worker-result-report-'));
const home = join(root, 'home');
const runtime = join(root, 'runtime');
const miRoot = join(root, 'assistant');
const socketPath = join(runtime, 'main.sock');
const fakePi = join(root, 'fake-pi.mjs');
const sessionFile = join(root, 'session.jsonl');
const lunaFinalText = 'Luna final result posted to main chat.';
const terraFinalText = 'Terra final result posted exactly once.';
const stoppedFinalText = 'This stopped result must never reach main chat.';

await mkdir(home, { recursive: true });
await mkdir(runtime, { recursive: true });
await mkdir(miRoot, { recursive: true });
await writeFile(sessionFile, '');
await writeFile(fakePi, `#!/usr/bin/env node
import readline from 'node:readline';
let sessionName = 'fake-worker';
let delayNextState = false;
const sessionFile = ${JSON.stringify(sessionFile)};
const sessionId = 'fake-session-id';
const model = 'fake/model';
const lunaFinalText = ${JSON.stringify(lunaFinalText)};
const terraFinalText = ${JSON.stringify(terraFinalText)};
const stoppedFinalText = ${JSON.stringify(stoppedFinalText)};
function send(payload) { process.stdout.write(JSON.stringify(payload) + '\\n'); }
function state() { return { sessionFile, sessionId, sessionName, model }; }
function settle(messages, delay) {
  setTimeout(() => send({ type: 'agent_end', messages }), delay);
}
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const request = JSON.parse(line);
  if (request.type === 'set_session_name') sessionName = request.name || sessionName;
  if (request.type === 'get_state') {
    const respond = () => send({ type: 'response', id: request.id, success: true, data: state() });
    if (delayNextState) { delayNextState = false; setTimeout(respond, 250); } else respond();
    return;
  }
  if (request.type === 'get_last_assistant_text') {
    send({ type: 'response', id: request.id, success: true, data: { text: '' } });
    return;
  }
  if (request.type === 'prompt') {
    send({ type: 'response', id: request.id, success: true, data: { queued: true } });
    const message = String(request.message || '');
    if (message.includes('luna')) {
      // This represents a nonterminal agent_end during retry/queue draining.
      settle([], 20);
      settle([{ role: 'assistant', content: lunaFinalText }], 45);
      setTimeout(() => send({ type: 'agent_settled' }), 70);
    } else if (message.includes('terra')) {
      settle([{ role: 'assistant', content: terraFinalText }], 20);
      settle([{ role: 'assistant', content: terraFinalText }], 40);
      setTimeout(() => send({ type: 'agent_settled' }), 65);
    } else if (message.includes('stop-race')) {
      delayNextState = true;
      settle([{ role: 'assistant', content: stoppedFinalText }], 20);
      setTimeout(() => send({ type: 'agent_settled' }), 35);
    }
    return;
  }
  send({ type: 'response', id: request.id, success: true, data: state() });
});
`, { mode: 0o755 });
await chmod(fakePi, 0o755);

const daemon = spawn(process.execPath, ['pi/extensions/mi-daemon.mjs'], {
  cwd: new URL('..', import.meta.url).pathname,
  env: {
    ...process.env,
    HOME: home,
    MI_ROOT: miRoot,
    MI_RUNTIME_DIR: runtime,
    MI_SOCKET_PATH: socketPath,
    MI_PI_BIN: fakePi,
    MI_MODEL: 'fake/model',
    MI_MAIN_IDLE_MS: '1000',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let daemonStderr = '';
daemon.stderr.on('data', (chunk) => { daemonStderr += chunk.toString('utf8'); });

function socketRequest(payload, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let data = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`socket timeout for ${payload.type}`));
    }, timeoutMs);
    socket.on('connect', () => socket.write(`${JSON.stringify(payload)}\n`));
    socket.on('data', (chunk) => {
      data += chunk.toString('utf8');
      if (!data.includes('\n')) return;
      clearTimeout(timer);
      socket.end();
      try { resolve(JSON.parse(data.slice(0, data.indexOf('\n')))); }
      catch (error) { reject(error); }
    });
    socket.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

const taskPath = join(home, 'mi', 'state', 'tasks.json');
const mainThreadPath = join(miRoot, 'state', 'threads', 'main.jsonl');

async function tasks() {
  return JSON.parse(await readFile(taskPath, 'utf8'));
}

async function mainMessages() {
  const text = await readFile(mainThreadPath, 'utf8').catch(() => '');
  return text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

async function waitFor(predicate, timeoutMs = 5000) {
  const start = Date.now();
  let lastError;
  while (Date.now() - start < timeoutMs) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw lastError || new Error('condition timed out');
}

async function startWorker(name, message) {
  const started = await socketRequest({
    type: 'run_worker', name, cwd: home, message, lastInput: message,
    background: true, reportToMain: true,
  });
  assert.equal(started.ok, true);
  assert.match(started.text, new RegExp(`Started background task: ${name}`));
  return started;
}

try {
  await waitFor(async () => existsSync(socketPath) && (await socketRequest({ type: 'health' })).ok === true);

  const luna = await startWorker('Luna delivery', 'luna: finish the task');
  // agent_end is not a terminal state: the task remains orderly/running until
  // agent_settled, even when the first agent_end has no assistant text.
  await new Promise((resolve) => setTimeout(resolve, 30));
  const lunaWhileUnsettled = (await tasks()).find((task) => task.id === luna.taskId);
  assert.equal(lunaWhileUnsettled.status, 'running');
  assert.equal(lunaWhileUnsettled.text, undefined);
  const lunaDone = await waitFor(async () => (await tasks()).find((task) => task.id === luna.taskId && task.status === 'complete'));
  assert.equal(lunaDone.text, lunaFinalText);
  await waitFor(async () => (await mainMessages()).filter((message) => message.text === lunaFinalText && message.source === 'mi-worker-result').length === 1);

  const terra = await startWorker('Terra delivery', 'terra: finish the task');
  const terraDone = await waitFor(async () => (await tasks()).find((task) => task.id === terra.taskId && task.status === 'complete'));
  assert.equal(terraDone.text, terraFinalText);
  await waitFor(async () => (await mainMessages()).filter((message) => message.text === terraFinalText && message.source === 'mi-worker-result').length === 1);
  assert.equal((await mainMessages()).filter((message) => message.text === terraFinalText && message.source === 'mi-worker-result').length, 1, 'duplicate agent_end events must deliver one result');

  const stopped = await startWorker('Terra stopped delivery', 'stop-race: do not report');
  // Wait until the terminal event has been emitted but before get_state returns;
  // this reproduces a late completion racing a user stop.
  await new Promise((resolve) => setTimeout(resolve, 60));
  const stopResult = await socketRequest({ type: 'stop_task', taskId: stopped.taskId });
  assert.equal(stopResult.ok, true);
  assert.match(stopResult.text, /Stopped Terra stopped delivery/);
  const stoppedTask = await waitFor(async () => (await tasks()).find((task) => task.id === stopped.taskId && task.status === 'paused'));
  assert.equal(stoppedTask.needsUser, true);
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.equal((await mainMessages()).filter((message) => message.text === stoppedFinalText).length, 0, 'stopped worker must not emit a stale result notification');

  console.log('mi worker result report e2e passed');
} finally {
  daemon.kill('SIGTERM');
  await new Promise((resolve) => daemon.once('exit', resolve));
  await rm(root, { recursive: true, force: true });
  if (daemon.exitCode && daemon.exitCode !== 0 && daemon.exitCode !== null) process.stderr.write(daemonStderr);
}
