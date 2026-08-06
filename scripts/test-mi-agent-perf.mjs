#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { median, performanceFailures } from './lib-mi-agent-perf.mjs';

const repo = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const root = await mkdtemp(join(tmpdir(), 'mi-agent-perf-'));
const baselinePath = join(repo, 'scripts', 'perf-baseline.json');
const SAMPLE_COUNT = 3;
const CHILD_TIMEOUT_MS = 15_000;
const cpuMarker = 'MI_AGENT_PERF_CPU_USAGE=';

function iso(offsetMs = 0) {
  return new Date(Date.UTC(2026, 0, 1, 0, 0, 0) + offsetMs).toISOString();
}

function tasks(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `perf-${count}-${index}`,
    name: `perf-task-${String(index).padStart(3, '0')}`,
    status: index % 3 === 0 ? 'paused' : index % 3 === 1 ? 'running' : 'complete',
    needsUser: index % 3 === 0,
    needsUserReason: index % 3 === 0 ? 'needs input' : undefined,
    progress: `working ${index} ${'x'.repeat(80)}`,
    text: index % 3 === 2 ? `completed ${index}` : undefined,
    startedAt: iso(index * 1000),
    updatedAt: iso(index * 1000),
    finishedAt: index % 3 === 2 ? iso(index * 1000 + 500) : undefined,
  }));
}

function cpuMsFromStderr(stderr) {
  const matches = [...stderr.matchAll(new RegExp(`^${cpuMarker}(.+)$`, 'gm'))];
  assert.equal(matches.length, 1, `Mi agent CPU probe did not report exactly once: ${stderr}`);
  const usage = JSON.parse(matches[0][1]);
  assert.ok(Number.isFinite(usage.user) && Number.isFinite(usage.system), 'Mi agent CPU probe reported invalid usage');
  return Math.round((usage.user + usage.system) / 1000);
}

async function renderSample(probeUrl, name, taskCount, { rows = 40, cols = 120, events = '' } = {}) {
  const tasksPath = join(root, `${name}.json`);
  await writeFile(tasksPath, JSON.stringify(tasks(taskCount), null, 2));
  const started = performance.now();
  const result = spawnSync(process.execPath, ['--import', probeUrl, 'dist/src/cli.js', 'agents'], {
    cwd: repo,
    env: {
      ...process.env,
      HOME: root,
      MI_AGENT_RENDER_TEST: '1',
      MI_AGENT_RENDER_TEST_TASKS: tasksPath,
      MI_AGENT_RENDER_TEST_EVENTS: events,
      MI_AGENT_RENDER_TEST_ROWS: String(rows),
      MI_AGENT_RENDER_TEST_COLS: String(cols),
      MI_AGENT_RENDER_TEST_NOW: iso(120000),
    },
    encoding: 'utf8',
    timeout: CHILD_TIMEOUT_MS,
  });
  const wallMs = Math.round(performance.now() - started);
  assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
  const snapshot = JSON.parse(result.stdout);
  assert.equal(snapshot.width, cols);
  assert.equal(snapshot.height, rows);
  return { wallMs, cpuMs: cpuMsFromStderr(result.stderr) };
}

async function samplesFor(probeUrl, name, taskCount, options) {
  const samples = [];
  for (let index = 0; index < SAMPLE_COUNT; index += 1) {
    samples.push(await renderSample(probeUrl, `${name}-${index}`, taskCount, options));
  }
  return {
    cpuMs: median(samples.map((sample) => sample.cpuMs)),
    // A single slow child can mean a hang or an unavailable runtime. Keep the
    // firm wall-clock ceiling for every child, while CPU median isolates work.
    wallMs: Math.max(...samples.map((sample) => sample.wallMs)),
    samples,
  };
}

try {
  const baseline = JSON.parse(await readFile(baselinePath, 'utf8'));
  const probePath = join(root, 'cpu-probe.mjs');
  await writeFile(probePath, [
    "import process from 'node:process';",
    'const started = process.cpuUsage();',
    "process.on('exit', () => {",
    '  const usage = process.cpuUsage(started);',
    `  process.stderr.write(${JSON.stringify(cpuMarker)} + JSON.stringify(usage) + '\\n');`,
    '});',
  ].join('\n'));
  const probeUrl = pathToFileURL(probePath).href;

  // Warm file and module caches once. The three measured child processes still
  // include normal process startup, and their median avoids one scheduler pause.
  const warmup = await renderSample(probeUrl, 'warmup', 8, { rows: 40, cols: 120 });
  const warmupBudget = baseline.wallBudgets?.coldRender8;

  const metrics = {
    coldRender8: await samplesFor(probeUrl, 'cold-8', 8, { rows: 40, cols: 120 }),
    render200: await samplesFor(probeUrl, 'render-200', 200, { rows: 40, cols: 120, events: 'pageDown,pageDown,pageUp' }),
    hostile40x10: await samplesFor(probeUrl, 'hostile-40x10', 25, { rows: 10, cols: 40, events: 'pageDown' }),
  };
  const failures = [
    ...(warmupBudget !== undefined && warmup.wallMs > warmupBudget
      ? [`warmup ${warmup.wallMs}ms exceeded the ${warmupBudget}ms wall-clock smoke ceiling`]
      : []),
    ...performanceFailures(baseline, metrics),
  ];
  console.log(JSON.stringify({ ok: failures.length === 0, metrics, warmup }, null, 2));
  assert.equal(failures.length, 0, `Mi agent perf budget failures:\n${failures.join('\n')}`);
} finally {
  await rm(root, { recursive: true, force: true });
}
