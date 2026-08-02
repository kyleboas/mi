#!/usr/bin/env node
import assert from 'node:assert/strict';
import net from 'node:net';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'mi-coordinator-sessions-'));
const home = join(root, 'home');
const runtime = join(root, 'runtime');
const miRoot = join(root, 'assistant');
const socketPath = join(runtime, 'main.sock');
const fakePi = join(root, 'fake-pi.mjs');
const piLog = join(root, 'pi-args.jsonl');
const piEnvLog = join(root, 'pi-env.jsonl');
const childPidFile = join(root, 'a-child.pid');
const revisionFile = join(root, 'revisions.json');
const taskPath = join(home, 'mi', 'state', 'tasks.json');

await Promise.all([mkdir(home, { recursive: true }), mkdir(runtime, { recursive: true }), mkdir(miRoot, { recursive: true })]);
await writeFile(piLog, '');
await writeFile(piEnvLog, '');
await writeFile(fakePi, `#!/usr/bin/env node
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
const root = ${JSON.stringify(root)};
const childPidFile = ${JSON.stringify(childPidFile)};
const revisionFile = ${JSON.stringify(revisionFile)};
appendFileSync(${JSON.stringify(piLog)}, JSON.stringify(process.argv.slice(2)) + '\\n');
appendFileSync(${JSON.stringify(piEnvLog)}, JSON.stringify({ coordinator: process.env.MI_COORDINATOR_MODE, profile: process.env.MI_CAPABILITY_PROFILE, grantsFile: process.env.MI_CAPABILITY_GRANTS_FILE, auditFile: process.env.MI_CAPABILITY_AUDIT_FILE }) + '\\n');
const fromSession = process.argv.indexOf('--session') >= 0 ? basename(process.argv[process.argv.indexOf('--session') + 1]).replace(/\\.jsonl$/, '') : '';
let sessionName = fromSession || 'coordinator';
let child;
function sessionFile() { const file = join(root, 'sessions', sessionName + '.jsonl'); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, ''); return file; }
function send(payload) { process.stdout.write(JSON.stringify(payload) + '\\n'); }
function state() { return { sessionFile: sessionFile(), sessionId: 'session-' + sessionName, sessionName, model: 'normal/pi-model' }; }
function snapshot() {
  if (!/A/i.test(sessionName)) return;
  if (!child) { child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); writeFileSync(childPidFile, String(child.pid)); }
  let revisions = {}; try { revisions = JSON.parse(readFileSync(revisionFile, 'utf8')); } catch {}
  const revision = (revisions[sessionName] || 1) + 1; revisions[sessionName] = revision; writeFileSync(revisionFile, JSON.stringify(revisions));
  const emit = (value, parentSessionId = 'session-' + sessionName, parentKey = 'parentSessionId') => send({ type: 'extension_ui_request', method: 'setWidget', widgetKey: 'mi-orchestrator-workers-v1', widgetLines: [JSON.stringify({ version: 1, revision: value, emittedAt: new Date(1700000000000 + value * 1000).toISOString(), [parentKey]: parentSessionId, workers: [{ id: 'nested-a', name: 'nested A', state: 'working', activity: value >= revision ? 'latest focused work' : 'old activity', age: '4s', startedAt: new Date(1700000000000).toISOString() }] }), 'visible widget text'] });
  emit(revision);
  setTimeout(() => emit(revision - 1), 5);
  setTimeout(() => emit(revision + 10, 'another-parent-session'), 10);
  // The real orchestrator widget names its own Pi session as sessionId.
  setTimeout(() => emit(revision + 20, 'another-parent-session', 'sessionId'), 15);
  // This valid parent snapshot arrives after stop_task below. It must not
  // replace that stopped state or make nested work look live again.
  setTimeout(() => emit(revision + 30), 250);
}
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const request = JSON.parse(line);
  if (request.type === 'set_session_name') { sessionName = request.name || sessionName; send({ type: 'response', id: request.id, success: true, data: state() }); return; }
  if (request.type === 'get_state') { send({ type: 'response', id: request.id, success: true, data: state() }); return; }
  if (request.type === 'get_last_assistant_text') { send({ type: 'response', id: request.id, success: true, data: { text: '' } }); return; }
  if (request.type === 'prompt') { send({ type: 'response', id: request.id, success: true, data: { queued: true } }); snapshot(); return; }
  send({ type: 'response', id: request.id, success: true, data: state() });
});
`, { mode: 0o755 });
await chmod(fakePi, 0o755);

