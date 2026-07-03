#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const source = await readFile(new URL('../src/loop-discovery.ts', import.meta.url), 'utf8');
const cli = await readFile(new URL('../src/cli.ts', import.meta.url), 'utf8');
const tick = await readFile(new URL('../src/tick.ts', import.meta.url), 'utf8');
const webChat = await readFile(new URL('./mi-web-chat.mjs', import.meta.url), 'utf8');
const daemon = await readFile(new URL('../pi/extensions/mi-daemon.mjs', import.meta.url), 'utf8');

assert.match(source, /\.pi', 'agent', 'sessions'/, 'loop discovery reads the approved Pi session root');
assert.match(source, /\.pi', 'security-fix-sessions'/, 'loop discovery reads the approved security-fix session root');
assert.match(source, /secret-store|\\\.env[\s\S]*infisical|agent-secrets/i, 'loop discovery refuses secret/env/Infisical paths');
assert.match(source, /slice\(0, 160\)/, 'snippets are capped at 160 chars');
assert.match(source, /candidate\.evidenceCount >= 3[\s\S]*candidate\.evidenceCount >= 2 && candidate\.painCount > 0/, 'candidate threshold requires recurrence or pain');
assert.match(source, /formatLoopDiscoveryBrief[\s\S]*Reply with a number or name and I’ll start grilling it in Pi/, 'brief uses the approved compact iMessage prompt');
assert.match(source, /appendNotes[\s\S]*loop-discovery:start[\s\S]*Aggregate-only notes/, 'NOTES updates are managed and aggregate-only');
assert.match(source, /capabilityProfile: 'worker-write-scoped'/, 'selection starts scoped writable grilling workers');
assert.match(cli, /mi loop-discovery \[--force\] \[--dry-run\] \[--notify\] \[--select <value>\]/, 'CLI documents mi loop-discovery');
assert.match(cli, /if \(command === 'loop-discovery'\) return loopDiscoveryCommand\(args\);/, 'CLI exposes mi loop-discovery');
assert.match(tick, /loopDiscoveryDue\(\)[\s\S]*runLoopDiscovery\(\{ mode: 'scheduled', notify: true \}\)/, 'mi tick runs scheduled loop discovery through the isolated module');
assert.match(webChat, /handleLoopDiscoverySelectionFromImessage[\s\S]*--select[\s\S]*loop-discovery-selection/, 'iMessage replies can select a loop-discovery candidate');
assert.match(webChat, /messageLooksLikeLoopDiscoveryRun[\s\S]*runLoopDiscoveryCli\(\['--force'\]\)/, 'iMessage can manually run loop discovery');
assert.match(daemon, /worker-write-scoped is only allowed under ~\/workflows/, 'daemon refuses write-scoped workers outside workflows');

const root = await mkdtemp(join(tmpdir(), 'mi-loop-discovery-'));
try {
  const sessionRoot = join(root, 'sessions');
  const statePath = join(root, 'state', 'loop-discovery.json');
  const notesPath = join(root, 'NOTES.md');
  const workflowsDir = join(root, 'workflows');
  await mkdir(sessionRoot, { recursive: true });
  await mkdir(workflowsDir, { recursive: true });
  await writeFile(notesPath, '# Notes\n');
  await writeFile(join(workflowsDir, 'imessage-send-failure-repair.md'), '# iMessage Send Failure Repair\n');
  const mkSession = async (name, text, ts) => {
    const file = join(sessionRoot, `${name}.jsonl`);
    await writeFile(file, [
      JSON.stringify({ type: 'session', timestamp: ts, cwd: root }),
      JSON.stringify({ type: 'message', timestamp: ts, message: { role: 'user', content: [{ type: 'text', text }] } }),
    ].join('\n'));
  };
  await mkSession('a', 'Run Tactics Journal detect candidates again and fix the stale report generation.', '2026-06-20T10:00:00.000Z');
  await mkSession('b', 'Tactics Journal candidate review is stuck, inspect the research report output.', '2026-06-21T10:00:00.000Z');
  await mkSession('c', 'Please repair Tactics Journal report generation for detect candidates. SECRET_TOKEN=abcd should not persist.', '2026-06-22T10:00:00.000Z');
  await mkSession('d', 'Current user request:\nFix the Mi iMessage handoff routing again.\n\nHandoff reason: test wrapper', '2026-06-23T10:00:00.000Z');

  const runner = join(root, 'run-loop.mjs');
  await writeFile(runner, `
    process.env.MI_LOOP_DISCOVERY_SESSION_ROOTS = ${JSON.stringify(sessionRoot)};
    process.env.MI_LOOP_DISCOVERY_STATE_PATH = ${JSON.stringify(statePath)};
    process.env.MI_LOOP_DISCOVERY_NOTES_PATH = ${JSON.stringify(notesPath)};
    process.env.MI_LOOP_DISCOVERY_WORKFLOWS_DIR = ${JSON.stringify(workflowsDir)};
    process.env.MI_PROACTIVE_IMESSAGE_NOTIFY = 'false';
    const mod = await import(${JSON.stringify(new URL('../src/loop-discovery.ts', import.meta.url).href)});
    const result = await mod.runLoopDiscovery({ mode: 'manual', force: true });
    const state = await mod.readLoopDiscoveryState();
    console.log(JSON.stringify({ result, state }));
  `);
  const tsx = new URL('../node_modules/.bin/tsx', import.meta.url).pathname;
  const result = spawnSync(process.execPath, [tsx, runner], { cwd: root, env: { ...process.env, HOME: root, MI_ROOT: join(root, 'assistant') }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout.trim());
  assert.equal(payload.result.status, 'brief', 'manual run creates a brief when threshold is met');
  assert.match(payload.result.message, /I found \d+ loops? worth looking at:/, 'brief is compact and numbered');
  assert.ok(payload.result.candidates.some((candidate) => candidate.key === 'tactics-journal-research-operations'), 'Tactics Journal recurrence is detected');
  assert.doesNotMatch(JSON.stringify(payload.state), /SECRET_TOKEN|abcd/, 'state does not persist raw secret-looking text');
  const notes = await readFile(notesPath, 'utf8');
  assert.match(notes, /loop-discovery:start[\s\S]*Tactics Journal research operations/, 'NOTES receives aggregate candidate notes');
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log('Mi loop discovery checks passed.');
