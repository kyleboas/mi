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

await writeFile(sessionFile, '');
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
      socket.end(JSON.stringify({ ok: true, tasks: [{
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
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }] }) + '\n');
      return;
    }
    if (request.type === 'run_worker') {
      socket.end(JSON.stringify({ ok: true, text: 'Started background task', taskId: 'task-new', sessionFile, sessionName: request.name || 'new task' }) + '\n');
      return;
    }
    if (request.type === 'continue_worker') {
      selectedTaskStatus = 'running';
      selectedTaskNeedsUser = false;
      selectedTaskNeedsUserReason = undefined;
      selectedTaskProgress = request.message;
      selectedTaskLastInput = request.message;
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
    const child = spawn(process.execPath, ['dist/src/cli.js', 'agents'], {
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
    }, 8000);
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
      if (code === 0 || signal === 'SIGTERM') resolve({ stdout, stderr });
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
typedReplyDone.afterMs = 6000;
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
await runAgentsAndSend('/resume\n\r', async () => (await readFile(requestLog, 'utf8').catch(() => '')).includes('resume_session'));
let piCalls = (await readFile(piLog, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean);
assert.equal(piCalls.length, 0, '/resume should not spawn pi');
requests = (await readFile(requestLog, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
assert.ok(requests.some((request) => request.type === 'list_pi_sessions'), '/resume should open the pi-session picker');
assert.ok(requests.some((request) => request.type === 'resume_session' && ['pi-session-old', 'pi-session-two'].includes(request.id)), 'CR Enter should add the selected pi session as a task, not enter multi-select');

// Other pi slash commands should be delegated to real pi with the selected session.
await runAgentsAndSend('/model\n', async () => (await readFile(piLog, 'utf8').catch(() => '')).includes('/model'));
piCalls = (await readFile(piLog, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
assert.deepEqual(piCalls.at(-1), ['--session', sessionFile, '/model']);

// /new is intentionally a mi agents command and must not be delegated to pi.
await writeFile(piLog, '');
await runAgentsAndSend('/new verify background task\n', async () => (await readFile(requestLog, 'utf8').catch(() => '')).includes('run_worker'));
piCalls = (await readFile(piLog, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean);
assert.equal(piCalls.length, 0, '/new should not spawn pi');
requests = (await readFile(requestLog, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
assert.ok(requests.some((request) => request.type === 'run_worker' && request.message === 'verify background task'), '/new should create a Mi background task');

server.close();
await rm(root, { recursive: true, force: true });
console.log('mi agents e2e tests passed');
