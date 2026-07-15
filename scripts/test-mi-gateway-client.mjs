#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const helper = join(root, 'scripts', 'mi-gateway-client.py');
const home = await mkdtemp(join(tmpdir(), 'mi-gateway-client-'));
await mkdir(join(home, '.config', 'agent'), { recursive: true, mode: 0o700 });
await writeFile(join(home, '.config', 'agent', 'gateway.token'), 'test-token-never-print', { mode: 0o600 });

let mode = 'ok';
let seen;
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    seen = { url: req.url, auth: req.headers.authorization, body: JSON.parse(body) };
    if (mode === 'hang') return;
    if (mode === 'malformed') return res.end('{');
    if (mode === 'empty') return res.end(JSON.stringify({ choices: [{ message: { content: '' } }] }));
    res.end(JSON.stringify({ choices: [{ message: { content: mode === 'long' ? 'x'.repeat(20) : 'safe answer' } }] }));
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

function run(input, extra = {}) {
  return new Promise((resolve) => {
    const child = spawn(helper, [], { env: { HOME: home, MI_GATEWAY_URL: `http://127.0.0.1:${port}/v1/chat/completions`, ...extra }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stdout, stderr, argv: child.spawnargs.slice(1) }));
    child.stdin.end(input);
  });
}

try {
  const request = JSON.stringify({ model: 'mi-concierge', messages: [{ role: 'user', content: 'hello' }], timeoutSeconds: 1, outputCap: 100 });
  let result = await run(request);
  assert.equal(result.code, 0); assert.equal(result.stdout, 'safe answer');
  assert.deepEqual(result.argv, [], 'request and prompt are stdin, never argv');
  assert.equal(seen.url, '/v1/chat/completions'); assert.equal(seen.body.model, 'mi-concierge'); assert.equal(seen.body.stream, false);
  assert.equal(seen.auth, 'Bearer test-token-never-print', 'helper authenticates only to the local fake gateway');
  result = await run(JSON.stringify({ model: 'external/model', messages: [{ role: 'user', content: 'hello' }] }));
  assert.notEqual(result.code, 0); assert.match(result.stderr, /invalid-model/); assert.doesNotMatch(result.stderr, /test-token|hello/);
  mode = 'long'; result = await run(JSON.stringify({ model: 'mi-concierge', messages: [{ role: 'user', content: 'hello' }], outputCap: 10 }));
  assert.notEqual(result.code, 0); assert.match(result.stderr, /output-limit/);
  mode = 'malformed'; result = await run(request); assert.notEqual(result.code, 0); assert.match(result.stderr, /invalid-response/);
  mode = 'empty'; result = await run(request); assert.notEqual(result.code, 0); assert.match(result.stderr, /invalid-response/);
  mode = 'hang'; result = await run(request); assert.notEqual(result.code, 0); assert.match(result.stderr, /gateway-unavailable/);
  result = await run(request, { MI_GATEWAY_URL: 'https://example.com/v1/chat/completions' }); assert.notEqual(result.code, 0); assert.match(result.stderr, /invalid-gateway/);
  console.log('Mi gateway client checks passed.');
} finally {
  await new Promise((resolve) => server.close(resolve));
  await rm(home, { recursive: true, force: true });
}
