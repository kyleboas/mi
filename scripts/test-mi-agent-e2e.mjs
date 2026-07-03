#!/usr/bin/env node
import assert from 'node:assert/strict';
import net from 'node:net';
import { appendFile, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const root = await mkdtemp(join(tmpdir(), 'mi agents-e2e-'));
const socketPath = join(root, 'mi.sock');
const piLog = join(root, 'pi.log');
const requestLog = join(root, 'requests.log');
const fakePi = join(root, 'fake-pi.mjs');
const sessionFile = join(root, 'selected-session.jsonl');
const stripAnsi = (text) => text.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
let selectedTaskStatus = 'active';
let selectedTaskNeedsUser = false;
let selectedTaskNeedsUserReason;
let selectedTaskProgress;
let selectedTaskLastInput;
const selectedTaskStartedAt = new Date(Date.now() - 60_000).toISOString();
const daemonTasks = [];

await writeFile(sessionFile, '');
await writeFile(piLog, '');
await writeFile(requestLog, '');
await writeFile(fakePi, `#!/usr/bin/env node\nimport { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(piLog)}, JSON.stringify(process.argv.slice(2)) + '\\n');\n`, { mode: 0o755 });

const server = net.createServer((socket) => {
  socket.on('error', () => {});
  let data = '';
  socket.on('data', async (chunk) => {
    data += chunk.toString('utf8');
    if (!data.includes('\n')) return;
    const line = data.slice(0, data.indexOf('\n'));
    const request = JSON.parse(line);
    await appendFile(requestLog, JSON.stringify(request) + '\n');
    if (request.type === 'list_tasks') {
      socket.end(JSON.stringify({ ok: true, tasks: [
        ...daemonTasks,
        {
          id: 'task-selected',
          name: 'selected task',
          sessionName: 'selected task',
          status: selectedTaskStatus,
          needsUser: selectedTaskNeedsUser,
          needsUserReason: selectedTaskNeedsUserReason,
          progress: selectedTaskProgress,
          lastInput: selectedTaskLastInput,
          cwd: root,
          sessionFile,
          actualSessionFile: sessionFile,
          startedAt: selectedTaskStartedAt,
          updatedAt: selectedTaskStartedAt,
        },
      ] }) + '\n');
      return;
    }
    if (request.type === 'run_worker') {
      const id = `task-new-${daemonTasks.length + 1}`;
      const taskSessionFile = join(root, `${id}.jsonl`);
      daemonTasks.unshift({
        id,
        name: request.name || 'new task',
        sessionName: request.name || 'new task',
        status: 'running',
        progress: request.message,
        lastInput: request.lastInput || request.message,
        cwd: root,
        sessionFile: taskSessionFile,
        actualSessionFile: taskSessionFile,
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      socket.end(JSON.stringify({ ok: true, text: 'Started background task', taskId: id, sessionFile: taskSessionFile, sessionName: request.name || 'new task' }) + '\n');
      return;
    }
    if (request.type === 'continue_worker') {
      const daemonTask = daemonTasks.find((task) => task.id === request.taskId || task.sessionName === request.taskId || task.name === request.taskId || task.sessionFile === request.taskId);
      if (daemonTask) {
        daemonTask.status = 'running';
        daemonTask.progress = request.message;
        daemonTask.lastInput = request.message;
        daemonTask.updatedAt = new Date().toISOString();
      } else {
        selectedTaskStatus = 'running';
        selectedTaskNeedsUser = false;
        selectedTaskNeedsUserReason = undefined;
        selectedTaskProgress = request.message;
        selectedTaskLastInput = request.message;
      }
      socket.end(JSON.stringify({ ok: true, text: 'Sent follow-up to background task' }) + '\n');
      return;
    }
    if (request.type === 'stop_task') {
      selectedTaskStatus = 'paused';
      selectedTaskNeedsUser = true;
      selectedTaskNeedsUserReason = 'stopped by Escape';
      selectedTaskProgress = 'stopped by Escape; needs User input';
      socket.end(JSON.stringify({ ok: true, text: 'Stopped selected task; moved to needs input' }) + '\n');
      return;
    }
    if (request.type === 'list_pi_sessions') {
      socket.end(JSON.stringify({ ok: true, sessions: [{
        id: 'pi-session-old',
        name: 'old pi session',
        sessionName: 'old pi session',
        status: 'inactive',
        cwd: root,
        sessionFile: join(root, 'old-session.jsonl'),
        actualSessionFile: join(root, 'old-session.jsonl'),
        startedAt: new Date(Date.now() - 10000).toISOString(),
        updatedAt: new Date(Date.now() - 5000).toISOString(),
        source: 'pi-session',
      }, {
        id: 'pi-session-two',
        name: 'second pi session',
        sessionName: 'second pi session',
        status: 'inactive',
        cwd: root,
        sessionFile: join(root, 'second-session.jsonl'),
        actualSessionFile: join(root, 'second-session.jsonl'),
        startedAt: new Date(Date.now() - 9000).toISOString(),
        updatedAt: new Date(Date.now() - 4000).toISOString(),
        source: 'pi-session',
      }] }) + '\n');
      return;
    }
    if (request.type === 'resume_session') {
      socket.end(JSON.stringify({ ok: true, text: 'Added old pi session as task' }) + '\n');
      return;
    }
    socket.end(JSON.stringify({ ok: true, text: 'ok' }) + '\n');
  });
});

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(socketPath, resolve);
});

function runAgentsAndSend(input, done) {
  const steps = Array.isArray(input) ? input : [{ input }];
  return new Promise((resolve, reject) => {
    const child = spawn('node_modules/.bin/tsx', ['src/cli.ts', 'agents'], {
      cwd: new URL('..', import.meta.url).pathname,
      env: { ...process.env, MI_SOCKET_PATH: socketPath, PI_CMD: fakePi, TERM: 'xterm-256color' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.on('error', reject);
    let finishing = false;
    const killTimer = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 500);
      reject(new Error(`mi agents timed out. stdout=${stdout.slice(-1000)} stderr=${stderr.slice(-1000)}`));
    }, 30000);
    const startedAt = Date.now();
    const doneTimer = setInterval(async () => {
      try {
        if (!finishing && (await done(stdout, stderr) || (done.afterMs && Date.now() - startedAt >= done.afterMs))) {
          finishing = true;
          clearInterval(doneTimer);
          clearTimeout(killTimer);
          child.kill('SIGTERM');
        }
      } catch {}
    }, 50);
    child.on('exit', (code, signal) => {
      clearInterval(doneTimer);
      clearTimeout(killTimer);
      if (code === 0 || code === 143 || signal === 'SIGTERM') resolve({ stdout, stderr });
      else reject(new Error(`mi agents exited ${code}/${signal}. stdout=${stdout.slice(-1000)} stderr=${stderr.slice(-1000)}`));
    });
    let stepIndex = 0;
    const writeStep = (text) => {
      let index = 0;
      const writeNext = () => {
        if (index >= text.length) {
          stepIndex++;
          waitForStep();
          return;
        }
        if (child.killed || child.stdin.destroyed) return;
        child.stdin.write(text[index++], () => {});
        setTimeout(writeNext, 100);
      };
      writeNext();
    };
    const waitForStep = () => {
      const step = steps[stepIndex];
      if (!step) return;
      if (!step.waitFor || stdout.includes(step.waitFor)) {
        writeStep(step.input);
        return;
      }
      setTimeout(waitForStep, 50);
    };
    setTimeout(waitForStep, 300);
  });
}

// Typing a plain reply to the selected task should send it to the worker, then Esc should stop it into needs input.
const typedReplyDone = async () => false;
typedReplyDone.afterMs = 12000;
const typedReplyRun = await runAgentsAndSend([
  { input: 'please continue selected task\n' },
  { waitFor: 'selected task', input: '\x1b\x1b' },
], typedReplyDone);
const typedReplyPlain = stripAnsi(typedReplyRun.stdout);
let requests = (await readFile(requestLog, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
assert.ok(requests.some((request) => request.type === 'continue_worker' && request.taskId === 'task-selected' && request.message === 'please continue selected task'), 'plain typed input should reply to selected task');
assert.match(typedReplyPlain, /paused/, 'Esc after typed reply should render task as paused');
assert.match(typedReplyPlain, /stopped by Escape; needs User input/, 'Esc after typed reply should render needs-input reason');

// /resume is a mi agents command: it opens a session picker, then Enter adds the selected pi session as a task without opening pi.
await runAgentsAndSend([
  { input: '/resume\r' },
  { waitFor: 'Enter add selected', input: '\n' },
], async () => (await readFile(requestLog, 'utf8').catch(() => '')).includes('resume_session'));
let piCalls = (await readFile(piLog, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean);
assert.equal(piCalls.length, 0, '/resume should not spawn pi');
requests = (await readFile(requestLog, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
assert.ok(requests.some((request) => request.type === 'list_pi_sessions'), '/resume should open the pi-session picker');
assert.ok(requests.some((request) => request.type === 'resume_session' && ['pi-session-old', 'pi-session-two'].includes(request.id)), 'CR Enter should add the selected pi session as a task, not enter multi-select');

// Other pi slash commands should be delegated to real pi with the selected session.
await runAgentsAndSend('/session\r', async () => (await readFile(piLog, 'utf8').catch(() => '')).includes('/session'));
piCalls = (await readFile(piLog, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
assert.deepEqual(piCalls.at(-1), ['--session', sessionFile, '/session']);

// /new is intentionally a mi agents command and must not be delegated to pi.
await writeFile(piLog, '');
await runAgentsAndSend('/new verify background task\r', async () => (await readFile(requestLog, 'utf8').catch(() => '')).includes('run_worker'));
piCalls = (await readFile(piLog, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean);
assert.equal(piCalls.length, 0, '/new should not spawn pi');
requests = (await readFile(requestLog, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
assert.ok(requests.some((request) => request.type === 'run_worker' && request.message === 'verify background task'), '/new should create a Mi background task');

// /plan is a full Mi agents workflow command: start a plan worker, send refinements to the same worker, and forward the go trigger without opening pi.
await writeFile(piLog, '');
await writeFile(requestLog, '');
await runAgentsAndSend('/plan design safe change\r', async () => (await readFile(requestLog, 'utf8').catch(() => '')).includes('"message":"/plan design safe change"'));
piCalls = (await readFile(piLog, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean);
assert.equal(piCalls.length, 0, '/plan should not spawn pi from mi agents');
requests = (await readFile(requestLog, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
const planStart = requests.find((request) => request.type === 'run_worker' && request.message === '/plan design safe change');
assert.ok(planStart, '/plan should create a Mi background task');
assert.equal(planStart.background, true, '/plan should run as a background worker');
assert.equal(planStart.lastInput, '/plan design safe change', '/plan task should preserve the slash command as last input');
const planTask = daemonTasks.find((task) => task.lastInput === '/plan design safe change');
assert.ok(planTask, '/plan task should appear in the Mi agents task list');

await writeFile(piLog, '');
await writeFile(requestLog, '');
await runAgentsAndSend('what tests should cover this?\n', async () => (await readFile(requestLog, 'utf8').catch(() => '')).includes('what tests should cover this?'));
requests = (await readFile(requestLog, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
assert.ok(requests.some((request) => request.type === 'continue_worker' && request.message === 'what tests should cover this?' && request.taskId === planTask.id), '/plan refinements should be sent to the plan worker');

await writeFile(piLog, '');
await writeFile(requestLog, '');
await runAgentsAndSend('go implement that plan\n', async () => (await readFile(requestLog, 'utf8').catch(() => '')).includes('go implement that plan'));
piCalls = (await readFile(piLog, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean);
assert.equal(piCalls.length, 0, '/plan go trigger should be forwarded to the worker, not opened in pi');
requests = (await readFile(requestLog, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
assert.ok(requests.some((request) => request.type === 'continue_worker' && request.message === 'go implement that plan' && request.taskId === planTask.id), '/plan go trigger should continue the same plan worker so the pi /plan extension can exit plan mode');

// /mi is a Mi-side question about the selected task and should go to Mi main, not pi.
await writeFile(piLog, '');
await runAgentsAndSend('/mi what is selected doing?\r', async () => (await readFile(requestLog, 'utf8').catch(() => '')).includes('"type":"prompt"'));
piCalls = (await readFile(piLog, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean);
assert.equal(piCalls.length, 0, '/mi should not spawn pi');
requests = (await readFile(requestLog, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
assert.ok(requests.some((request) => request.type === 'prompt' && /selected background task/i.test(request.message || '')), '/mi should ask Mi main about the selected task');

// /goal is intentionally not intercepted as a local mi-agents slash command; it is sent to the worker as a normal follow-up.
await runAgentsAndSend('/goal finish the selected work\r', async () => (await readFile(requestLog, 'utf8').catch(() => '')).includes('/goal finish the selected work'));
requests = (await readFile(requestLog, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
assert.ok(requests.some((request) => request.type === 'continue_worker' && request.message === '/goal finish the selected work'), '/goal should be forwarded to the selected worker');

server.close();
await rm(root, { recursive: true, force: true });
console.log('mi agents e2e tests passed');
