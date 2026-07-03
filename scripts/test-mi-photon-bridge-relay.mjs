#!/usr/bin/env node
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const repoRoot = new URL('..', import.meta.url).pathname;

const bridgeSource = await readFile(join(repoRoot, 'scripts', 'mi-photon-bridge.mjs'), 'utf8');
assert.match(bridgeSource, /await sendToUser\(target, message, 'notification'\)/, 'notify endpoint sends the message body without a title heading');

async function readJsonl(path) {
  if (!existsSync(path)) return [];
  const text = await readFile(path, 'utf8');
  return text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk.toString('utf8'); });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch (error) { reject(error); }
    });
    req.on('error', reject);
  });
}

function startMiServer({ source, text }) {
  const calls = [];
  let messagesPolls = 0;
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      if (req.method === 'POST' && url.pathname === '/api/imessage') {
        const body = await readBody(req);
        calls.push({ method: req.method, path: url.pathname, body });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, reply: 'On it. I’ll follow up here.', handoff: true }));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/messages') {
        messagesPolls += 1;
        calls.push({ method: req.method, path: url.pathname, thread: url.searchParams.get('thread'), messagesPolls });
        const messages = messagesPolls >= 2
          ? [{ role: 'assistant', source, text, ts: new Date().toISOString() }]
          : [];
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ messages }));
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    } catch (error) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: error?.message || String(error) }));
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        server,
        calls,
        baseUrl: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

function runBridge(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/mi-photon-bridge.mjs'], {
      cwd: repoRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`mi-photon-bridge timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, 10000);
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`mi-photon-bridge exited ${code || signal}\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    });
  });
}

async function runRelayCase(root, name, workerReply) {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  const eventsPath = join(dir, 'events.json');
  const sendsPath = join(dir, 'sends.jsonl');
  await writeFile(eventsPath, JSON.stringify([
    {
      space: { id: `${name}-space`, phone: '+15551234567' },
      message: {
        id: `${name}-message`,
        direction: 'inbound',
        sender: { id: '+15551234567' },
        content: { type: 'text', text: 'check detect status' },
      },
    },
  ], null, 2));

  const mi = await startMiServer(workerReply);
  try {
    const result = await runBridge({
      ...process.env,
      PHOTON_PROJECT_ID: 'test-project',
      PHOTON_PROJECT_SECRET: 'test-secret',
      PHOTON_ALLOWED_USERS: '+15551234567',
      PHOTON_BOOT_TEST_SEND: '0',
      MI_WEB_URL: mi.baseUrl,
      MI_PHOTON_THREAD: 'main',
      MI_PHOTON_POLL_MS: '25',
      MI_PHOTON_MAX_WAIT_MS: '3000',
      MI_PHOTON_MAX_REPLY_CHARS: '1200',
      MI_PHOTON_NOTIFY_PORT: '0',
      MI_PHOTON_TEST: '1',
      MI_PHOTON_TEST_EVENTS: eventsPath,
      MI_PHOTON_TEST_SENDS: sendsPath,
    });
    assert.match(result.stdout, /imessage handoff - polling for worker result/, `${name}: bridge should poll after handoff`);

    const sends = (await readJsonl(sendsPath)).filter((entry) => entry.kind === 'message');
    assert.equal(sends.length, 2, `${name}: bridge should send ack plus worker follow-up`);
    assert.equal(sends[0].text, 'On it. I’ll follow up here.');
    assert.equal(sends[1].text, workerReply.text);
    assert.equal(sends[0].phone, '+15551234567');
    assert.equal(sends[1].phone, '+15551234567');

    assert.ok(mi.calls.some((call) => call.method === 'POST' && call.path === '/api/imessage' && call.body.message === 'check detect status' && call.body.thread === 'main'), `${name}: bridge should forward inbound iMessage to Mi web`);
    assert.ok(mi.calls.filter((call) => call.method === 'GET' && call.path === '/api/messages').length >= 2, `${name}: bridge should poll Mi messages until worker result appears`);
  } finally {
    await mi.close();
  }
}

const root = await mkdtemp(join(tmpdir(), 'mi-photon-bridge-relay-'));
try {
  await runRelayCase(root, 'result', { source: 'mi-worker-result', text: 'Worker finished and posted the final answer.' });
  await runRelayCase(root, 'error', { source: 'mi-worker-error', text: 'I hit an error finishing that: fake failure.' });
  console.log('Mi Photon bridge relay checks passed.');
} finally {
  await rm(root, { recursive: true, force: true });
}
