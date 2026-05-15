#!/usr/bin/env node
import 'dotenv/config';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { createInterface } from 'node:readline/promises';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { stdin as input, stdout as output } from 'node:process';
import { draftAssistant, proposeAssistantEdit } from './builder.js';
import { assistantPath } from './assistant.js';
import { checkAssistant, runAssistant } from './runner.js';
import { readRunRecords } from './primitives.js';
import { runFlueChat } from './flue.js';
import { readRecentEvents, logEvent } from './state.js';
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

async function askMi(threadId: string, message: string) {
  const thread = await getThread(threadId);
  if (!thread) throw new Error(`thread not found: ${threadId}`);
  await appendThreadMessage(threadId, 'user', message, { unread: false, source: 'cli' });
  await logEvent('mi.thread.user', { threadId, message });

  const context = await threadContext(threadId);
  const prompt = `You are Mi, Kyle's private persistent assistant. Reply as Mi in the current conversation. Be concise. Do not claim to have inspected files or services unless context explicitly says so. Risky actions require approval.\n\nThread: ${thread.title}\n\n${context}\n\nCurrent user message:\n${message}`;
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
  await chatCommand(thread.id);
}

async function compactCommand(args: string[]) {
  const threadId = args[0] || 'main';
  const result = await compactThread(threadId);
  await logEvent('mi.thread.compact', result);
  console.log(`Compacted ${result.compacted} message(s), kept ${result.kept}.`);
  console.log(`Summary: ${result.summaryPath}`);
  if (result.archivePath) console.log(`Archive: ${result.archivePath}`);
}

