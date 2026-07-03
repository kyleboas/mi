import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { cronPaths, readCrons } from './crons.js';
import { notify as sendNotification } from './notify.js';
import { logEvent, readApprovals } from './state.js';
import { appendThreadMessage } from './threads.js';
import { redactSecrets } from './redact.js';
import { projectQuestion } from './questions.js';
import { queuedProposals, readProposalQueue, renderNumberedProposals } from './proposals.js';

export type ProactiveNotice = {
  message: string;
  notify?: boolean;
  dedupeKey?: string;
  repairPrompt?: string;
  repairName?: string;
  suppressActionFooter?: boolean;
};

export type ProactiveCheck = {
  id: string;
  run: () => Promise<null | ProactiveNotice>;
};

export type ProactiveCheckRunOptions = {
  checkIds?: string[];
  dryRun?: boolean;
  force?: boolean;
  notify?: boolean;
};

export type ProactiveCheckRunResult = {
  checked: string[];
  notices: Array<{ checkId: string; notice: ProactiveNotice }>;
  skipped: Array<{ checkId: string; notice: ProactiveNotice; reason: string }>;
  message: string;
  appended: boolean;
  notified: boolean;
};

const DEFAULT_DEDUPE_MS = Number(process.env.MI_PROACTIVE_DEDUPE_MS || 6 * 60 * 60_000);
const DAILY_DEDUPE_MS = 36 * 60 * 60_000;
const miRoot = process.env.MI_ROOT || join(homedir(), 'assistant');
const stateDir = resolve(miRoot, 'state');
const miTasksDir = join(homedir(), 'mi');
const miStateDir = process.env.MI_TASK_STATE_DIR || join(miTasksDir, 'state');
const miPreferencesPath = join(miTasksDir, 'preferences.md');
const dedupePath = join(stateDir, 'proactive-dedupe.json');
const monitorHealthPath = join(stateDir, 'monitor-health.json');
const monitorRegistryPath = process.env.MI_MONITOR_REGISTRY_PATH || join(miRoot, 'assistants', 'monitors.md');
const autoActionsPath = join(stateDir, 'auto-actions.json');
const runtimeDir = process.env.MI_RUNTIME_DIR || join(homedir(), '.pi', 'agent', 'mi');
const socketPath = process.env.MI_SOCKET_PATH || join(runtimeDir, 'main.sock');
const repairModel = process.env.MI_WORKER_MODEL || 'openai-codex/gpt-5.5:low';

function today() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function briefDate() {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(new Date());
}

