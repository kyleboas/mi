import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { notifyImessage } from './notify.js';

const DEFAULT_INTERVAL_MS = 15 * 60 * 1000;
const MAX_STATE_BYTES = 24 * 1024;

export type TacticsJournalCheckName = 'site' | 'board' | 'community' | 'ama';
export type TacticsJournalCheck = { ok: boolean; detail: string };
type CheckMap = Record<TacticsJournalCheckName, TacticsJournalCheck>;
type MonitorState = {
  version: 1;
  checkedAt: string;
  availability: 'healthy' | 'degraded';
  checks: CheckMap;
};
type NotifyResult = { ok?: boolean; skipped?: boolean; status?: number };
type MonitorDependencies = {
  now?: Date;
  statePath?: string;
  fetchFn?: typeof fetch;
  notify?: (title: string, message: string, options?: { requireEnabled?: boolean }) => Promise<NotifyResult>;
};
export type TacticsJournalMonitorResult = {
  status: 'ok' | 'notified' | 'skipped' | 'error';
  availability?: 'healthy' | 'degraded';
  notifications?: number;
  checks?: CheckMap;
  reason?: string;
};

function enabled() {
  return !/^(0|false|no|off)$/i.test(String(process.env.MI_TACTICS_JOURNAL_MONITOR_ENABLED ?? 'true').trim());
}

function intervalMs() {
  const value = Number(process.env.MI_TACTICS_JOURNAL_MONITOR_INTERVAL_MS || DEFAULT_INTERVAL_MS);
  return Number.isSafeInteger(value) && value >= 60_000 ? value : DEFAULT_INTERVAL_MS;
}

function defaultStatePath() {
  const root = process.env.MI_ROOT || join(homedir(), 'assistant');
  return resolve(root, 'state', 'tactics-journal-monitor-state.json');
}

function boundedText(value: unknown, limit = 240) {
  return String(value || '')
    .replace(/https?:\/\/\S+/gi, '[endpoint]')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit);
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

async function get(fetchFn: typeof fetch, url: string, accept: string) {
  return fetchFn(url, {
    headers: { accept, 'user-agent': 'mi-tactics-journal-monitor/1.0' },
    signal: AbortSignal.timeout(10_000),
  });
}

async function checkSite(fetchFn: typeof fetch): Promise<TacticsJournalCheck> {
  const response = await get(fetchFn, process.env.MI_TACTICS_JOURNAL_HEALTH_URL || 'https://tacticsjournal.com/api/health', 'application/json');
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const payload = await response.json() as Record<string, unknown>;
  if (payload.ok !== true) throw new Error('health API did not report ok');
  return { ok: true, detail: 'health API ok' };
}

async function checkBoard(fetchFn: typeof fetch): Promise<TacticsJournalCheck> {
  const response = await get(fetchFn, process.env.MI_TACTICS_JOURNAL_BOARD_URL || 'https://board.tacticsjournal.com/', 'text/html');
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const html = await response.text();
  if (!/<title>\s*Board\s*<\/title>/i.test(html)) throw new Error('Board shell marker missing');
  return { ok: true, detail: 'public Board shell loaded' };
}

async function checkCommunity(fetchFn: typeof fetch): Promise<TacticsJournalCheck> {
  const response = await get(fetchFn, process.env.MI_TACTICS_JOURNAL_COMMUNITY_URL || 'https://tacticsjournal.com/api/community/me', 'application/json');
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const payload = await response.json() as Record<string, unknown>;
  if (typeof payload.authenticated !== 'boolean' || typeof payload.access_enabled !== 'boolean') throw new Error('Community status response incomplete');
  if (payload.access_enabled !== true) throw new Error('Community access is disabled');
  return { ok: true, detail: payload.applications_enabled === true ? 'Community access and applications enabled' : 'Community access enabled; applications paused' };
}

async function checkAma(fetchFn: typeof fetch): Promise<TacticsJournalCheck> {
  const response = await get(fetchFn, process.env.MI_TACTICS_JOURNAL_AMA_URL || 'https://tacticsjournal.com/api/ama/active', 'application/json');
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const payload = await response.json() as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(payload, 'event')) throw new Error('AMA status response incomplete');
  return { ok: true, detail: payload.event ? 'AMA API returned an active event' : 'AMA API healthy; no active event' };
}

async function safeCheck(check: () => Promise<TacticsJournalCheck>): Promise<TacticsJournalCheck> {
  try {
    return await check();
  } catch (error) {
    return { ok: false, detail: boundedText(error instanceof Error ? error.message : error) || 'check failed' };
  }
}

function failedChecks(checks: CheckMap) {
  const labels: Record<TacticsJournalCheckName, string> = { site: 'Site', board: 'Board', community: 'Community', ama: 'AMA' };
  return (Object.entries(checks) as Array<[TacticsJournalCheckName, TacticsJournalCheck]>)
    .filter(([, check]) => !check.ok)
    .map(([name, check]) => `${labels[name]}: ${check.detail}`);
}

export async function runTacticsJournalMonitor(dependencies: MonitorDependencies = {}): Promise<TacticsJournalMonitorResult> {
  if (!enabled()) return { status: 'skipped', reason: 'disabled' };
  const now = dependencies.now || new Date();
  const statePath = dependencies.statePath || defaultStatePath();
  const previous = await readState(statePath);
  if (!due(previous, now)) return { status: 'skipped', reason: 'interval' };

  const fetchFn = dependencies.fetchFn || fetch;
  const notify = dependencies.notify || notifyImessage;
  const checks: CheckMap = {
    site: await safeCheck(() => checkSite(fetchFn)),
    board: await safeCheck(() => checkBoard(fetchFn)),
    community: await safeCheck(() => checkCommunity(fetchFn)),
    ama: await safeCheck(() => checkAma(fetchFn)),
  };
  const failures = failedChecks(checks);
  const availability = failures.length ? 'degraded' : 'healthy';
  let message = '';
  if (availability === 'degraded' && previous?.availability !== 'degraded') {
    message = `Tactics Journal needs attention. ${failures.join('; ')}. These are public read-only checks; signed-in workflows still need separate review.`;
  } else if (availability === 'healthy' && previous?.availability === 'degraded') {
    message = 'Tactics Journal public checks are healthy again: Board, Community, AMA, and site health.';
  }

  if (message) {
    try {
      const result = await notify('Tactics Journal', message, { requireEnabled: false });
      if (result.ok !== true) throw new Error(`iMessage notification failed${result.status ? ` with HTTP ${result.status}` : ''}`);
    } catch (error) {
      return { status: 'error', availability, checks, reason: boundedText(error instanceof Error ? error.message : error) };
    }
  }

  await writeState(statePath, { version: 1, checkedAt: now.toISOString(), availability, checks });
  return { status: message ? 'notified' : 'ok', availability, notifications: message ? 1 : 0, checks };
}
