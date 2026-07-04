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
const finalText = 'Worker final result posted to main chat.';
const secondFinalText = 'Second run final result.';

await mkdir(home, { recursive: true });
await mkdir(runtime, { recursive: true });
await mkdir(miRoot, { recursive: true });
await writeFile(sessionFile, '');
await writeFile(fakePi, `#!/usr/bin/env node
import readline from 'node:readline';
let sessionName = 'fake-worker';
const sessionFile = ${JSON.stringify(sessionFile)};
const sessionId = 'fake-session-id';
const model = 'fake/model';
function send(payload) { process.stdout.write(JSON.stringify(payload) + '\\n'); }
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const request = JSON.parse(line);
  if (request.type === 'set_session_name') sessionName = request.name || sessionName;
  if (request.type === 'prompt') {
    send({ type: 'response', id: request.id, success: true, data: { queued: true } });
    const message = String(request.message || '');
    const slow = message.includes('slow');
    const reply = message.includes('again') ? ${JSON.stringify(secondFinalText)} : ${JSON.stringify(finalText)};
    setTimeout(() => send({ type: 'agent_end', messages: [{ role: 'assistant', content: reply }] }), slow ? 1500 : 25);
    return;
  }
  send({ type: 'response', id: request.id, success: true, data: { sessionFile, sessionId, sessionName, model } });
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
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw lastError || new Error('condition timed out');
}

try {
  await waitFor(async () => existsSync(socketPath) && (await socketRequest({ type: 'health' })).ok === true);

  const started = await socketRequest({
    type: 'run_worker',
    name: 'result-report-e2e',
    cwd: home,
    message: 'do the task',
    lastInput: 'do the task',
    background: true,
    reportToMain: true,
  });
  assert.equal(started.ok, true);
  assert.match(started.text, /Started background task: result-report-e2e/);

  const reported = await waitFor(async () => {
    const path = join(miRoot, 'state', 'threads', 'main.jsonl');
    const text = await readFile(path, 'utf8');
    return text.split('\n').filter(Boolean).map((line) => JSON.parse(line)).find((message) => message.source === 'mi-worker-result' && message.text === finalText);
  });
  assert.equal(reported.role, 'assistant');
  assert.equal(reported.unread, true);

  const tasks = JSON.parse(await readFile(join(home, 'mi', 'state', 'tasks.json'), 'utf8'));
  const task = tasks.find((entry) => entry.name === 'result-report-e2e');
  assert.equal(task.status, 'complete');
  assert.equal(task.text, finalText);

  // A second run with the same name merges into the same row (sameLogicalTask
  // matches on name+cwd). While it is starting/running it must not display
  // the first run's output; upsertTask resets stale result fields on a fresh id.
  const secondStarted = await socketRequest({
    type: 'run_worker',
    name: 'result-report-e2e',
    cwd: home,
    message: 'do the task again slow',
    lastInput: 'do the task again slow',
    background: true,
  });
  assert.equal(secondStarted.ok, true);
  assert.match(secondStarted.text, /Started background task: result-report-e2e/);

  const runningRow = await waitFor(async () => {
    const rows = JSON.parse(await readFile(join(home, 'mi', 'state', 'tasks.json'), 'utf8'));
    const row = rows.find((entry) => entry.name === 'result-report-e2e');
    return row && row.id === secondStarted.taskId && String(row.status) === 'running' ? row : undefined;
  });
  assert.notEqual(runningRow.text, finalText, 'fresh run must not display the previous run output');
  assert.ok(!runningRow.text, 'fresh run should start with no output text');
  assert.ok(!runningRow.finishedAt, 'fresh run should not inherit finishedAt');

  const secondDone = await waitFor(async () => {
    const rows = JSON.parse(await readFile(join(home, 'mi', 'state', 'tasks.json'), 'utf8'));
    const row = rows.find((entry) => entry.name === 'result-report-e2e');
    return row && String(row.status) === 'complete' && row.text === secondFinalText ? row : undefined;
  });
  assert.equal(secondDone.id, secondStarted.taskId);

  console.log('mi worker result report e2e passed');
} finally {
  daemon.kill('SIGTERM');
  await new Promise((resolve) => daemon.once('exit', resolve));
  await rm(root, { recursive: true, force: true });
  if (daemon.exitCode && daemon.exitCode !== 0 && daemon.exitCode !== null) process.stderr.write(daemonStderr);
}