async function miOwnerName() {
  const envName = (process.env.MI_OWNER_NAME || process.env.MI_USER_NAME || '').trim();
  if (envName) return envName;
  try {
    const preferences = await readFile(miPreferencesPath, 'utf8');
    const match = preferences.match(/^\s*-\s*(?:Owner|\{owner\}|User(?:'s)?(?: display)? name|Name):\s*(.+?)\s*$/im);
    const name = match?.[1]?.trim().replace(/[.。]+$/, '');
    if (name) return name;
  } catch {}
  return 'owner';
}

function compactLines(lines: string[], empty = 'None.') {
  return lines.length > 0 ? lines.join('\n') : empty;
}

function truncateLine(value: string, max = 180) {
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.length > max ? `${compact.slice(0, max - 1)}…` : compact;
}

function approvalSummary(approval: Awaited<ReturnType<typeof readApprovals>>[number]) {
  const reason = String(approval.reason || '');
  const prompt = String(approval.prompt || '').trim();
  if (/Matched risky action pattern/i.test(reason) && prompt) return prompt;
  return reason || prompt || 'pending review';
}

function formatApprovalLine(approval: Awaited<ReturnType<typeof readApprovals>>[number]) {
  return `- ${approval.id}: ${truncateLine(approvalSummary(approval))}`;
}

function formatCronLine(cron: Awaited<ReturnType<typeof readCrons>>[number]) {
  const schedule = cron.every ? `every ${cron.every}` : cron.at ? `at ${cron.at}` : 'unscheduled';
  const status = cron.lastStatus ? `last ${cron.lastStatus}${cron.lastRunAt ? ` at ${cron.lastRunAt}` : ''}` : 'never run';
  return `- ${cron.name}: ${schedule}; ${status}`;
}

function formatFailedCronLine(cron: Awaited<ReturnType<typeof readCrons>>[number]) {
  const output = cron.lastOutput ? ` — ${truncateLine(cron.lastOutput, 220)}` : '';
  return `- ${cron.name}: ${cron.lastRunAt || 'never run'}${output}`;
}

type BriefTask = {
  name?: string;
  status?: string;
  text?: string;
  progress?: string;
  lastInput?: string;
  cwd?: string;
  updatedAt?: string;
  finishedAt?: string;
  startedAt?: string;
  needsUser?: boolean;
  needsUserReason?: string;
};

async function readJsonArray<T>(path: string): Promise<T[]> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function taskTime(task: BriefTask) {
  return Date.parse(task.updatedAt || task.finishedAt || task.startedAt || '') || 0;
}

function briefTaskTitle(task: BriefTask) {
  const title = String(task.text || task.lastInput || task.name || task.progress || 'Mi task')
    .replace(/^Background worker handoff from Mi web chat\.\s*/i, '')
    .replace(/^Follow-up from Mi web chat for the active background worker\.\s*/i, '')
    .replace(/-/g, ' ');
  return truncateLine(title, 86);
}

function formatTaskLine(task: BriefTask) {
  const status = String(task.status || 'open');
  const cwd = task.cwd && task.cwd !== homedir() ? ` (${task.cwd.replace(homedir(), '~')})` : '';
  const detail = truncateLine(String(task.text || task.progress || task.lastInput || '').replace(/```[\s\S]*?```/g, '').replace(/\n+/g, ' '), 140);
  return `- ${briefTaskTitle(task)}: ${status}${task.needsUser ? `; needs input${task.needsUserReason ? ` — ${truncateLine(task.needsUserReason, 90)}` : ''}` : ''}${cwd}${detail ? ` — ${detail}` : ''}`;
}

async function recentWorkTasks() {
  const miTasks = await readJsonArray<BriefTask>(join(miStateDir, 'tasks.json'));
  const webWorkers = (await readJsonArray<BriefTask>(join(stateDir, 'web-workers.json')))
    .map((worker) => ({
      ...worker,
      text: worker.text || worker.progress,
      updatedAt: worker.updatedAt || worker.finishedAt || worker.startedAt,
    }));
  return [...miTasks, ...webWorkers]
    .filter((task) => task.name || task.text || task.progress || task.lastInput)
    .sort((a, b) => taskTime(b) - taskTime(a));
}

function isBriefableTask(task: BriefTask) {
  const title = briefTaskTitle(task).toLowerCase();
  const detail = String(task.text || task.progress || task.lastInput || '').toLowerCase();
  if (/^(continue|ok|okay|thanks|yes|no)$/.test(title.trim())) return false;
  if (/^running shell command$/.test(detail.trim())) return false;
  return title.length > 8 || detail.length > 24;
}

async function currentWorkLines() {
  const tasks = (await recentWorkTasks()).filter(isBriefableTask);
  const seen = new Set<string>();
  const unique = tasks.filter((task) => {
    const key = briefTaskTitle(task).toLowerCase().replace(/\W+/g, ' ').slice(0, 72);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const active = unique.filter((task) => ['running', 'active', 'queued', 'paused', 'error'].includes(String(task.status || '').toLowerCase()) || task.needsUser).slice(0, 6);
  const recent = unique.filter((task) => !active.includes(task)).slice(0, 8);
  return {
    active: active.map(formatTaskLine),
    recent: recent.map(formatTaskLine),
  };
}

function projectFromTask(task: BriefTask) {
  const text = `${task.cwd || ''} ${task.name || ''} ${task.lastInput || ''} ${task.text || ''}`.toLowerCase();
  if (/38-0|38and0/.test(text)) return '38-0 / 38and0.com';
  if (/tacticsjournal|detect|research/.test(text)) return 'Tactics Journal research/detect pipeline';
  if (/mi|briefing|worker|handoff|web chat|routing|assistant/.test(text)) return 'Mi assistant / background workers';
  if (/railrat|train-112/.test(text)) return 'Railrat train 112 monitor';
  if (/cloudflare|budget/.test(text)) return 'Cloudflare / budget guard';
  const cwd = task.cwd?.replace(homedir(), '~');
  return cwd && cwd !== '~' ? cwd : '';
}

async function projectLines() {
  const tasks = await recentWorkTasks();
  const projects = new Map<string, number>();
  for (const task of tasks.slice(0, 120)) {
    const project = projectFromTask(task);
    if (project) projects.set(project, Math.max(projects.get(project) || 0, taskTime(task)));
  }
  return [...projects.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([project]) => `- ${project}`);
}

function taskNameFromPrompt(prompt: string) {
  return prompt
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || `repair-${Date.now().toString(36)}`;
}

function sendSocketRequest(payload: unknown, timeoutMs = 30000): Promise<{ ok?: boolean; error?: string; text?: string; taskId?: string; sessionFile?: string }> {
  return new Promise((resolve, reject) => {
    if (!existsSync(socketPath)) {
      reject(new Error(`Mi main socket not found: ${socketPath}`));
      return;
    }
    const socket = net.createConnection(socketPath);
    let data = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('Timed out waiting for Mi main'));
    }, timeoutMs);
    socket.on('connect', () => socket.write(`${JSON.stringify(payload)}\n`));
    socket.on('data', (chunk) => {
      data += chunk.toString('utf8');
      if (!data.includes('\n')) return;
      clearTimeout(timer);
      socket.end();
      try {
        const response = JSON.parse(data.slice(0, data.indexOf('\n'))) as { ok?: boolean; error?: string; text?: string; taskId?: string; sessionFile?: string };
        if (response.ok) resolve(response);
        else reject(new Error(response.error || 'Mi main returned an error'));
      } catch (error) {
        reject(error);
      }
    });
    socket.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

type AutoActionState = {
  date?: string;
  readOnlyTriageToday?: number;
};

function autoActionsEnabled() {
  return process.env.MI_AUTO_ACTIONS_ENABLED !== 'false';
}

function autoActionMaxPerDay() {
  const value = Number(process.env.MI_AUTO_ACTION_INSPECT_MAX_PER_DAY || process.env.MI_AUTO_ACTIONS_MAX_PER_DAY || 3);
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 3;
}

async function readAutoActionState(): Promise<AutoActionState> {
  try {
    const parsed = JSON.parse(await readFile(autoActionsPath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

async function writeAutoActionState(state: AutoActionState) {
  await mkdir(dirname(autoActionsPath), { recursive: true });
  await writeFile(autoActionsPath, JSON.stringify(state, null, 2), { mode: 0o600 });
}

async function consumeReadOnlyTriageBudget() {
  if (!autoActionsEnabled()) return { allowed: false, reason: 'disabled' };
  const maxPerDay = autoActionMaxPerDay();
  if (maxPerDay <= 0) return { allowed: false, reason: 'daily budget disabled' };
  const state = await readAutoActionState();
  const date = today();
  if (state.date !== date) {
    state.date = date;
    state.readOnlyTriageToday = 0;
  }
  if ((state.readOnlyTriageToday || 0) >= maxPerDay) return { allowed: false, reason: 'daily budget exhausted' };
  state.readOnlyTriageToday = (state.readOnlyTriageToday || 0) + 1;
  await writeAutoActionState(state);
  return { allowed: true, reason: 'ok' };
}

async function startRepairWorker(notice: ProactiveNotice) {
  if (!notice.repairPrompt) return null;
  const budget = await consumeReadOnlyTriageBudget();
  if (!budget.allowed) return { skipped: true, reason: budget.reason };
  const name = notice.repairName || taskNameFromPrompt(notice.repairPrompt);
  const result = await sendSocketRequest({
    type: 'run_worker',
    name,
    cwd: homedir(),
    message: notice.repairPrompt,
    lastInput: notice.message,
    background: true,
    reportToMain: true,
    model: repairModel,
    capabilityProfile: 'worker-read',
  }, 30000);
  return { name, taskId: result.taskId, sessionFile: result.sessionFile, capabilityProfile: 'worker-read' };
}

function noticeHash(checkId: string, notice: ProactiveNotice) {
  return createHash('sha256')
    .update([checkId, notice.dedupeKey || notice.message].join('\u001f'))
    .digest('hex');
}

async function readDedupe(): Promise<Record<string, { lastSeenAt: string }>> {
  try {
    return JSON.parse(await readFile(dedupePath, 'utf8'));
  } catch {
    return {};
  }
}

async function writeDedupe(state: Record<string, { lastSeenAt: string }>) {
  await mkdir(dirname(dedupePath), { recursive: true });
  await writeFile(dedupePath, JSON.stringify(state, null, 2));
}

async function alreadySeen(checkId: string, notice: ProactiveNotice, force = false) {
  if (force) return false;
  const state = await readDedupe();
  const seen = state[noticeHash(checkId, notice)];
  if (!seen) return false;
  const ttl = notice.dedupeKey?.startsWith('dailyBrief:') ? DAILY_DEDUPE_MS : DEFAULT_DEDUPE_MS;
  return Date.now() - Date.parse(seen.lastSeenAt) < ttl;
}

async function remember(checkId: string, notice: ProactiveNotice) {
  const state = await readDedupe();
  state[noticeHash(checkId, notice)] = { lastSeenAt: new Date().toISOString() };
  await writeDedupe(state);
}

export async function pendingApprovals(): Promise<null | ProactiveNotice> {
  const pending = (await readApprovals()).filter((approval) => approval.status === 'pending');
  if (pending.length === 0) return null;
  return {
    message: [
      pending.length === 1 ? 'Mi noticed 1 pending approval.' : `Mi noticed ${pending.length} pending approvals.`,
      'Pending:',
      compactLines(pending.slice(0, 10).map((approval) => `- ${approval.id}: ${approval.reason}`)),
    ].join('\n'),
    notify: true,
    dedupeKey: `pendingApprovals:${pending.map((approval) => approval.id).sort().join(',')}`,
  };
}

export async function failedCrons(): Promise<null | ProactiveNotice> {
  const crons = await readCrons().catch(() => []);
  const failed = crons.filter((cron) => cron.lastStatus === 'error');
  if (failed.length === 0) return null;
  const paths = cronPaths();
  const failedSummary = compactLines(failed.map((cron) => `- ${cron.name}: ${cron.lastOutput || 'failed'}`));
  return {
    message: [
      failed.length === 1 ? 'Mi noticed 1 failed cron run.' : `Mi noticed ${failed.length} failed cron runs.`,
      'Failed:',
      failedSummary,
      `State: ${paths.cronsPath}`,
      `Log: ${paths.logPath}`,
      'Starting a background repair worker now.',
    ].join('\n'),
    notify: true,
    dedupeKey: `failedCrons:${failed.map((cron) => `${cron.name}:${cron.lastRunAt || ''}:${cron.lastOutput || ''}`).sort().join('|')}`,
    repairName: 'repair-failed-mi-crons',
    repairPrompt: [
      'Background repair worker launched automatically by Mi after detecting failed cron runs.',
      'Report the root cause and repair the failing cron/task without exposing secrets.',
      '',
      `Failed crons:\n${failedSummary}`,
      `Cron state file: ${paths.cronsPath}`,
      `Cron log: ${paths.logPath}`,
      '',
      'Instructions:',
      '- Inspect the cron state/logs and relevant repo/service files.',
      '- Fix the failure or document exactly what user action/credential is required if it cannot be repaired safely.',
      '- Summarize changes, files touched, test/check results, and remaining user action.',
    ].join('\n'),
  };
}

export async function dailyBrief(): Promise<null | ProactiveNotice> {
  if (process.env.MI_DAILY_BRIEF === 'false') return null;
  const owner = await miOwnerName();
  const pending = (await readApprovals()).filter((approval) => approval.status === 'pending');
  const crons = await readCrons().catch(() => []);
  const enabledCrons = crons.filter((cron) => cron.enabled);
  const failed = crons.filter((cron) => cron.lastStatus === 'error');
  const recentCrons = [...crons]
    .filter((cron) => cron.lastRunAt)
    .sort((a, b) => Date.parse(b.lastRunAt || '') - Date.parse(a.lastRunAt || ''))
    .slice(0, 5);
  const paths = cronPaths();
  const proposals = queuedProposals(await readProposalQueue());
  const proposalLines = renderNumberedProposals(proposals);
  const work = await currentWorkLines();
  const projects = await projectLines();
  const actionItems = [
    ...pending.slice(0, 3).map((approval) => `- Review approval ${approval.id}: ${truncateLine(approvalSummary(approval), 120)}`),
    ...failed.slice(0, 3).map((cron) => `- Fix failed cron ${cron.name}: ${truncateLine(cron.lastOutput || 'failed', 120)}`),
    ...work.active.filter((line) => /needs input|error|paused/i.test(line)).slice(0, 3),
  ];
  return {
    message: [
      `Good morning, ${owner}. Here is your daily briefing for ${briefDate()}.`,
      '',
      'TODAY’S FOCUS',
      compactLines(work.active.slice(0, 5), '- No active background work is currently open.'),
      '',
      'ACTION ITEMS',
      compactLines(actionItems.slice(0, 8), '- No urgent approvals, failed monitors, or blocked tasks found.'),
      '',
      'PROPOSALS',
      compactLines(proposalLines, '- No queued proposals today.'),
      '',
      'PROJECTS IN MOTION',
      compactLines(projects, '- No recent project activity found.'),
      '',
      'RECENT WORK / CONTEXT',
      compactLines(work.recent.slice(0, 6), '- No recent completed task history found.'),
      '',
      'MONITORING HEALTH',
      `- Summary: ${failed.length} failed crons, ${enabledCrons.length} enabled crons, ${crons.length} total tracked.`,
      failed.length > 0 ? '- Failed monitors:' : '- Failed monitors: none.',
      failed.length > 0 ? compactLines(failed.slice(0, 5).map(formatFailedCronLine)) : '',
      recentCrons.length > 0 ? '- Recent monitor runs:' : '',
      recentCrons.length > 0 ? compactLines(recentCrons.map(formatCronLine)) : '',
      '',
      'APPROVALS',
      `- Pending approvals: ${pending.length}`,
      pending.length > 0 ? compactLines(pending.slice(0, 5).map(formatApprovalLine)) : '',
      pending.length > 5 ? `- ...and ${pending.length - 5} more.` : '',
      '',
      'REFERENCE',
      `- State: ${paths.cronsPath}`,
      `- Log: ${paths.logPath}`,
    ].filter((line) => line !== '').join('\n'),
    notify: process.env.MI_DAILY_BRIEF_NOTIFY !== 'false',
    dedupeKey: `dailyBrief:${today()}`,
  };
}

type MonitorStatus = 'ok' | 'stale' | 'degraded' | 'human-required' | 'muted_pending_human';

type MonitorObservation = {
  id: string;
  title: string;
  status: MonitorStatus;
  reason: string;
  detail?: string;
  repairable?: boolean;
  repairPrompt?: string;
  repairName?: string;
};

type MonitorRecord = {
  status?: MonitorStatus;
  reason?: string;
  detail?: string;
  lastObservedAt?: string;
  lastTransitionAt?: string;
  repairAttempts?: number;
  nextRepairAfter?: string;
};

type MonitorHealthState = {
  version: 1;
  monitors: Record<string, MonitorRecord>;
};

const tacticsJournalRoot = process.env.MI_TACTICS_JOURNAL_ROOT || '/home/kyle/code/research';
const tacticsHealthDir = process.env.MI_TACTICS_HEALTH_DIR || join(tacticsJournalRoot, '.logs');
const tacticsHealthSteps = (process.env.MI_TACTICS_HEALTH_STEPS || 'ingest,detect,report,report-worker,tune,storage-prune')
  .split(',')
  .map((step) => step.trim())
  .filter(Boolean);
const tacticsStaleMs = Number(process.env.MI_TACTICS_HEALTH_STALE_MS || 30 * 60 * 60_000);
const monitorRepairCooldownMs = Number(process.env.MI_MONITOR_REPAIR_COOLDOWN_MS || 6 * 60 * 60_000);
const monitorRepairMaxAttempts = Math.max(1, Number(process.env.MI_MONITOR_REPAIR_MAX_ATTEMPTS || 3));
const humanRequiredReasons = new Set(['railway_auth_failed', 'railway_project_unlinked', 'cloudflare_ai_gateway_billing', 'cloudflare_ai_gateway_forbidden']);
const repairableMonitorReasons = new Set(['stale', 'missing_health_sidecar', 'unreadable_health_sidecar', 'process_killed', 'rescore_degraded', 'degraded', 'failed', 'error']);

async function readJsonObject<T extends object>(path: string): Promise<Partial<T>> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function readMonitorHealthState(): Promise<MonitorHealthState> {
  const parsed = await readJsonObject<MonitorHealthState>(monitorHealthPath);
  return { version: 1, monitors: parsed.monitors && typeof parsed.monitors === 'object' ? parsed.monitors as Record<string, MonitorRecord> : {} };
}

async function writeMonitorHealthState(state: MonitorHealthState) {
  await mkdir(dirname(monitorHealthPath), { recursive: true });
  await writeFile(monitorHealthPath, JSON.stringify(state, null, 2), { mode: 0o600 });
}

function transitionFor(previous: MonitorRecord | undefined, current: MonitorObservation) {
  if (!previous?.status) return 'seed' as const;
  if (previous.status === current.status && previous.reason === current.reason && previous.detail === current.detail) return 'unchanged' as const;
  if (previous.status !== 'ok' && current.status === 'ok') return 'recovered' as const;
  if (previous.status === 'ok' && current.status !== 'ok') return 'broken' as const;
  if (previous.status !== current.status) return 'changed' as const;
  return 'changed-detail' as const;
}

function monitorLine(observation: MonitorObservation) {
  const suffix = observation.detail ? ` — ${truncateLine(observation.detail, 180)}` : '';
  return `- ${observation.title}: ${observation.reason}${suffix}`;
}

function recoveryLine(observation: MonitorObservation) {
  return `- ${observation.title} is healthy again.`;
}

function makeMonitorRepairPrompt(observation: MonitorObservation) {
  if (observation.repairPrompt) return observation.repairPrompt;
  return [
    'Safe read-only triage worker launched automatically by Mi for a configured monitor that became stale or degraded.',
    `Monitor: ${observation.title}`,
    `Status: ${observation.status}`,
    `Reason: ${observation.reason}`,
    observation.detail ? `Detail: ${observation.detail}` : '',
    '',
    'Scope:',
    '- Inspect and summarize only this configured monitor using read-only tools.',
    '- Do not edit files, deploy, merge, delete, change config, approve anything, or touch secrets.',
    '- Do not start new open-ended Tactics Journal research work if nothing is broken.',
    '- If a mutation or human action is required, stop and report exactly what is needed.',
  ].filter(Boolean).join('\n');
}

function repairAllowed(observation: MonitorObservation, previous: MonitorRecord | undefined, nowMs: number) {
  if (!observation.repairable) return false;
  if (observation.status !== 'stale' && observation.status !== 'degraded') return false;
  if (!repairableMonitorReasons.has(observation.reason)) return false;
  if (previous?.nextRepairAfter && Date.parse(previous.nextRepairAfter) > nowMs) return false;
  return true;
}

type MonitorRegistryEntry = {
  id: string;
  title: string;
  type: 'health_sidecar' | 'mi_crons';
  source: string;
  freshnessMs?: number;
  allowedAutoActions?: string;
};

function parseDurationMs(value: string, fallback: number) {
  const match = value.trim().match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/i);
  if (!match) return fallback;
  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  if (unit === 'ms') return amount;
  if (unit === 's') return amount * 1000;
  if (unit === 'm') return amount * 60_000;
  if (unit === 'h') return amount * 60 * 60_000;
  return amount * 24 * 60 * 60_000;
}

function defaultTacticsRegistryEntries(): MonitorRegistryEntry[] {
  return tacticsHealthSteps.map((step) => ({
    id: `tactics:${step}`,
    title: `Tactics Journal ${step} health`,
    type: 'health_sidecar',
    source: join(tacticsHealthDir, `${step}-latest-health.json`),
    freshnessMs: tacticsStaleMs,
    allowedAutoActions: 'read_triage',
  }));
}

function parseMonitorRegistry(markdown: string): MonitorRegistryEntry[] {
  const entries: MonitorRegistryEntry[] = [];
  for (const line of markdown.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|') || trimmed.includes('---') || /^\|\s*id\s*\|/i.test(trimmed)) continue;
    const cells = trimmed.split('|').slice(1, -1).map((cell) => cell.trim());
    if (cells.length < 8) continue;
    const [id, title, type, source, freshness, , allowedAutoActions] = cells;
    if (!id || !title || !type || !source) continue;
    if (type !== 'health_sidecar' && type !== 'mi_crons') continue;
    entries.push({
      id,
      title,
      type,
      source,
      freshnessMs: freshness && freshness !== 'n/a' ? parseDurationMs(freshness, tacticsStaleMs) : undefined,
      allowedAutoActions,
    });
  }
  return entries;
}

async function readMonitorRegistry(): Promise<MonitorRegistryEntry[]> {
  if (process.env.MI_TACTICS_HEALTH_DIR || process.env.MI_TACTICS_HEALTH_STEPS || process.env.MI_TACTICS_HEALTH_STALE_MS) {
    return [...defaultTacticsRegistryEntries(), { id: 'mi-crons:configured', title: 'Mi reminder crons', type: 'mi_crons', source: 'state/crons.json', allowedAutoActions: 'read_triage' }];
  }
  const parsed = parseMonitorRegistry(await readFile(monitorRegistryPath, 'utf8').catch(() => ''));
  return parsed.length > 0 ? parsed : [{ id: 'mi-crons:configured', title: 'Mi reminder crons', type: 'mi_crons', source: 'state/crons.json', allowedAutoActions: 'read_triage' }];
}

async function observeTacticsHealthStep(entryOrStep: MonitorRegistryEntry | string): Promise<MonitorObservation | null> {
  const entry = typeof entryOrStep === 'string' ? defaultTacticsRegistryEntries().find((item) => item.id === `tactics:${entryOrStep}`) : entryOrStep;
  if (!entry) return null;
  const path = entry.source;
  const title = entry.title;
  try {
    const [raw, info] = await Promise.all([readFile(path, 'utf8'), stat(path)]);
    const payload = JSON.parse(raw) as Record<string, unknown>;
    const checkedAt = String(payload.checked_at || payload.checkedAt || '');
    const checkedMs = Date.parse(checkedAt) || info.mtimeMs;
    const reason = String(payload.reason || payload.status || 'unknown');
    const status = String(payload.status || '').toLowerCase();
    const human = payload.human_action_required === true || humanRequiredReasons.has(reason);
    const ageMs = Date.now() - checkedMs;
    if (human) return { id: entry.id, title, status: 'human-required', reason, detail: checkedAt ? `checked ${checkedAt}` : path, repairable: false };
    if (ageMs > (entry.freshnessMs || tacticsStaleMs)) return { id: entry.id, title, status: 'stale', reason: 'stale', detail: `last checked ${checkedAt || new Date(checkedMs).toISOString()}`, repairable: entry.allowedAutoActions === 'read_triage' };
    if (status === 'ok') return { id: entry.id, title, status: 'ok', reason: 'ok', detail: checkedAt ? `checked ${checkedAt}` : undefined };
    const degradedReason = reason || status || 'degraded';
    return { id: entry.id, title, status: 'degraded', reason: degradedReason, detail: String(payload.log_file || payload.exit_code || path), repairable: entry.allowedAutoActions === 'read_triage' && repairableMonitorReasons.has(degradedReason) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    const reason = error instanceof SyntaxError ? 'unreadable_health_sidecar' : 'unreadable_health_sidecar';
    return { id: entry.id, title, status: 'stale', reason, detail: path, repairable: entry.allowedAutoActions === 'read_triage' };
  }
}

async function observeMiCronHealth(): Promise<MonitorObservation[]> {
  const crons = await readCrons().catch(() => []);
  const enabled = crons.filter((cron) => cron.enabled);
  if (enabled.length === 0) return [{ id: 'mi-crons:configured', title: 'Mi reminder crons', status: 'ok', reason: 'none-configured', detail: 'No Mi reminder crons are configured.' }];
  const commandCrons = enabled.filter((cron) => cron.command);
  if (commandCrons.length > 0) {
    return [{ id: 'mi-crons:command-crons', title: 'Mi command crons', status: 'human-required', reason: 'legacy_command_crons', detail: `${commandCrons.length} command cron(s) should be migrated to configured monitors or reminders.`, repairable: false }];
  }
  const failed = enabled.filter((cron) => cron.lastStatus === 'error');
  if (failed.length > 0) return [{ id: 'mi-crons:reminders', title: 'Mi reminder crons', status: 'degraded', reason: 'failed', detail: failed.map((cron) => cron.name).join(', '), repairable: true }];
  return [{ id: 'mi-crons:reminders', title: 'Mi reminder crons', status: 'ok', reason: 'ok', detail: `${enabled.length} enabled reminder cron(s).` }];
}

async function observeConfiguredMonitors() {
  const registry = await readMonitorRegistry();
  const sidecars = (await Promise.all(registry.filter((entry) => entry.type === 'health_sidecar').map(observeTacticsHealthStep))).filter((item): item is MonitorObservation => Boolean(item));
  const miCrons = registry.some((entry) => entry.type === 'mi_crons') ? await observeMiCronHealth() : [];
  return [...sidecars, ...miCrons];
}

export async function configuredMonitorHealth(): Promise<null | ProactiveNotice> {
  const state = await readMonitorHealthState();
  const nowIso = new Date().toISOString();
  const nowMs = Date.now();
  const observations = await observeConfiguredMonitors();
  const activeIds = new Set(observations.map((observation) => observation.id));
  for (const id of Object.keys(state.monitors)) {
    if (id.startsWith('tactics:') && !activeIds.has(id)) delete state.monitors[id];
  }
  const becameBroken: MonitorObservation[] = [];
  const changedBroken: MonitorObservation[] = [];
  const recovered: MonitorObservation[] = [];
  const humanRequired: MonitorObservation[] = [];
  const repairable: MonitorObservation[] = [];

  for (const observation of observations) {
    const previous = state.monitors[observation.id];
    if (previous?.status === 'muted_pending_human' && observation.status !== 'ok') {
      state.monitors[observation.id] = {
        ...previous,
        reason: observation.reason,
        detail: observation.detail,
        lastObservedAt: nowIso,
      };
      continue;
    }

    const attempts = previous?.repairAttempts || 0;
    if (observation.status !== 'ok' && attempts >= monitorRepairMaxAttempts) {
      const mutedObservation: MonitorObservation = {
        ...observation,
        status: 'human-required',
        reason: 'muted_pending_human',
        detail: `${observation.detail ? `${observation.detail}; ` : ''}auto-repair attempted ${attempts} time(s); muted pending human`,
        repairable: false,
      };
      humanRequired.push(mutedObservation);
      state.monitors[observation.id] = {
        ...previous,
        status: 'muted_pending_human',
        reason: observation.reason,
        detail: observation.detail,
        repairAttempts: attempts,
        lastObservedAt: nowIso,
        lastTransitionAt: nowIso,
        nextRepairAfter: undefined,
      };
      continue;
    }

    const transition = transitionFor(previous, observation);
    const next: MonitorRecord = {
      ...previous,
      status: observation.status,
      reason: observation.reason,
      detail: observation.detail,
      lastObservedAt: nowIso,
      lastTransitionAt: transition === 'seed' || transition === 'unchanged' ? previous?.lastTransitionAt : nowIso,
    };
    if (transition !== 'seed' && transition !== 'unchanged') {
      if (observation.status === 'ok') recovered.push(observation);
      else if (observation.status === 'human-required') humanRequired.push(observation);
      else if (transition === 'broken') becameBroken.push(observation);
      else changedBroken.push(observation);
    }
    if (transition !== 'seed' && observation.status !== 'ok' && repairAllowed(observation, previous, nowMs)) {
      repairable.push(observation);
      next.repairAttempts = (previous?.repairAttempts || 0) + 1;
      next.nextRepairAfter = new Date(nowMs + monitorRepairCooldownMs * Math.max(1, Math.min(next.repairAttempts, 6))).toISOString();
    }
    if (observation.status === 'ok') {
      next.repairAttempts = 0;
      next.nextRepairAfter = undefined;
    }
    state.monitors[observation.id] = next;
  }
  await writeMonitorHealthState(state);

  if (becameBroken.length === 0 && changedBroken.length === 0 && recovered.length === 0 && humanRequired.length === 0) return null;
  const lines = [
    becameBroken.length > 0 ? 'I noticed a configured monitor needs attention:' : '',
    ...becameBroken.map(monitorLine),
    changedBroken.length > 0 ? 'A configured monitor changed state:' : '',
    ...changedBroken.map(monitorLine),
    humanRequired.length > 0 ? 'This one needs you before I can do anything safely:' : '',
    ...humanRequired.map(monitorLine),
    recovered.length > 0 ? 'Good news — this recovered:' : '',
    ...recovered.map(recoveryLine),
    repairable.length > 0 ? 'Starting safe read-only triage now.' : 'No action taken.',
  ].filter(Boolean);
  const firstRepairable = repairable[0];
  return {
    message: lines.join('\n'),
    notify: true,
    dedupeKey: `monitorHealth:${[...becameBroken, ...changedBroken, ...humanRequired, ...recovered].map((item) => `${item.id}:${item.status}:${item.reason}:${item.detail || ''}`).sort().join('|')}`,
    repairName: firstRepairable ? `repair-${firstRepairable.id.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}` : undefined,
    repairPrompt: firstRepairable ? makeMonitorRepairPrompt(firstRepairable) : undefined,
  };
}

export const checks: ProactiveCheck[] = [
  { id: 'pendingApprovals', run: pendingApprovals },
  { id: 'failedCrons', run: failedCrons },
  { id: 'dailyBrief', run: dailyBrief },
];

const checkRegistry = new Map<string, ProactiveCheck>([
  ...checks.map((check) => [check.id, check] as const),
  ['pending-approvals', { id: 'pendingApprovals', run: pendingApprovals }],
  ['approval-reminders', { id: 'pendingApprovals', run: pendingApprovals }],
  ['failed-crons', { id: 'failedCrons', run: failedCrons }],
  ['crons', { id: 'failedCrons', run: failedCrons }],
  ['daily-brief', { id: 'dailyBrief', run: dailyBrief }],
  ['brief', { id: 'dailyBrief', run: dailyBrief }],
  ['health-check', { id: 'configuredMonitorHealth', run: configuredMonitorHealth }],
  ['heartbeat', { id: 'configuredMonitorHealth', run: configuredMonitorHealth }],
  ['configured-monitor-health', { id: 'configuredMonitorHealth', run: configuredMonitorHealth }],
  ['projectQuestion', { id: 'projectQuestion', run: projectQuestion }],
  ['project-question', { id: 'projectQuestion', run: projectQuestion }],
  ['question', { id: 'projectQuestion', run: projectQuestion }],
  ['questions', { id: 'projectQuestion', run: projectQuestion }],
  ['ask', { id: 'projectQuestion', run: projectQuestion }],
]);

function resolveChecks(ids: string[] | undefined) {
  if (!ids || ids.length === 0 || ids.includes('all')) return checks;
  return ids.map((id) => {
    const check = checkRegistry.get(id);
    if (!check) throw new Error(`unknown Mi proactive check: ${id}`);
    return check;
  });
}

function formatCheckMessage(notices: Array<{ checkId: string; notice: ProactiveNotice }>) {
  if (notices.length === 0) return 'Mi check found no new notices.';
  const body = notices.map(({ notice }) => notice.message).join('\n\n');
  const hasRepair = notices.some(({ notice }) => Boolean(notice.repairPrompt));
  const needsFooter = notices.some(({ notice }) => !notice.suppressActionFooter);
  if (!needsFooter) return String(redactSecrets(body));
  return String(redactSecrets(`${body}\n\n${hasRepair ? 'Background worker requested.' : 'No action taken.'}`));
}

export async function runMiCheck(options: ProactiveCheckRunOptions = {}): Promise<ProactiveCheckRunResult> {
  const selectedChecks = resolveChecks(options.checkIds);
  const notices: Array<{ checkId: string; notice: ProactiveNotice }> = [];
  const skipped: ProactiveCheckRunResult['skipped'] = [];

  for (const check of selectedChecks) {
    let notice: ProactiveNotice | null = null;
    try {
      notice = await check.run();
    } catch (error) {
      const errorText = error instanceof Error ? error.message : String(error);
      notice = {
        message: `Mi proactive check failed: ${check.id}\n${errorText}\nStarting a background repair worker now.`,
        notify: true,
        dedupeKey: `checkError:${check.id}:${errorText}`,
        repairName: `repair-mi-check-${check.id}`,
        repairPrompt: [
          'Background repair worker launched automatically by Mi after a proactive check crashed.',
          `Failed check: ${check.id}`,
          `Error: ${errorText}`,
          '',
          'Instructions:',
          '- Inspect the Mi proactive check implementation and state files.',
          '- Repair the failing check without exposing secrets, or document the required user action if blocked.',
          '- Summarize changes, files touched, test/check results, and remaining user action.',
        ].join('\n'),
      };
    }
    if (!notice) continue;
    if (await alreadySeen(check.id, notice, options.force)) {
      skipped.push({ checkId: check.id, notice, reason: 'deduped' });
      await logEvent('mi.check.deduped', { checkId: check.id, notice });
      continue;
    }
    notices.push({ checkId: check.id, notice });
    if (!options.dryRun) await remember(check.id, notice);
  }

  const message = formatCheckMessage(notices);
  let appended = false;
  let notified = false;

  if (notices.length > 0 && !options.dryRun) {
    await appendThreadMessage('main', 'assistant', message, { unread: true, source: 'mi:check' });
    appended = true;
    for (const { checkId, notice } of notices) {
      if (!notice.repairPrompt) continue;
      try {
        const repair = await startRepairWorker(notice);
        if (repair?.skipped) {
          await logEvent('mi.check.repair_worker.skipped', { checkId, reason: repair.reason });
          await appendThreadMessage('main', 'assistant', `Mi skipped safe read-only triage for ${checkId}: ${repair.reason}.`, { unread: true, source: 'mi:check' });
        } else {
          await logEvent('mi.check.repair_worker.started', { checkId, repair });
        }
      } catch (error) {
        const errorText = redactSecrets(error instanceof Error ? error.message : String(error));
        await logEvent('mi.check.repair_worker.error', { checkId, error: errorText });
        await appendThreadMessage('main', 'assistant', `Mi could not start the background repair worker for ${checkId}: ${errorText}`, { unread: true, source: 'mi:check' });
      }
    }
  }

  if (options.notify !== false && notices.some(({ notice }) => notice.notify) && !options.dryRun) {
    await sendNotification('Mi check', message).catch(() => ({ skipped: true }));
    notified = true;
  }

  await logEvent('mi.check.complete', { checked: selectedChecks.map((check) => check.id), notices: notices.length, skipped: skipped.length, appended, notified });

  return {
    checked: selectedChecks.map((check) => check.id),
    notices,
    skipped,
    message,
    appended,
    notified,
  };
}
