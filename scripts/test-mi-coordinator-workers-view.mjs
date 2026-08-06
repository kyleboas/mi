#!/usr/bin/env node
// Focused UI/state tests for the per-Pi-session worker view in `mi agents`,
// and for the bounded-work guarantee of the ^F full-output view.
import assert from 'node:assert/strict';
import { visibleWidth } from '@mariozechner/pi-tui';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = await mkdtemp(join(tmpdir(), 'mi-coordinator-workers-view-'));
const NOW = '2026-07-25T12:00:00.000Z';
const nowMs = Date.parse(NOW);
const at = (offsetMs) => new Date(nowMs + offsetMs).toISOString();
const SECOND = 1000;
const MINUTE = 60 * SECOND;

const stripAnsi = (line) => line.replace(/\x1b\[[0-9;:]*[A-Za-z]/g, '');

let fixtureCounter = 0;
async function run(tasks, { events = '', cols = 100, rows = 24, extraEnv = {}, reloadTasks } = {}) {
  const fixture = join(root, `tasks-${fixtureCounter++}.json`);
  await writeFile(fixture, JSON.stringify(tasks, null, 2));
  let eventList = events;
  if (reloadTasks) {
    const reloadPath = join(root, `tasks-${fixtureCounter++}.json`);
    await writeFile(reloadPath, JSON.stringify(reloadTasks, null, 2));
    eventList = [events, `reload:${reloadPath}`].filter(Boolean).join(',');
  }
  const started = Date.now();
  const result = spawnSync(process.execPath, ['node_modules/.bin/tsx', 'src/cli.ts', 'agents'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env,
      MI_AGENT_RENDER_TEST: '1',
      MI_AGENT_RENDER_TEST_TASKS: fixture,
      MI_AGENT_RENDER_TEST_EVENTS: eventList,
      MI_AGENT_RENDER_TEST_ROWS: String(rows),
      MI_AGENT_RENDER_TEST_COLS: String(cols),
      MI_AGENT_RENDER_TEST_NOW: NOW,
      ...extraEnv,
    },
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  assert.equal(result.status, 0, `render run failed: ${result.stderr}`);
  const parsed = JSON.parse(result.stdout);
  return { ...parsed, elapsedMs: Date.now() - started };
}

// Map each rendered line to the section header above it, so worker rows can be
// checked against the parent card they belong to.
function sections(frame) {
  const bySection = new Map();
  let current = '';
  for (const raw of frame.lines) {
    const line = stripAnsi(raw).trimEnd();
    const label = line.trim();
    if (['needs input', 'working'].includes(label) || label.startsWith('completed')) {
      current = label.startsWith('completed') ? 'completed' : label;
      bySection.set(current, []);
      continue;
    }
    if (!current || !label) continue;
    bySection.get(current).push(line);
  }
  return bySection;
}

function sectionOf(frame, taskName) {
  for (const [label, entries] of sections(frame)) {
    if (entries.some((line) => line.includes(taskName))) return label;
  }
  return undefined;
}

// A parent card with a live nested worker: the parent's own Pi process is idle
// (complete) but the accepted snapshot is newer than finishedAt.
function coordinator(name, workers, overrides = {}) {
  return {
    id: `task-${name}`,
    name,
    cwd: '/home/kyle',
    status: 'complete',
    coordinatorMode: true,
    sessionId: `session-${name}`,
    startedAt: at(-10 * MINUTE),
    updatedAt: at(-2 * MINUTE),
    finishedAt: at(-2 * MINUTE),
    workers,
    workersRevision: 7,
    workersEmittedAt: at(-30 * SECOND),
    workersUpdatedAt: at(-30 * SECOND),
    ...overrides,
  };
}

const legacyTask = { id: 'legacy-1', name: 'legacy-run', cwd: '/home/kyle', status: 'running', progress: 'legacy progress', startedAt: at(-3 * MINUTE), updatedAt: at(-1 * MINUTE) };
const legacyDone = { id: 'legacy-2', name: 'legacy-done', cwd: '/home/kyle', status: 'complete', text: 'legacy result', finishedAt: at(-4 * MINUTE), updatedAt: at(-4 * MINUTE) };

try {
  // 1. Several parent sessions keep isolated worker lists, and an unselected
  //    coordinator costs one summary row instead of its whole fleet.
  {
    const alpha = coordinator('coord-alpha', [
      { id: 'w-a1', name: 'alpha-one', state: 'working', activity: 'Working on assigned task', startedAt: at(-90 * SECOND) },
      { id: 'w-a2', name: 'alpha-two', state: 'idle', activity: 'Waiting for review', startedAt: at(-5 * MINUTE), settledAt: at(-1 * MINUTE) },
    ]);
    const beta = coordinator('coord-beta', [
      { id: 'w-b1', name: 'beta-one', state: 'working', activity: 'Working on assigned task', startedAt: at(-45 * SECOND) },
    ]);
    const gamma = coordinator('coord-gamma', [
      { id: 'w-g1', name: 'gamma-one', state: 'failed', activity: 'Worker failed', startedAt: at(-6 * MINUTE), settledAt: at(-3 * MINUTE) },
    ]);
    const { frames } = await run([alpha, beta, gamma, legacyTask, legacyDone], { events: 'ctrlW' });
    const collapsed = frames[0];
    const expanded = frames.at(-1);

    const collapsedText = collapsed.lines.map(stripAnsi).join('\n');
    const expandedText = expanded.lines.map(stripAnsi).join('\n');
    assert.ok(/↳ .*1 working/.test(collapsedText), 'unselected coordinators show a one-row worker summary');
    assert.ok(expandedText.includes('alpha-one') && expandedText.includes('beta-one') && expandedText.includes('gamma-one'), '^W expands every coordinator');

    // Isolation: each worker name appears exactly once, under its own parent.
    for (const worker of ['alpha-one', 'alpha-two', 'beta-one', 'gamma-one']) {
      const hits = expanded.lines.map(stripAnsi).filter((line) => line.includes(worker));
      assert.equal(hits.length, 1, `${worker} renders once, under a single parent`);
    }
    const workerLines = expanded.lines.map(stripAnsi).map((line) => line.trimEnd());
    const alphaIndex = workerLines.findIndex((line) => line.includes('coord-alpha'));
    const betaIndex = workerLines.findIndex((line) => line.includes('coord-beta'));
    const alphaOne = workerLines.findIndex((line) => line.includes('alpha-one'));
    const alphaTwo = workerLines.findIndex((line) => line.includes('alpha-two'));
    assert.ok(alphaIndex < alphaOne && alphaOne < betaIndex, 'alpha workers sit between their parent and the next parent');
    assert.ok(alphaTwo < betaIndex, 'alpha workers never leak under coord-beta');

    // Age is derived from startedAt; a settled worker's age freezes.
    assert.ok(/alpha-one · working · Working on assigned task · 1m/.test(expandedText), 'live worker shows a derived age');
    assert.ok(/alpha-two · idle .*· 4m/.test(expandedText), 'settled worker age freezes at settledAt');
    assert.ok(/gamma-one · failed · Worker failed · 3m/.test(expandedText), 'result derived from state is not duplicated with activity');

    // Legacy tasks are untouched.
    assert.ok(!/legacy-run.*↳/s.test(collapsedText.split('\n').find((line) => line.includes('legacy-run')) || ''), 'legacy tasks get no worker rows');
    const legacyFrameLines = collapsed.lines.map(stripAnsi).filter((line) => line.includes('legacy-'));
    assert.equal(legacyFrameLines.length, 2, 'both legacy tasks render as plain cards');
  }

  // 2. A coordinator with a large fleet cannot evict the other sessions.
  {
    const many = coordinator('coord-many', Array.from({ length: 24 }, (_, index) => ({
      id: `w-${index}`,
      name: `fleet-${String(index).padStart(2, '0')}`,
      state: 'working',
      activity: 'Working on assigned task',
      startedAt: at(-60 * SECOND),
    })), { status: 'running', finishedAt: undefined });
    // Collapsed (the coordinator is not selected): one summary row only.
    const collapsed = await run([many, legacyTask, legacyDone], { rows: 20 });
    const collapsedText = collapsed.frames[0].lines.map(stripAnsi).join('\n');
    assert.ok(collapsedText.includes('coord-many'), 'the coordinator card renders');
    assert.ok(collapsedText.includes('legacy-run') && collapsedText.includes('legacy-done'), 'a 24-worker fleet does not push other sessions out of the list');
    assert.ok(/↳ 24 working/.test(collapsedText), 'the fleet costs one summary row while unselected');
    assert.equal(collapsed.frames[0].lines.filter((line) => /fleet-\d\d/.test(stripAnsi(line))).length, 0, 'unselected coordinators spend no worker rows');

    // Selected: rows expand but stay capped with a +N more tail.
    const expanded = await run([many, legacyTask, legacyDone], { events: 'down', rows: 30 });
    const frame = expanded.frames.at(-1);
    assert.equal(frame.selectedTask, 'coord-many');
    const text = frame.lines.map(stripAnsi).join('\n');
    const shown = frame.lines.map(stripAnsi).filter((line) => /fleet-\d\d/.test(line));
    assert.ok(shown.length > 0 && shown.length <= 8, `inline worker rows stay bounded (got ${shown.length})`);
    assert.ok(/\+16 more/.test(text), 'the worker list is capped with a +N more tail');
    assert.ok(text.includes('legacy-run') && text.includes('legacy-done'), 'other sessions survive an expanded fleet');
  }

  // 3. Narrow terminals: every worker line fits, name and state survive.
  for (const cols of [48, 60, 80]) {
    const narrow = coordinator('coord-narrow', [
      { id: 'w-n1', name: 'narrow-worker-one', state: 'working', activity: 'Working on a long assigned task description', startedAt: at(-30 * SECOND), result: 'a fairly long result summary line' },
    ], { status: 'running', finishedAt: undefined });
    const { frames } = await run([narrow, legacyTask], { events: 'ctrlW', cols, rows: 20 });
    for (const line of frames.at(-1).lines) {
      assert.ok(visibleWidth(line) <= cols, `line exceeds ${cols} columns: ${JSON.stringify(stripAnsi(line))}`);
    }
    const workerLine = frames.at(-1).lines.map(stripAnsi).find((line) => line.includes('narrow-worker'));
    assert.ok(workerLine, `worker row renders at ${cols} columns`);
    assert.ok(workerLine.includes('working'), `state survives truncation at ${cols} columns`);
  }

  // 4. Parent card state derived from the accepted current snapshot.
  {
    const active = coordinator('parent-active', [
      { id: 'w1', name: 'live-worker', state: 'working', startedAt: at(-60 * SECOND) },
      { id: 'w2', name: 'done-worker', state: 'idle', startedAt: at(-5 * MINUTE), settledAt: at(-1 * MINUTE) },
    ]);
    const mixedFailed = coordinator('parent-mixed', [
      { id: 'w1', name: 'live-worker-2', state: 'starting', startedAt: at(-10 * SECOND) },
      { id: 'w2', name: 'dead-worker', state: 'failed', startedAt: at(-5 * MINUTE), settledAt: at(-2 * MINUTE) },
    ]);
    const settled = coordinator('parent-settled', [
      { id: 'w1', name: 'settled-one', state: 'idle', startedAt: at(-5 * MINUTE), settledAt: at(-1 * MINUTE) },
      { id: 'w2', name: 'settled-two', state: 'stopped', startedAt: at(-5 * MINUTE), settledAt: at(-1 * MINUTE) },
    ]);
    const stale = coordinator('parent-stale', [
      { id: 'w1', name: 'stale-one', state: 'working', stale: true, startedAt: at(-5 * MINUTE) },
    ]);
    const expired = coordinator('parent-expired', [
      { id: 'w1', name: 'expired-one', state: 'working', startedAt: at(-3 * 60 * MINUTE) },
    ], { workersUpdatedAt: at(-2 * 60 * MINUTE), workersEmittedAt: at(-2 * 60 * MINUTE) });
    const preFinish = coordinator('parent-prefinish', [
      { id: 'w1', name: 'prefinish-one', state: 'working', startedAt: at(-9 * MINUTE) },
    ], { workersUpdatedAt: at(-5 * MINUTE), workersEmittedAt: at(-5 * MINUTE) });
    const errored = coordinator('parent-errored', [
      { id: 'w1', name: 'errored-live', state: 'working', startedAt: at(-60 * SECOND) },
    ], { status: 'error', needsUser: true, error: 'coordinator failed', finishedAt: undefined });

    // Two runs: the `completed` section is deliberately truncated to three
    // entries unless the selection sits inside it.
    const promoted = (await run([active, mixedFailed, errored], { rows: 40 })).frames[0];
    assert.equal(sectionOf(promoted, 'parent-active'), 'working', 'an active nested worker makes an idle parent read as working');
    assert.equal(sectionOf(promoted, 'parent-mixed'), 'working', 'a starting worker alongside a failed one still reads as working');
    assert.equal(sectionOf(promoted, 'parent-errored'), 'needs input', 'needs input still wins over a live worker');

    const rejected = (await run([settled, stale, expired, preFinish], { rows: 40 })).frames[0];
    assert.equal(sectionOf(rejected, 'parent-settled'), 'completed', 'all workers settled returns the card to its parent state');
    assert.equal(sectionOf(rejected, 'parent-stale'), 'completed', 'stale snapshots never mark a parent working');
    assert.equal(sectionOf(rejected, 'parent-expired'), 'completed', 'an expired snapshot never marks a parent working');
    assert.equal(sectionOf(rejected, 'parent-prefinish'), 'completed', 'a snapshot older than finishedAt never marks a parent working');

    // Transition: the same parent settles on the next poll.
    const settledLater = coordinator('parent-active', [
      { id: 'w1', name: 'live-worker', state: 'stopped', startedAt: at(-60 * SECOND), settledAt: at(-5 * SECOND) },
      { id: 'w2', name: 'done-worker', state: 'idle', startedAt: at(-5 * MINUTE), settledAt: at(-1 * MINUTE) },
    ], { workersRevision: 8 });
    const transition = await run([active], { rows: 24, reloadTasks: [settledLater] });
    assert.equal(sectionOf(transition.frames[0], 'parent-active'), 'working');
    assert.equal(sectionOf(transition.frames.at(-1), 'parent-active'), 'completed', 'the card returns to its parent state once workers settle');
    for (const frame of transition.frames) {
      assert.ok(!frame.status.includes('Full output'), 'worker state updates without entering ^F');
    }
  }

  // 5. Live worker updates land without ^F and without touching stored state.
  {
    const before = coordinator('coord-live', [
      { id: 'w1', name: 'live-one', state: 'starting', activity: 'Starting worker', startedAt: at(-10 * SECOND) },
    ], { status: 'running', finishedAt: undefined });
    const after = coordinator('coord-live', [
      { id: 'w1', name: 'live-one', state: 'working', activity: 'Working on assigned task', startedAt: at(-10 * SECOND) },
      { id: 'w2', name: 'live-two', state: 'working', activity: 'Working on assigned task', startedAt: at(-2 * SECOND) },
    ], { status: 'running', finishedAt: undefined, workersRevision: 9 });
    const { frames } = await run([before], { rows: 24, reloadTasks: [after] });
    const first = frames[0].lines.map(stripAnsi).join('\n');
    const last = frames.at(-1).lines.map(stripAnsi).join('\n');
    assert.ok(first.includes('Starting worker') && !first.includes('live-two'));
    assert.ok(last.includes('live-two') && last.includes('Working on assigned task'), 'new worker state appears on the next poll');
    for (const frame of frames) assert.ok(!frame.status.includes('Full output'), 'no ^F needed for live worker updates');
  }

  // 6. Navigation: worker rows are display only and never become selectable.
  {
    const alpha = coordinator('nav-alpha', [{ id: 'w1', name: 'nav-worker-a', state: 'working', startedAt: at(-30 * SECOND) }], { status: 'running', finishedAt: undefined });
    const beta = coordinator('nav-beta', [{ id: 'w1', name: 'nav-worker-b', state: 'working', startedAt: at(-30 * SECOND) }], { status: 'running', finishedAt: undefined });
    const { frames } = await run([alpha, beta, legacyTask], { events: 'down,down,up,ctrlW,ctrlW', rows: 24 });
    for (const frame of frames) {
      assert.ok(['nav-alpha', 'nav-beta', 'legacy-run'].includes(frame.selectedTask), `selection landed on a worker row: ${frame.selectedTask}`);
    }
    const names = frames.map((frame) => frame.selectedTask);
    assert.ok(new Set(names).size > 1, 'arrow keys still move between task cards');
    assert.ok(frames.at(-2).status.includes('Workers expanded'), '^W reports its state');
    assert.ok(!frames.at(-1).status.includes('Workers expanded'), '^W toggles back');

    // ^W with a non-empty input buffer must not toggle; it belongs to the editor.
    const typing = await run([alpha, beta], { events: 'text:hello,ctrlW', rows: 24 });
    assert.ok(!typing.frames.at(-1).status.includes('Workers expanded'), '^W does not toggle while typing');
  }

  // 7. ^F full view does bounded work per keystroke on large stored output.
  {
    const bigText = Array.from({ length: 6000 }, (_, index) => `stored output line ${index} with some unicode: café ✓ 日本語`).join('\n');
    const big = { id: 'big-1', name: 'big-output', cwd: '/home/kyle', status: 'complete', text: bigText, finishedAt: at(-5 * MINUTE), updatedAt: at(-5 * MINUTE) };
    const rows = 24;
    // Paging happens before typing: PgUp/PgDn belong to the viewport only
    // while the input buffer is empty.
    const { frames, height } = await run([big], { events: 'ctrlF,pageUp,pageDown,text:a,text:b,text:c', rows, cols: 100 });
    assert.equal(height, rows);
    const [, entered, pagedUp, pagedDown, typedA, typedB, typedC] = frames;
    assert.ok(entered.status.includes('Full output'), '^F enters the full view');

    // Bounded work: every frame is exactly one terminal-sized viewport, never
    // the whole stored output.
    for (const frame of frames) {
      assert.equal(frame.lines.length, rows, 'the full view renders exactly one terminal-sized viewport, not the whole transcript');
      for (const line of frame.lines) assert.ok(visibleWidth(line) <= 100, 'full view lines respect the terminal width');
    }

    // Paging scrolls the viewport and returns to the newest output.
    assert.notDeepEqual(pagedUp.lines, entered.lines, 'PageUp scrolls the output viewport');
    assert.deepEqual(pagedDown.lines, entered.lines, 'PageDown returns to the newest output');

    // Typing must not reload, rewrap, or redraw any stored-output line. Only
    // the footer input row may differ between consecutive typing frames.
    for (const [previous, next] of [[typedA, typedB], [typedB, typedC]]) {
      const differing = previous.lines.map((line, index) => (line === next.lines[index] ? -1 : index)).filter((index) => index >= 0);
      assert.deepEqual(differing, [rows - 2], `typing redrew ${differing.length} lines instead of only the input row`);
    }

    // Unicode content still renders and still fits.
    const rendered = typedC.lines.map(stripAnsi).join('\n');
    assert.ok(rendered.includes('café') && rendered.includes('日本語'), 'unicode content still renders in the viewport');
  }

  // 8. Narrow/resized terminal in the full view stays bounded too.
  {
    const bigText = Array.from({ length: 2000 }, (_, index) => `line ${index} 日本語テキストのとても長い行 ${'x'.repeat(40)}`).join('\n');
    const big = { id: 'big-2', name: 'big-narrow', cwd: '/home/kyle', status: 'complete', text: bigText, finishedAt: at(-5 * MINUTE), updatedAt: at(-5 * MINUTE) };
    for (const cols of [48, 72]) {
      const { frames } = await run([big], { events: 'ctrlF,text:x', rows: 18, cols });
      const frame = frames.at(-1);
      assert.equal(frame.lines.length, 18, `full view stays one viewport tall at ${cols} columns`);
      for (const line of frame.lines) assert.ok(visibleWidth(line) <= cols, `full view line exceeds ${cols} columns`);
    }
  }

  console.log('mi coordinator worker view tests passed');
} finally {
  await rm(root, { recursive: true, force: true });
}
