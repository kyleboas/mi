import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeHealthSidecar, writeHealthSidecar } from '../dist/src/monitoring.js';

const docs = await readFile(new URL('../docs/monitoring.md', import.meta.url), 'utf8');
const registry = await readFile(new URL('../assistants/monitors.md', import.meta.url), 'utf8');

assert.match(docs, /Health sidecar contract[\s\S]*checked_at[\s\S]*status[\s\S]*reason/, 'monitoring docs define the health sidecar schema');
assert.match(docs, /writeHealthSidecar\(\)[\s\S]*src\/monitoring\.ts/, 'monitoring docs describe the writer helper');
assert.match(docs, /observe and persist state[\s\S]*worker-read[\s\S]*muted_pending_human/, 'monitoring docs describe the escalation ladder');
assert.match(registry, /allowed_auto_actions/, 'monitor registry documents allowed auto-actions');

const normalized = normalizeHealthSidecar({ step: 'detect', status: 'ok', counts: { candidates: 2 } }, new Date('2026-07-02T00:00:00.000Z'));
assert.deepEqual(normalized, {
  version: 1,
  checked_at: '2026-07-02T00:00:00.000Z',
  step: 'detect',
  status: 'ok',
  reason: 'ok',
  counts: { candidates: 2 },
});

const root = await mkdtemp(join(tmpdir(), 'mi-monitoring-'));
try {
  const path = join(root, '.logs', 'detect-latest-health.json');
  await writeHealthSidecar(path, { step: 'detect', status: 'error', error: 'x'.repeat(700), exit_code: 2 }, new Date('2026-07-02T01:00:00.000Z'));
  const info = await stat(path);
  assert.equal(info.mode & 0o777, 0o600, 'health sidecar is private');
  const payload = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(payload.checked_at, '2026-07-02T01:00:00.000Z');
  assert.equal(payload.reason, 'error');
  assert.equal(payload.error.length, 500, 'helper truncates error text');
  assert.equal(payload.exit_code, 2);
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log('Mi monitoring docs/helper checks passed.');
