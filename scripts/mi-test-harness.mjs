#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile, appendFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const repoRoot = new URL('..', import.meta.url).pathname.replace(/\/$/, '');

export function repoPath(...parts) {
  return join(repoRoot, ...parts);
}

export function stripAnsi(text) {
  return String(text || '')
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
}

export async function createHermeticMiEnv(prefix = 'mi-test-') {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const home = join(root, 'home');
  const miRoot = join(root, 'assistant');
  const runtime = join(root, 'runtime');
  const bin = join(root, 'bin');
  await mkdir(home, { recursive: true, mode: 0o700 });
  await mkdir(miRoot, { recursive: true, mode: 0o700 });
  await mkdir(runtime, { recursive: true, mode: 0o700 });
  await mkdir(bin, { recursive: true, mode: 0o700 });
  await mkdir(join(home, 'mi'), { recursive: true, mode: 0o700 });
  await writeFile(join(home, 'mi', 'preferences.md'), '- Owner: Test Owner\n');
  const fakePi = join(bin, 'pi');
  await writeFile(fakePi, '#!/usr/bin/env node\nprocess.exit(0);\n', { mode: 0o755 });
  await chmod(fakePi, 0o755);
  const env = {
    ...process.env,
    HOME: home,
    MI_ROOT: miRoot,
    MI_RUNTIME_DIR: runtime,
    MI_SOCKET_PATH: join(runtime, 'main.sock'),
    MI_DAEMON_SYSTEMD: '0',
    MI_DAEMON_HOST: join(root, 'missing-daemon-host'),
    MI_DAEMON_PATH: join(root, 'missing-daemon.mjs'),
    MI_DAILY_BRIEF: 'false',
    MI_TICK_DAILY_BRIEF: 'false',
    MI_IMESSAGE_MONITOR_ENABLED: 'false',
    MI_LOOP_DISCOVERY_ENABLED: 'false',
    MI_LOOP_FACTORY_ENABLED: 'false',
    MI_CHAT_LOOKUP_TOOLS: '0',
    FLUE_ENABLED: 'false',
    PI_CMD: fakePi,
    PUSHOVER_USER: '',
    PUSHOVER_TOKEN: '',
    PUSHOVER_USER_KEY: '',
    PUSHOVER_APP_TOKEN: '',
    PATH: `${bin}:${process.env.PATH || ''}`,
  };
  return { root, home, miRoot, runtime, bin, fakePi, env, cleanup: () => rm(root, { recursive: true, force: true }) };
}

export function runCli(args, options = {}) {
  const result = spawnSync(repoPath('node_modules/.bin/tsx'), [repoPath('src/cli.ts'), ...args], {
    cwd: options.cwd || repoRoot,
    env: options.env || process.env,
    input: options.input,
    encoding: 'utf8',
    timeout: options.timeout || 45000,
  });
  if (options.check !== false && result.status !== 0) {
    throw new Error(`mi ${args.join(' ')} exited ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  return { ...result, stdout: stripAnsi(result.stdout || ''), stderr: stripAnsi(result.stderr || '') };
}

export function runCliAsync(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(repoPath('node_modules/.bin/tsx'), [repoPath('src/cli.ts'), ...args], {
      cwd: options.cwd || repoRoot,
      env: options.env || process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`mi ${args.join(' ')} timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, options.timeout || 45000);
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
    child.on('exit', (status, signal) => {
      clearTimeout(timer);
      const result = { status, signal, stdout: stripAnsi(stdout), stderr: stripAnsi(stderr) };
      if (options.check !== false && status !== 0) {
        reject(new Error(`mi ${args.join(' ')} exited ${status || signal}\nstdout:\n${stdout}\nstderr:\n${stderr}`));
      } else {
        resolve(result);
      }
    });
  });
}

export async function readJsonl(path) {
  if (!existsSync(path)) return [];
  const text = await readFile(path, 'utf8');
  return text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

export async function waitFor(predicate, { timeoutMs = 5000, intervalMs = 50, message = 'condition' } = {}) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out waiting for ${message}${lastError ? `: ${lastError.message || lastError}` : ''}`);
}

export async function startFakeDaemon(socketPath, responder = defaultDaemonResponder) {
  await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
  await rm(socketPath, { force: true }).catch(() => undefined);
  const requests = [];
  const server = net.createServer((socket) => {
    socket.on('error', () => {});
    let data = '';
    socket.on('data', async (chunk) => {
      data += chunk.toString('utf8');
      while (data.includes('\n')) {
        const index = data.indexOf('\n');
        const line = data.slice(0, index);
        data = data.slice(index + 1);
        if (!line.trim()) continue;
        let request;
        try {
          request = JSON.parse(line);
          requests.push(request);
          const response = await responder(request, requests);
          socket.end(`${JSON.stringify({ ok: true, ...response })}\n`);
        } catch (error) {
          socket.end(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
        }
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  return { requests, close: () => new Promise((resolve) => server.close(resolve)) };
}

function defaultDaemonResponder(request) {
  if (request.type === 'list_tasks') return { tasks: [] };
  if (request.type === 'run_worker') return { text: 'Started background task', taskId: 'task-1', sessionFile: '/tmp/mi-test-session.jsonl', sessionName: request.name || 'task' };
  if (request.type === 'continue_worker') return { text: 'Sent follow-up', taskId: request.taskId || 'task-1' };
  if (request.type === 'health') return { pi: true };
  if (request.type === 'prompt') return { text: 'Hello.' };
  if (request.type === 'state') return { state: { model: { provider: 'test', modelId: 'model' } } };
  return { text: 'ok' };
}

export async function httpJson(baseUrl, path, { method = 'GET', body, token, headers = {} } = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = undefined; }
  return { status: res.status, ok: res.ok, text, json };
}

export async function startWebChat(env, { port = 0 } = {}) {
  const actualPort = port || 19000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, ['scripts/mi-web-chat.mjs'], {
    cwd: repoRoot,
    env: { ...env, MI_WEB_HOST: '127.0.0.1', MI_WEB_PORT: String(actualPort), MI_WEB_HTTPS_PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
  child.on('error', () => {});
  const baseUrl = `http://127.0.0.1:${actualPort}`;
  await waitFor(async () => {
    try {
      const res = await fetch(`${baseUrl}/api/health`);
      return res.ok;
    } catch {
      if (child.exitCode !== null) throw new Error(`web chat exited ${child.exitCode}; stdout=${stdout}; stderr=${stderr}`);
      return false;
    }
  }, { timeoutMs: 10000, message: 'Mi web chat server' });
  return {
    baseUrl,
    child,
    output: () => ({ stdout, stderr }),
    close: async () => {
      if (child.exitCode === null) child.kill('SIGTERM');
      await new Promise((resolve) => child.once('exit', resolve));
    },
  };
}

export function assertStatus(result, status, label) {
  assert.equal(result.status, status, `${label}: ${result.text}`);
  return result.json;
}

export async function appendJsonl(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(value)}\n`);
}
