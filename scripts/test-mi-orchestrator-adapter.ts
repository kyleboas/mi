#!/usr/bin/env tsx
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { miCoordinatorPrompt } from './mi-imessage-coordinator.mjs';

const root = await mkdtemp(path.join(tmpdir(), 'mi-orchestrator-adapter-'));
const workspaceRoot = path.join(root, 'diver-notes-document-notes');
const workspace = workspaceRoot;
const outside = path.join(root, 'outside');
const socketPath = path.join(root, 'mi.sock');
const policyPath = path.join(root, 'policy.json');
const advisorRoot = path.join(root, 'global', '.pi', 'agent', 'skills', 'advisor');
const advisorReference = path.join(advisorRoot, 'references', 'source-standards.md');
const grantsPath = path.join(root, 'grants.json');
const requests: Record<string, unknown>[] = [];
const daemonReplies: Record<string, unknown>[] = [];
const handlers = new Map<string, Array<(...args: any[]) => any>>();
let registeredTool: any;
let activeTools = ['read', 'orchestrator_delegate', 'orchestrator_workers'];

await mkdir(workspace, { recursive: true });
await mkdir(outside, { recursive: true });
await mkdir(path.dirname(advisorReference), { recursive: true });
await writeFile(path.join(advisorRoot, 'SKILL.md'), '# Advisor fixture\n');
await writeFile(advisorReference, '# Source standards fixture\n');
await writeFile(grantsPath, JSON.stringify({ grants: [{
  id: 'diver-notes-scoped-write', resource: `file://${workspace}`, rights: ['read', 'write'],
  constraints: { recursive: true, profile: 'worker-write-scoped', scope: 'workspace-only' }, expiresAt: new Date(Date.now() + 60_000).toISOString(),
}, {
  id: 'advisor-skill-fixture', resource: `file://${advisorRoot}`, rights: ['read'],
  constraints: { recursive: true, profile: 'advisor-read' }, expiresAt: new Date(Date.now() + 60_000).toISOString(),
}] }));

const daemon = net.createServer((socket) => {
  let buffer = '';
  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    const newline = buffer.indexOf('\n');
    if (newline < 0) return;
    requests.push(JSON.parse(buffer.slice(0, newline)));
    socket.end(`${JSON.stringify(daemonReplies.shift() || { ok: true, taskId: `restricted-${requests.length}` })}\n`);
  });
});
await new Promise<void>((resolve, reject) => {
  daemon.once('error', reject);
  daemon.listen(socketPath, resolve);
});

async function writePolicy(objective: string, allowWrite = false, advisorSelections: Array<'Seth' | 'Alex'> = []) {
  await writeFile(policyPath, JSON.stringify({
    version: 1,
    correlationId: 'coordinator-turn-123',
    objective,
    workspaceRoot,
    workspaceCwd: workspace,
    socketPath,
    allowWrite,
    advisorSelections,
    advisorTaskIds: [],
  }));
}

function addHandler(name: string, handler: (...args: any[]) => any) {
  const callbacks = handlers.get(name) || [];
  callbacks.push(handler);
  handlers.set(name, callbacks);
}

const pi = {
  on: addHandler,
  registerTool(tool: any) { registeredTool = tool; },
  getActiveTools() { return activeTools; },
  setActiveTools(next: string[]) { activeTools = next; },
};

