#!/usr/bin/env node
import 'dotenv/config';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { createInterface } from 'node:readline/promises';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { stdin as input, stdout as output } from 'node:process';
import { draftAssistant, proposeAssistantEdit } from './builder.js';
import { assistantPath } from './assistant.js';
import { checkAssistant, runAssistant } from './runner.js';
import { readRunRecords } from './primitives.js';
import { runFlueChat } from './flue.js';
import { readRecentEvents, logEvent } from './state.js';
import { cronPaths, readCrons, removeCron, tickCrons, upsertCron } from './crons.js';
import { createUploadLink } from './uploads.js';
import {
  appendThreadMessage,
  compactThread,
  createTempThread,
  getThread,
  listThreads,
  markThreadRead,
  readThreadMessages,
  threadContext,
} from './threads.js';

function usage() {
  return `Mi - tiny private assistant harness

Usage:
  mi                              Open the full-screen Mi terminal UI
  mi pi                           Open Mi main in pi
  mi raw                          Open the minimal fallback conversation
  mi --once <message>             Send one message to main and exit
  mi chat [thread]                Open main or an existing temporary conversation
  mi ask [--thread <id>] <message> Send one message to a Mi thread and exit
  mi inbox                        Show Mi main + temporary conversations
  mi threads                      List Mi conversations
  mi temp <title>                 Create/open a temporary conversation
  mi compact [thread]             Compact old read messages in a thread
  mi upload                       Create a temporary one-time image upload link
  mi cron list|tick|remove <name>
  mi cron add <name> --every 1h [--cwd <path>] -- <command>
  mi task <name> [--cwd <path>] -- <task prompt>
  mi task reply <task-id-or-name> -- <follow-up prompt>
  mi task list

  mi make <description> [--name <name>]
  mi run <assistant>
  mi edit <assistant> <change>
  mi check <assistant>
  mi logs <assistant> [limit]
`;
}

function argValue(args: string[], flag: string) {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  return args[index + 1];
}

function argsWithoutFlag(args: string[], flag: string) {
  const index = args.indexOf(flag);
  if (index === -1) return args;
  return args.filter((_, i) => i !== index && i !== index + 1);
}

async function writeAssistantFile(path: string, markdown: string) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, markdown);
}

async function makeCommand(args: string[]) {
  const name = argValue(args, '--name');
  const description = args.filter((arg, i) => arg !== '--name' && args[i - 1] !== '--name').join(' ').trim();
  if (!description) throw new Error('description required');
  const draft = draftAssistant({ description, name });
  await writeAssistantFile(draft.path, draft.markdown);
  await logEvent('mi.make', { name: draft.name, path: draft.path });
  console.log(`Created ${draft.path}`);
}

async function uploadCommand() {
  const link = await createUploadLink();
  console.log(`Upload image: ${link.url}`);
  console.log(`Expires: ${link.expiresAt}`);
  console.log(`Max bytes: ${link.maxBytes}`);
}

async function runCommand(args: string[]) {
  const name = args[0];
  if (!name) throw new Error('assistant name required');
  const result = await runAssistant({ name, trigger: 'manual' });
  await logEvent('mi.run', result);
  console.log(`${name}: ${result.status}`);
  console.log(result.summary);
  if (result.status === 'error') process.exitCode = 1;
}

async function editCommand(args: string[]) {
  const name = args[0];
  const change = args.slice(1).join(' ').trim();
  if (!name) throw new Error('assistant name required');
  if (!change) throw new Error('change required');
  const path = assistantPath(name);
  const currentMarkdown = await readFile(path, 'utf8');
  const draft = proposeAssistantEdit({ name, change, currentMarkdown });
  await writeAssistantFile(draft.path, draft.markdown);
  await logEvent('mi.edit', { name, path: draft.path, change });
  console.log(`Updated ${draft.path}`);
}

async function checkCommand(args: string[]) {
  const name = args[0];
  if (!name) throw new Error('assistant name required');
  const result = await checkAssistant(name);
  console.log(`${result.path}: ${result.ok ? 'ok' : 'needs work'}`);
  for (const issue of result.issues) console.log(`- ${issue}`);
  if (!result.ok) process.exitCode = 1;
}

async function logsCommand(args: string[]) {
  const name = args[0];
  if (!name) throw new Error('assistant name required');
  const limit = Number(args[1] || 20);
  const runs = await readRunRecords(Number.isFinite(limit) ? limit : 20);
  const matchingRuns = runs.filter((run) => run.assistant === name || JSON.stringify(run).includes(name));
  for (const run of matchingRuns) console.log(JSON.stringify(run));

  const events = await readRecentEvents(Number.isFinite(limit) ? limit : 20);
  const matchingEvents = events.filter((event: any) => JSON.stringify(event).includes(name));
  for (const event of matchingEvents) console.log(JSON.stringify(event));
}

function renderThreadLine(thread: { id: string; title: string; kind: string; unread: number; updatedAt: string }) {
  const unread = thread.unread > 0 ? `  ${thread.unread} unread` : '';
  const label = thread.kind === 'main' ? 'main' : `temp: ${thread.title}`;
  return `${label.padEnd(32)} ${thread.updatedAt}${unread}`;
}

async function inboxCommand() {
  const threads = await listThreads();
  console.log('Mi');
  for (const thread of threads) console.log(`  ${renderThreadLine(thread)}`);
}

async function showThread(threadId: string) {
  const thread = await getThread(threadId);
  if (!thread) throw new Error(`thread not found: ${threadId}`);
  const messages = await readThreadMessages(threadId, 30);
  const unread = messages.filter((message) => message.unread);

  console.log(`Mi / ${thread.title}`);
  if (unread.length > 0) {
    console.log(`\nUnread:`);
    for (const message of unread) console.log(`${message.role}> ${message.text}`);
  } else if (messages.length > 0) {
    console.log('\nRecent:');
    for (const message of messages.slice(-8)) console.log(`${message.role}> ${message.text}`);
  } else {
    console.log('\nNo messages yet.');
  }
  await markThreadRead(threadId);
}

function timezoneOffsetMs(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(date).reduce<Record<string, string>>((acc, part) => {
    if (part.type !== 'literal') acc[part.type] = part.value;
    return acc;
  }, {});
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  return asUtc - date.getTime();
}

function localTimeToUtcIso(hour: number, minute: number, timeZone = 'America/New_York') {
  const nowDate = new Date();
  const nowParts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(nowDate).reduce<Record<string, string>>((acc, part) => {
    if (part.type !== 'literal') acc[part.type] = part.value;
    return acc;
  }, {});
  let guess = new Date(Date.UTC(Number(nowParts.year), Number(nowParts.month) - 1, Number(nowParts.day), hour, minute, 0));
  guess = new Date(guess.getTime() - timezoneOffsetMs(guess, timeZone));
  if (guess.getTime() <= nowDate.getTime()) guess = new Date(guess.getTime() + 24 * 60 * 60_000);
  return guess.toISOString();
}