async function chatCommand(threadId = 'main') {
  await showThread(threadId);
  console.log('\nType a message. Commands: /inbox, /compact, /exit');
  const rl = createInterface({ input, output });
  try {
    while (true) {
      const line = (await rl.question('you> ')).trim();
      if (!line) continue;
      if (line === '/exit' || line === '/quit') break;
      if (line === '/help') {
        console.log('Commands: /inbox, /compact, /exit');
        continue;
      }
      if (line === '/inbox') {
        await inboxCommand();
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
const MI_MAX_RESPONSE_CHARS = 255;
const MI_TASKS_DIR = join(HOME, 'mi');
const MI_PROMPT_PREFIX = `Answer in ${MI_MAX_RESPONSE_CHARS} characters or fewer. Do not exceed the limit. Be concise.\n\n`;
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
const WHITE_CURSOR = '\x1b]12;white\x07';
const RESET_CURSOR = '\x1b]112\x07';
const PI_SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

function fgAccent(text: string) {
  return `${PI_ACCENT}${text}${RESET_FG}`;
}

function fgDim(text: string) {
  return `${PI_DIM}${text}${RESET_FG}`;
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

function sendSocketRequest(payload: unknown, timeoutMs = 120000): Promise<{ ok?: boolean; error?: string; text?: string; state?: any }> {
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
        const response = JSON.parse(data.slice(0, data.indexOf('\n'))) as { ok?: boolean; error?: string; text?: string; state?: any };
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

async function startMiDaemon() {
  await mkdir(dirname(MI_SOCKET_PATH), { recursive: true });
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
  return `${MI_PROMPT_PREFIX}${message}`;
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
    if (existsSync(MI_SOCKET_PATH)) throw error;
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
    if (existsSync(MI_SOCKET_PATH)) throw error;
    await startMiDaemon();
    await sendSocketRequest({ type: 'set_model', provider, modelId }, 30000);
    return level ? (await sendSocketRequest({ type: 'set_thinking', level }, 30000)).state : await getMiState();
  }
}

async function setMiThinking(level: 'low' | 'medium' | 'high') {
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
    let text = await requestMi(miPrompt(message));
    if (text.length <= MI_MAX_RESPONSE_CHARS) return text;
    text = await requestMi(`Rewrite this answer in ${MI_MAX_RESPONSE_CHARS} characters or fewer. Do not truncate; produce a complete concise answer.\n\n${text}`);
    return normalizeMiResponse(text);
  } catch (error) {
    if (existsSync(MI_SOCKET_PATH)) throw error;
  }
  await startMiDaemon();
  let text = await requestMi(miPrompt(message));
  if (text.length <= MI_MAX_RESPONSE_CHARS) return text;
  text = await requestMi(`Rewrite this answer in ${MI_MAX_RESPONSE_CHARS} characters or fewer. Do not truncate; produce a complete concise answer.\n\n${text}`);
  return normalizeMiResponse(text);
}

async function miTuiCommand(initial = '') {
  await mkdir(MI_TASKS_DIR, { recursive: true });
  let transcript = (await readThreadMessages('main', 300))
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .map((message) => ({ role: message.role as 'user' | 'assistant', text: message.text }));
  await markThreadRead('main');

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

  function inputCursorColumn(width: number) {
    return Math.min(width, widthOf(inputText()) + 1);
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
    const thinking = miState?.thinkingLevel ? ` ${miState.thinkingLevel}` : '';
    const left = messageQueue.length > 0 ? `q${messageQueue.length}` : '';
    const right = `${modelName}${thinking}`;
    const available = Math.max(1, width - widthOf(left) - widthOf(right));
    if (left && available > 1) return fgDim(`${left}${' '.repeat(available)}${right}`);
    return fgDim(right.padStart(Math.max(widthOf(right), width)));
  }

  function renderInputLine() {
    if (closed) return;
    const width = cols();
    const height = rows();
    const line = truncateText(inputDisplayText(), width);
    const padding = Math.max(0, width - widthOf(line));
    const inputRow = Math.max(1, height - 3);
    process.stdout.write(`${WHITE_CURSOR}\x1b[${inputRow};1H\x1b[2K${line}${' '.repeat(padding)}\x1b[${inputRow};${inputCursorColumn(width)}H`);
  }

  function render() {
    if (closed) return;
    const width = cols();
    const height = rows();
    const innerWidth = Math.max(20, width - 4);
    const bodyViewport = Math.max(1, height - 5);
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
      truncateText(inputDisplayText(), width),
      fgThinking(miState?.thinkingLevel, '─'.repeat(width)),
      statusLine(width),
      '',
    ].slice(0, height);

    while (lines.length < height) lines.push('');
    const out = ['\x1b[?2026h', '\x1b[H'];
    lines.forEach((line, index) => {
      const padding = Math.max(0, width - widthOf(line));
      out.push('\x1b[2K', line, ' '.repeat(padding));
      if (index < lines.length - 1) out.push('\r\n');
    });
    out.push(WHITE_CURSOR, `\x1b[${Math.max(1, height - 3)};${inputCursorColumn(width)}H`, '\x1b[?25h', '\x1b[?2026l');
    process.stdout.write(out.join(''));
  }

  async function askOne(text: string) {
    setPending(true);
    transcript.push({ role: 'user', text });
    scrollOffset = 0;
    await appendThreadMessage('main', 'user', text, { unread: false, source: 'mi-cli' });
    requestRender();
    try {
      const response = await sendToMiMain(text);
      getMiState().then((state) => {
        miState = state;
        requestRender();
      }).catch(() => undefined);
      await appendThreadMessage('main', 'assistant', response, { unread: false, source: 'mi-main' });
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

  function cleanup() {
    if (closed) return;
    closed = true;
    if (renderTimer) clearTimeout(renderTimer);
    if (workingTimer) clearInterval(workingTimer);
    process.stdin.off('data', onData);
    process.stdout.off('resize', requestRender);
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdout.write(`${RESET_CURSOR}\x1b[?25h\x1b[?1000l\x1b[?1002l\x1b[?1006l\x1b[?1007l\x1b[?1049l`);
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
    statusMessage = `Tier ${tier}: ${modelSpec}${level ? ` ${level}` : ''}`;
    requestRender();
    await setMiModelThinking(modelSpec, level);
    miState = await getMiState();
    statusMessage = `Shift+Tab thinking • ${shortcut}/${shortcut.repeat(2)}/${shortcut.repeat(3)} pi-cycle`;
    requestRender();
    return { handled: true, body: (match[2] || '').trim() };
  }

  async function cycleThinking() {
    if (pending) {
      statusMessage = 'Wait for current response before switching thinking';
      requestRender();
      return;
    }
    const current = miState?.thinkingLevel === 'high' || miState?.thinkingLevel === 'medium' || miState?.thinkingLevel === 'low' ? miState.thinkingLevel : 'low';
    const next = current === 'low' ? 'medium' : current === 'medium' ? 'high' : 'low';
    statusMessage = `Switching to gpt-5.5 ${next}...`;
    requestRender();
    try {
      const result = await setMiThinking(next);
      miState = await getMiState();
      if (result?.thinkingLevel) miState.thinkingLevel = result.thinkingLevel;
      statusMessage = `Shift+Tab thinking • ${piCycleConfig.shortcut}/${piCycleConfig.shortcut.repeat(2)}/${piCycleConfig.shortcut.repeat(3)} pi-cycle`;
    } catch (error) {
      statusMessage = error instanceof Error ? error.message : String(error);
    }
    requestRender();
  }

  function submitInput() {
    const text = inputLine.trim();
    if (!text) return;
    inputLine = '';
    renderInputLine();
    void applyPiCycle(text)
      .then(({ body }) => {
        if (body) enqueueMessage(body);
        else requestRender();
      })
      .catch((error) => {
        statusMessage = error instanceof Error ? error.message : String(error);
        requestRender();
      });
  }

  function onData(buffer: Buffer) {
    const data = buffer.toString('utf8');
    if (data === '\x03' || data === '\x1b') {
      if (pending || messageQueue.length > 0) {
        messageQueue.length = 0;
        statusMessage = 'Stopping...';
        setPending(false);
        void abortMiMain().then(() => {
          statusMessage = `Shift+Tab thinking • ${piCycleConfig.shortcut}/${piCycleConfig.shortcut.repeat(2)}/${piCycleConfig.shortcut.repeat(3)} pi-cycle`;
          requestRender();
        });
        requestRender();
      } else {
        cleanup();
      }
      return;
    }
    if (data === '\x1b[Z' || data === '\x1b[1;2Z' || data === '\x1b\t' || data.includes('\x1b[Z') || data.includes('\x1b[1;2Z')) {
      void cycleThinking();
    } else if (data === '\x1b[5~' || data === '\x1b[A' || data === '\x1bOA' || data === '\x1b[1;2A' || data.includes('\x1b[<64;')) {
      scrollBy(Math.max(3, Math.floor(rows() / 2)));
    } else if (data === '\x1b[6~' || data === '\x1b[B' || data === '\x1bOB' || data === '\x1b[1;2B' || data.includes('\x1b[<65;')) {
      scrollBy(-Math.max(3, Math.floor(rows() / 2)));
    } else if (data.includes('\r') || data.includes('\n')) {
      const parts = data.split(/[\r\n]+/);
      const beforeEnter = parts.shift() || '';
      const textBeforeEnter = beforeEnter.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
      if (textBeforeEnter) inputLine += textBeforeEnter;
      submitInput();
      const afterEnter = parts.join('');
      const textAfterEnter = afterEnter.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
      if (textAfterEnter) inputLine += textAfterEnter;
      renderInputLine();
    } else if (data === '\x7f' || data === '\b') {
      inputLine = inputLine.slice(0, -1);
      renderInputLine();
    } else if (data === '\x15') {
      inputLine = '';
      renderInputLine();
    } else {
      const text = data.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
      if (text) {
        inputLine += text;
        renderInputLine();
      }
    }
  }

  process.stdout.write(`\x1b[?1049h${WHITE_CURSOR}\x1b[?1000h\x1b[?1002h\x1b[?1006h\x1b[?1007h\x1b[?25h\x1b[2J\x1b[H`);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
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
  if (!command) return miTuiCommand('');
  if (command === 'help' || command === '--help' || command === '-h') {
    console.log(usage());
    return;
  }
  if (command === '--once') return onceCommand(args);
  if (command === 'raw') return chatCommand(args[0] || 'main');
  if (command === 'pi') return launchPiMain(args);
  if (command === 'ui') return miTuiCommand(args.join(' '));
  if (command === 'chat' || command === 'open') return chatCommand(args[0] || 'main');
  if (command === 'ask') return askCommand(args);
  if (command === 'inbox' || command === 'threads') return inboxCommand();
  if (command === 'temp') return tempCommand(args);
  if (command === 'compact') return compactCommand(args);
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
