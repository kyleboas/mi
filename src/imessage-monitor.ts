import { spawn } from 'node:child_process';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { notifyImessage, notifyPushover, safeNotificationText } from './notify.js';
import { redactSecrets } from './redact.js';
import { appendThreadMessage, readThreadMessages, type ThreadMessage } from './threads.js';

export type ImessageAnomaly = {
  code: string;
  severity: 'warn' | 'error';
  detail: string;
  service?: string;
  preview?: string;
};

export type ImessageMonitorResult = {
  status: 'skipped' | 'healthy' | 'repaired' | 'unrepaired' | 'error';
  skippedReason?: string;
  anomalies: ImessageAnomaly[];
  repairs: Array<{ service: string; ok: boolean; detail?: string }>;
  notified?: boolean;
};

type MonitorState = { lastRunAt?: string; openIncidentAt?: string; lastNotificationAt?: string };

type CommandResult = { ok: boolean; code: number | null; stdout: string; stderr: string };

type MonitorDeps = {
  now?: () => Date;
  runCommand?: (command: string, args: string[], options?: { timeoutMs?: number }) => Promise<CommandResult>;
  fetch?: typeof fetch;
  readMessages?: typeof readThreadMessages;
  appendMain?: (text: string) => Promise<unknown>;
  notifyImessage?: typeof notifyImessage;
  notifyPushover?: typeof notifyPushover;
};

const miRoot = process.env.MI_ROOT || join(homedir(), 'assistant');
const stateDir = resolve(miRoot, 'state');
const statePath = join(stateDir, 'imessage-monitor-state.json');
const logPath = join(stateDir, 'imessage-monitor.jsonl');
function monitorIntervalMs() {
  return Number(process.env.MI_IMESSAGE_MONITOR_INTERVAL_MS || 15 * 60_000);
}

function monitorMaxWaitMs() {
  return Number(process.env.MI_PHOTON_MAX_WAIT_MS || 3 * 60_000);
}
const commandTimeoutMs = Number(process.env.MI_IMESSAGE_MONITOR_COMMAND_TIMEOUT_MS || 8_000);
const notifyProbeTimeoutMs = Number(process.env.MI_IMESSAGE_MONITOR_NOTIFY_PROBE_TIMEOUT_MS || 3_000);
const recentLogMinutes = Number(process.env.MI_IMESSAGE_MONITOR_LOG_MINUTES || 30);
const bridgeService = process.env.MI_IMESSAGE_BRIDGE_SERVICE || 'mi-photon-bridge.service';
const repairUserServices = (process.env.MI_IMESSAGE_REPAIR_USER_SERVICES || 'mi-web-chat.service,mi-daemon.service')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean);
const dangerousUrlPattern = /https?:\/\/\S+/gi;

function enabled() {
  return process.env.MI_IMESSAGE_MONITOR_ENABLED !== 'false';
}

function redacted(text: string, limit = 500) {
  return String(redactSecrets(String(text || '').replace(dangerousUrlPattern, '[link omitted]').replace(/\s+/g, ' ').trim())).slice(0, limit);
}

function command(command: string, args: string[], options: { timeoutMs?: number } = {}): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    const errors: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 1000).unref();
    }, options.timeoutMs || commandTimeoutMs);
    child.stdout.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => errors.push(Buffer.from(chunk)));
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ ok: false, code: null, stdout: '', stderr: error.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, code, stdout: Buffer.concat(chunks).toString('utf8'), stderr: Buffer.concat(errors).toString('utf8') });
    });
  });
}

