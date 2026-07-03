#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const files = {
  cli: await readFile('src/cli.ts', 'utf8'),
  daemon: await readFile('pi/extensions/mi-daemon.mjs', 'utf8'),
  web: await readFile('scripts/mi-web-chat.mjs', 'utf8'),
};

const coverage = {
  cli: {
    '--once': ['test-mi-cli-surfaces.mjs'],
    raw: ['test-mi-capability-matrix.mjs'],
    pi: ['test-mi-capabilities.mjs'],
    ui: ['test-mi-main-queue-render.mjs'],
    chat: ['test-mi-cli-surfaces.mjs'],
    open: ['test-mi-cli-surfaces.mjs'],
    ask: ['test-mi-cli-surfaces.mjs'],
    inbox: ['test-mi-cli-surfaces.mjs'],
    threads: ['test-mi-cli-surfaces.mjs'],
    temp: ['test-mi-cli-surfaces.mjs'],
    compact: ['test-mi-cli-surfaces.mjs'],
    agents: ['test-mi-agent-e2e.mjs', 'test-mi-agent-render-snapshot.mjs'],
    tick: ['test-mi-tick.mjs'],
    'project-status': ['test-mi-project-status.mjs'],
    status: ['test-mi-approvals-status.mjs'],
    approvals: ['test-mi-approvals-status.mjs'],
    proposals: ['test-mi-approvals-status.mjs'],
    delegations: ['test-mi-approvals-status.mjs'],
    'loop-discovery': ['test-mi-loop-discovery.mjs'],
    'loop-factory': ['test-mi-loop-factory.mjs'],
    check: ['test-mi-cli-surfaces.mjs', 'test-mi-proactive-check.mjs'],
    cron: ['test-mi-cli-surfaces.mjs'],
    task: ['test-mi-cli-surfaces.mjs', 'test-mi-daemon-pi-session-e2e.mjs'],
    make: ['test-mi-cli-surfaces.mjs'],
    run: ['test-mi-cli-surfaces.mjs'],
    edit: ['test-mi-cli-surfaces.mjs'],
    logs: ['test-mi-cli-surfaces.mjs'],
  },
  daemon: {
    prompt: ['test-mi-daemon-pi-session-e2e.mjs'],
    health: ['test-mi-daemon-pi-session-e2e.mjs'],
    pi_session_event: ['test-mi-daemon-pi-session-e2e.mjs'],
    abort: ['test-mi-agent-e2e.mjs'],
    state: ['test-mi-agent-e2e.mjs'],
    cycle_model: ['test-mi-capabilities.mjs'],
    set_model: ['test-mi-capabilities.mjs'],
    set_thinking: ['test-mi-capabilities.mjs'],
    new_session: ['test-mi-capabilities.mjs'],
    set_session_name: ['test-mi-capabilities.mjs'],
    get_available_models: ['test-mi-capabilities.mjs'],
    run_worker: ['test-mi-cli-surfaces.mjs', 'test-mi-web-api-e2e.mjs', 'test-mi-agent-e2e.mjs'],
    continue_worker: ['test-mi-cli-surfaces.mjs', 'test-mi-worker-error-continue.mjs', 'test-mi-worker-result-report.mjs'],
    list_tasks: ['test-mi-cli-surfaces.mjs', 'test-mi-agent-e2e.mjs'],
    stop_task: ['test-mi-agent-e2e.mjs'],
    dismiss_task: ['test-mi-agent-render-snapshot.mjs'],
    list_pi_sessions: ['test-mi-agent-e2e.mjs'],
    resume_session: ['test-mi-agent-e2e.mjs'],
    resume_sessions: ['test-mi-daemon-pi-session-e2e.mjs'],
  },
  web: {
    'GET /': ['test-mi-web-api-e2e.mjs'],
    'GET /favicon.jpg': ['test-mi-capability-matrix.mjs'],
    'GET /apple-touch-icon.png': ['test-mi-capability-matrix.mjs'],
    'GET /sw.js': ['test-mi-web-api-e2e.mjs'],
    'GET /manifest.json': ['test-mi-web-api-e2e.mjs'],
    'GET /api/health': ['test-mi-web-api-e2e.mjs'],
    'GET /api/push/public-key': ['test-mi-web-api-e2e.mjs'],
    'POST /api/push/subscribe': ['test-mi-web-api-e2e.mjs'],
    'GET /api/threads': ['test-mi-web-api-e2e.mjs'],
    'GET /api/messages': ['test-mi-web-api-e2e.mjs'],
    'POST /api/notify': ['test-mi-web-api-e2e.mjs'],
    'POST /api/send': ['test-mi-web-api-e2e.mjs', 'test-mi-web-chat-routing.mjs'],
    'POST /api/photo': ['test-mi-web-api-e2e.mjs'],
    'POST /api/imessage': ['test-mi-web-api-e2e.mjs', 'test-mi-imessage-scenarios.mjs'],
  },
};