let daemon;
function startDaemon() {
  daemon = spawn(process.execPath, ['pi/extensions/mi-daemon.mjs'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, HOME: home, MI_ROOT: miRoot, MI_RUNTIME_DIR: runtime, MI_SOCKET_PATH: socketPath, MI_PI_BIN: fakePi, MI_MODEL: 'fake/low', MI_DAEMON_IDLE_EXIT_MS: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  daemon.stderr.on('data', () => {});
}
function request(payload, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let data = '';
    const timer = setTimeout(() => { socket.destroy(); reject(new Error(`timed out: ${payload.type}`)); }, timeoutMs);
    socket.on('connect', () => socket.write(`${JSON.stringify(payload)}\n`));
    socket.on('data', (chunk) => {
      data += chunk;
      if (!data.includes('\n')) return;
      clearTimeout(timer); socket.end();
      try { resolve(JSON.parse(data.slice(0, data.indexOf('\n')))); } catch (error) { reject(error); }
    });
    socket.on('error', (error) => { clearTimeout(timer); reject(error); });
  });
}
async function waitFor(predicate, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { const value = await predicate(); if (value) return value; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('condition timed out');
}
async function tasks() { return JSON.parse(await readFile(taskPath, 'utf8')); }
async function stopDaemon() {
  if (!daemon || daemon.exitCode !== null) return;
  daemon.kill('SIGTERM');
  await new Promise((resolve) => daemon.once('exit', resolve));
}

try {
  startDaemon();
  await waitFor(() => existsSync(socketPath));
  const a = await request({ type: 'run_worker', name: 'session A', cwd: home, message: 'coordinate A', background: true, coordinatorMode: true });
  const b = await request({ type: 'run_worker', name: 'session B', cwd: home, message: 'coordinate B', background: true, coordinatorMode: true });
  assert.equal(a.ok, true); assert.equal(b.ok, true);
  await request({ type: 'continue_worker', taskId: a.taskId, message: 'A follow-up', background: true });
  await request({ type: 'continue_worker', taskId: b.taskId, message: 'B follow-up', background: true });
  const liveA = await waitFor(async () => (await tasks()).find((task) => task.id === a.taskId && task.workers?.[0]?.id === 'nested-a'));
  const liveB = (await tasks()).find((task) => task.id === b.taskId);
  assert.equal(liveA.coordinatorMode, true);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const latestA = (await tasks()).find((task) => task.id === a.taskId);
  assert.match(String(latestA.workersRevision), /^\d+$/);
  assert.equal(latestA.workers[0].activity, 'latest focused work', 'older or wrong-parent snapshots cannot replace the latest display state');
  assert.equal(latestA.workers[0].transcript, undefined, 'only compact worker display state is saved');
  assert.equal(latestA.workers[0].startedAt, new Date(1700000000000).toISOString(), 'worker start time is kept so mi agents can show a live age');
  assert.equal(latestA.workersParentSessionId, latestA.sessionId, 'only snapshots naming this parent session are attached');
  assert.equal(liveB.workers, undefined, 'nested worker rows stay under their own coordinator');
  const starts = (await readFile(piLog, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
  const coordinatorArgs = starts.filter((args) => args.includes('--mode') && args.includes('rpc'));
  assert.ok(coordinatorArgs.length >= 2);
  for (const args of coordinatorArgs.slice(0, 2)) {
    assert.ok(!args.includes('--no-extensions') && !args.includes('--no-context-files') && !args.includes('--no-skills') && !args.includes('--no-prompt-templates') && !args.includes('--no-themes'), 'coordinator gets normal Pi extensions, context files, skills, prompt templates, and themes');
    assert.ok(!args.includes('--tools') && !args.includes('--model'), 'unselected coordinator model and tools come from normal Pi settings');
  }
  const coordinatorEnvs = (await readFile(piEnvLog, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse).slice(0, 2);
  for (const env of coordinatorEnvs) {
    assert.equal(env.coordinator, '1', 'Mi Agents requests always set explicit coordinator mode');
    assert.equal(env.profile, undefined, 'coordinators do not inherit the restricted capability profile');
    assert.equal(env.grantsFile, undefined, 'coordinators do not receive restricted capability grants');
    assert.equal(env.auditFile, undefined, 'coordinators do not receive restricted capability audit setup');
  }

  // Reload through the task API before a daemon restart, then restore the same
  // saved parent session. Old nested state must be marked stale until Pi emits
  // another widget snapshot.
  const listed = await request({ type: 'list_tasks' });
  assert.equal(listed.tasks.filter((task) => task.id === a.taskId).length, 1);
  await stopDaemon();
  startDaemon();
  await waitFor(() => existsSync(socketPath));
  const afterRestart = await waitFor(async () => {
    const worker = (await request({ type: 'list_tasks' })).tasks.find((task) => task.id === a.taskId)?.workers?.[0];
    return worker?.stale ? worker : undefined;
  });
  assert.equal(afterRestart.state, 'interrupted');
  await request({ type: 'continue_worker', taskId: a.taskId, message: 'resume A after restart', background: true });
  const freshA = await waitFor(async () => (await tasks()).find((task) => task.id === a.taskId && task.workers?.[0]?.stale === undefined));
  assert.equal(freshA.workers[0].state, 'working');

  const childPid = Number(await readFile(childPidFile, 'utf8'));
  const stopped = await request({ type: 'stop_task', taskId: a.taskId });
  assert.equal(stopped.ok, true);
  await waitFor(async () => (await tasks()).find((task) => task.id === a.taskId)?.status === 'paused');
  const stillB = (await tasks()).find((task) => task.id === b.taskId);
  assert.equal(stillB.status, 'running', 'stopping A does not stop B');
  await waitFor(() => !existsSync(`/proc/${childPid}`));
  await new Promise((resolve) => setTimeout(resolve, 300));
  const stoppedA = (await tasks()).find((task) => task.id === a.taskId);
  assert.equal(stoppedA.workers[0].state, 'stopped', 'late coordinator snapshots cannot revive a stopped worker');
  assert.equal(stoppedA.workers[0].stale, true, 'stopped nested work remains visibly stale');

  // Existing automated workers remain hermetic, whether they come from a
  // proactive check, iMessage handoff, a loop, or the old task route.
  const workflows = join(home, 'workflows');
  await mkdir(workflows, { recursive: true });
  const restrictedRequests = [
    { name: 'legacy cedar', cwd: home, message: 'legacy cedar inspection' },
    { name: 'proactive cedar', cwd: home, message: 'proactive cedar inspection', capabilityProfile: 'worker-read' },
    { name: 'iMessage cedar', cwd: home, message: 'iMessage cedar inspection', capabilityProfile: 'worker-read' },
    { name: 'loop cedar', cwd: workflows, message: 'loop cedar inspection', capabilityProfile: 'worker-write-scoped' },
  ];
  const startsBeforeRestricted = (await readFile(piLog, 'utf8')).trim().split('\n').filter(Boolean).length;
  for (const requestBody of restrictedRequests) {
    const result = await request({ type: 'run_worker', background: true, ...requestBody });
    assert.equal(result.ok, true);
  }
  const allArgs = (await readFile(piLog, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
  const allEnvs = (await readFile(piEnvLog, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
  const restrictedArgs = allArgs.slice(startsBeforeRestricted);
  const restrictedEnvs = allEnvs.slice(startsBeforeRestricted);
  assert.equal(restrictedArgs.length, restrictedRequests.length, `only requested restricted workers start: ${JSON.stringify(restrictedArgs)}`);
  for (let index = 0; index < restrictedArgs.length; index += 1) {
    assert.ok(restrictedArgs[index].includes('--no-extensions') && restrictedArgs[index].includes('--no-context-files') && restrictedArgs[index].includes('--no-skills') && restrictedArgs[index].includes('--no-prompt-templates') && restrictedArgs[index].includes('--no-themes') && restrictedArgs[index].includes('--tools'), `${restrictedRequests[index].name} keeps the restricted Pi launch: ${JSON.stringify(restrictedArgs[index])}`);
    assert.equal(restrictedEnvs[index].coordinator, undefined, `${restrictedRequests[index].name} does not get coordinator mode`);
    assert.ok(restrictedEnvs[index].profile, `${restrictedRequests[index].name} keeps a capability profile`);
    assert.ok(restrictedEnvs[index].grantsFile, `${restrictedRequests[index].name} gets capability grants`);
  }

  // Daemon shutdown also sends SIGTERM to the coordinator process group.
  const exitCoordinator = await request({ type: 'run_worker', name: 'session exit A', cwd: home, message: 'coordinate exit', background: true, coordinatorMode: true });
  await waitFor(async () => (await tasks()).find((task) => task.id === exitCoordinator.taskId && task.workers?.[0]?.id === 'nested-a'));
  const exitChildPid = Number(await readFile(childPidFile, 'utf8'));
  await stopDaemon();
  await waitFor(() => !existsSync(`/proc/${exitChildPid}`));
  console.log('mi coordinator sessions e2e passed');
} finally {
  await stopDaemon();
  await rm(root, { recursive: true, force: true });
}
