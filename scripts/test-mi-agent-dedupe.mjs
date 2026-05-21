#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod } from 'node:fs/promises';
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

const fakePiJsPath = join(root, 'fake-pi.js');
const fakePiPath = join(root, 'fake-pi');
await writeFile(fakePiJsPath, `
let sessionId = 'fake-' + Math.random().toString(36).slice(2);
let sessionName = 'fake';
const sessionFile = ${JSON.stringify(root)} + '/fake-' + sessionId + '.jsonl';
process.stdin.on('data', (chunk) => {
  for (const line of chunk.toString('utf8').trim().split(/\\n/)) {
    if (!line) continue;
    const request = JSON.parse(line);
    if (request.type === 'set_session_name') {
      sessionName = request.name || sessionName;
      console.log(JSON.stringify({ type: 'response', id: request.id, success: true, data: {} }));
    } else if (request.type === 'get_state') {
      console.log(JSON.stringify({ type: 'response', id: request.id, success: true, data: { sessionFile, sessionId, sessionName, model: {} } }));
    } else if (request.type === 'prompt') {
      console.log(JSON.stringify({ type: 'response', id: request.id, success: true, data: {} }));
      setTimeout(() => console.log(JSON.stringify({ type: 'agent_end', messages: [{ role: 'assistant', content: [{ type: 'text', text: 'done' }] }] })), 500);
    }
  }
});
`);
await writeFile(fakePiPath, `#!/bin/sh\nexec ${process.execPath} ${fakePiJsPath} "$@"\n`);
await chmod(fakePiPath, 0o755);

function iso(offsetMs = 0) {
  return new Date(Date.UTC(2026, 0, 1, 0, 0, 0) + offsetMs).toISOString();
}

function uuid(n) {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

async function sessionFile({ id, name, cwd = '/repo', busy = false, finalText = 'done', at = iso(), userText }) {
  const file = join(sessionsRoot, `2026-01-01T00-00-00-000Z_${id}.jsonl`);
  const records = [
    { type: 'session', version: 3, id, timestamp: at, cwd },
    { type: 'session_info', timestamp: at, name },
    { type: 'message', timestamp: at, message: { role: 'user', content: [{ type: 'text', text: userText || `do ${name}` }] } },
  ];
  if (busy) records.push({ type: 'message', timestamp: at, message: { role: 'assistant', content: [{ type: 'toolCall', id: 'call', name: 'bash', arguments: {} }] } });
  else records.push({ type: 'message', timestamp: at, message: { role: 'assistant', content: [{ type: 'text', text: finalText }] } });
  await writeFile(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return file;
}

async function writeTasks(tasks) {
  await writeFile(tasksPath, JSON.stringify(tasks, null, 2));
}

async function request(type, payload = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let data = '';
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('timeout')); }, 5000);
    socket.on('connect', () => socket.write(`${JSON.stringify({ type, ...payload })}\n`));
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
    MI_PI_BIN: fakePiPath,
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
  const sameSession = rows.find((t) => t.name === 'same-session-task');
  assert.equal(rows.filter((t) => t.name === 'same-session-task').length, 1, 'same UUID/path duplicated');
  assert.equal(sameSession.status, 'complete', 'scanned terminal session should complete a stale stored running row');

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

  // 5. A just-opened pi session may not have session_info yet and shows as a generic cwd name.
  // It must still merge with the stored worker task when the latest user input matches.
  await writeTasks([{ id: 'task-generic-open', name: 'specific-stored-task', sessionName: 'specific-stored-task', cwd: '/repo', status: 'running', lastInput: 'same user prompt', updatedAt: iso(3900) }]);
  await sessionFile({ id: uuid(9), name: 'user', cwd: '/repo', finalText: 'done', at: iso(3950), userText: 'same user prompt' });
  rows = (await request('list_tasks')).tasks;
  const genericPromptRows = rows.filter((t) => t.cwd === '/repo' && (t.id === 'task-generic-open' || t.sessionId === uuid(9) || t.lastInput === 'same user prompt'));
  assert.equal(genericPromptRows.length, 1, 'stored task and generic open pi session duplicated');
  assert.equal(genericPromptRows[0].lastInput, 'same user prompt', 'scanned pi session did not preserve last user input');

  // 6. Generic person names must not collapse unrelated external sessions.
  await writeTasks([]);
  await sessionFile({ id: uuid(6), name: 'user', cwd: '/repo-a', finalText: 'a', at: iso(4000) });
  await sessionFile({ id: uuid(7), name: 'user', cwd: '/repo-b', finalText: 'b', at: iso(5000) });
  rows = (await request('list_tasks')).tasks.filter((t) => [uuid(6), uuid(7)].includes(t.sessionId));
  assert.equal(rows.length, 2, 'generic session names were incorrectly merged');
  assert.deepEqual(new Set(rows.map((t) => t.cwd)), new Set(['/repo-a', '/repo-b']), 'generic session rows lost their cwd identity');

  // 7. Concurrent duplicate starts must be suppressed before both requests can upsert.
  await writeTasks([]);
  const [firstStart, secondStart] = await Promise.all([
    request('run_worker', { name: 'same-start', cwd: home, message: 'same prompt', background: true }),
    request('run_worker', { name: 'same-start', cwd: home, message: 'same prompt', background: true }),
  ]);
  assert.equal([firstStart, secondStart].filter((result) => /^Started background task/.test(result.text || '')).length, 1, 'concurrent duplicate starts both launched workers');
  assert.equal([firstStart, secondStart].filter((result) => /Not starting duplicate task/.test(result.text || '')).length, 1, 'concurrent duplicate start was not reported as suppressed');
  rows = (await request('list_tasks')).tasks;
  assert.equal(rows.filter((t) => t.name === 'same-start').length, 1, 'concurrent duplicate start persisted duplicate task rows');

  // 8. A freshly queued follow-up must not be overwritten by the previous completed scan.
  await writeTasks([{ id: 'task-new-followup', name: 'new-followup', sessionName: 'new-followup', cwd: '/repo', status: 'running', sessionId: uuid(10), sessionFile: await sessionFile({ id: uuid(10), name: 'new-followup', cwd: '/repo', finalText: 'old complete', at: iso(6000) }), continuedAt: iso(7000), updatedAt: iso(7000), lastInput: 'new prompt' }]);
  rows = (await request('list_tasks')).tasks;
  const followup = rows.find((t) => t.id === 'task-new-followup' || t.sessionId === uuid(10));
  assert.equal(followup.status, 'running', 'newer stored follow-up was overwritten by stale completed session scan');

  // 9. A persisted external Pi session that was working but is no longer open must stay visible as needs input.
  await writeTasks([{ id: `pi-session:${uuid(11)}`, source: 'pi-session', name: 'stopped-external-pi', sessionName: 'stopped-external-pi', cwd: '/repo', status: 'running', sessionId: uuid(11), sessionFile: '/missing/session.jsonl', updatedAt: iso(8000), progress: 'working' }]);
  rows = (await request('list_tasks')).tasks;
  const stoppedExternal = rows.find((t) => t.name === 'stopped-external-pi');
  assert.equal(stoppedExternal.status, 'paused', 'stopped external pi session disappeared or stayed working instead of needs input');
  assert.equal(stoppedExternal.needsUser, true, 'stopped external pi session did not move to needs input');

  console.log('Mi agent dedupe repro checks passed.');
} finally {
  daemon.kill('SIGTERM');
  await new Promise((resolve) => daemon.once('exit', resolve));
  await rm(root, { recursive: true, force: true });
}