function actualCliCommands(source) {
  const main = source.slice(source.indexOf('async function main()'));
  const found = new Set();
  for (const match of main.matchAll(/command === '([^']+)'/g)) found.add(match[1]);
  for (const match of main.matchAll(/command === '([^']+)' \|\| command === '([^']+)'/g)) {
    found.add(match[1]);
    found.add(match[2]);
  }
  for (const match of main.matchAll(/if \(command === '([^']+)' \|\| command === '([^']+)'\)/g)) {
    found.add(match[1]);
    found.add(match[2]);
  }
  for (const alias of ['--once', 'raw', 'pi', 'ui', 'chat', 'open', 'ask', 'inbox', 'threads', 'temp', 'compact', 'agents', 'tick', 'project-status', 'status', 'approvals', 'proposals', 'delegations', 'loop-discovery', 'loop-factory', 'check', 'cron', 'task', 'make', 'run', 'edit', 'logs']) {
    if (main.includes(`command === '${alias}'`)) found.add(alias);
  }
  found.delete('help');
  found.delete('--help');
  found.delete('-h');
  return [...found].sort();
}

function actualDaemonTypes(source) {
  return [...source.matchAll(/request\.type === "([^"]+)"/g)].map((match) => match[1]).sort();
}

function actualWebRoutes(source) {
  const routes = new Set();
  for (const match of source.matchAll(/req\.method === '([^']+)' && url\.pathname === '([^']+)'/g)) routes.add(`${match[1]} ${match[2]}`);
  const favicon = source.match(/req\.method === 'GET' && \(url\.pathname === '([^']+)' \|\| url\.pathname === '([^']+)'\)/);
  if (favicon) {
    routes.add(`GET ${favicon[1]}`);
    routes.add(`GET ${favicon[2]}`);
  }
  return [...routes].sort();
}

function assertCovered(kind, actual, expected) {
  assert.deepEqual(actual, Object.keys(expected).sort(), `${kind} capability coverage is stale; update scripts/test-mi-capability-matrix.mjs`);
  for (const [capability, tests] of Object.entries(expected)) {
    assert.ok(Array.isArray(tests) && tests.length > 0, `${kind} ${capability} must name at least one owning test`);
    for (const test of tests) assert.match(test, /^test-mi-.+\.mjs$/, `${kind} ${capability} has invalid test owner ${test}`);
  }
}

assertCovered('CLI', actualCliCommands(files.cli), coverage.cli);
assertCovered('daemon', actualDaemonTypes(files.daemon), coverage.daemon);
assertCovered('web', actualWebRoutes(files.web), coverage.web);

assert.match(files.cli, /MI_TUI_RENDER_TEST === '1'/, 'default Mi TUI needs a hermetic render-test hook');
assert.match(files.cli, /MI_AGENT_RENDER_TEST === '1'/, 'mi agents needs a hermetic render-test hook');
assert.match(files.web, /maxUploadBytes/, 'web photo upload limits must remain testable');
assert.match(files.web, /webhookAuthorized\(req\)/, 'web notify endpoint must remain token gated');

console.log('mi capability matrix tests passed');