async function maybeHandleLocalIntent(message: string) {
  const match = message.trim().match(/^remind\s+me\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s+(.+)$/i);
  if (!match) return undefined;
  let hour = Number(match[1]);
  const minute = Number(match[2] || '0');
  const meridiem = match[3]?.toLowerCase();
  const text = match[4].trim();
  if (meridiem === 'pm' && hour < 12) hour += 12;
  if (meridiem === 'am' && hour === 12) hour = 0;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59 || !text) return undefined;
  const at = localTimeToUtcIso(hour, minute);
  const name = `reminder-${Date.now().toString(36)}`;
  await upsertCron({ name, at, message: text, enabled: true });
  return `Reminder set for ${new Date(at).toLocaleString('en-US', { timeZone: 'America/New_York', dateStyle: 'short', timeStyle: 'short' })}: ${text}`;
}

async function askMi(threadId: string, message: string) {
  const thread = await getThread(threadId);
  if (!thread) throw new Error(`thread not found: ${threadId}`);
  await appendThreadMessage(threadId, 'user', message, { unread: false, source: 'cli' });
  await logEvent('mi.thread.user', { threadId, message });

  const localReply = await maybeHandleLocalIntent(message);
  if (localReply) {
    await appendThreadMessage(threadId, 'assistant', localReply, { unread: false, source: 'mi-local' });
    return localReply;
  }

  const context = await threadContext(threadId);
  const prompt = `You are Mi, Kyle's private persistent assistant. Reply as Mi in the current conversation. Be concise. Do not claim to have inspected files or services unless context explicitly says so. Risky actions require approval. If Kyle asks in plain English to monitor, periodically check, alert on, or schedule something, translate that into a Mi cron when enough details are known. Mi crons live in /home/kyle/mi/state/crons.json and are managed with: mi cron add <name> --every 1h [--cwd <path>] -- <command>; mi cron list; mi cron tick; mi cron remove <name>. If details are missing, ask only for the missing repo/path, cadence, health command, and alert behavior. When Kyle gives Mi a substantive task that needs coding, repo inspection, testing, research, or multi-step work, immediately hand it off to a background pi worker instead of doing the work in Mi. If there is already a relevant running/background task, continue that same session; otherwise create a new background pi worker conversation with: mi task <name> [--cwd <path>] -- <task prompt>. Name it clearly. Mi task wraps the prompt in /goal by default for sustained execution. This command returns after the worker starts; do not wait for the task to finish before replying to Kyle. Worker sessions use /home/kyle/.pi/agent/sessions so Kyle can see them in /resume. Use mi task list to inspect background task status. When Kyle responds to a task result or asks for changes/follow-up on a task, continue the same worker conversation with: mi task reply <task-id-or-name> -- <follow-up prompt>. Follow-ups are also wrapped in /goal by default unless already using /goal. Escalate to Kyle when approval, ambiguity, or risk blocks progress. If the worker opens or updates a PR, it must include the full GitHub PR URL in its final answer and state whether it needs Kyle review/merge.\n\nThread: ${thread.title}\n\n${context}\n\nCurrent user message:\n${message}`;
  const result = await runFlueChat(prompt);
  const reply = result.reply || 'Got it.';
  await appendThreadMessage(threadId, 'assistant', reply, { unread: false, source: result.source });
  await logEvent('mi.thread.assistant', { threadId, source: result.source, ok: result.ok });
  return reply;
}

async function askCommand(args: string[]) {
  const threadId = argValue(args, '--thread') || 'main';
  const message = argsWithoutFlag(args, '--thread').join(' ').trim();
  if (!message) throw new Error('message required');
  console.log(await askMi(threadId, message));
}

async function onceCommand(args: string[]) {
  const message = args.join(' ').trim();
  if (!message) throw new Error('message required');
  console.log(await askMi('main', message));
}

async function tempCommand(args: string[]) {
  const title = args.join(' ').trim();
  if (!title) {
    const temps = (await listThreads()).filter((thread) => thread.kind === 'temporary');
    if (temps.length === 0) console.log('No temporary conversations.');
    else for (const thread of temps) console.log(renderThreadLine(thread));
    return;
  }
  const thread = await createTempThread(title);
  await miTuiCommand(thread.id);
}

async function compactCommand(args: string[]) {
  const threadId = args[0] || 'main';
  const result = await compactThread(threadId);
  await logEvent('mi.thread.compact', result);
  console.log(`Compacted ${result.compacted} message(s), kept ${result.kept}.`);
  console.log(`Summary: ${result.summaryPath}`);
  if (result.archivePath) console.log(`Archive: ${result.archivePath}`);
}

async function taskCommand(args: string[]) {
  const name = args[0];
  if (name === 'reply') {
    const taskId = args[1];
    const sep = args.indexOf('--');
    const message = sep >= 0 ? args.slice(sep + 1).join(' ').trim() : args.slice(2).join(' ').trim();
    if (!taskId || !message) throw new Error('usage: mi task reply <task-id-or-name> -- <follow-up prompt>');
    const payload = { type: 'continue_worker', taskId, message, background: true };
    const result = await sendSocketRequest(payload, 30_000).catch(async (error) => {
      if (existsSync(MI_SOCKET_PATH) && !isSocketConnectionRefused(error)) throw error;
      await startMiDaemon();
      return sendSocketRequest(payload, 30_000);
    });
    console.log(result.text || 'Sent follow-up.');
    if (result.taskId) console.log(`Task: ${result.taskId}`);
    if (result.sessionName) console.log(`Session: ${result.sessionName}`);
    if (result.sessionFile) console.log(`Visible in /resume: ${result.sessionFile}`);
    return;
  }
  if (name === 'list') {
    const result = await sendSocketRequest({ type: 'list_tasks' }, 10000).catch(async (error) => {
      if (existsSync(MI_SOCKET_PATH) && !isSocketConnectionRefused(error)) throw error;
      await startMiDaemon();
      return sendSocketRequest({ type: 'list_tasks' }, 10000);
    });
    console.log(JSON.stringify(result.tasks || [], null, 2));
    return;
  }
  const cwd = argValue(args, '--cwd') || '/home/kyle';
  const sep = args.indexOf('--');
  const message = sep >= 0 ? args.slice(sep + 1).join(' ').trim() : args.slice(1).join(' ').trim();
  if (!name || !message) throw new Error('usage: mi task <name>|list [--cwd <path>] -- <task prompt>');
  const payload = { type: 'run_worker', name, cwd, message, background: true };
  try {
    const result = await sendSocketRequest(payload, 30_000);
    console.log(result.text || 'Started background task.');
    if (result.taskId) console.log(`Task: ${result.taskId}`);
    if (result.sessionName) console.log(`Session: ${result.sessionName}`);
    if (result.sessionFile) console.log(`Visible in /resume: ${result.sessionFile}`);
  } catch (error) {
    if (existsSync(MI_SOCKET_PATH) && !isSocketConnectionRefused(error)) throw error;
    await startMiDaemon();
    const result = await sendSocketRequest(payload, 30_000);
    console.log(result.text || 'Started background task.');
    if (result.taskId) console.log(`Task: ${result.taskId}`);
    if (result.sessionName) console.log(`Session: ${result.sessionName}`);
    if (result.sessionFile) console.log(`Visible in /resume: ${result.sessionFile}`);
  }
}

