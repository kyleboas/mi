#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { v2RiskClassification, v2RouteDecision } from './mi-web-chat-v2-route.mjs';

const source = await readFile(new URL('./mi-web-chat.mjs', import.meta.url), 'utf8');
const photonSource = await readFile(new URL('./mi-photon-bridge.mjs', import.meta.url), 'utf8');
const runtimeSource = await readFile(new URL('./mi-imessage-runtime.mjs', import.meta.url), 'utf8');
const coordinatorSource = await readFile(new URL('./mi-imessage-coordinator.mjs', import.meta.url), 'utf8');

assert.match(source, /MI_WEB_MAINTENANCE/, 'Web chat has an explicit maintenance gate');
assert.match(source, /!webMaintenance && url\.pathname !== '\/api\/health'/, 'default Web routes stay unavailable');
assert.doesNotMatch(source, /\/api\/imessage|\/api\/messages|runImessageChat|loadLegacyImessageRouting|MI_IMESSAGE_V2|MI_IMESSAGE_ASK_FIRST/, 'Web chat has no iMessage routing or polling');
assert.doesNotMatch(photonSource, /MI_WEB_URL|\/api\/imessage|\/api\/messages|poll/, 'Photon has no Web relay or result polling');
assert.match(photonSource, /createImessageRuntime/, 'Photon calls the focused runtime directly');
assert.match(runtimeSource, /stateRoot = path\.join\(root, 'state'\)/, 'runtime stores state below state/imessage');
assert.match(runtimeSource, /recoverStaleRunning/, 'runtime recovers stale running deliveries');
assert.match(runtimeSource, /sendAndMark/, 'runtime marks delivery sent only after Photon success');
assert.match(coordinatorSource, /'--session', sessionPath/, 'coordinator uses the exact session path');
assert.doesNotMatch(coordinatorSource, /--session-dir|--no-session/, 'coordinator has no session fallback');
assert.equal(v2RouteDecision({ message: 'hello', workspace: { root: '/tmp/work', cwd: '/tmp/work' } }).kind, 'coordinator');
assert.equal(v2RiskClassification('delete all data').kind, 'never-delegate');
assert.equal(v2RiskClassification('send Kyle a message').kind, 'confirm');
assert.equal(v2RouteDecision({ message: 'Reply exactly: iMessage check passed.', workspace: { root: '/tmp/work', cwd: '/tmp/work' } }).kind, 'coordinator');
assert.equal(v2RouteDecision({ message: 'reply to Alice: iMessage check passed.', workspace: { root: '/tmp/work', cwd: '/tmp/work' } }).kind, 'confirm');
assert.equal(v2RouteDecision({ message: 'cancel', workspace: { root: '/tmp/work', cwd: '/tmp/work' } }).kind, 'cancel');

const root = await mkdtemp(join(tmpdir(), 'mi-web-maintenance-route-'));
const port = String(24000 + Math.floor(Math.random() * 5000));
const fakeSocketPath = join(root, 'fake-main.sock');
await mkdir(join(root, 'state'), { recursive: true, mode: 0o700 });
await writeFile(join(root, 'state', 'web-workers.json'), JSON.stringify([{ id: 'persisted-worker', threadId: 'main', status: 'running', createdAt: new Date().toISOString() }]));
let taskRequests = 0;
const fakeSocket = net.createServer((socket) => {
  taskRequests += 1;
  socket.on('data', () => socket.end(JSON.stringify({ ok: true, tasks: [] }) + '\\n'));
});
await new Promise((resolve, reject) => {
  fakeSocket.once('error', reject);
  fakeSocket.listen(fakeSocketPath, resolve);
});
const child = spawn(process.execPath, ['scripts/mi-web-chat.mjs'], {
  cwd: new URL('..', import.meta.url).pathname,
  env: { ...process.env, MI_ROOT: root, HOME: root, MI_SOCKET_PATH: fakeSocketPath, MI_WEB_HOST: '127.0.0.1', MI_WEB_PORT: port, MI_WEB_HTTPS_PORT: '0', MI_WEB_MAINTENANCE: '0' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
try {
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const health = await fetch(`${base}/api/health`);
  assert.equal(health.status, 200, 'health remains available for diagnostics');
  const ui = await fetch(`${base}/`);
  assert.equal(ui.status, 404, 'Web UI is unavailable without maintenance mode');
  const mutable = await fetch(`${base}/api/send`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'not allowed' }) });
  assert.equal(mutable.status, 404, 'mutable Web routes are unavailable without maintenance mode');
  assert.equal(taskRequests, 0, 'maintenance-off startup does not monitor persisted active workers');
} finally {
  child.kill('SIGTERM');
  await new Promise((resolve) => child.once('exit', resolve));
  await new Promise((resolve) => fakeSocket.close(resolve));
  await rm(root, { recursive: true, force: true });
}
console.log('Mi Web maintenance routing checks passed.');
