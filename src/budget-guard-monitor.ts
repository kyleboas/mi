import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { notifyImessage } from './notify.js';

const DEFAULT_STATUS_URL = 'https://budget-guard.heyboas.workers.dev/status';
const DEFAULT_INTERVAL_MS = 15 * 60 * 1000;
const MAX_STATE_BYTES = 16 * 1024;
const THRESHOLDS = [0.5, 0.75, 0.9];

type BudgetSnapshot = {
  day: string;
  enabled: boolean;
  mode: string;
  spentUsd: number;
  dailyLimitUsd: number;
  hardStopReason: string | null;
  syncHealthy: boolean;
  syncReason: string | null;
};

type MonitorState = BudgetSnapshot & {
  version: 1;
  availability: 'available' | 'unavailable';
  checkedAt: string;
  notifiedThresholds: number[];
};

type NotifyResult = { ok?: boolean; skipped?: boolean; status?: number };

type MonitorDependencies = {
  now?: Date;
  statePath?: string;
  fetchFn?: typeof fetch;
  notify?: (title: string, message: string, options?: { requireEnabled?: boolean }) => Promise<NotifyResult>;
};

export type BudgetGuardMonitorResult = {
  status: 'ok' | 'notified' | 'skipped' | 'error';
  notifications?: number;
  reason?: string;
};

function enabled() {
  return !/^(0|false|no|off)$/i.test(String(process.env.MI_BUDGET_GUARD_IMESSAGE_NOTIFY ?? 'true').trim());
}

function intervalMs() {
  const value = Number(process.env.MI_BUDGET_GUARD_MONITOR_INTERVAL_MS || DEFAULT_INTERVAL_MS);
  return Number.isSafeInteger(value) && value >= 60_000 ? value : DEFAULT_INTERVAL_MS;
}

function defaultStatePath() {
  const root = process.env.MI_ROOT || join(homedir(), 'assistant');
  return resolve(root, 'state', 'budget-guard-monitor-state.json');
}

function finiteNumber(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : Number.NaN;
}

function boundedText(value: unknown, limit = 500) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function parseSnapshot(payload: unknown, now: Date): BudgetSnapshot {
  if (!payload || typeof payload !== 'object') throw new Error('malformed status response');
  const value = payload as Record<string, unknown>;
  const sync = value.sync && typeof value.sync === 'object' ? value.sync as Record<string, unknown> : {};
  const spentUsd = finiteNumber(value.spentUsd);
  const dailyLimitUsd = finiteNumber(value.dailyLimitUsd);
  if (typeof value.enabled !== 'boolean' || !Number.isFinite(spentUsd) || !(dailyLimitUsd > 0) || typeof sync.healthy !== 'boolean') {
    throw new Error('incomplete status response');
  }
  return {
    day: typeof value.currentDay === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.currentDay)
      ? value.currentDay
      : now.toISOString().slice(0, 10),
    enabled: value.enabled,
    mode: boundedText(value.mode, 50) || 'unknown',
    spentUsd,
    dailyLimitUsd,
    hardStopReason: boundedText(value.hardStopReason) || null,
    syncHealthy: sync.healthy,
    syncReason: boundedText(sync.reason) || null,
  };
}

async function readState(path: string): Promise<MonitorState | null> {
  try {
    const text = await readFile(path, 'utf8');
    if (Buffer.byteLength(text) > MAX_STATE_BYTES) return null;
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== 'object' || (value as MonitorState).version !== 1) return null;
    return value as MonitorState;
  } catch {
    return null;
  }
}

async function writeState(path: string, state: MonitorState) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600, flag: 'wx' });
  await rename(temporary, path);
}

function due(previous: MonitorState | null, now: Date) {
  if (!previous?.checkedAt) return true;
  const checkedAt = Date.parse(previous.checkedAt);
  return !Number.isFinite(checkedAt) || now.getTime() - checkedAt >= intervalMs();
}

function money(value: number) {
  return `$${value.toFixed(value >= 1 ? 2 : 4)}`;
}