async function readState(): Promise<MonitorState> {
  try {
    const parsed = JSON.parse(await readFile(statePath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

async function writeState(state: MonitorState) {
  await mkdir(dirname(statePath), { recursive: true });
  await writeFile(statePath, JSON.stringify(state, null, 2), { mode: 0o600 });
}

async function appendMonitorLog(event: string, payload: Record<string, unknown>) {
  await mkdir(dirname(logPath), { recursive: true });
  await appendFile(logPath, `${JSON.stringify({ ts: new Date().toISOString(), event, ...payload })}\n`, { mode: 0o600 });
}

export function analyzePhotonLogs(logs: string): ImessageAnomaly[] {
  const anomalies: ImessageAnomaly[] = [];
  const lines = logs.split(/\r?\n/).filter(Boolean).slice(-80);
  for (const line of lines) {
    const safe = redacted(line, 240);
    if (/photon send failed permanently|photon notify failed|mi photon fatal|mi photon handling failed/i.test(line)) {
      anomalies.push({ code: 'photon-log-error', severity: 'error', detail: safe, service: bridgeService });
    } else if (/send failed attempt=|imessage poll error|typing .* failed|endpoint error/i.test(line)) {
      anomalies.push({ code: 'photon-log-warning', severity: 'warn', detail: safe, service: bridgeService });
    }
  }
  return anomalies.slice(-10);
}

export function analyzeThreadMessages(messages: ThreadMessage[], now = new Date(), waitMs = monitorMaxWaitMs()): ImessageAnomaly[] {
  const imessages = messages.filter((message) => String(message.source || '').startsWith('imessage'));
  const anomalies: ImessageAnomaly[] = [];
  for (let i = imessages.length - 1; i >= 0; i -= 1) {
    const message = imessages[i];
    if (message.role !== 'user') continue;
    const age = now.getTime() - Date.parse(message.ts);
    if (!Number.isFinite(age) || age < waitMs) continue;
    const hasReply = imessages.slice(i + 1).some((candidate) => candidate.role === 'assistant' && Date.parse(candidate.ts) >= Date.parse(message.ts));
    if (!hasReply) {
      anomalies.push({
        code: 'imessage-stuck-reply',
        severity: 'warn',
        detail: `iMessage user message has no visible assistant reply after ${Math.round(age / 1000)}s`,
        preview: redacted(message.text, 80),
      });
      break;
    }
  }
  return anomalies;
}

export function serviceNeedsRestart(anomalies: ImessageAnomaly[]) {
  return anomalies.some((item) => ['service-inactive', 'photon-log-error', 'notify-endpoint-down', 'imessage-stuck-reply'].includes(item.code));
}

async function probeNotifyEndpoint(fetchImpl: typeof fetch, signal?: AbortSignal): Promise<ImessageAnomaly[]> {
  const url = process.env.MI_PHOTON_NOTIFY_URL || `http://127.0.0.1:${process.env.MI_PHOTON_NOTIFY_PORT || '8788'}/notify`;
  try {
    const response = await fetchImpl(url, { method: 'GET', signal });
    if (response.status === 404 || response.status === 405 || response.status === 401) return [];
    return [{ code: 'notify-endpoint-unexpected', severity: 'warn', detail: `notify endpoint returned HTTP ${response.status}` }];
  } catch (error) {
    return [{ code: 'notify-endpoint-down', severity: 'error', detail: redacted(error instanceof Error ? error.message : String(error)) }];
  }
}

async function inspect(deps: Required<Pick<MonitorDeps, 'runCommand' | 'fetch' | 'readMessages'>>, now: Date) {
  const anomalies: ImessageAnomaly[] = [];
  const service = await deps.runCommand('systemctl', ['is-active', bridgeService], { timeoutMs: commandTimeoutMs });
  if (!service.ok || service.stdout.trim() !== 'active') {
    anomalies.push({ code: 'service-inactive', severity: 'error', detail: `systemd reports ${bridgeService} as ${redacted(service.stdout || service.stderr || 'inactive', 120)}`, service: bridgeService });
  }

  const logs = await deps.runCommand('journalctl', ['-u', bridgeService, '--since', `${recentLogMinutes} minutes ago`, '--no-pager', '-n', '120'], { timeoutMs: commandTimeoutMs });
  if (logs.ok) anomalies.push(...analyzePhotonLogs(logs.stdout));
  else anomalies.push({ code: 'journal-unavailable', severity: 'warn', detail: redacted(logs.stderr || logs.stdout || 'journalctl failed'), service: bridgeService });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), notifyProbeTimeoutMs);
  try {
    anomalies.push(...await probeNotifyEndpoint(deps.fetch, controller.signal));
  } finally {
    clearTimeout(timer);
  }

  const messages = await deps.readMessages('main', 80).catch(() => [] as ThreadMessage[]);
  anomalies.push(...analyzeThreadMessages(messages, now, monitorMaxWaitMs()));
  return anomalies;
}

async function restartService(deps: Required<Pick<MonitorDeps, 'runCommand'>>, service: string, user = false) {
  const args = user ? ['--user', 'restart', service] : ['restart', service];
  let result = await deps.runCommand('systemctl', args, { timeoutMs: commandTimeoutMs });
  if (!result.ok && !user) {
    result = await deps.runCommand('sudo', ['-n', 'systemctl', 'restart', service], { timeoutMs: commandTimeoutMs });
  }
  return { service, ok: result.ok, detail: redacted(result.stderr || result.stdout || (result.ok ? 'restarted' : 'restart failed'), 240) };
}

async function repair(anomalies: ImessageAnomaly[], deps: Required<Pick<MonitorDeps, 'runCommand'>>) {
  const repairs: ImessageMonitorResult['repairs'] = [];
  if (!serviceNeedsRestart(anomalies)) return repairs;
  repairs.push(await restartService(deps, bridgeService, false));
  for (const service of repairUserServices) repairs.push(await restartService(deps, service, true));
  return repairs;
}

function successText(anomalies: ImessageAnomaly[], repairs: ImessageMonitorResult['repairs']) {
  const services = repairs.filter((item) => item.ok).map((item) => item.service.replace(/\.service$/, '')).join(', ') || 'the iMessage bridge';
  const problem = anomalies.some((item) => item.code === 'service-inactive') ? 'it had stopped responding' : 'it looked unhealthy';
  return `I noticed the iMessage bridge ${problem}, restarted ${services}, and it looks healthy again now.`;
}

function failureText(anomalies: ImessageAnomaly[], repairs: ImessageMonitorResult['repairs']) {
  const problems = anomalies.map((item) => `${item.code}: ${item.detail}`).slice(0, 4).join('; ');
  const repairSummary = repairs.map((item) => `${item.service} ${item.ok ? 'ok' : 'failed'}`).join(', ') || 'no repair attempted';
  return safeNotificationText(`I could not repair the iMessage bridge automatically. Problems: ${problems}. Repairs: ${repairSummary}.`);
}

export async function runImessageMonitor(deps: MonitorDeps = {}): Promise<ImessageMonitorResult> {
  const now = (deps.now || (() => new Date()))();
  const runCommand = deps.runCommand || command;
  const fetchImpl = deps.fetch || fetch;
  const readMessages = deps.readMessages || readThreadMessages;
  const appendMain = deps.appendMain || ((text: string) => appendThreadMessage('main', 'assistant', text, { unread: true, source: 'imessage-monitor' }));
  const imessageNotify = deps.notifyImessage || notifyImessage;
  const pushoverNotify = deps.notifyPushover || notifyPushover;

  if (!enabled()) return { status: 'skipped', skippedReason: 'disabled', anomalies: [], repairs: [] };

  const state = await readState();
  if (state.lastRunAt && now.getTime() - Date.parse(state.lastRunAt) < monitorIntervalMs()) {
    return { status: 'skipped', skippedReason: 'interval', anomalies: [], repairs: [] };
  }
  state.lastRunAt = now.toISOString();
  await writeState(state);

  try {
    const firstAnomalies = await inspect({ runCommand, fetch: fetchImpl, readMessages }, now);
    if (firstAnomalies.length === 0) {
      await appendMonitorLog('healthy', { anomalies: [] });
      return { status: 'healthy', anomalies: [], repairs: [] };
    }

    await appendMonitorLog('anomaly', { anomalies: firstAnomalies });
    const repairs = await repair(firstAnomalies, { runCommand });
    await appendMonitorLog('repair_attempt', { anomalies: firstAnomalies, repairs });
    await new Promise((resolve) => setTimeout(resolve, Number(process.env.MI_IMESSAGE_MONITOR_VERIFY_DELAY_MS || 3000)));

    const postRepairAnomalies = await inspect({ runCommand, fetch: fetchImpl, readMessages }, now);
    const hardPostRepairAnomalies = postRepairAnomalies.filter((item) => item.severity === 'error');
    if (repairs.some((item) => item.ok) && hardPostRepairAnomalies.length === 0) {
      const text = successText(firstAnomalies, repairs);
      const notified = await imessageNotify('Mi iMessage bridge fixed', text, { requireEnabled: false }).then((result: any) => Boolean(result?.ok)).catch(() => false);
      if (!notified) {
        await appendMain(failureText([{ code: 'repair-notify-failed', severity: 'error', detail: 'repair looked successful but iMessage notification failed' }, ...postRepairAnomalies], repairs));
        await pushoverNotify('Mi iMessage bridge repair', 'I fixed the iMessage bridge, but the bridge could not send the repair confirmation.');
      }
      state.openIncidentAt = undefined;
      state.lastNotificationAt = now.toISOString();
      await writeState(state);
      await appendMonitorLog('repaired', { anomalies: firstAnomalies, repairs, notified });
      return { status: 'repaired', anomalies: firstAnomalies, repairs, notified };
    }

    const text = failureText(postRepairAnomalies.length ? postRepairAnomalies : firstAnomalies, repairs);
    await appendMain(text);
    await pushoverNotify('Mi iMessage bridge needs help', text);
    state.openIncidentAt ||= now.toISOString();
    await writeState(state);
    await appendMonitorLog('unrepaired', { anomalies: postRepairAnomalies.length ? postRepairAnomalies : firstAnomalies, repairs });
    return { status: 'unrepaired', anomalies: postRepairAnomalies.length ? postRepairAnomalies : firstAnomalies, repairs, notified: false };
  } catch (error) {
    const detail = redacted(error instanceof Error ? error.message : String(error));
    await appendMonitorLog('error', { error: detail });
    return { status: 'error', anomalies: [{ code: 'monitor-error', severity: 'error', detail }], repairs: [] };
  }
}
