import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { cronPaths, readCrons } from './crons.js';
import { notify as sendNotification } from './notify.js';
import { logEvent, readApprovals } from './state.js';
import { appendThreadMessage } from './threads.js';
import { redactSecrets } from './redact.js';

export type ProactiveNotice = {
  message: string;
  notify?: boolean;
  dedupeKey?: string;
  repairPrompt?: string;
  repairName?: string;
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
const miStateDir = process.env.MI_TASK_STATE_DIR || join(homedir(), 'mi', 'state');
const dedupePath = join(stateDir, 'proactive-dedupe.json');
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

async function startRepairWorker(notice: ProactiveNotice) {
  if (!notice.repairPrompt) return null;
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
  }, 30000);
  return { name, taskId: result.taskId, sessionFile: result.sessionFile };
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
  const pending = (await readApprovals()).filter((approval) => approval.status === 'pending');
  const crons = await readCrons().catch(() => []);
  const enabledCrons = crons.filter((cron) => cron.enabled);
  const failed = crons.filter((cron) => cron.lastStatus === 'error');
  const recentCrons = [...crons]
    .filter((cron) => cron.lastRunAt)
    .sort((a, b) => Date.parse(b.lastRunAt || '') - Date.parse(a.lastRunAt || ''))
    .slice(0, 5);
  const paths = cronPaths();
  const work = await currentWorkLines();
  const projects = await projectLines();
  const actionItems = [
    ...pending.slice(0, 3).map((approval) => `- Review approval ${approval.id}: ${truncateLine(approvalSummary(approval), 120)}`),
    ...failed.slice(0, 3).map((cron) => `- Fix failed cron ${cron.name}: ${truncateLine(cron.lastOutput || 'failed', 120)}`),
    ...work.active.filter((line) => /needs input|error|paused/i.test(line)).slice(0, 3),
  ];
  return {
    message: [
      `Good morning. Here is your daily briefing for ${briefDate()}.`,
      '',
      'TODAY’S FOCUS',
      compactLines(work.active.slice(0, 5), '- No active background work is currently open.'),
      '',
      'ACTION ITEMS',
      compactLines(actionItems.slice(0, 8), '- No urgent approvals, failed monitors, or blocked tasks found.'),
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
  return String(redactSecrets(`${body}\n\n${hasRepair ? 'Repair worker requested.' : 'No action taken.'}`));
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
        await logEvent('mi.check.repair_worker.started', { checkId, repair });
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