try {
  await writePolicy('Keep ordinary chat local unless a restricted worker is needed.');
  process.env.MI_COORDINATOR_MODE = '1';
  process.env.MI_COORDINATOR_POLICY_FILE = policyPath;
  process.env.MI_CAPABILITY_ENFORCEMENT = 'enforce';
  process.env.MI_CAPABILITY_GRANTS_FILE = grantsPath;
  process.env.MI_ADVISOR_SKILL_PATH = advisorRoot;

  const cacheBuster = `?test=${Date.now()}`;
  const adapterModule = await import(`${pathToFileURL(path.join(process.cwd(), 'pi/extensions/mi-orchestrator-adapter.ts')).href}${cacheBuster}`);
  const guardModule = await import(`${pathToFileURL(path.join(process.cwd(), 'pi/extensions/mi-capability-guard.ts')).href}${cacheBuster}`);
  adapterModule.default(pi as any);
  guardModule.default(pi as any);

  for (const handler of handlers.get('session_start') || []) handler();
  assert.ok(activeTools.includes('orchestrator_delegate'), 'normal global discovery remains visible beside the Mi adapter');
  assert.ok(activeTools.includes('mi_orchestrator_delegate'), 'the reviewed adapter is available in a coordinator session');
  assert.equal(requests.length, 0, 'ordinary coordinator setup never starts a worker by itself');

  const prompt = miCoordinatorPrompt({ message: 'Ask Seth how I should position this offer.' });
  assert.match(prompt, /Answer ordinary conversation and advice directly; delegate only work that the policy permits/, 'ordinary conversation remains direct unless delegation is permitted');
  assert.doesNotMatch(prompt, /Ask Terra request select Terra|Ask Luna select Luna|Ask Seth selects Seth|Ask Alex or Ask Hormozi selects Alex|Sol-High worker|mi_orchestrator_delegate/, 'routing instructions remain outside the coordinator prompt');

  const guard = (handlers.get('tool_call') || [])[0];
  assert.ok(guard, 'the real capability guard is registered');
  for (const toolName of ['orchestrator_delegate', 'orchestrator_steer', 'orchestrator_workers', 'orchestrator_stop', 'orchestrator_takeover', 'unreviewed_worker_tool']) {
    const allowed = await guard({ toolName, toolCallId: toolName, input: {} }, { cwd: workspace });
    assert.equal(allowed, undefined, `${toolName} remains available as a normal Pi extension tool`);
  }
  const allowedAdapter = await guard({ toolName: 'mi_orchestrator_delegate', toolCallId: 'adapter-1', input: {} }, { cwd: workspace });
  assert.equal(allowedAdapter, undefined, 'the reviewed Mi adapter remains available through the guard');
  const allowedAdvisorRead = await guard({ toolName: 'read', toolCallId: 'advisor-read', input: { path: advisorReference } }, { cwd: workspace });
  assert.equal(allowedAdvisorRead, undefined, 'the exact trusted advisor skill and source registry are readable');
  const blockedOtherPi = await guard({ toolName: 'read', toolCallId: 'other-pi', input: { path: path.join(root, 'global', '.pi', 'extensions', 'evil.ts') } }, { cwd: workspace });
  assert.equal(blockedOtherPi?.block, true, 'unrelated .pi resources remain blocked');
  const blockedAdvisorWrite = await guard({ toolName: 'write', toolCallId: 'advisor-write', input: { path: advisorReference } }, { cwd: workspace });
  assert.equal(blockedAdvisorWrite?.block, true, 'advisor grants never permit writes');
  const allowedDiverRead = await guard({ toolName: 'read', toolCallId: 'diver-read', input: { path: 'document.md' } }, { cwd: workspace });
  const allowedDiverWrite = await guard({ toolName: 'write', toolCallId: 'diver-write', input: { path: 'document.md' } }, { cwd: workspace });
  assert.equal(allowedDiverRead, undefined, 'the canonical Diver Notes workspace is readable');
  assert.equal(allowedDiverWrite, undefined, 'the canonical Diver Notes workspace permits scoped writes');
  for (const [label, target] of [
    ['git', '.git/config'], ['node modules', 'node_modules/pkg/index.js'], ['config', 'config/app.json'],
    ['state', 'state/data.json'], ['secrets', 'secrets/key'], ['credentials', 'credentials/id'],
  ]) {
    const denied = await guard({ toolName: 'read', toolCallId: `protected-${label}`, input: { path: target } }, { cwd: workspace });
    assert.equal(denied?.block, true, `${label} remains protected inside Diver Notes`);
  }
  const deniedParent = await guard({ toolName: 'read', toolCallId: 'parent', input: { path: path.join(root, 'README.md') } }, { cwd: workspace });
  const deniedSibling = await guard({ toolName: 'write', toolCallId: 'sibling', input: { path: path.join(outside, 'note.md') } }, { cwd: workspace });
  assert.equal(deniedParent?.block, true, 'workspace parents remain outside the grant');
  assert.equal(deniedSibling?.block, true, 'workspace siblings remain outside the grant');
  await symlink(outside, path.join(workspace, 'escape'));
  const deniedEscape = await guard({ toolName: 'write', toolCallId: 'escape', input: { path: 'escape/note.md' } }, { cwd: workspace });
  assert.equal(deniedEscape?.block, true, 'symlink escapes remain outside the canonical workspace');
  assert.equal(requests.length, 0, 'blocked global and unknown tools never reach the daemon');

  assert.equal(registeredTool?.name, 'mi_orchestrator_delegate', 'the adapter keeps a distinct reviewed tool name');
  async function delegate(worker: 'Terra' | 'Luna' | 'Sol-High', objective: string) {
    await writePolicy(objective);
    const result = await registeredTool.execute('tool-call', { worker }, new AbortController().signal, () => {}, { cwd: await realpath(workspace) });
    assert.match(result.content[0].text, /Started a restricted Mi worker/, `${worker} starts through the reviewed adapter`);
  }

  await delegate('Terra', 'Ask Terra to inspect the workflow.');
  await delegate('Luna', 'Ask Luna to check the tests.');
  await delegate('Sol-High', 'Ask Seth how I should position this offer.');
  await delegate('Sol-High', '/skill:advisor ask Seth about the offer.');
  assert.equal(requests.length, 4, 'only explicit restricted routes reach the fake daemon');
  const expected = [
    ['Terra', 'openai-codex/gpt-5.6-terra:high', 'Ask Terra to inspect the workflow.'],
    ['Luna', 'openai-codex/gpt-5.6-luna:low', 'Ask Luna to check the tests.'],
    ['Sol-High', 'openai-codex/gpt-5.6-sol:high', 'Ask Seth how I should position this offer.'],
    ['Sol-High', 'openai-codex/gpt-5.6-sol:high', '/skill:advisor ask Seth about the offer.'],
  ];
  for (const [index, [worker, model, objective]] of expected.entries()) {
    const request = requests[index];
    assert.equal(request.cwd, await realpath(workspace), `${worker} stays in the policy realpath workspace`);
    assert.equal(request.model, model, `${worker} uses its restricted model`);
    assert.equal(request.capabilityProfile, 'worker-read', `${worker} has the safe read-only profile by default`);
    assert.match(String(request.message), new RegExp(objective.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${worker} receives only the current objective`);
    assert.match(String(request.name), new RegExp(`Mi ${worker} coordinator-`), `${worker} is tied to the current coordinator correlation`);
  }

  const beforeAdvisor = requests.length;
  const beforeAgent = (handlers.get('before_agent_start') || [])[0];
  assert.ok(beforeAgent, 'adapter starts direct advisor routes before the coordinator can answer');

  await writePolicy('/skill:advisor Ask Seth how I should position this offer.', false, ['Seth']);
  const singleSeth = await beforeAgent({ systemPrompt: 'base' }, { cwd: await realpath(workspace) });
  const singleSethReplay = await beforeAgent({ systemPrompt: 'base' }, { cwd: await realpath(workspace) });
  assert.equal(requests.length, beforeAdvisor + 1, 'single Seth starts exactly one advisor worker and a same-advisor replay is safe');
  assert.match(singleSeth.systemPrompt, /1 independent read-only advisor worker started/, 'a fresh single-advisor notice is truthful');
  assert.match(singleSethReplay.systemPrompt, /already active: 1 independent read-only advisor worker is tracked/, 'a replay does not claim a fresh advisor start');

  await writePolicy('Ask Alex how I should price this offer.', false, ['Alex']);
  await beforeAgent({ systemPrompt: 'base' }, { cwd: await realpath(workspace) });
  assert.equal(requests.length, beforeAdvisor + 2, 'single Alex starts exactly one advisor worker');

  const collisionTopics = [
    'Ask the advisors: should I invest more in research?',
    'Ask the advisors whether to keep the daily briefing',
    'Ask Seth and Alex how to fix my worker routing.',
  ];
  for (const objective of collisionTopics) {
    for (const advisors of [['Seth', 'Alex'], ['Alex', 'Seth']] as Array<Array<'Seth' | 'Alex'>>) {
      const start = requests.length;
      await writePolicy(objective, false, advisors);
      const result = await beforeAgent({ systemPrompt: 'base' }, { cwd: await realpath(workspace) });
      const started = requests.slice(start);
      assert.equal(started.length, 2, `${objective} starts both advisors in ${advisors.join(', ')} order`);
      assert.deepEqual(started.map((request) => request.advisor), advisors, `${objective} preserves both advisor identities`);
      assert.notEqual(started[0].name, started[1].name, `${objective} gives advisors distinct names`);
      assert.notEqual(started[0].lastInput, started[1].lastInput, `${objective} gives advisors distinct deduplication inputs`);
      assert.notEqual(started[0].message, started[1].message, `${objective} gives advisors distinct lane instructions`);
      assert.match(result.systemPrompt, /2 independent read-only advisor workers started/, `${objective} reports both fresh starts truthfully`);
      const saved = JSON.parse(await readFile(policyPath, 'utf8'));
      assert.equal(saved.advisorTaskIds.length, 2, `${objective} persists both task IDs`);
      assert.equal(new Set(saved.advisorTaskIds).size, 2, `${objective} persists each task ID exactly once`);
    }
  }
  const advisorRequests = requests.slice(beforeAdvisor);
  assert.ok(advisorRequests.every((request) => request.model === 'openai-codex/gpt-5.6-sol:high'), 'advisor workers always use Sol-High');
  assert.ok(advisorRequests.every((request) => request.capabilityProfile === 'advisor-read'), 'advisor workers are read-only');
  assert.match(String(advisorRequests[0].message), /^\/skill:advisor/m, 'advisor worker explicitly loads the trusted advisor skill');

  // The adapter must fail closed when the daemon says a start was suppressed,
  // omits a usable ID, or returns the same ID for two advisor lanes.
  const failedAdvisorStart = async (replies: Record<string, unknown>[], expectedTaskIds: string[] = []) => {
    daemonReplies.push(...replies);
    await writePolicy('Ask the advisors about fail-closed replies.', false, ['Seth', 'Alex']);
    const result = await beforeAgent({ systemPrompt: 'base' }, { cwd: await realpath(workspace) });
    assert.match(result.systemPrompt, /routing failed before all selected advisors started/, 'unsafe daemon reply does not claim advisor success');
    const saved = JSON.parse(await readFile(policyPath, 'utf8'));
    assert.deepEqual(saved.advisorTaskIds, expectedTaskIds, 'only safely started advisor IDs are recorded after a failed multi-advisor start');
  };
  await failedAdvisorStart([{ ok: true, duplicate: true, taskId: 'already-running' }]);
  await failedAdvisorStart([{ ok: true, taskId: 'not a valid task id' }]);
  await failedAdvisorStart([{ ok: true, taskId: 'same-id' }, { ok: true, taskId: 'same-id' }], ['same-id']);
  const beforePartialReplay = requests.length;
  const partialReplay = await beforeAgent({ systemPrompt: 'base' }, { cwd: await realpath(workspace) });
  assert.equal(requests.length, beforePartialReplay, 'a partial advisor start never retries or conceals the missing lane');
  assert.match(partialReplay.systemPrompt, /routing failed before all selected advisors started/, 'a partial advisor start stays visibly failed');

  const beforeDenied = requests.length;
  const outsideResult = await registeredTool.execute('tool-call', { worker: 'Terra' }, new AbortController().signal, () => {}, { cwd: outside });
  assert.match(outsideResult.content[0].text, /outside Mi’s approved workspace/, 'a changed cwd is denied before daemon delivery');
  await writePolicy('Ask Terra to make a change.', false);
  const writeResult = await registeredTool.execute('tool-call', { worker: 'Terra', mode: 'write' }, new AbortController().signal, () => {}, { cwd: workspace });
  assert.match(writeResult.content[0].text, /no approved scoped-write context/, 'a write request without approval is denied');
  assert.equal(requests.length, beforeDenied, 'denied cwd and write requests never reach the daemon');

  console.log('Mi orchestrator adapter checks passed.');
} finally {
  await new Promise<void>((resolve) => daemon.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
}
