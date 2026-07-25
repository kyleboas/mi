#!/usr/bin/env tsx
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { miCoordinatorPrompt } from './mi-imessage-coordinator.mjs';

const root = await mkdtemp(path.join(tmpdir(), 'mi-orchestrator-adapter-'));
const workspaceRoot = path.join(root, 'workflows');
const workspace = path.join(workspaceRoot, 'project');
const outside = path.join(root, 'outside');
const socketPath = path.join(root, 'mi.sock');
const policyPath = path.join(root, 'policy.json');
const advisorRoot = path.join(root, 'global', '.pi', 'agent', 'skills', 'advisor');
const advisorReference = path.join(advisorRoot, 'references', 'source-standards.md');
const grantsPath = path.join(root, 'grants.json');
const requests: Record<string, unknown>[] = [];
const handlers = new Map<string, Array<(...args: any[]) => any>>();
let registeredTool: any;
let activeTools = ['read', 'orchestrator_delegate', 'orchestrator_workers'];

await mkdir(workspace, { recursive: true });
await mkdir(outside, { recursive: true });
await mkdir(path.dirname(advisorReference), { recursive: true });
await writeFile(path.join(advisorRoot, 'SKILL.md'), '# Advisor fixture\n');
await writeFile(advisorReference, '# Source standards fixture\n');
await writeFile(grantsPath, JSON.stringify({ grants: [{
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
    socket.end(`${JSON.stringify({ ok: true, taskId: `restricted-${requests.length}` })}\n`);
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
  assert.match(prompt, /Keep ordinary chat and uninvoked advice local/, 'ordinary uninvoked advice remains local');
  assert.match(prompt, /Ask Terra request select Terra/, 'Terra has an explicit restricted route');
  assert.match(prompt, /Ask Luna select Luna/, 'Luna has an explicit restricted route');
  assert.match(prompt, /Ask Seth selects Seth.*Ask Alex or Ask Hormozi selects Alex.*Ask the advisors selects Seth and Alex/s, 'advisor selector rules are explicit');

  const guard = (handlers.get('tool_call') || [])[0];
  assert.ok(guard, 'the real capability guard is registered');
  const blockedGlobal = await guard({ toolName: 'orchestrator_delegate', toolCallId: 'global-1', input: {} }, { cwd: workspace });
  assert.equal(blockedGlobal?.block, true, 'a discovered global orchestrator tool cannot bypass the Mi guard');
  const allowedAdapter = await guard({ toolName: 'mi_orchestrator_delegate', toolCallId: 'adapter-1', input: {} }, { cwd: workspace });
  assert.equal(allowedAdapter, undefined, 'only the reviewed Mi adapter is allowed through the guard');
  const blockedUnknown = await guard({ toolName: 'unreviewed_worker_tool', toolCallId: 'unknown-1', input: {} }, { cwd: workspace });
  assert.equal(blockedUnknown?.block, true, 'unknown extension tools fail closed');
  const allowedAdvisorRead = await guard({ toolName: 'read', toolCallId: 'advisor-read', input: { path: advisorReference } }, { cwd: workspace });
  assert.equal(allowedAdvisorRead, undefined, 'the exact trusted advisor skill and source registry are readable');
  const blockedOtherPi = await guard({ toolName: 'read', toolCallId: 'other-pi', input: { path: path.join(root, 'global', '.pi', 'extensions', 'evil.ts') } }, { cwd: workspace });
  assert.equal(blockedOtherPi?.block, true, 'unrelated .pi resources remain blocked');
  const blockedAdvisorWrite = await guard({ toolName: 'write', toolCallId: 'advisor-write', input: { path: advisorReference } }, { cwd: workspace });
  assert.equal(blockedAdvisorWrite?.block, true, 'advisor grants never permit writes');
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
  await writePolicy('Ask Seth how I should position this offer.', false, ['Seth']);
  const beforeAgent = (handlers.get('before_agent_start') || [])[0];
  assert.ok(beforeAgent, 'adapter starts direct advisor routes before the coordinator can answer');
  await beforeAgent({ systemPrompt: 'base' }, { cwd: await realpath(workspace) });
  await beforeAgent({ systemPrompt: 'base' }, { cwd: await realpath(workspace) });
  assert.equal(requests.length, beforeAdvisor + 1, 'Ask Seth starts exactly one independent advisor worker and does not repeat it');
  await writePolicy('Ask the advisors how I should position this offer.', false, ['Seth', 'Alex']);
  await beforeAgent({ systemPrompt: 'base' }, { cwd: await realpath(workspace) });
  assert.equal(requests.length, beforeAdvisor + 3, 'Ask the advisors starts one Sol-High worker per registered advisor');
  const advisorRequests = requests.slice(beforeAdvisor);
  assert.deepEqual(advisorRequests.map((request) => request.model), ['openai-codex/gpt-5.6-sol:high', 'openai-codex/gpt-5.6-sol:high', 'openai-codex/gpt-5.6-sol:high'], 'advisor workers always use Sol-High');
  assert.deepEqual(advisorRequests.map((request) => request.capabilityProfile), ['advisor-read', 'advisor-read', 'advisor-read'], 'advisor workers are read-only');
  assert.notEqual(advisorRequests[1].name, advisorRequests[2].name, 'multi-advisor worker names are independent');
  assert.notEqual(advisorRequests[1].message, advisorRequests[2].message, 'multi-advisor worker messages preserve individual identities');
  assert.match(String(advisorRequests[0].message), /^\/skill:advisor/m, 'advisor worker explicitly loads the trusted advisor skill');

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
