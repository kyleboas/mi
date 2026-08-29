import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { runTacticsJournalMonitor } = await import('../dist/src/tactics-journal-monitor.js');
const root = await mkdtemp(join(tmpdir(), 'mi-tj-monitor-'));
try {
  process.env.MI_TACTICS_JOURNAL_MONITOR_INTERVAL_MS = '60000';
  const statePath = join(root, 'state.json');
  const notifications = [];
  const payloads = {
    'https://tacticsjournal.com/api/health': { ok: true },
    'https://board.tacticsjournal.com/': '<!doctype html><title>Board</title>',
    'https://tacticsjournal.com/api/community/me': { authenticated: false, access_enabled: true, applications_enabled: true },
    'https://tacticsjournal.com/api/ama/active': { event: null },
  };
  const fetchFn = async (url) => Response.json(payloads[url] ?? {}, { status: url === 'https://board.tacticsjournal.com/' ? 200 : 200, headers: { 'content-type': url === 'https://board.tacticsjournal.com/' ? 'text/html' : 'application/json' } });
  const notify = async (title, message, options) => { notifications.push({ title, message, options }); return { ok: true, status: 200 }; };
  const first = await runTacticsJournalMonitor({ statePath, now: new Date('2026-08-29T10:00:00Z'), fetchFn, notify });
  assert.equal(first.status, 'ok');
  assert.equal(notifications.length, 0, 'healthy baseline is silent');
  assert.equal((await stat(statePath)).mode & 0o777, 0o600, 'state is private');
  const skipped = await runTacticsJournalMonitor({ statePath, now: new Date('2026-08-29T10:00:30Z'), fetchFn, notify });
  assert.equal(skipped.status, 'skipped');
  const failingFetch = async (url) => url.includes('board') ? new Response('broken', { status: 503 }) : fetchFn(url);
  const failed = await runTacticsJournalMonitor({ statePath, now: new Date('2026-08-29T10:01:00Z'), fetchFn: failingFetch, notify });
  assert.equal(failed.status, 'notified');
  assert.match(notifications[0].message, /Board/);
  assert.match(notifications[0].message, /read-only checks/);
  const recovered = await runTacticsJournalMonitor({ statePath, now: new Date('2026-08-29T10:02:00Z'), fetchFn, notify });
  assert.equal(recovered.status, 'notified');
  assert.match(notifications.at(-1).message, /healthy again/);
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(state.availability, 'healthy');
  console.log('Mi Tactics Journal monitor checks passed.');
} finally { await rm(root, { recursive: true, force: true }); }
