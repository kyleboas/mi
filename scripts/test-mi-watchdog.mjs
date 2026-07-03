#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const root = await mkdtemp(join(tmpdir(), 'mi-watchdog-'));
try {
  const state = join(root, 'state');
  await mkdir(state, { recursive: true });
  const socket = join(state, 'mi-daemon.sock');
  const server = spawn(process.execPath, ['-e', `const net=require('net'); const s=net.createServer(); s.listen(process.argv[1]); process.on('SIGTERM',()=>s.close(()=>process.exit(0)));`, socket]);
  await new Promise((resolve, reject) => {
    const started = Date.now();
    const check = () => {
      const result = spawnSync('test', ['-S', socket]);
      if (result.status === 0) return resolve();
      if (Date.now() - started > 5000) return reject(new Error('socket did not start'));
      setTimeout(check, 50);
    };
    check();
  });
  await writeFile(join(state, 'tick.json'), JSON.stringify({ ts: new Date().toISOString() }));
  let result = spawnSync('bash', ['scripts/mi-watchdog.sh'], { cwd: process.cwd(), env: { ...process.env, MI_STATE_DIR: state, MI_SOCKET_PATH: socket, MI_WATCHDOG_SERVICES: '' }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Mi watchdog ok/);

  await writeFile(join(state, 'tick.json'), JSON.stringify({ ts: '2020-01-01T00:00:00.000Z' }));
  result = spawnSync('bash', ['scripts/mi-watchdog.sh'], { cwd: process.cwd(), env: { ...process.env, MI_STATE_DIR: state, MI_SOCKET_PATH: socket, MI_WATCHDOG_SERVICES: '', MI_WATCHDOG_MAX_STALE_SECONDS: '1' }, encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Mi watchdog alert: stale tick/);
  server.kill('SIGTERM');
} finally {
  await rm(root, { recursive: true, force: true });
}
console.log('Mi watchdog checks passed.');
