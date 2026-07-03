#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function socketHealth(socketPath, timeoutMs = 500) {
  return new Promise((resolve) => {
    const socket = net.createConnection(socketPath);
    let data = '';
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, timeoutMs);
    socket.on('connect', () => socket.write(`${JSON.stringify({ type: 'health' })}\n`));
    socket.on('data', (chunk) => {
      data += chunk.toString('utf8');
      if (!data.includes('\n')) return;
      clearTimeout(timer);
      socket.end();
      try { resolve(JSON.parse(data.slice(0, data.indexOf('\n'))).ok === true); } catch { resolve(false); }
    });
    socket.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

async function waitForHealth(socketPath) {
  for (let i = 0; i < 60; i += 1) {
    if (await socketHealth(socketPath, 300)) return true;
    await sleep(100);
  }
  return false;
}

const root = await mkdtemp(join(tmpdir(), 'mi-daemon-singleton-'));
const runtime = join(root, 'runtime');
const socketPath = join(runtime, 'main.sock');
const sessionDir = join(root, 'sessions');
await mkdir(runtime, { recursive: true });

const daemon = new URL('../pi/extensions/mi-daemon.mjs', import.meta.url).pathname;
const env = {
  ...process.env,
  HOME: root,
  MI_ROOT: join(root, 'assistant'),
  MI_RUNTIME_DIR: runtime,
  MI_SOCKET_PATH: socketPath,
  MI_SESSION_DIR: sessionDir,
  MI_PI_BIN: '/bin/false',
  MI_DAEMON_LOCK_START_GRACE_MS: '5000',
  MI_DAEMON_LOCK_STALE_MS: '60000',
  MI_DAEMON_IDLE_EXIT_MS: '0',
};

const procs = [spawn(process.execPath, [daemon], { env, stdio: ['ignore', 'pipe', 'pipe'] }), spawn(process.execPath, [daemon], { env, stdio: ['ignore', 'pipe', 'pipe'] })];
const stderr = ['', ''];
procs.forEach((proc, index) => proc.stderr.on('data', (chunk) => { stderr[index] += chunk.toString('utf8'); }));

try {
  assert.equal(await waitForHealth(socketPath), true, 'one daemon becomes healthy');
  await sleep(1500);
  const running = procs.filter((proc) => proc.exitCode === null && proc.signalCode === null);
  assert.equal(running.length, 1, 'only one daemon remains running after singleton race');
  const log = await readFile(join(runtime, 'mi-daemon.log'), 'utf8');
  assert.match(log, /singleton exit|listening/, 'daemon race records singleton/listening status');
  assert.doesNotMatch(`${log}\n${stderr.join('\n')}`, /EADDRINUSE/, 'daemon race stays free of EADDRINUSE');
} finally {
  for (const proc of procs) {
    if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGTERM');
  }
  await sleep(300);
  await rm(root, { recursive: true, force: true });
}

console.log('Mi daemon singleton race checks passed.');
