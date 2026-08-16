import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { runBudgetGuardMonitor } = await import('../dist/src/budget-guard-monitor.js');

function status({ spent = 0.4, limit = 1, enabled = true, healthy = true, reason = null } = {}) {
  return {
    currentDay: '2026-08-16',
    enabled,
    mode: enabled ? 'normal' : 'emergency_stop',
    spentUsd: spent,
    dailyLimitUsd: limit,
    hardStopReason: enabled ? null : reason || 'daily limit reached',
    sync: { healthy, reason: healthy ? null : reason || 'analytics stale' },
  };
}

function response(payload, responseStatus = 200) {
  return async () => Response.json(payload, { status: responseStatus });
}

const root = await mkdtemp(join(tmpdir(), 'mi-budget-guard-'));
try {
  process.env.MI_BUDGET_GUARD_IMESSAGE_NOTIFY = 'true';
  process.env.MI_BUDGET_GUARD_MONITOR_INTERVAL_MS = '60000';
  const statePath = join(root, 'state.json');
  const sends = [];
  const notify = async (title, message, options) => {
    sends.push({ title, message, options });
    return { ok: true, status: 200 };
  };

  const baseline = await runBudgetGuardMonitor({
    statePath,
    now: new Date('2026-08-16T10:00:00Z'),
    fetchFn: response(status({ spent: 0.4 })),
    notify,
  });
  assert.equal(baseline.status, 'ok');
  assert.equal(sends.length, 0, 'a healthy first observation stays silent');
  assert.equal((await stat(statePath)).mode & 0o777, 0o600, 'monitor state is private');

  const threshold = await runBudgetGuardMonitor({
    statePath,
    now: new Date('2026-08-16T10:01:00Z'),
    fetchFn: response(status({ spent: 0.6 })),
    notify,
  });
  assert.equal(threshold.status, 'notified');
  assert.equal(sends.length, 1);
  assert.match(sends[0].message, /reached 50%/);
  assert.equal(sends[0].options.requireEnabled, false, 'Budget Guard iMessage does not depend on general proactive notifications');

  const stopped = await runBudgetGuardMonitor({
    statePath,
    now: new Date('2026-08-16T10:02:00Z'),
    fetchFn: response(status({ spent: 1.01, enabled: false, reason: 'tracked spend reached the limit' })),
    notify,
  });
  assert.equal(stopped.status, 'notified');
  assert.match(sends.at(-1).message, /stopped expensive work/);
  assert.doesNotMatch(sends.at(-1).message, /reached 90%/, 'a hard stop sends one actionable message instead of threshold spam');

  await runBudgetGuardMonitor({
    statePath,
    now: new Date('2026-08-16T10:03:00Z'),
    fetchFn: response(status({ spent: 1.01, enabled: false, reason: 'tracked spend reached the limit' })),
    notify,
  });
  assert.equal(sends.length, 2, 'unchanged stopped state does not resend');

  const unavailablePath = join(root, 'unavailable.json');
  const unavailableSends = [];
  const unavailableNotify = async (_title, message) => { unavailableSends.push(message); return { ok: true }; };
  const offline = async () => { throw new Error('offline'); };
  const firstOffline = await runBudgetGuardMonitor({ statePath: unavailablePath, now: new Date('2026-08-16T11:00:00Z'), fetchFn: offline, notify: unavailableNotify });
  assert.equal(firstOffline.status, 'notified');
  assert.match(unavailableSends[0], /stopped fail-closed/);
  const secondOffline = await runBudgetGuardMonitor({ statePath: unavailablePath, now: new Date('2026-08-16T11:01:00Z'), fetchFn: offline, notify: unavailableNotify });
  assert.equal(secondOffline.status, 'ok');
  assert.equal(unavailableSends.length, 1, 'repeated outage is deduplicated');

  const recovered = await runBudgetGuardMonitor({ statePath: unavailablePath, now: new Date('2026-08-16T11:02:00Z'), fetchFn: response(status()), notify: unavailableNotify });
  assert.equal(recovered.status, 'notified');
  assert.match(unavailableSends.at(-1), /healthy again/);

  const state = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(state.availability, 'available');
  console.log('Mi Budget Guard iMessage monitor checks passed.');
} finally {
  await rm(root, { recursive: true, force: true });
}
