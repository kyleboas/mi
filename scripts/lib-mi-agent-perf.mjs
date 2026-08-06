export const CPU_REGRESSION_RATIO = 1.3;

export function median(values) {
  if (!Array.isArray(values) || values.length === 0 || values.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new Error('Mi agent performance samples must be non-negative numbers.');
  }
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

export function performanceFailures(baseline, metrics) {
  const failures = [];
  for (const [name, metric] of Object.entries(metrics)) {
    const wallBudget = baseline.wallBudgets?.[name];
    const cpuBaseline = baseline.cpuMetrics?.[name];
    if (!Number.isFinite(metric?.wallMs) || !Number.isFinite(metric?.cpuMs)) {
      failures.push(`${name} did not report finite wall and CPU measurements`);
      continue;
    }
    if (wallBudget !== undefined && metric.wallMs > wallBudget) {
      failures.push(`${name} ${metric.wallMs}ms exceeded the ${wallBudget}ms wall-clock smoke ceiling`);
    }
    if (cpuBaseline !== undefined && metric.cpuMs > Math.ceil(cpuBaseline * CPU_REGRESSION_RATIO)) {
      failures.push(`${name} ${metric.cpuMs}ms CPU regressed >30% from baseline ${cpuBaseline}ms`);
    }
  }
  return failures;
}
