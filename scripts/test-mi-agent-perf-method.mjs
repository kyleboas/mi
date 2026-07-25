#!/usr/bin/env node
import assert from 'node:assert/strict';
import { median, performanceFailures } from './lib-mi-agent-perf.mjs';

const baseline = {
  cpuMetrics: { render: 100 },
  wallBudgets: { render: 1000 },
};

assert.equal(median([180, 100, 140]), 140, 'the middle CPU sample is used');

// A scheduler pause increases elapsed time but does not consume child CPU.
// It stays below the firm wall smoke ceiling and must not look like a render
// regression merely because the process had to wait for the host CPU.
const injectedSchedulerDelay = performanceFailures(baseline, {
  render: { cpuMs: 100, wallMs: 900 },
});
assert.deepEqual(injectedSchedulerDelay, [], 'injected scheduler delay does not fail the CPU regression check');

const injectedCpuRegression = performanceFailures(baseline, {
  render: { cpuMs: 131, wallMs: 200 },
});
assert.equal(injectedCpuRegression.length, 1, 'a synthetic CPU regression fails');
assert.match(injectedCpuRegression[0], /CPU regressed >30%/);

const hangSmokeFailure = performanceFailures(baseline, {
  render: { cpuMs: 100, wallMs: 1001 },
});
assert.equal(hangSmokeFailure.length, 1, 'the firm wall-clock smoke ceiling remains active');
assert.match(hangSmokeFailure[0], /wall-clock smoke ceiling/);

console.log('Mi agent performance methodology checks passed.');
