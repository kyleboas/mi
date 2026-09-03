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
  let pendingAlerts = [];
  const acknowledgements = [];
  const fetchFn = async (url, init = {}) => {
    if (url === 'https://tacticsjournal.com/api/internal/imessage-alerts') {
      assert.equal(init.headers.authorization, 'Bearer local-test-secret');
      if (init.method === 'POST') {
        const ids = JSON.parse(init.body).ids;
        acknowledgements.push(...ids);
        pendingAlerts = pendingAlerts.filter((alert) => !ids.includes(alert.id));
        return Response.json({ ok: true, acknowledged: ids.length });
      }
      return Response.json({ alerts: pendingAlerts });
    }
    return Response.json(payloads[url] ?? {}, { status: 200, headers: { 'content-type': url === 'https://board.tacticsjournal.com/' ? 'text/html' : 'application/json' } });
  };
  const notify = async (title, message, options) => { notifications.push({ title, message, options }); return { ok: true, status: 200 }; };
  const first = await runTacticsJournalMonitor({ statePath, now: new Date('2026-08-29T10:00:00Z'), fetchFn, notify });
  assert.equal(first.status, 'ok');
  assert.equal(notifications.length, 0, 'healthy baseline is silent');
  assert.equal((await stat(statePath)).mode & 0o777, 0o600, 'state is private');
  process.env.MI_TACTICS_JOURNAL_ALERT_SECRET = 'local-test-secret';
  pendingAlerts = [{ id: 'alert-1', message: 'New AMA question for Guest One' }];
  const alert = await runTacticsJournalMonitor({ statePath, now: new Date('2026-08-29T10:00:30Z'), fetchFn, notify });
  assert.equal(alert.status, 'notified');
  assert.equal(alert.notifications, 1);
  assert.equal(notifications.at(-1).message, 'New AMA question for Guest One');
  assert.deepEqual(acknowledgements, ['alert-1']);
  const failingFetch = async (url, init) => url.includes('board') ? new Response('broken', { status: 503 }) : fetchFn(url, init);
  const failed = await runTacticsJournalMonitor({ statePath, now: new Date('2026-08-29T10:01:00Z'), fetchFn: failingFetch, notify });
  assert.equal(failed.status, 'notified');
  assert.match(notifications.at(-1).message, /Board/);
  assert.match(notifications.at(-1).message, /read-only checks/);
  const recovered = await runTacticsJournalMonitor({ statePath, now: new Date('2026-08-29T10:02:00Z'), fetchFn, notify });
  assert.equal(recovered.status, 'notified');
  assert.match(notifications.at(-1).message, /healthy again/);
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(state.availability, 'healthy');
  console.log('Mi Tactics Journal monitor checks passed.');
} finally {
  delete process.env.MI_TACTICS_JOURNAL_ALERT_SECRET;
  await rm(root, { recursive: true, force: true });
}
