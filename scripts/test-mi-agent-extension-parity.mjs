#!/usr/bin/env node
import assert from 'node:assert/strict';
import net from 'node:net';
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const repo = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const root = await mkdtemp(join(tmpdir(), 'mi-agent-parity-'));
const socketPath = join(root, 'mi.sock');
const requestLog = join(root, 'requests.log');
const dispatchLog = join(root, 'dispatch.log');
const piLog = join(root, 'pi.log');
const fakePi = join(root, 'fake-pi.mjs');
const sessionFile = join(root, 'session.jsonl');
const stripAnsi = (text) => String(text || '').replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');

await writeFile(requestLog, '');
await writeFile(dispatchLog, '');
await writeFile(piLog, '');
await writeFile(sessionFile, '');
await writeFile(fakePi, `#!/usr/bin/env node\nimport { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(piLog)}, JSON.stringify(process.argv.slice(2)) + '\\n');\nif (process.argv.includes('--mode') && process.argv.includes('json')) {\n  process.stdout.write(JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'headless ok' } }) + '\\n');\n}\n`, { mode: 0o755 });

const baseEnv = {
  ...process.env,
  HOME: root,
  MI_ROOT: join(root, 'assistant'),
  MI_SOCKET_PATH: socketPath,
  MI_DAEMON_SYSTEMD: '0',
  MI_DAEMON_HOST: join(root, 'missing-host'),
  MI_DAEMON_PATH: join(root, 'missing-daemon.mjs'),
  PI_CMD: fakePi,
  TERM: 'xterm-256color',
};

const inventoryResult = spawnSync(process.execPath, ['dist/src/cli.js', 'pi-commands', '--json'], { cwd: repo, env: baseEnv, encoding: 'utf8', timeout: 30000 });
assert.equal(inventoryResult.status, 0, inventoryResult.stderr || inventoryResult.stdout);
const inventory = JSON.parse(inventoryResult.stdout);
assert.ok(inventory.length >= 25, 'pi command inventory should include Mi agents extension commands');
for (const command of inventory) assert.ok(command.classification, `${command.slash} must be classified`);

const expected = {
  '/goal': 'worker-forward',
  '/council': 'background-task',
  '/secret': 'headless-exec',
  '/settings': 'blocked',
  '/open': 'native-mi',
};
for (const [slash, classification] of Object.entries(expected)) {
  assert.equal(inventory.find((command) => command.slash === slash)?.classification, classification, `${slash} classification`);
}

let tasks = [{
  id: 'task-selected',
  name: 'selected task',
  sessionName: 'selected task',
  status: 'paused',
  needsUser: true,
  cwd: root,
  sessionFile,
  actualSessionFile: sessionFile,
  startedAt: new Date(Date.now() - 1000).toISOString(),
  updatedAt: new Date(Date.now() - 1000).toISOString(),
}];

const server = net.createServer((socket) => {
  socket.on('error', () => {});
  let data = '';
  socket.on('data', async (chunk) => {
    data += chunk.toString('utf8');
    if (!data.includes('\n')) return;
    const line = data.slice(0, data.indexOf('\n'));
    const request = JSON.parse(line);
    await appendFile(requestLog, JSON.stringify(request) + '\n');
    if (request.type === 'list_tasks') return socket.end(JSON.stringify({ ok: true, tasks }) + '\n');
    if (request.type === 'continue_worker') return socket.end(JSON.stringify({ ok: true, text: 'forwarded' }) + '\n');
    if (request.type === 'run_worker') {
      tasks = [{ id: `task-${tasks.length + 1}`, name: request.name, status: 'running', progress: request.message, cwd: root, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, ...tasks];
      return socket.end(JSON.stringify({ ok: true, text: 'started', taskId: tasks[0].id }) + '\n');
    }
    socket.end(JSON.stringify({ ok: true, text: 'ok' }) + '\n');
  });
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });

async function readJsonl(path) {
  if (!existsSync(path)) return [];
  const text = await readFile(path, 'utf8');
  return text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

async function runRenderSlash(value) {
  const tasksPath = join(root, `tasks-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  await writeFile(tasksPath, JSON.stringify(tasks, null, 2));
  const result = spawnSync(process.execPath, ['dist/src/cli.js', 'agents'], {
    cwd: repo,
    env: {
      ...baseEnv,
      MI_AGENT_RENDER_TEST: '1',
      MI_AGENT_RENDER_TEST_TASKS: tasksPath,
      MI_AGENT_RENDER_TEST_EVENTS: `slash:${value}`,
      MI_AGENT_RENDER_TEST_ROWS: '20',
      MI_AGENT_RENDER_TEST_COLS: '80',
      MI_AGENT_RENDER_TEST_DISPATCH_LOG: dispatchLog,
    },
    encoding: 'utf8',
    timeout: 30000,
  });
  assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
  return JSON.parse(result.stdout).frames.at(-1);
}

let frame = await runRenderSlash('/goal ship it');
assert.ok((await readJsonl(dispatchLog)).some((r) => r.class === 'worker-forward' && r.message === '/goal ship it'), '/goal should forward to selected worker');
frame = await runRenderSlash('/council compare options');
assert.ok((await readJsonl(dispatchLog)).some((r) => r.class === 'background-task' && r.message === '/council compare options'), '/council should start background task');
frame = await runRenderSlash('/secret status');
assert.ok((await readJsonl(dispatchLog)).some((r) => r.class === 'headless-exec' && r.args.includes('/secret status')), '/secret should run pi headlessly');
frame = await runRenderSlash('/settings');
assert.match(frame.status, /Pi app command/, '/settings should be blocked without opening pi');
frame = await runRenderSlash('/definitely-new-command');
assert.match(frame.status, /Unknown command \/definitely-new-command/, 'unknown slash commands should not open pi');

const piCalls = (await readFile(piLog, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
assert.equal(piCalls.length, 0, 'render-test parity dispatch should never open interactive pi');

await new Promise((resolve) => server.close(resolve));
await rm(root, { recursive: true, force: true });
console.log('mi agent extension parity ok');
