#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import net from 'node:net';

const root = await mkdtemp(join(tmpdir(), 'mi-dedupe-'));
const home = join(root, 'home');
const runtime = join(root, 'runtime');
const socketPath = join(runtime, 'main.sock');
const tasksPath = join(home, 'mi', 'state', 'tasks.json');
const sessionsRoot = join(home, '.pi', 'agent', 'sessions', '--home-test--');
await mkdir(sessionsRoot, { recursive: true });
await mkdir(join(home, 'mi', 'state'), { recursive: true });

function iso(offsetMs = 0) {
  return new Date(Date.UTC(2026, 0, 1, 0, 0, 0) + offsetMs).toISOString();
}

function uuid(n) {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

async function sessionFile({ id, name, cwd = '/repo', busy = false, finalText = 'done', at = iso() }) {
  const file = join(sessionsRoot, `2026-01-01T00-00-00-000Z_${id}.jsonl`);
  const records = [
    { type: 'session', version: 3, id, timestamp: at, cwd },
    { type: 'session_info', timestamp: at, name },
    { type: 'message', timestamp: at, message: { role: 'user', content: [{ type: 'text', text: `do ${name}` }] } },
  ];
  if (busy) records.push({ type: 'message', timestamp: at, message: { role: 'assistant', content: [{ type: 'toolCall', id: 'call', name: 'bash', arguments: {} }] } });
  else records.push({ type: 'message', timestamp: at, message: { role: 'assistant', content: [{ type: 'text', text: finalText }] } });
  await writeFile(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return file;
}

async function writeTasks(tasks) {
  await writeFile(tasksPath, JSON.stringify(tasks, null, 2));
}

async function request(type) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let data = '';
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('timeout')); }, 5000);
    socket.on('connect', () => socket.write(`${JSON.stringify({ type })}\n`));
    socket.on('data', (chunk) => {
      data += chunk.toString('utf8');
      if (!data.includes('\n')) return;
      clearTimeout(timer);
      socket.end();
      const response = JSON.parse(data.slice(0, data.indexOf('\n')));
      response.ok ? resolve(response) : reject(new Error(response.error || 'request failed'));
    });
    socket.on('error', (error) => { clearTimeout(timer); reject(error); });
  });
}

async function waitForDaemon() {
  const deadline = Date.now() + 5000;
  let last;
  while (Date.now() < deadline) {
    try { await request('health'); return; } catch (error) { last = error; await new Promise((r) => setTimeout(r, 100)); }
  }
  throw last || new Error('daemon did not start');
}

const daemon = spawn(process.execPath, [new URL('../pi/extensions/mi-daemon.mjs', import.meta.url).pathname], {
  env: {
    ...process.env,
    HOME: home,
    MI_RUNTIME_DIR: runtime,
    MI_SOCKET_PATH: socketPath,
    MI_PI_BIN: process.execPath,
    MI_ACTIVE_PI_SESSION_WINDOW_MS: String(365 * 24 * 60 * 60_000),
    MI_PI_SESSION_SCAN_CACHE_MS: '0',
  },
  stdio: ['ignore', 'ignore', 'pipe'],
});
daemon.stderr.on('data', (chunk) => process.stderr.write(chunk));
await waitForDaemon();

