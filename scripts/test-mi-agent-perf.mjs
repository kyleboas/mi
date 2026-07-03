#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';

const repo = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const root = await mkdtemp(join(tmpdir(), 'mi-agent-perf-'));
const baselinePath = join(repo, 'scripts', 'perf-baseline.json');

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

async function renderWallMs(name, taskCount, { rows = 40, cols = 120, events = '' } = {}) {
  const tasksPath = join(root, `${name}.json`);
  await writeFile(tasksPath, JSON.stringify(tasks(taskCount), null, 2));
  const started = performance.now();
  const result = spawnSync(process.execPath, ['dist/src/cli.js', 'agents'], {
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
    timeout: 30000,
  });
  const elapsed = performance.now() - started;
  assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
  const snapshot = JSON.parse(result.stdout);
  assert.equal(snapshot.width, cols);
  assert.equal(snapshot.height, rows);
  return Math.round(elapsed);
}

try {
  const baseline = JSON.parse(await readFile(baselinePath, 'utf8'));
  const metrics = {
    coldRender8WallMs: await renderWallMs('cold-8', 8, { rows: 40, cols: 120 }),
    render200WallMs: await renderWallMs('render-200', 200, { rows: 40, cols: 120, events: 'pageDown,pageDown,pageUp' }),
    hostile40x10WallMs: await renderWallMs('hostile-40x10', 25, { rows: 10, cols: 40, events: 'pageDown' }),
  };

  const failures = [];
  for (const [key, value] of Object.entries(metrics)) {
    const budget = baseline.budgets?.[key];
    const previous = baseline.metrics?.[key];
    if (budget !== undefined && value > budget) failures.push(`${key} ${value}ms > budget ${budget}ms`);
    if (previous !== undefined && value > Math.ceil(previous * 1.3)) failures.push(`${key} ${value}ms regressed >30% from baseline ${previous}ms`);
  }
  assert.equal(failures.length, 0, `Mi agent perf budget failures:\n${failures.join('\n')}\nmetrics=${JSON.stringify(metrics)}`);
  console.log(JSON.stringify({ ok: true, metrics }, null, 2));
} finally {
  await rm(root, { recursive: true, force: true });
}
