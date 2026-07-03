#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHermeticMiEnv } from './mi-test-harness.mjs';

const fixture = await createHermeticMiEnv('mi-incidents-');
process.chdir(fixture.root);
try {
  await mkdir(join(fixture.root, 'state'), { recursive: true });
  const { appendIncident, readIncidents, recurringIncidentReady, markIncidentIssueFiled } = await import('../dist/src/incidents.js');
  await appendIncident({ fingerprint: 'daemon-stale', source: 'watchdog', summary: 'daemon stale', severity: 'critical', ts: '2026-07-01T00:00:00.000Z' });
  await appendIncident({ fingerprint: 'daemon-stale', source: 'watchdog', summary: 'daemon stale again', severity: 'critical', ts: '2026-07-02T00:00:00.000Z' });
  assert.equal(recurringIncidentReady(await readIncidents(), 'daemon-stale', new Date('2026-07-03T00:00:00.000Z')), false);
  await appendIncident({ fingerprint: 'daemon-stale', source: 'watchdog', summary: 'daemon stale third time', severity: 'critical', ts: '2026-07-03T00:00:00.000Z' });
  assert.equal(recurringIncidentReady(await readIncidents(), 'daemon-stale', new Date('2026-07-03T00:00:00.000Z')), true);
  await markIncidentIssueFiled('daemon-stale', 'https://github.com/kyleboas/mi/issues/1');
  assert.equal(recurringIncidentReady(await readIncidents(), 'daemon-stale', new Date('2026-07-03T00:00:00.000Z')), false);
  const text = await readFile(join(fixture.root, 'state', 'incidents.jsonl'), 'utf8');
  assert.match(text, /"issueFiled":true/);
} finally {
  await fixture.cleanup();
}
console.log('Mi incident journal checks passed.');
