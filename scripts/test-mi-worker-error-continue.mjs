#!/usr/bin/env node
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const root = await mkdtemp(join(tmpdir(), 'mi-worker-error-continue-'));
const home = join(root, 'home');
const runtime = join(root, 'runtime');
const miRoot = join(root, 'assistant');
const socketPath = join(runtime, 'main.sock');
const fakePi = join(root, 'fake-pi.mjs');
const sessionFile = join(root, 'session.jsonl');
const runCountFile = join(root, 'fake-pi-runs.txt');
const finalText = 'Worker recovered after the first error and finished.';

await mkdir(home, { recursive: true });
await mkdir(runtime, { recursive: true });
await mkdir(miRoot, { recursive: true });
await writeFile(sessionFile, '');
await writeFile(runCountFile, '0');
await writeFile(fakePi, `#!/usr/bin/env node
import readline from 'node:readline';
import { readFileSync, writeFileSync } from 'node:fs';
let sessionName = 'fake-worker';
const sessionFile = ${JSON.stringify(sessionFile)};
const runCountFile = ${JSON.stringify(runCountFile)};
const finalText = ${JSON.stringify(finalText)};
const sessionId = 'fake-session-id';
const model = 'fake/model';
const run = Number(readFileSync(runCountFile, 'utf8') || '0') + 1;
writeFileSync(runCountFile, String(run));
function send(payload) { process.stdout.write(JSON.stringify(payload) + '\\n'); }
function state() { return { sessionFile, sessionId, sessionName, model }; }
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const request = JSON.parse(line);
  if (request.type === 'set_session_name') sessionName = request.name || sessionName;
  if (request.type === 'prompt') {
    send({ type: 'response', id: request.id, success: true, data: { queued: true } });
    setTimeout(() => {
      if (run === 1) send({ type: 'agent_end', messages: [] });
      else send({ type: 'agent_end', messages: [{ role: 'assistant', content: finalText }] });
      send({ type: 'agent_settled' });
    }, 25);
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
    MI_WORKER_ERROR_CONTINUE_RETRIES: '1',
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
    name: 'error-continue-e2e',
    cwd: home,
    message: 'finish even if the first worker errors',
    lastInput: 'finish even if the first worker errors',
    background: true,
  });
  assert.equal(started.ok, true);
  assert.match(started.text, /Started background task: error-continue-e2e/);

  const task = await waitFor(async () => {
    const tasks = JSON.parse(await readFile(join(home, 'mi', 'state', 'tasks.json'), 'utf8'));
    return tasks.find((entry) => entry.name === 'error-continue-e2e' && entry.status === 'complete');
  });
  assert.equal(task.text, finalText);
  assert.equal(task.error, undefined);
  assert.equal(task.autoContinueAttempts, undefined);
  assert.equal(Number(await readFile(runCountFile, 'utf8')), 2);

  console.log('mi worker error continue e2e passed');
} finally {
  daemon.kill('SIGTERM');
  await new Promise((resolve) => daemon.once('exit', resolve));
  await rm(root, { recursive: true, force: true });
  if (daemon.exitCode && daemon.exitCode !== 0 && daemon.exitCode !== null) process.stderr.write(daemonStderr);
}