async function cronCommand(args: string[]) {
  const sub = args[0] || 'list';
  if (sub === 'list') {
    const crons = await readCrons();
    if (crons.length === 0) {
      console.log('No Mi crons.');
      console.log(`State: ${cronPaths().cronsPath}`);
      return;
    }
    for (const cron of crons) {
      const schedule = cron.at ? `at ${cron.at}` : `every ${cron.every}`;
      const action = cron.message || cron.command || '';
      console.log(`${cron.enabled ? 'on ' : 'off'} ${cron.name} ${schedule}${cron.cwd ? ` cwd=${cron.cwd}` : ''} last=${cron.lastStatus || 'never'} — ${action}`);
    }
    return;
  }
  if (sub === 'tick') {
    const ran = await tickCrons();
    console.log(ran.length ? JSON.stringify(ran, null, 2) : 'No crons due.');
    return;
  }
  if (sub === 'remove') {
    const name = args[1];
    if (!name) throw new Error('usage: mi cron remove <name>');
    console.log(`Removed ${await removeCron(name)} cron(s).`);
    return;
  }
  if (sub === 'add') {
    const name = args[1];
    const every = argValue(args, '--every');
    const cwd = argValue(args, '--cwd');
    const sep = args.indexOf('--');
    const command = sep >= 0 ? args.slice(sep + 1).join(' ').trim() : '';
    if (!name || !every || !command) throw new Error('usage: mi cron add <name> --every 1h [--cwd <path>] -- <command>');
    await upsertCron({ name, every, cwd, command, enabled: true });
    console.log(`Saved cron ${name}. Run due jobs with: mi cron tick`);
    return;
  }
  throw new Error(`unknown cron command: ${sub}`);
}

async function chatCommand(threadId = 'main') {
  await showThread(threadId);
  console.log('\nType a message. Commands: /compact, /exit');
  const rl = createInterface({ input, output });
  try {
    while (true) {
      const line = (await rl.question('you> ')).trim();
      if (!line) continue;
      if (line === '/exit' || line === '/quit') break;
      if (line === '/help') {
        console.log('Commands: /compact, /exit');
        continue;
      }
      if (line === '/compact') {
        await compactCommand([threadId]);
        continue;
      }
      const reply = await askMi(threadId, line);
      console.log(`mi> ${reply}`);
    }
  } finally {
    rl.close();
  }
}

const HOME = homedir();
const PUSHOVER_ENDPOINT = 'https://api.pushover.net/1/messages.json';
const PUSHOVER_ENV_FILE = join(HOME, '.config', 'pushover', 'env');
const PUSHOVER_MESSAGE_LIMIT = 1024;
const MI_TASKS_DIR = join(HOME, 'mi');
const MI_RUNTIME_DIR = process.env.MI_RUNTIME_DIR || join(HOME, '.pi', 'agent', 'mi');
const MI_SOCKET_PATH = process.env.MI_SOCKET_PATH || join(MI_RUNTIME_DIR, 'main.sock');
const MI_DAEMON_PATH = process.env.MI_DAEMON_PATH || join(HOME, '.pi', 'agent', 'extensions', 'mi-daemon.mjs');
const MI_MODEL = process.env.MI_MODEL || 'openai-codex/gpt-5.5:low';
const PI_CYCLE_PATH = join(HOME, '.pi', 'agent', 'pi-cycle.json');

type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
type PiCycleConfig = {
  shortcut: string;
  tiers: Record<string, string[]>;
  thinkingLevels?: Record<string, ThinkingLevel>;
};

type MiTask = {
  id?: string;
  name?: string;
  status?: string;
  startedAt?: string;
  continuedAt?: string;
  finishedAt?: string;
};

function readPushoverEnvFile(): Record<string, string> {
  try {
    const text = readFileSync(PUSHOVER_ENV_FILE, 'utf8');
    const values: Record<string, string> = {};
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (!match) continue;
      let value = match[2].trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      values[match[1]] = value;
    }
    return values;
  } catch {
    return {};
  }
}

function usableSecret(value: string | undefined) {
  return value && !value.includes('${') ? value : undefined;
}

function getPushoverCredentials() {
  const fileEnv = readPushoverEnvFile();
  const token = usableSecret(process.env.PUSHOVER_APP_TOKEN) || usableSecret(fileEnv.PUSHOVER_APP_TOKEN) || usableSecret(process.env.PUSHOVER_TOKEN) || usableSecret(fileEnv.PUSHOVER_TOKEN);
  const user = usableSecret(process.env.PUSHOVER_USER_KEY) || usableSecret(fileEnv.PUSHOVER_USER_KEY) || usableSecret(process.env.PUSHOVER_USER) || usableSecret(fileEnv.PUSHOVER_USER);
  return token && user ? { token, user } : undefined;
}

