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
const variantDir = join(sessionDir, 'variants');
const fakePi = join(root, 'pi');
let daemon;
let interactivePi;

function startInteractivePiSession() {
  return spawn('script', ['-q', '-c', `${fakePi} -c 'while true; do sleep 1; done' pi --session ${sessionFile}`, '/dev/null'], {
    cwd: root,
    env: { ...process.env, HOME: home, MI_WORKER: '0' },
    stdio: ['pipe', 'ignore', 'ignore'],
  });
}

function iso(offsetMs = 0) {
  return new Date(Date.now() + offsetMs).toISOString();
}

async function writeVariantSession({ id, name, records }) {
  const file = join(variantDir, `${id}.jsonl`);
  const startedAt = iso();
  await writeFile(file, [
    JSON.stringify({ type: 'session', id, cwd: root, timestamp: startedAt }),
    JSON.stringify({ type: 'session_info', name }),
    ...records.map((record, index) => JSON.stringify({ timestamp: iso(1000 + index), ...record })),
    '',
  ].join('\n'));
  return file;
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
  await mkdir(variantDir, { recursive: true });
  await mkdir(miRoot, { recursive: true });
  await mkdir(join(home, 'mi', 'state'), { recursive: true });
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

  await writeFile(join(home, 'mi', 'state', 'dismissed-tasks.json'), JSON.stringify(['Pi session'], null, 2));
  await writeFile(join(home, 'mi', 'state', 'tasks.json'), JSON.stringify([
    { id: 'pi-session:/tmp/generic-visible.jsonl', source: 'pi-session', name: 'Pi session', sessionName: 'Pi session', sessionFile: '/tmp/generic-visible.jsonl', cwd: root, status: 'complete', text: 'generic session result', finishedAt: iso(), updatedAt: iso() },
  ], null, 2));
  const genericVisible = await waitFor(async () => {
    const response = await request({ type: 'list_tasks' });
    return response.tasks?.find((entry) => entry.id === 'pi-session:/tmp/generic-visible.jsonl');
  }, 'generic Pi session not to be hidden by generic dismissed name');
  assert.equal(genericVisible.name, 'Pi session');
  assert.equal(genericVisible.text, 'generic session result');

  await writeFile(join(home, 'mi', 'state', 'tasks.json'), JSON.stringify([
    { id: 'pi-session:/tmp/generic-visible.jsonl', source: 'pi-session', name: 'Pi session', sessionName: 'Pi session', sessionFile: '/tmp/generic-visible.jsonl', cwd: root, status: 'complete', text: 'generic session result', finishedAt: iso(), updatedAt: iso() },
    { id: 'pi-session:11111111-1111-4111-8111-111111111111', source: 'pi-session', name: 'typed e2e task', sessionName: 'typed e2e task', sessionId: '11111111-1111-4111-8111-111111111111', sessionFile, actualSessionFile: sessionFile, cwd: root, status: 'running', needsUser: false, needsUserReason: undefined, openPiSession: true, openPiPid: process.pid, progress: 'stored still running', updatedAt: iso(5000) },
  ], null, 2));
  const preservedWorking = await waitFor(async () => {
    const response = await request({ type: 'list_tasks' });
    const task = response.tasks?.find((entry) => entry.sessionFile === sessionFile || entry.actualSessionFile === sessionFile || entry.sessionId === '11111111-1111-4111-8111-111111111111');
    return task && String(task.status).toLowerCase() === 'running' ? task : undefined;
  }, 'stored running pi session to stay running over a passive paused scan');
  assert.equal(preservedWorking.needsUser, false);
  assert.equal(preservedWorking.needsUserReason, undefined);
  assert.equal(preservedWorking.progress, 'stored still running');
  assert.equal(preservedWorking.openPiSession, true);

  interactivePi = startInteractivePiSession();

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
  assert.match(paused.needsUserReason, /Pi session is no longer running and no final assistant response was recorded/);
  assert.equal(paused.finishedAt, undefined);

  interactivePi = startInteractivePiSession();
  const resumed = await waitFor(async () => {
    const response = await request({ type: 'list_tasks' });
    const task = response.tasks?.find((entry) => entry.sessionFile === sessionFile || entry.actualSessionFile === sessionFile || entry.sessionId === '11111111-1111-4111-8111-111111111111');
    return task && String(task.status).toLowerCase() === 'running' && task.openPiSession ? task : undefined;
  }, 'reopened typed pi session to clear stale needs-input state');
  assert.equal(resumed.needsUser, false);
  assert.equal(resumed.needsUserReason, undefined);
  assert.equal(resumed.finishedAt, undefined);
  assert.ok(resumed.openPiPid, 'reopened session should publish its current pi pid');

  interactivePi.kill('SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 500));

  const variants = [
    {
      id: '22222222-2222-4222-8222-222222222222',
      name: 'stopped-after-user',
      expectedProgress: 'Pi session is still running',
      records: [
        { type: 'message', message: { role: 'user', content: 'new prompt with no response' } },
      ],
    },
    {
      id: '33333333-3333-4333-8333-333333333333',
      name: 'stopped-after-thinking',
      expectedProgress: 'Pi session is still running',
      records: [
        { type: 'message', message: { role: 'user', content: 'think then stop' } },
        { type: 'message', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'private reasoning' }] } },
      ],
    },
    {
      id: '44444444-4444-4444-8444-444444444444',
      name: 'stopped-after-toolcall',
      expectedProgress: 'Pi session is still running',
      records: [
        { type: 'message', message: { role: 'user', content: 'run a command then stop' } },
        { type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'echo should-not-be-final-output' } }] } },
      ],
    },
    {
      id: '55555555-5555-4555-8555-555555555555',
      name: 'stopped-after-toolresult',
      expectedProgress: 'Pi session is still running',
      records: [
        { type: 'message', message: { role: 'user', content: 'run tool with result then stop' } },
        { type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'call-2', name: 'bash', arguments: { command: 'echo done' } }] } },
        { type: 'message', message: { role: 'toolResult', toolCallId: 'call-2', toolName: 'bash', content: 'done' } },
      ],
    },
    {
      id: '66666666-6666-4666-8666-666666666666',
      name: 'stopped-after-old-final-and-new-user',
      expectedProgress: 'Pi session is still running',
      records: [
        { type: 'message', message: { role: 'user', content: 'old prompt' } },
        { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'old final should not be current progress' }] } },
        { type: 'message', message: { role: 'user', content: 'new prompt then stop' } },
      ],
    },
  ];
  const variantFiles = new Map();
  for (const variant of variants) variantFiles.set(variant.name, await writeVariantSession(variant));
  const variantRows = await waitFor(async () => {
    const response = await request({ type: 'list_tasks' });
    const found = variants.map((variant) => response.tasks?.find((entry) => entry.sessionFile === variantFiles.get(variant.name) || entry.sessionId === variant.id));
    return found.every(Boolean) ? found : undefined;
  }, 'all stopped pi-session variants to appear');
  for (let index = 0; index < variants.length; index += 1) {
    const variant = variants[index];
    const row = variantRows[index];
    assert.equal(row.status, 'paused', `${variant.name} should pause`);
    assert.equal(row.needsUser, true, `${variant.name} should need input`);
    assert.match(row.needsUserReason, /Pi session is no longer running and no final assistant response was recorded/, `${variant.name} reason`);
    assert.equal(row.progress, variant.expectedProgress, `${variant.name} should not expose stale assistant/tool progress`);
    assert.doesNotMatch(`${row.progress}\n${row.text || ''}`, /old final should not be current progress|should-not-be-final-output|private reasoning/, `${variant.name} leaked non-final activity`);
  }

  console.log('mi daemon pi-session e2e passed');
} finally {
  interactivePi?.kill('SIGTERM');
  daemon?.kill('SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 200));
  if (!process.env.KEEP_TMP) await rm(root, { recursive: true, force: true });
  else console.error(`kept ${root}`);
}