try {
  // 1. Stored task + discovered pi-session with the same UUID/path must be one row.
  const f1 = await sessionFile({ id: uuid(1), name: 'same-session-task', cwd: '/repo', finalText: 'session complete', at: iso(1000) });
  await writeTasks([{ id: 'task-1', name: 'same-session-task', sessionName: 'same-session-task', cwd: '/repo', status: 'running', sessionId: uuid(1), sessionFile: f1, actualSessionFile: f1, updatedAt: iso(500) }]);
  let rows = (await request('list_tasks')).tasks;
  assert.equal(rows.filter((t) => t.name === 'same-session-task').length, 1, 'same UUID/path duplicated');

  // 2. Same UUID but different visible/actual paths must still be one row.
  await writeTasks([{ id: 'task-2', name: 'same-uuid-different-path', sessionName: 'same-uuid-different-path', cwd: '/repo', status: 'running', sessionFile: `/tmp/mirror_${uuid(2)}.jsonl`, updatedAt: iso(500) }]);
  await sessionFile({ id: uuid(2), name: 'same-uuid-different-path', cwd: '/repo', finalText: 'done', at: iso(1000) });
  rows = (await request('list_tasks')).tasks;
  assert.equal(rows.filter((t) => t.name === 'same-uuid-different-path').length, 1, 'same UUID in different paths duplicated');

  // 3. Replying to an external pi task can create a new session id; same non-generic name+cwd must merge.
  await writeTasks([{ id: `pi-session:${uuid(3)}`, source: 'pi-session', name: 'external-followup-task', sessionName: 'external-followup-task', cwd: '/repo', status: 'complete', sessionId: uuid(3), sessionFile: await sessionFile({ id: uuid(3), name: 'external-followup-task', cwd: '/repo', finalText: 'old complete', at: iso(1000) }), finishedAt: iso(1000), updatedAt: iso(1000) }]);
  await sessionFile({ id: uuid(4), name: 'external-followup-task', cwd: '/repo', finalText: 'new complete', at: iso(2000) });
  rows = (await request('list_tasks')).tasks;
  assert.equal(rows.filter((t) => t.name === 'external-followup-task').length, 1, 'same logical external task duplicated after follow-up');

  // 4. Terminal stored row must not be promoted back to Working by a stale busy scan.
  await writeTasks([{ id: `pi-session:${uuid(5)}`, source: 'pi-session', name: 'terminal-plus-stale-busy', sessionName: 'terminal-plus-stale-busy', cwd: '/repo', status: 'complete', sessionId: uuid(5), sessionFile: await sessionFile({ id: uuid(5), name: 'terminal-plus-stale-busy', cwd: '/repo', busy: true, at: iso(3000) }), finishedAt: iso(2500), updatedAt: iso(2500) }]);
  rows = (await request('list_tasks')).tasks;
  const terminal = rows.find((t) => t.name === 'terminal-plus-stale-busy');
  assert.equal(rows.filter((t) => t.name === 'terminal-plus-stale-busy').length, 1, 'terminal/stale-busy task duplicated');
  assert.notEqual(terminal.status, 'running', 'terminal task was promoted to running by stale busy session');

  // 4b. Paused/stopped rows must not flip back to running even while the just-killed worker is still tracked.
  await writeTasks([{ id: `pi-session:${uuid(8)}`, source: 'pi-session', name: 'paused-plus-live-busy', sessionName: 'paused-plus-live-busy', cwd: '/repo', status: 'paused', needsUser: true, needsUserReason: 'stopped by Escape', sessionId: uuid(8), sessionFile: await sessionFile({ id: uuid(8), name: 'paused-plus-live-busy', cwd: '/repo', busy: true, at: iso(3500) }), progress: 'stopped by Escape; needs user input', updatedAt: iso(3500) }]);
  rows = (await request('list_tasks')).tasks;
  const paused = rows.find((t) => t.name === 'paused-plus-live-busy');
  assert.equal(rows.filter((t) => t.name === 'paused-plus-live-busy').length, 1, 'paused/live-busy task duplicated');
  assert.equal(paused.status, 'paused', 'paused task was promoted to running by busy session scan');
  assert.equal(paused.needsUser, true, 'paused task lost needs-input state');

  // 5. Generic person names must not collapse unrelated external sessions.
  await writeTasks([]);
  await sessionFile({ id: uuid(6), name: 'kyle', cwd: '/repo-a', finalText: 'a', at: iso(4000) });
  await sessionFile({ id: uuid(7), name: 'kyle', cwd: '/repo-b', finalText: 'b', at: iso(5000) });
  rows = (await request('list_tasks')).tasks.filter((t) => t.name === 'kyle');
  assert.equal(rows.length, 2, 'generic session names were incorrectly merged');

  console.log('Mi agent dedupe repro checks passed.');
} finally {
  daemon.kill('SIGTERM');
  await new Promise((resolve) => daemon.once('exit', resolve));
  await rm(root, { recursive: true, force: true });
}