async function sendPushover(title: string, message: string) {
  const credentials = getPushoverCredentials();
  if (!credentials) return false;
  const body = new URLSearchParams({
    token: credentials.token,
    user: credentials.user,
    title,
    message: message.length > PUSHOVER_MESSAGE_LIMIT ? `${message.slice(0, PUSHOVER_MESSAGE_LIMIT - 1)}…` : message,
    priority: '0',
    monospace: '1',
  });
  const response = await fetch(PUSHOVER_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  return response.ok;
}

function stripAnsi(text: string) {
  return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
}

function widthOf(text: string) {
  return stripAnsi(text).length;
}

function truncateText(text: string, width: number) {
  const plain = stripAnsi(text);
  return plain.length <= width ? text : plain.slice(0, Math.max(0, width));
}

function wrapPlain(text: string, width: number) {
  const normalized = text.replace(/\r/g, '').split('\n');
  const out: string[] = [];
  for (const paragraph of normalized) {
    if (!paragraph) {
      out.push('');
      continue;
    }
    let line = '';
    for (const word of paragraph.split(/\s+/)) {
      if (!word) continue;
      if (!line) {
        while (word.length > width) {
          out.push(word.slice(0, width));
          line = word.slice(width);
          break;
        }
        if (!line) line = word;
      } else if (line.length + 1 + word.length <= width) {
        line += ` ${word}`;
      } else {
        out.push(line);
        line = word;
      }
      while (line.length > width) {
        out.push(line.slice(0, width));
        line = line.slice(width);
      }
    }
    out.push(line);
  }
  return out;
}

const PI_ACCENT = '\x1b[38;2;138;190;183m';
const PI_DIM = '\x1b[38;2;102;102;102m';
const PI_LIGHT_DIM = '\x1b[38;2;170;170;170m';
const PI_USER_BG = '\x1b[48;2;52;53;65m';
const THINKING_COLORS: Record<string, string> = {
  off: '\x1b[38;2;80;80;80m',
  minimal: '\x1b[38;2;110;110;110m',
  low: '\x1b[38;2;95;135;175m',
  medium: '\x1b[38;2;129;162;190m',
  high: '\x1b[38;2;178;148;187m',
  xhigh: '\x1b[38;2;209;131;232m',
};
const RESET_FG = '\x1b[39m';
const RESET_BG = '\x1b[49m';
const INVERSE = '\x1b[7m';
const RESET_INVERSE = '\x1b[27m';
const CURSOR_CELL = ' ';
const WHITE_CURSOR = '\x1b]12;white\x07';
const RESET_CURSOR = '\x1b]112\x07';
const PI_SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

function fgAccent(text: string) {
  return `${PI_ACCENT}${text}${RESET_FG}`;
}

function fgDim(text: string) {
  return `${PI_DIM}${text}${RESET_FG}`;
}

function fgLightDim(text: string) {
  return `${PI_LIGHT_DIM}${text}${RESET_FG}`;
}

function thinkingLabel(level: string | undefined) {
  return level === 'off' ? 'no effort' : (level || 'low');
}

function fgThinking(level: string | undefined, text: string) {
  return `${THINKING_COLORS[level || 'low'] || THINKING_COLORS.low}${text}${RESET_FG}`;
}

function userBgLine(text: string, width: number) {
  const content = truncateText(text, width);
  return `${PI_USER_BG}${content}${' '.repeat(Math.max(0, width - widthOf(content)))}${RESET_BG}`;
}

function workingLine() {
  const frame = PI_SPINNER_FRAMES[Math.floor(Date.now() / 80) % PI_SPINNER_FRAMES.length];
  return `${fgAccent(frame)} ${fgDim('Working...')}`;
}

function formatActiveDuration(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function taskDisplayName(task: MiTask) {
  return (task.name || task.id || 'task').replace(/^Mi task:\s*/i, '').trim() || 'task';
}

function activeTaskSince(task: MiTask) {
  const started = Date.parse(task.continuedAt || task.startedAt || '');
  return Number.isFinite(started) ? started : Date.now();
}

function isActiveTask(task: MiTask) {
  if (task.finishedAt) return false;
  const status = String(task.status || '').toLowerCase();
  if (['complete', 'completed', 'done', 'success', 'succeeded', 'failed', 'error', 'cancelled', 'canceled'].includes(status)) return false;
  return ['running', 'waiting', 'active'].includes(status);
}

function sendSocketRequest(payload: unknown, timeoutMs = 120000): Promise<{ ok?: boolean; error?: string; text?: string; state?: any; sessionFile?: string; sessionId?: string; sessionName?: string; model?: unknown; taskId?: string; tasks?: unknown[] }> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(MI_SOCKET_PATH);
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
        const response = JSON.parse(data.slice(0, data.indexOf('\n'))) as { ok?: boolean; error?: string; text?: string; state?: any; sessionFile?: string; sessionId?: string; sessionName?: string; model?: unknown; taskId?: string; tasks?: unknown[] };
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

function isSocketConnectionRefused(error: unknown) {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === 'ECONNREFUSED');
}

async function startMiDaemon() {
  await mkdir(dirname(MI_SOCKET_PATH), { recursive: true });
  if (existsSync(MI_SOCKET_PATH)) await rm(MI_SOCKET_PATH, { force: true });
  const child = spawn(process.execPath, [MI_DAEMON_PATH], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, MI_SOCKET_PATH, MI_RUNTIME_DIR },
  });
  child.unref();
  for (let i = 0; i < 20; i++) {
    try {
      await sendSocketRequest({ type: 'health' }, 500);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error('Mi main did not start');
}

function normalizeMiResponse(text: string) {
  return text.trim() || 'Mi completed without text.';
}

function miPrompt(message: string) {
  return message;
}

async function requestMi(message: string) {
  const response = await sendSocketRequest({ type: 'prompt', message });
  return normalizeMiResponse(response.text || '');
}

async function abortMiMain() {
  return sendSocketRequest({ type: 'abort' }, 10000).catch(() => undefined);
}

async function getMiState() {
  try {
    return (await sendSocketRequest({ type: 'state' }, 10000)).state;
  } catch (error) {
    if (existsSync(MI_SOCKET_PATH) && !isSocketConnectionRefused(error)) throw error;
    await startMiDaemon();
    return (await sendSocketRequest({ type: 'state' }, 10000)).state;
  }
}

async function setMiModelThinking(modelSpec: string, level?: ThinkingLevel) {
  const [provider, ...idParts] = modelSpec.split('/');
  const modelId = idParts.join('/');
  if (!provider || !modelId) throw new Error(`Invalid model spec: ${modelSpec}`);
  try {
    await sendSocketRequest({ type: 'set_model', provider, modelId }, 30000);
    return level ? (await sendSocketRequest({ type: 'set_thinking', level }, 30000)).state : await getMiState();
  } catch (error) {
    if (existsSync(MI_SOCKET_PATH) && !isSocketConnectionRefused(error)) throw error;
    await startMiDaemon();
    await sendSocketRequest({ type: 'set_model', provider, modelId }, 30000);
    return level ? (await sendSocketRequest({ type: 'set_thinking', level }, 30000)).state : await getMiState();
  }
}

async function setMiThinking(level: ThinkingLevel) {
  return setMiModelThinking('openai-codex/gpt-5.5', level);
}

async function loadPiCycleConfig(): Promise<PiCycleConfig> {
  try {
    const raw = JSON.parse(await readFile(PI_CYCLE_PATH, 'utf8')) as Partial<PiCycleConfig>;
    return {
      shortcut: typeof raw.shortcut === 'string' && raw.shortcut.trim() ? raw.shortcut.trim() : 'z',
      tiers: {
        '1': Array.isArray(raw.tiers?.['1']) ? raw.tiers!['1'] : ['openai-codex/gpt-5.5'],
        '2': Array.isArray(raw.tiers?.['2']) ? raw.tiers!['2'] : ['openai-codex/gpt-5.5'],
        '3': Array.isArray(raw.tiers?.['3']) ? raw.tiers!['3'] : ['openai-codex/gpt-5.5'],
      },
      thinkingLevels: raw.thinkingLevels || {},
    };
  } catch {
    return { shortcut: 'z', tiers: { '1': ['openai-codex/gpt-5.5'], '2': ['openai-codex/gpt-5.5'], '3': ['openai-codex/gpt-5.5'] }, thinkingLevels: {} };
  }
}

async function sendToMiMain(message: string): Promise<string> {
  try {
    return await requestMi(miPrompt(message));
  } catch (error) {
    if (existsSync(MI_SOCKET_PATH) && !isSocketConnectionRefused(error)) throw error;
  }
  await startMiDaemon();
  return await requestMi(miPrompt(message));
}

async function miTuiCommand(threadId = 'main', initial = '') {
  await mkdir(MI_TASKS_DIR, { recursive: true });
  const initialMessages = await readThreadMessages(threadId, 300);
  const seenMessageIds = new Set(initialMessages.map((message) => message.id));
  let transcript = initialMessages
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .map((message) => ({ role: message.role as 'user' | 'assistant', text: message.text }));
  await markThreadRead(threadId);

  let miState: any;
  let piCycleConfig = await loadPiCycleConfig();
  const piCycleNextIndex: Record<string, number> = { '1': 0, '2': 0, '3': 0 };
  let statusMessage = `Shift+Tab thinking • ${piCycleConfig.shortcut}/${piCycleConfig.shortcut.repeat(2)}/${piCycleConfig.shortcut.repeat(3)} pi-cycle`;
  let inputLine = '';
  let pending = false;
  const messageQueue: string[] = [];
  let scrollOffset = 0;
  let closed = false;
  let renderTimer: NodeJS.Timeout | undefined;
  let workingTimer: NodeJS.Timeout | undefined;
  let threadPollTimer: NodeJS.Timeout | undefined;
  let taskPollTimer: NodeJS.Timeout | undefined;
  let activeTasks: MiTask[] = [];
  let lastSigintTime = 0;
  let slashSelectedIndex = 0;

  const rows = () => process.stdout.rows || 24;
  const cols = () => process.stdout.columns || 80;

  getMiState()
    .then((state) => {
      miState = state;
      requestRender();
    })
    .catch((error) => {
      statusMessage = error instanceof Error ? error.message : String(error);
      requestRender();
    });

  function refreshActiveTasks() {
    sendSocketRequest({ type: 'list_tasks' }, 5000)
      .then((result) => {
        activeTasks = ((result.tasks || []) as MiTask[]).filter(isActiveTask);
        requestRender();
      })
      .catch(() => undefined);
  }

  refreshActiveTasks();
  taskPollTimer = setInterval(refreshActiveTasks, 1000);

  function requestRender() {
    if (renderTimer) return;
    renderTimer = setTimeout(() => {
      renderTimer = undefined;
      render();
    }, 16);
  }

  function setPending(next: boolean) {
    if (pending === next) return;
    pending = next;
    if (pending) {
      workingTimer = setInterval(requestRender, 80);
    } else if (workingTimer) {
      clearInterval(workingTimer);
      workingTimer = undefined;
    }
  }

  function inputText() {
    return inputLine;
  }

  function inputDisplayText() {
    return inputText();
  }

  function inputWrappedPlainLines(width: number) {
    const wrapWidth = Math.max(1, width);
    const text = inputDisplayText();
    const lines: string[] = [];
    for (let i = 0; i < text.length; i += wrapWidth) lines.push(text.slice(i, i + wrapWidth));
    return lines.length ? lines : [''];
  }

  function slashSuggestions() {
    const slashCommands = [
      { command: '/quit', description: 'Quit Mi' },
      { command: '/stop', description: 'Abort the current Mi turn' },
      { command: '/reload', description: 'Reload Mi' },
      { command: '/status', description: 'Show model/session status' },
      { command: '/compact', description: 'Compact old read thread history' },
      { command: '/upload', description: 'Create a temporary image upload link' },
      { command: '/tasks', description: 'Show background tasks' },
    ];
    if (!inputLine.startsWith('/')) return [];
    return slashCommands.filter((item) => item.command.startsWith(inputLine));
  }

  function slashSuggestionLines(width: number) {
    const suggestions = slashSuggestions();
    if (suggestions.length === 0) return [];
    slashSelectedIndex = Math.max(0, Math.min(slashSelectedIndex, suggestions.length - 1));
    const maxVisible = 8;
    const start = Math.max(0, Math.min(slashSelectedIndex - Math.floor(maxVisible / 2), suggestions.length - maxVisible));
    const visible = suggestions.slice(start, start + maxVisible);
    const primaryWidth = Math.min(32, Math.max(12, ...suggestions.map((item) => item.command.length + 2)));
    const lines = visible.map((item, offset) => {
      const index = start + offset;
      const selected = index === slashSelectedIndex;
      const prefix = selected ? '→ ' : '  ';
      const command = item.command.padEnd(primaryWidth);
      const line = truncateText(`${prefix}${command}${item.description}`, width);
      return selected ? fgLightDim(line) : line;
    });
    if (start > 0 || start + visible.length < suggestions.length) lines.push(fgDim(truncateText(`  (${slashSelectedIndex + 1}/${suggestions.length})`, width)));
    return lines;
  }

  function acceptSlashSelection() {
    const suggestions = slashSuggestions();
    if (suggestions.length === 0) return false;
    slashSelectedIndex = Math.max(0, Math.min(slashSelectedIndex, suggestions.length - 1));
    inputLine = `${suggestions[slashSelectedIndex].command} `;
    requestRender();
    return true;
  }

  function moveSlashSelection(delta: number) {
    const suggestions = slashSuggestions();
    if (suggestions.length === 0) return false;
    slashSelectedIndex = (slashSelectedIndex + delta + suggestions.length) % suggestions.length;
    requestRender();
    return true;
  }

  function inputDisplayLines(width: number) {
    const wrapWidth = Math.max(1, width);
    const lines = inputWrappedPlainLines(width);
    const lastIndex = lines.length - 1;
    const last = lines[lastIndex] || '';
    const hasCursorRoom = widthOf(last) < wrapWidth;
    const rendered = lines.slice(0, lastIndex).map((line) => truncateText(line, width));
    if (hasCursorRoom) rendered.push(truncateText(`${last}${INVERSE}${CURSOR_CELL}${RESET_INVERSE}`, width));
    else rendered.push(truncateText(last, width), `${INVERSE}${CURSOR_CELL}${RESET_INVERSE}`);
    return rendered;
  }

  function inputCursorPosition(width: number, inputRows: number, inputStartRow: number) {
    const lines = inputWrappedPlainLines(width);
    const last = lines[lines.length - 1] || '';
    const row = inputStartRow + Math.min(inputRows - 1, lines.length - 1);
    const col = Math.min(width, widthOf(last) + 1);
    return { row, col };
  }

  function formatTokens(value: number | undefined) {
    if (!Number.isFinite(value)) return '—';
    const n = Number(value);
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${Math.round(n / 100) / 10}k`;
    return String(n);
  }

  function statusLine(width: number) {
    const model = miState?.model;
    const modelName = model ? `${model.provider}/${model.id}` : MI_MODEL;
    const thinking = miState?.thinkingLevel ? ` ${thinkingLabel(miState.thinkingLevel)}` : '';
    const left = messageQueue.length > 0 ? `q${messageQueue.length}` : '';
    const right = `${modelName}${thinking}`;
    const available = Math.max(1, width - widthOf(left) - widthOf(right));
    if (left && available > 1) return fgDim(`${left}${' '.repeat(available)}${right}`);
    return fgDim(right.padStart(Math.max(widthOf(right), width)));
  }

  function activeTaskLines(width: number) {
    return activeTasks
      .slice(0, 5)
      .map((task) => fgDim(truncateText(`${taskDisplayName(task)} (active ${formatActiveDuration(Date.now() - activeTaskSince(task))})`, width)));
  }

  function renderInputLine() {
    if (closed) return;
    const width = cols();
    const height = rows();
    requestRender();
  }

  function render() {
    if (closed) return;
    const width = cols();
    const height = rows();
    const innerWidth = Math.max(20, width - 4);
    const inputLines = inputDisplayLines(width);
    const inputRows = inputLines.length;
    const suggestionLines = slashSuggestionLines(width);
    const taskLines = activeTaskLines(width);
    const bodyViewport = Math.max(1, height - 4 - inputRows - suggestionLines.length - taskLines.length);
    const body: string[] = [];

    for (const item of transcript) {
      if (item.role === 'user') {
        body.push(userBgLine('', width));
        for (const line of wrapPlain(item.text, Math.max(20, width - 4))) {
          body.push(userBgLine(`  ${line}`, width));
        }
        body.push(userBgLine('', width));
        body.push('');
      } else {
        body.push(...wrapPlain(item.text, innerWidth));
        body.push('');
      }
    }
    if (pending) {
      body.push(workingLine());
      body.push('');
    }

    const maxOffset = Math.max(0, body.length - bodyViewport);
    const offset = Math.min(scrollOffset, maxOffset);
    const end = body.length - offset;
    const start = Math.max(0, end - bodyViewport);
    const visibleBody = body.slice(start, end);
    while (visibleBody.length < bodyViewport) visibleBody.unshift('');

    const lines = [
      ...visibleBody.map((line) => truncateText(line, width)),
      fgThinking(miState?.thinkingLevel, '─'.repeat(width)),
      ...inputLines,
      ...suggestionLines,
      fgThinking(miState?.thinkingLevel, '─'.repeat(width)),
      statusLine(width),
      ...taskLines,
      '',
    ].slice(0, height);

    while (lines.length < height) lines.push('');
    const out = ['\x1b[?2026h', '\x1b[H'];
    lines.forEach((line, index) => {
      const padding = Math.max(0, width - widthOf(line));
      out.push('\x1b[2K', line, ' '.repeat(padding));
      if (index < lines.length - 1) out.push('\r\n');
    });
    const cursor = inputCursorPosition(width, inputRows, Math.max(1, height - 2 - inputRows));
    out.push(`\x1b[${cursor.row};${cursor.col}H`, '\x1b[?25l', '\x1b[?2026l');
    process.stdout.write(out.join(''));
  }

  async function askOne(text: string) {
    setPending(true);
    transcript.push({ role: 'user', text });
    scrollOffset = 0;
    requestRender();
    try {
      let response: string;
      if (threadId === 'main') {
        const userMessage = await appendThreadMessage(threadId, 'user', text, { unread: false, source: 'mi-cli' });
        seenMessageIds.add(userMessage.id);
        const localReply = await maybeHandleLocalIntent(text);
        response = localReply || await sendToMiMain(text);
        getMiState().then((state) => {
          miState = state;
          requestRender();
        }).catch(() => undefined);
        const assistantMessage = await appendThreadMessage(threadId, 'assistant', response, { unread: false, source: 'mi-main' });
        seenMessageIds.add(assistantMessage.id);
      } else {
        response = await askMi(threadId, text);
        for (const message of await readThreadMessages(threadId, 300)) seenMessageIds.add(message.id);
      }
      transcript.push({ role: 'assistant', text: response });
      await sendPushover('Mi', response).catch(() => undefined);
    } catch (error) {
      transcript.push({ role: 'assistant', text: error instanceof Error ? error.message : String(error) });
    } finally {
      scrollOffset = 0;
      requestRender();
    }
  }

  async function processQueue() {
    if (pending) return;
    while (messageQueue.length > 0) {
      const next = messageQueue.shift()!;
      if (closed) break;
      await askOne(next);
    }
    setPending(false);
    requestRender();
  }

  function enqueueMessage(text: string) {
    messageQueue.push(text);
    void processQueue();
    requestRender();
  }

  async function pollThread() {
    if (closed) return;
    const messages = await readThreadMessages(threadId, 300).catch(() => []);
    const fresh = messages.filter((message) => !seenMessageIds.has(message.id) && (message.role === 'user' || message.role === 'assistant'));
    if (fresh.length === 0) return;
    for (const message of fresh) {
      seenMessageIds.add(message.id);
      transcript.push({ role: message.role as 'user' | 'assistant', text: message.text });
    }
    scrollOffset = 0;
    await markThreadRead(threadId).catch(() => undefined);
    requestRender();
  }

  function cleanup() {
    if (closed) return;
    closed = true;
    if (renderTimer) clearTimeout(renderTimer);
    if (workingTimer) clearInterval(workingTimer);
    if (threadPollTimer) clearInterval(threadPollTimer);
    if (taskPollTimer) clearInterval(taskPollTimer);
    process.stdin.off('data', onData);
    process.stdout.off('resize', requestRender);
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdout.write(`${RESET_CURSOR}\x1b[?25h`);
  }

  function scrollBy(delta: number) {
    scrollOffset = Math.max(0, scrollOffset + delta);
    requestRender();
  }

  function piCycleThinkingLevel(tier: string, modelSpec: string): ThinkingLevel | undefined {
    return piCycleConfig.thinkingLevels?.[`${tier}:${modelSpec}`] || piCycleConfig.thinkingLevels?.[modelSpec];
  }

  async function applyPiCycle(text: string): Promise<{ handled: boolean; body: string }> {
    piCycleConfig = await loadPiCycleConfig();
    const shortcut = piCycleConfig.shortcut || 'z';
    const escaped = shortcut.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = text.match(new RegExp(`^((?:${escaped}){1,3})(?:\\s+([\\s\\S]*)|$)`));
    if (!match || match[1].length % shortcut.length !== 0) return { handled: false, body: text };
    const tier = String(match[1].length / shortcut.length);
    const models = piCycleConfig.tiers[tier] || [];
    if (models.length === 0) throw new Error(`pi-cycle tier ${tier} has no models`);
    const index = piCycleNextIndex[tier] % models.length;
    const modelSpec = models[index];
    piCycleNextIndex[tier] = (index + 1) % models.length;
    const level = piCycleThinkingLevel(tier, modelSpec);
    statusMessage = `Tier ${tier}: ${modelSpec}${level ? ` ${thinkingLabel(level)}` : ''}`;
    requestRender();
    await setMiModelThinking(modelSpec, level);
    miState = await getMiState();
    statusMessage = `Shift+Tab thinking • ${shortcut}/${shortcut.repeat(2)}/${shortcut.repeat(3)} pi-cycle`;
    requestRender();
    return { handled: true, body: (match[2] || '').trim() };
  }

  async function cycleThinking() {
    const current = miState?.thinkingLevel === 'high' || miState?.thinkingLevel === 'medium' || miState?.thinkingLevel === 'low' || miState?.thinkingLevel === 'off' ? miState.thinkingLevel : 'off';
    const next = current === 'off' ? 'low' : current === 'low' ? 'medium' : current === 'medium' ? 'high' : 'off';
    statusMessage = `Switching to gpt-5.5 ${thinkingLabel(next)}...`;
    requestRender();
    try {
      const result = await setMiThinking(next);
      miState = await getMiState();
      if (result?.thinkingLevel) miState.thinkingLevel = result.thinkingLevel;
      statusMessage = pending ? `Thinking level will apply after current response` : `Shift+Tab thinking • ${piCycleConfig.shortcut}/${piCycleConfig.shortcut.repeat(2)}/${piCycleConfig.shortcut.repeat(3)} pi-cycle`;
    } catch (error) {
      statusMessage = error instanceof Error ? error.message : String(error);
    }
    requestRender();
  }

  async function runLocalSlashCommand(text: string) {
    if (text === '/quit') {
      cleanup();
      return true;
    }
    if (text === '/stop') {
      messageQueue.length = 0;
      setPending(false);
      await abortMiMain();
      statusMessage = 'Stopped Mi.';
      requestRender();
      return true;
    }
    if (text === '/reload') {
      transcript = (await readThreadMessages(threadId, 300))
        .filter((message) => message.role === 'user' || message.role === 'assistant')
        .map((message) => ({ role: message.role as 'user' | 'assistant', text: message.text }));
      seenMessageIds.clear();
      for (const message of await readThreadMessages(threadId, 300)) seenMessageIds.add(message.id);
      piCycleConfig = await loadPiCycleConfig();
      miState = await getMiState().catch(() => miState);
      statusMessage = `Reloaded Mi state`;
      await markThreadRead(threadId);
      requestRender();
      return true;
    }
    if (text === '/status') {
      miState = await getMiState().catch(() => miState);
      const model = miState?.model ? `${miState.model.provider}/${miState.model.id}` : MI_MODEL;
      const stats = miState?.stats ? `\nTokens: in ${formatTokens(miState.stats.inputTokens)} / out ${formatTokens(miState.stats.outputTokens)} / cache ${formatTokens(miState.stats.cacheReadTokens)}` : '';
      transcript.push({ role: 'assistant', text: `Model: ${model}\nThinking: ${thinkingLabel(miState?.thinkingLevel)}\nSession: ${miState?.sessionName || miState?.sessionId || 'unknown'}${stats}` });
      requestRender();
      return true;
    }
    if (text === '/compact') {
      const result = await compactThread(threadId);
      transcript.push({ role: 'assistant', text: `Compacted ${result.compacted} message(s), kept ${result.kept}.` });
      requestRender();
      return true;
    }
    if (text === '/upload') {
      const link = await createUploadLink();
      transcript.push({ role: 'assistant', text: `Temporary image upload link (expires ${link.expiresAt}, max ${link.maxBytes} bytes):\n${link.url}\nAfter upload, paste the returned image URL/reference into Mi or Pi.` });
      requestRender();
      return true;
    }
    if (text === '/tasks') {
      const result = await sendSocketRequest({ type: 'list_tasks' }, 10000).catch(async (error) => {
        if (existsSync(MI_SOCKET_PATH) && !isSocketConnectionRefused(error)) throw error;
        await startMiDaemon();
        return sendSocketRequest({ type: 'list_tasks' }, 10000);
      });
      const tasks = (result.tasks || []) as Array<any>;
      transcript.push({ role: 'assistant', text: tasks.slice(0, 10).map((task) => `${task.status || 'unknown'} ${task.id || ''} ${task.name || ''}`).join('\n') || 'No Mi tasks.' });
      return true;
    }
    return false;
  }

  function commonPrefix(values: string[]) {
    if (values.length === 0) return '';
    let prefix = values[0];
    for (const value of values.slice(1)) {
      while (!value.startsWith(prefix) && prefix) prefix = prefix.slice(0, -1);
    }
    return prefix;
  }

  function completeInput() {
    if (!inputLine.startsWith('/')) return false;
    const matches = slashSuggestions();
    if (matches.length === 1) {
      inputLine = `${matches[0].command} `;
      requestRender();
      return true;
    }
    if (matches.length > 1) {
      const prefix = commonPrefix(matches.map((item) => item.command));
      if (prefix.length > inputLine.length) inputLine = prefix;
      statusMessage = matches.map((item) => item.command).join('  ');
      requestRender();
      return true;
    }
    return false;
  }

  function submitInput() {
    const text = inputLine.trim();
    if (!text) return;
    inputLine = '';
    requestRender();
    void runLocalSlashCommand(text)
      .then((handled) => {
        if (handled) return undefined;
        return applyPiCycle(text);
      })
      .then((result) => {
        if (!result) return;
        if (result.body) enqueueMessage(result.body);
        else requestRender();
      })
      .catch((error) => {
        statusMessage = error instanceof Error ? error.message : String(error);
        requestRender();
      });
  }

  function onData(buffer: Buffer) {
    const data = buffer.toString('utf8');
    if (/^\x1b\[<\d+;\d+;\d+[mM]$/.test(data)) return;
    if (data === '\x03') {
      if (pending || messageQueue.length > 0) {
        messageQueue.length = 0;
        statusMessage = 'Stopping...';
        setPending(false);
        void abortMiMain().then(() => {
          statusMessage = `Shift+Tab thinking • ${piCycleConfig.shortcut}/${piCycleConfig.shortcut.repeat(2)}/${piCycleConfig.shortcut.repeat(3)} pi-cycle`;
          requestRender();
        });
      } else {
        const now = Date.now();
        if (now - lastSigintTime < 500 && !inputLine.trim()) cleanup();
        else {
          inputLine = '';
          lastSigintTime = now;
        }
      }
      requestRender();
      return;
    }
    if (data === '\x1b') {
      if (pending || messageQueue.length > 0) {
        messageQueue.length = 0;
        statusMessage = 'Stopping...';
        setPending(false);
        void abortMiMain().then(() => {
          statusMessage = `Shift+Tab thinking • ${piCycleConfig.shortcut}/${piCycleConfig.shortcut.repeat(2)}/${piCycleConfig.shortcut.repeat(3)} pi-cycle`;
          requestRender();
        });
        requestRender();
      }
      return;
    }
    if (data === '\t' || data === '\x09' || data === '\x1b[9;u') {
      if (!completeInput()) statusMessage = 'No completion';
      requestRender();
    } else if (data === '\x1b[Z' || data === '\x1b[1;2Z' || data === '\x1b\t' || data.includes('\x1b[Z') || data.includes('\x1b[1;2Z')) {
      void cycleThinking();
    } else if (data === '\x1b[A' || data === '\x1bOA') {
      if (!moveSlashSelection(-1)) requestRender();
    } else if (data === '\x1b[B' || data === '\x1bOB') {
      if (!moveSlashSelection(1)) requestRender();
    } else if (data === '\x1b[5~') {
      if (!moveSlashSelection(-8)) requestRender();
    } else if (data === '\x1b[6~') {
      if (!moveSlashSelection(8)) requestRender();
    } else if (data.includes('\r') || data.includes('\n')) {
      if (inputLine.startsWith('/') && slashSuggestions().length > 0 && !slashSuggestions().some((item) => `${item.command} ` === inputLine || item.command === inputLine.trim())) {
        acceptSlashSelection();
        return;
      }
      const parts = data.split(/[\r\n]+/);
      const beforeEnter = parts.shift() || '';
      const textBeforeEnter = beforeEnter.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
      if (textBeforeEnter) inputLine += textBeforeEnter;
      submitInput();
      const afterEnter = parts.join('');
      const textAfterEnter = afterEnter.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
      if (textAfterEnter) inputLine += textAfterEnter;
      slashSelectedIndex = 0;
      renderInputLine();
    } else if (data === '\x7f' || data === '\b') {
      inputLine = inputLine.slice(0, -1);
      slashSelectedIndex = 0;
      renderInputLine();
    } else if (data === '\x15') {
      inputLine = '';
      slashSelectedIndex = 0;
      renderInputLine();
    } else {
      const text = data.replace(/\x1b\[<\d+;\d+;\d+[mM]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
      if (text) {
        inputLine += text;
        slashSelectedIndex = 0;
        renderInputLine();
      }
    }
  }

  process.stdout.write(`\x1b[?25l\x1b[2J\x1b[H`);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  threadPollTimer = setInterval(() => { void pollThread(); }, 2000);
  process.stdin.on('data', onData);
  process.stdout.on('resize', requestRender);
  render();
  if (initial.trim()) enqueueMessage(initial.trim());

  await new Promise<void>((resolve) => {
    const interval = setInterval(() => {
      if (closed) {
        clearInterval(interval);
        resolve();
      }
    }, 50);
  });
}

async function launchPiMain(args: string[]) {
  const prompt = [
    'You are Mi, Kyle private persistent assistant.',
    'Be concise and minimal.',
    'Do not use emoji.',
    'Risky actions require explicit approval.',
    'All Mi tasks, goals, objectives, todos, plans, and work queues must be stored and maintained as Markdown files under /home/kyle/mi/.',
    'When Kyle asks in plain English to monitor, periodically check, alert on, or schedule something, create or update a Mi cron instead of requiring a manual cron expression. Use: mi cron add <name> --every 1h [--cwd <path>] -- <command>; mi cron list; mi cron tick; mi cron remove <name>. Ask only for missing repo/path, cadence, health command, and alert behavior.',
    'When Kyle gives Mi a substantive task that needs coding, repo inspection, testing, research, or multi-step work, immediately hand it off to a background pi worker instead of doing the work in Mi. If there is already a relevant running/background task, use mi task reply <task-id-or-name> -- <follow-up prompt> to continue that same session. Otherwise create one with mi task <name> [--cwd <path>] -- <task prompt>. Name it clearly. Mi task wraps the prompt in /goal by default for sustained execution. These commands return after the worker starts; do not wait for the task to finish before replying to Kyle. Worker sessions use /home/kyle/.pi/agent/sessions so Kyle can see them in /resume. Use mi task list to inspect background task status. Escalate to Kyle when approval, ambiguity, or risk blocks progress. If the worker opens or updates a PR, it must include the full GitHub PR URL in its final answer and state whether it needs Kyle review/merge.',
    'Do not deploy, merge, push, publish, edit secrets, or change production settings unless explicitly approved.',
    'Use the /mi command for side-channel notes, /mi read for unread Mi messages, and /mi bring-in only when Kyle asks to bring Mi thread context into this pi conversation.',
  ].join(' ');

  const piArgs = [
    '--append-system-prompt',
    prompt,
    '--tools',
    '',
    '--model',
    MI_MODEL,
    ...args,
  ];

  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.env.PI_CMD || 'pi', piArgs, {
      cwd: process.env.MI_ROOT || process.cwd(),
      env: { ...process.env, MI_MAIN: '1', MI_ROOT: process.env.MI_ROOT || process.cwd() },
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('close', (code) => {
      process.exitCode = code ?? 0;
      resolve();
    });
  });
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command) return miTuiCommand('main', '');
  if (command === 'help' || command === '--help' || command === '-h') {
    console.log(usage());
    return;
  }
  if (command === '--once') return onceCommand(args);
  if (command === 'raw') return chatCommand(args[0] || 'main');
  if (command === 'pi') return launchPiMain(args);
  if (command === 'ui') return miTuiCommand('main', args.join(' '));
  if (command === 'chat' || command === 'open') return miTuiCommand(args[0] || 'main');
  if (command === 'read') return showThread(args[0] || 'main');
  if (command === 'upload') return uploadCommand();
  if (command === 'ask') return askCommand(args);
  if (command === 'inbox' || command === 'threads') return inboxCommand();
  if (command === 'temp') return tempCommand(args);
  if (command === 'compact') return compactCommand(args);
  if (command === 'cron') return cronCommand(args);
  if (command === 'task') return taskCommand(args);
  if (command === 'make') return makeCommand(args);
  if (command === 'run') return runCommand(args);
  if (command === 'edit') return editCommand(args);
  if (command === 'check') return checkCommand(args);
  if (command === 'logs') return logsCommand(args);
  throw new Error(`unknown command: ${command}`);
}

try {
  await main();
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
}
