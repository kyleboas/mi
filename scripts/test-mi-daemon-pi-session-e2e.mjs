#!/usr/bin/env node
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtemp, mkdir, rm, symlink, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const root = await mkdtemp(join(tmpdir(), 'mi-daemon-pi-session-e2e-'));
const home = join(root, 'home');
const runtime = join(root, 'runtime');
const miRoot = join(root, 'assistant');
const socketPath = join(runtime, 'main.sock');
const sessionDir = join(home, '.pi', 'agent', 'sessions', 'e2e');
const sessionFile = join(sessionDir, '11111111-1111-4111-8111-111111111111.jsonl');
const fakePi = join(root, 'pi');
let daemon;
let interactivePi;

function iso(offsetMs = 0) {
  return new Date(Date.now() + offsetMs).toISOString();
}

function request(payload, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let data = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Timed out waiting for daemon response to ${payload.type}`));
    }, timeoutMs);
    socket.on('connect', () => socket.write(`${JSON.stringify(payload)}\n`));
    socket.on('data', (chunk) => {
      data += chunk.toString('utf8');
      if (!data.includes('\n')) return;
      clearTimeout(timer);
      socket.end();
      const response = JSON.parse(data.slice(0, data.indexOf('\n')));
      response.ok ? resolve(response) : reject(new Error(response.error || 'daemon returned error'));
    });
    socket.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function waitFor(check, label, timeoutMs = 8000) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeoutMs) {
    last = await check().catch((error) => error);
    if (last && !(last instanceof Error)) return last;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${label}; last=${last instanceof Error ? last.message : JSON.stringify(last)}`);
}

try {
  await mkdir(sessionDir, { recursive: true });
  await mkdir(miRoot, { recursive: true });
  const startedAt = iso();
  await writeFile(sessionFile, [
    JSON.stringify({ type: 'session', id: '11111111-1111-4111-8111-111111111111', cwd: root, timestamp: startedAt }),
    JSON.stringify({ type: 'session_info', name: 'typed e2e task' }),
    JSON.stringify({ type: 'message', timestamp: iso(10), message: { role: 'user', content: 'please continue selected task' } }),
    '',
  ].join('\n'));
  await symlink('/bin/bash', fakePi);

  daemon = spawn(process.execPath, ['pi/extensions/mi-daemon.mjs'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: {
      ...process.env,
      HOME: home,
      MI_ROOT: miRoot,
      MI_RUNTIME_DIR: runtime,
      MI_SOCKET_PATH: socketPath,
      MI_WORKER: '0',
      MI_PI_SESSION_SCAN_CACHE_MS: '0',
      MI_ACTIVE_PI_SESSION_WINDOW_MS: String(60_000),
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  daemon.stderr.on('data', (chunk) => process.stderr.write(chunk));
  await waitFor(() => request({ type: 'health' }).then(() => true), 'daemon health');

  interactivePi = spawn('script', ['-q', '-c', `${fakePi} -c 'while true; do sleep 1; done' pi --session ${sessionFile}`, '/dev/null'], {
    cwd: root,
    env: { ...process.env, HOME: home, MI_WORKER: '0' },
    stdio: ['pipe', 'ignore', 'ignore'],
  });

  const running = await waitFor(async () => {
    const response = await request({ type: 'list_tasks' });
    const task = response.tasks?.find((entry) => entry.sessionFile === sessionFile || entry.actualSessionFile === sessionFile || entry.sessionId === '11111111-1111-4111-8111-111111111111');
    return task && String(task.status).toLowerCase() === 'running' ? task : undefined;
  }, 'typed pi session to appear as running');
  assert.equal(running.name, 'typed e2e task');

  interactivePi.kill('SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 500));

  const paused = await waitFor(async () => {
    const response = await request({ type: 'list_tasks' });
    const task = response.tasks?.find((entry) => entry.sessionFile === sessionFile || entry.actualSessionFile === sessionFile || entry.sessionId === '11111111-1111-4111-8111-111111111111');
    return task && String(task.status).toLowerCase() === 'paused' ? task : undefined;
  }, 'stopped typed pi session to move to needs input');
  assert.equal(paused.needsUser, true);
  assert.equal(paused.needsUserReason, 'interactive pi session stopped before replying');
  assert.equal(paused.finishedAt, undefined);

  console.log('mi daemon pi-session e2e passed');
} finally {
  interactivePi?.kill('SIGTERM');
  daemon?.kill('SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 200));
  if (!process.env.KEEP_TMP) await rm(root, { recursive: true, force: true });
  else console.error(`kept ${root}`);
}
