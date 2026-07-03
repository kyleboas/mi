#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const source = await readFile(new URL('../src/loop-factory.ts', import.meta.url), 'utf8');
const cli = await readFile(new URL('../src/cli.ts', import.meta.url), 'utf8');
const tick = await readFile(new URL('../src/tick.ts', import.meta.url), 'utf8');
const webChat = await readFile(new URL('./mi-web-chat.mjs', import.meta.url), 'utf8');
const loopDiscovery = await readFile(new URL('../src/loop-discovery.ts', import.meta.url), 'utf8');

assert.match(source, /loop-factory\.json/, 'Loop Factory keeps an isolated state file');
assert.match(source, /loop-factory:start[\s\S]*Aggregate-only Loop Factory records/, 'Loop Factory uses a separate aggregate NOTES block');
assert.match(source, /this is a loop[\s\S]*make this a workflow[\s\S]*automate this recurring thing[\s\S]*i keep doing this[\s\S]*next time do this automatically/i, 'Loop Factory recognizes the approved capture phrases');
assert.match(source, /captured' \| 'triaged_low' \| 'ready_to_grill' \| 'grilling' \| 'build_ready' \| 'implementation_queued' \| 'rejected' \| 'superseded'/, 'Loop Factory encodes the required candidate statuses');
assert.match(source, /capabilityProfile: 'worker-write-scoped'/, 'Loop Factory grilling workers are scoped to workflow specs');
assert.match(source, /loop-factory:build_ready/, 'Loop Factory scans specs for a build-ready marker');
assert.match(source, /Reply: queue now, later, or never/, 'Loop Factory sends the implementation approval checkpoint');
assert.match(source, /\^\[rR\]\$[\s\S]*accept the recommended answer/, 'Loop Factory maps r/R to accepting the recommended answer');
assert.match(source, /Never quote private transcripts|Privacy: never quote private transcripts/, 'Loop Factory prompts preserve transcript privacy');
assert.match(cli, /mi loop-factory capture <text>/, 'CLI documents loop capture');
assert.match(cli, /if \(command === 'loop-factory'\) return loopFactoryCommand\(args\);/, 'CLI exposes mi loop-factory');
assert.match(tick, /runLoopFactoryTick\(\)/, 'mi tick runs Loop Factory');
assert.match(webChat, /handleLoopDiscoverySelectionFromImessage[\s\S]*handleLoopFactoryReplyFromImessage[\s\S]*handleLoopFactoryCaptureFromImessage/, 'iMessage routes loop discovery before active Loop Factory reply before capture');
assert.match(webChat, /url\.pathname === '\/api\/send'[\s\S]*messageLooksLikeLoopFactoryCapture\(message\)[\s\S]*runLoopFactoryCli\(\['capture', message\]\)/, 'web chat captures Loop Factory phrases before normal worker queueing');
assert.match(loopDiscovery, /recordMinedLoopSelection/, 'Loop discovery records selected mined candidates into Loop Factory state');

const root = await mkdtemp(join(tmpdir(), 'mi-loop-factory-'));
try {
  const statePath = join(root, 'state', 'loop-factory.json');
  const notesPath = join(root, 'NOTES.md');
  const workflowsDir = join(root, 'workflows');
  await mkdir(workflowsDir, { recursive: true });
  await writeFile(notesPath, '# Notes\n');
  const runner = join(root, 'run-loop-factory.mjs');
  await writeFile(runner, `
    process.env.MI_LOOP_FACTORY_STATE_PATH = ${JSON.stringify(statePath)};
    process.env.MI_LOOP_FACTORY_NOTES_PATH = ${JSON.stringify(notesPath)};
    process.env.MI_LOOP_FACTORY_WORKFLOWS_DIR = ${JSON.stringify(workflowsDir)};
    process.env.MI_PROACTIVE_IMESSAGE_NOTIFY = 'false';
    const mod = await import(${JSON.stringify(new URL('../src/loop-factory.ts', import.meta.url).href)});
    const capture = await mod.runLoopFactoryCapture('this is a loop: reconcile recurring weekly project notes', { source: 'manual', startGrilling: false });
    const status = await mod.loopFactoryStatus();
    console.log(JSON.stringify({ capture, status, paths: mod.loopFactoryPaths() }));
  `);
  const tsx = new URL('../node_modules/.bin/tsx', import.meta.url).pathname;
  const result = spawnSync(process.execPath, [tsx, runner], { cwd: root, env: { ...process.env, HOME: root, MI_ROOT: join(root, 'assistant') }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout.trim());
  assert.equal(payload.capture.ok, true, 'capture succeeds');
  assert.equal(payload.capture.candidate.status, 'triaged_low', 'single mild capture is held for digest');
  assert.match(payload.status.message, /Loop Factory: 1 candidate/, 'status summarizes candidate counts');
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(state.candidates.length, 1, 'state stores the candidate');
  assert.doesNotMatch(JSON.stringify(state), /SECRET|TOKEN=/, 'state avoids secret-looking content');
  const notes = await readFile(notesPath, 'utf8');
  assert.match(notes, /loop-factory:start[\s\S]*weekly project notes/, 'NOTES receives Loop Factory aggregate notes');
  const spec = await readFile(join(workflowsDir, 'reconcile-recurring-weekly-project-notes.md'), 'utf8');
  assert.match(spec, /Loop Factory grilling in progress/, 'capture creates a draft workflow spec');
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log('Mi Loop Factory checks passed.');
