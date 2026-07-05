import { appendFile, chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { notify } from './notify.js';
import { appendThreadMessage } from './threads.js';
import { runFlueChat, type FlueChatResult } from './flue.js';
import { redactSecrets } from './redact.js';
import { logEvent } from './state.js';

export type MiCron = {
  name: string;
  enabled: boolean;
  every?: string;
  at?: string;
  command?: string;
  message?: string;
  prompt?: string;
  thread?: string;
  cwd?: string;
  lastRunAt?: string;
  lastStatus?: 'ok' | 'error';
  lastOutput?: string;
  disabledReason?: string;
};

const HOME = process.env.HOME || homedir();
const STATE_DIR = join(HOME, 'mi', 'state');
const CRONS_PATH = join(STATE_DIR, 'crons.json');
const LOG_PATH = join(STATE_DIR, 'cron-runs.jsonl');
const TURN_CRON_OUTPUT_LIMIT = 4000;
const inFlightTurnCrons = new Set<string>();

function now() { return new Date().toISOString(); }

export function intervalToMs(value: string): number | undefined {
  const match = value.trim().match(/^(\d+)\s*(s|m|h|d)$/i);
  if (!match) return undefined;
  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  if (unit === 's') return amount * 1000;
  if (unit === 'm') return amount * 60_000;
  if (unit === 'h') return amount * 60 * 60_000;
  if (unit === 'd') return amount * 24 * 60 * 60_000;
  return undefined;
}


function cronKindCount(cron: MiCron) {
  return [cron.command, cron.message, cron.prompt].filter((value) => typeof value === 'string' && value.trim().length > 0).length;
}

function validateCronShape(cron: MiCron) {
  if (!cron.name?.trim()) return 'cron name required';
  if (Boolean(cron.every) === Boolean(cron.at)) return 'cron needs exactly one of every or at';
  if (cron.every) {
    const ms = intervalToMs(cron.every);
    if (!ms || ms < 60_000) return 'cron interval must be like 1m, 10m, 1h, 1d and at least 1m';
  }
  if (cron.at && !Number.isFinite(Date.parse(cron.at))) return 'reminder time must be an ISO timestamp';
  if (cronKindCount(cron) !== 1) return 'cron needs exactly one of command, message, or prompt';
  if (cron.thread && !cron.prompt) return 'cron thread is only valid with prompt';
  return undefined;
}

function truncateTurnCronOutput(output: string) {
  const redacted = redactOutput(output);
  if (redacted.length <= TURN_CRON_OUTPUT_LIMIT) return redacted;
  return `${redacted.slice(0, TURN_CRON_OUTPUT_LIMIT)}\n\n[truncated to ${TURN_CRON_OUTPUT_LIMIT} chars]`;
}

function turnCronPrompt(cron: MiCron, firedAt: string) {
  return `Scheduled Mi turn cron fired.\nName: ${cron.name}\nSchedule: ${cron.every ? `every ${cron.every}` : `at ${cron.at}`}\nFired at: ${firedAt}\n\nUser prompt:\n${cron.prompt}`;
}

async function ensureState() {
  await mkdir(dirname(CRONS_PATH), { recursive: true, mode: 0o700 });
  await chmod(dirname(CRONS_PATH), 0o700).catch(() => undefined);
}

export async function readCrons(): Promise<MiCron[]> {
  await ensureState();
  if (!existsSync(CRONS_PATH)) return [];
  const raw = await readFile(CRONS_PATH, 'utf8');
  if (!raw.trim()) return [];
  const crons = JSON.parse(raw) as MiCron[];
  let changed = false;
  for (const cron of crons) {
    const reason = validateCronShape(cron);
    if (reason && cron.enabled !== false) {
      cron.enabled = false;
      cron.disabledReason = reason;
      changed = true;
      await logEvent('mi.cron.invalid', { name: cron.name, reason }).catch(() => undefined);
    }
  }
  if (changed) await writeCrons(crons);
  return crons;
}

export async function writeCrons(crons: MiCron[]) {
  await ensureState();
  await writeFile(CRONS_PATH, JSON.stringify(crons, null, 2), { mode: 0o600 });
  await chmod(CRONS_PATH, 0o600).catch(() => undefined);
}

export async function upsertCron(cron: MiCron) {
  const validationError = validateCronShape(cron);
  if (validationError) throw new Error(validationError);
  const crons = await readCrons();
  const index = crons.findIndex((item) => item.name === cron.name);
  if (index >= 0) crons[index] = { ...crons[index], ...cron };
  else crons.push(cron);
  await writeCrons(crons);
  return cron;
}

export async function removeCron(name: string) {
  const crons = await readCrons();
  const next = crons.filter((cron) => cron.name !== name);
  await writeCrons(next);
  return crons.length - next.length;
}

function due(cron: MiCron, at = Date.now()) {
  if (!cron.enabled) return false;
  if (cron.at) return Date.parse(cron.at) <= at;
  const ms = cron.every ? intervalToMs(cron.every) : undefined;
  if (!ms) return false;
  if (!cron.lastRunAt) return true;
  return at - Date.parse(cron.lastRunAt) >= ms;
}

function formatCronErrorMessage(cron: MiCron, output: string) {
  const detail = output.trim() || 'No output captured.';
  return `Mi cron error: ${cron.name}\n\n${detail}\n\nState: ${CRONS_PATH}\nLog: ${LOG_PATH}`;
}

async function surfaceCronError(cron: MiCron, output: string) {
  const message = formatCronErrorMessage(cron, output);
  await appendThreadMessage('main', 'assistant', message, { unread: true, source: 'mi-cron' });
  await notify(`Mi cron error: ${cron.name}`, message).catch(() => ({ skipped: true }));
}

function redactOutput(output: string) {
  return String(redactSecrets(output));
}

function splitCronCommand(command: string) {
  const parts: string[] = [];
  let current = '';
  let quote: 'single' | 'double' | undefined;
  let escaped = false;
  for (const char of command.trim()) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === '\\' && quote !== 'single') {
      escaped = true;
      continue;
    }
    if (char === "'" && quote !== 'double') {
      quote = quote === 'single' ? undefined : 'single';
      continue;
    }
    if (char === '"' && quote !== 'single') {
      quote = quote === 'double' ? undefined : 'double';
      continue;
    }
    if (!quote && /\s/.test(char)) {
      if (current) parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  if (escaped || quote) throw new Error('cron command has unfinished escape or quote');
  if (current) parts.push(current);
  if (!parts.length) throw new Error('cron command is empty');
  if (parts.some((part) => /[;&|`$<>]/.test(part))) throw new Error('cron command contains shell metacharacters; use a simple executable plus args');
  return { file: parts[0], args: parts.slice(1) };
}

function cronEnv() {
  const keys = ['HOME', 'USER', 'LOGNAME', 'PATH', 'SHELL', 'LANG', 'LC_ALL', 'TERM'];
  return Object.fromEntries(keys.flatMap((key) => process.env[key] ? [[key, process.env[key] as string]] : []));
}

async function appendCronLog(record: unknown) {
  await ensureState();
  await appendFile(LOG_PATH, `${JSON.stringify(redactSecrets(record))}\n`, { mode: 0o600 });
  await chmod(LOG_PATH, 0o600).catch(() => undefined);
}

export async function runCron(cron: MiCron, options: { flueChat?: (message: string) => Promise<FlueChatResult> } = {}) {
  const startedAt = now();
  if (cron.message && !cron.command) {
    await appendThreadMessage('main', 'assistant', cron.message, { unread: true, source: 'mi-reminder' });
    const sent = await notify('Mi reminder', cron.message).catch(() => ({ skipped: true }));
    const result = { status: 'ok' as const, output: `Reminder: ${cron.message}${sent?.skipped ? ' (notification skipped)' : ''}` };
    await appendCronLog({ name: cron.name, startedAt, finishedAt: now(), ...result });
    return result;
  }
  if (cron.prompt && !cron.command && !cron.message) {
    if (inFlightTurnCrons.has(cron.name)) {
      const result = { status: 'skipped' as const, output: 'Turn cron already in flight' };
      await appendCronLog({ ts: startedAt, name: cron.name, status: result.status, durationMs: 0, outputChars: 0 });
      return result;
    }
    inFlightTurnCrons.add(cron.name);
    const firedAt = startedAt;
    const started = Date.now();
    try {
      const flueChat = options.flueChat || runFlueChat;
      const chat = await flueChat(turnCronPrompt(cron, firedAt));
      if (!chat.ok) throw new Error(chat.error || 'turn cron model call failed');
      const output = truncateTurnCronOutput(chat.reply || '');
      await appendThreadMessage(cron.thread || 'main', 'assistant', output, { unread: true, source: `cron:${cron.name}` });
      await notify('Mi scheduled turn', output).catch(() => ({ skipped: true }));
      const result = { status: 'ok' as const, output };
      await appendCronLog({ ts: startedAt, name: cron.name, status: 'ok', durationMs: Date.now() - started, outputChars: output.length });
      await logEvent('mi.cron.turn', { name: cron.name, status: 'ok', durationMs: Date.now() - started, outputChars: output.length });
      return result;
    } catch (e) {
      const output = redactOutput(e instanceof Error ? e.message : String(e));
      const result = { status: 'error' as const, output };
      await appendCronLog({ ts: startedAt, name: cron.name, status: 'error', durationMs: Date.now() - started, outputChars: 0, error: output });
      await logEvent('mi.cron.turn', { name: cron.name, status: 'error', durationMs: Date.now() - started, error: output });
      return result;
    } finally {
      inFlightTurnCrons.delete(cron.name);
    }
  }
  if (!cron.command) throw new Error(`cron ${cron.name} has no command`);
  const { file, args } = splitCronCommand(cron.command);
  const result = await new Promise<{ status: 'ok' | 'error'; output: string }>((resolve) => {
    const child = spawn(file, args, { cwd: cron.cwd || HOME, shell: false, env: cronEnv() });
    let output = '';
    child.stdout.on('data', (data) => { output += data.toString(); });
    child.stderr.on('data', (data) => { output += data.toString(); });
    child.on('error', (error) => resolve({ status: 'error', output: redactOutput(String(error)) }));
    child.on('close', (code) => resolve({ status: code === 0 ? 'ok' : 'error', output: redactOutput(output.slice(-4000)) }));
  });
  await appendCronLog({ name: cron.name, startedAt, finishedAt: now(), ...result });
  if (result.status === 'error') await surfaceCronError(cron, result.output);
  return result;
}

export async function tickCrons(options: { remindersOnly?: boolean; flueChat?: (message: string) => Promise<FlueChatResult>; turnCronLimit?: number } = {}) {
  const crons = await readCrons();
  const ran: Array<{ name: string; status: 'ok' | 'error' | 'skipped' }> = [];
  let turnCronsRun = 0;
  const turnCronLimit = options.turnCronLimit ?? Number(process.env.MI_TURN_CRONS_PER_TICK || 2);
  for (const cron of crons) {
    if (!due(cron)) continue;
    if (options.remindersOnly && cron.command) {
      ran.push({ name: cron.name, status: 'skipped' });
      continue;
    }
    if (cron.prompt && turnCronsRun >= turnCronLimit) {
      ran.push({ name: cron.name, status: 'skipped' });
      continue;
    }
    if (cron.prompt) turnCronsRun += 1;
    const result = await runCron(cron, { flueChat: options.flueChat });
    if (result.status !== 'skipped') {
      cron.lastRunAt = now();
      cron.lastStatus = result.status;
      cron.lastOutput = redactOutput(result.output).slice(-1000);
      if (cron.at) cron.enabled = false;
    }
    ran.push({ name: cron.name, status: result.status });
  }
  await writeCrons(crons);
  return ran;
}

export async function tickReminderCrons() {
  return tickCrons({ remindersOnly: true });
}

export function cronPaths() { return { cronsPath: CRONS_PATH, logPath: LOG_PATH }; }