function notificationMessages(previous: MonitorState | null, current: BudgetSnapshot) {
  const messages: string[] = [];
  const recoveredAvailability = previous?.availability === 'unavailable';
  const syncDegraded = !current.syncHealthy && (!previous || previous.syncHealthy || recoveredAvailability);
  const syncRecovered = current.syncHealthy && previous?.syncHealthy === false;
  const stopped = !current.enabled && (!previous || previous.enabled || recoveredAvailability);
  const resumed = current.enabled && previous?.enabled === false;

  if (stopped) {
    messages.push(`Budget Guard stopped expensive work at ${money(current.spentUsd)} of ${money(current.dailyLimitUsd)} today. ${current.hardStopReason || 'The daily limit was reached.'}`);
  } else if (syncDegraded) {
    messages.push(`Budget Guard tracking is unhealthy, so expensive work is stopped fail-closed. ${current.syncReason || 'Usage synchronization needs attention.'}`);
  } else {
    if (recoveredAvailability || syncRecovered) messages.push(`Budget Guard tracking is healthy again. Expensive work is ${current.enabled ? 'allowed' : 'still stopped'}.`);
    if (resumed) messages.push(`Budget Guard resumed expensive work. Today is at ${money(current.spentUsd)} of ${money(current.dailyLimitUsd)}.`);
  }

  if (current.enabled && current.syncHealthy) {
    const previousPercent = !previous
      ? current.spentUsd / current.dailyLimitUsd
      : previous.day === current.day && previous.dailyLimitUsd > 0
        ? previous.spentUsd / previous.dailyLimitUsd
        : 0;
    const currentPercent = current.spentUsd / current.dailyLimitUsd;
    for (const threshold of THRESHOLDS) {
      if (previousPercent < threshold && currentPercent >= threshold) {
        messages.push(`Budget Guard reached ${Math.round(threshold * 100)}%: ${money(current.spentUsd)} of ${money(current.dailyLimitUsd)} today.`);
      }
    }
  }
  return messages;
}

async function sendMessages(messages: string[], notify: NonNullable<MonitorDependencies['notify']>) {
  for (const message of messages) {
    const result = await notify('Budget Guard', message, { requireEnabled: false });
    if (result.ok !== true) throw new Error(`iMessage notification failed${result.status ? ` with HTTP ${result.status}` : ''}`);
  }
}

export async function runBudgetGuardMonitor(dependencies: MonitorDependencies = {}): Promise<BudgetGuardMonitorResult> {
  if (!enabled()) return { status: 'skipped', reason: 'disabled' };
  const now = dependencies.now || new Date();
  const statePath = dependencies.statePath || defaultStatePath();
  const previous = await readState(statePath);
  if (!due(previous, now)) return { status: 'skipped', reason: 'interval' };

  const fetchFn = dependencies.fetchFn || fetch;
  const notify = dependencies.notify || notifyImessage;
  let current: BudgetSnapshot;
  try {
    const response = await fetchFn(process.env.MI_BUDGET_GUARD_STATUS_URL || DEFAULT_STATUS_URL, {
      headers: { accept: 'application/json', 'user-agent': 'mi-budget-guard-monitor/1.0' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    current = parseSnapshot(await response.json(), now);
  } catch (error) {
    const reason = boundedText(error instanceof Error ? error.message : error) || 'unknown error';
    if (previous?.availability !== 'unavailable') {
      try {
        await sendMessages([
          `Budget Guard is unavailable, so expensive work is stopped fail-closed. ${reason}`,
        ], notify);
      } catch (notifyError) {
        return { status: 'error', reason: boundedText(notifyError instanceof Error ? notifyError.message : notifyError) };
      }
    }
    const unavailableState: MonitorState = previous
      ? { ...previous, availability: 'unavailable', checkedAt: now.toISOString() }
      : {
        version: 1,
        day: now.toISOString().slice(0, 10),
        enabled: true,
        mode: 'unknown',
        spentUsd: 0,
        dailyLimitUsd: 1,
        hardStopReason: null,
        syncHealthy: true,
        syncReason: null,
        availability: 'unavailable',
        checkedAt: now.toISOString(),
        notifiedThresholds: [],
      };
    await writeState(statePath, unavailableState);
    return { status: previous?.availability === 'unavailable' ? 'ok' : 'notified', notifications: previous?.availability === 'unavailable' ? 0 : 1, reason };
  }

  const messages = notificationMessages(previous, current);
  try {
    await sendMessages(messages, notify);
  } catch (error) {
    return { status: 'error', reason: boundedText(error instanceof Error ? error.message : error) };
  }
  const notifiedThresholds = THRESHOLDS.filter((threshold) => current.spentUsd / current.dailyLimitUsd >= threshold);
  await writeState(statePath, {
    version: 1,
    ...current,
    availability: 'available',
    checkedAt: now.toISOString(),
    notifiedThresholds,
  });
  return { status: messages.length ? 'notified' : 'ok', notifications: messages.length };
}
