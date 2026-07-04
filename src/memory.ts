import { appendFile, chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { runFlueChat, type FlueChatResult } from './flue.js';
import { listThreads, readThreadMessages } from './threads.js';
import { redactSecrets } from './redact.js';
import { logEvent } from './state.js';

const MEMORY_DIR = join(process.cwd(), 'state', 'memory');
const MEMORY_MD = join(MEMORY_DIR, 'MEMORY.md');
const HISTORY = join(MEMORY_DIR, 'history.jsonl');
const CURSOR = join(MEMORY_DIR, '.dream_cursor');
const PROMPT = join(MEMORY_DIR, 'dream-prompt.md');
const EVENTS = join(process.cwd(), 'state', 'events.jsonl');
const DEFAULT_PROMPT = 'Distill durable facts for Mi. Return strict JSON: {"entries":[{"ts":"ISO","source":"...","summary":"...","refs":[]}],"memory":"full replacement MEMORY.md"}. Keep only reusable facts, decisions, feedback, and project context. Do not include secrets.';

type Cursor = { threads?: Record<string, number>; eventsOffset?: number; lastRunAt?: string };
export type DreamResult = { status: 'ok' | 'skipped' | 'error'; inputChars?: number; entriesAppended?: number; memoryBytes?: number; error?: string };

async function ensureMemory() {
  await mkdir(MEMORY_DIR, { recursive: true, mode: 0o700 });
  await chmod(MEMORY_DIR, 0o700).catch(() => undefined);
  if (!existsSync(MEMORY_MD)) await writePrivate(MEMORY_MD, '# Mi memory\n\n');
  if (!existsSync(PROMPT)) await writePrivate(PROMPT, DEFAULT_PROMPT + '\n');
  if (!existsSync(CURSOR)) await writePrivate(CURSOR, JSON.stringify({ threads: {}, eventsOffset: 0 }, null, 2));
  if (!existsSync(HISTORY)) await writePrivate(HISTORY, '');
}
async function writePrivate(path: string, data: string) { await writeFile(path, String(redactSecrets(data)), { mode: 0o600 }); await chmod(path, 0o600).catch(() => undefined); }
async function appendPrivate(path: string, data: string) { await appendFile(path, String(redactSecrets(data)), { mode: 0o600 }); await chmod(path, 0o600).catch(() => undefined); }
async function readCursor(): Promise<Cursor> { await ensureMemory(); try { return JSON.parse(await readFile(CURSOR, 'utf8')); } catch { return { threads: {}, eventsOffset: 0 }; } }
async function writeCursor(cursor: Cursor) { await writePrivate(CURSOR, JSON.stringify(cursor, null, 2)); }

export async function readMemory(maxChars = Number(process.env.MI_MEMORY_MAX_CHARS || 6000)) {
  await ensureMemory();
  const text = String(redactSecrets(await readFile(MEMORY_MD, 'utf8')));
  return text.length > maxChars ? text.slice(0, maxChars) + '\n\n[Mi memory truncated]' : text;
}
export async function memorySystemBlock() { const memory = await readMemory(); return memory.trim() ? `\n\nDurable Mi memory:\n${memory}` : ''; }
export async function readMemoryHistory(limit = 20) { await ensureMemory(); const text = await readFile(HISTORY, 'utf8').catch(() => ''); return text.trim().split('\n').filter(Boolean).slice(-limit).map((line) => JSON.parse(line)); }

async function git(args: string[]) { return new Promise<boolean>((resolve) => { const child = spawn('git', args, { cwd: MEMORY_DIR, shell: false, stdio: 'ignore' }); child.on('error', () => resolve(false)); child.on('close', (code) => resolve(code === 0)); }); }
async function gitCommit() { if (!existsSync(join(MEMORY_DIR, '.git'))) { if (!await git(['init'])) { await logEvent('mi.dream.git_warning', { step: 'init' }); return; } } await git(['add', 'MEMORY.md', '.dream_cursor']); const ok = await git(['commit', '-m', `mi-dream: ${new Date().toISOString()}`]); if (!ok) await logEvent('mi.dream.git_warning', { step: 'commit' }); }

async function collectInput(cursor: Cursor, maxChars: number) {
  let input = ''; const next: Cursor = { threads: { ...(cursor.threads || {}) }, eventsOffset: cursor.eventsOffset || 0 };
  for (const thread of await listThreads()) {
    if (thread.kind === 'temporary') continue;
    const messages = await readThreadMessages(thread.id);
    const start = next.threads![thread.id] || 0;
    for (const message of messages.slice(start)) input += `[thread:${thread.id}] ${message.role}: ${message.text}\n`;
    next.threads![thread.id] = messages.length;
    if (input.length >= maxChars) break;
  }
  try {
    const text = await readFile(EVENTS, 'utf8');
    const slice = text.slice(cursor.eventsOffset || 0);
    for (const line of slice.split('\n').filter(Boolean)) if (/approval|worker|delegation/.test(line)) input += `[event] ${line}\n`;
    next.eventsOffset = Buffer.byteLength(text);
  } catch { next.eventsOffset = 0; }
  return { input: String(redactSecrets(input)).slice(0, maxChars), next };
}

export async function runDreamConsolidation(options: { force?: boolean; flueChat?: (message: string) => Promise<FlueChatResult>; maxRounds?: number } = {}): Promise<DreamResult> {
  if (process.env.MI_DREAM_ENABLED === 'false' && !options.force) return { status: 'skipped' };
  await ensureMemory();
  const cursor = await readCursor();
  const interval = Number(process.env.MI_DREAM_INTERVAL_HOURS || 24) * 60 * 60 * 1000;
  if (!options.force && cursor.lastRunAt && Date.now() - Date.parse(cursor.lastRunAt) < interval) return { status: 'skipped' };
  const maxChars = Number(process.env.MI_DREAM_MAX_INPUT_CHARS || 24000);
  for (let round = 0; round < (options.maxRounds || 5); round++) {
    const current = await readCursor();
    const { input, next } = await collectInput(current, maxChars);
    if (!input.trim()) return { status: 'skipped', inputChars: 0 };
    const prompt = await readFile(PROMPT, 'utf8');
    const existing = await readMemory(12000);
    const chat = await (options.flueChat || runFlueChat)(`${prompt}\n\nExisting MEMORY.md:\n${existing}\n\nNew source material:\n${input}`);
    if (!chat.ok) { const error = chat.error || 'dream model failed'; await logEvent('mi.dream.error', { error }); return { status: 'error', error }; }
    let parsed: any; try { parsed = JSON.parse(chat.reply); } catch (e) { const error = 'dream response was not JSON'; await logEvent('mi.dream.error', { error }); return { status: 'error', error }; }
    if (!Array.isArray(parsed.entries) || typeof parsed.memory !== 'string') { const error = 'dream response shape invalid'; await logEvent('mi.dream.error', { error }); return { status: 'error', error }; }
    for (const entry of parsed.entries) await appendPrivate(HISTORY, JSON.stringify(redactSecrets(entry)) + '\n');
    await writePrivate(MEMORY_MD, parsed.memory);
    next.lastRunAt = new Date().toISOString();
    await writeCursor(next);
    await gitCommit();
    const memoryBytes = (await stat(MEMORY_MD)).size;
    await logEvent('mi.dream.run', { inputChars: input.length, entriesAppended: parsed.entries.length, memoryBytes });
    return { status: 'ok', inputChars: input.length, entriesAppended: parsed.entries.length, memoryBytes };
  }
  return { status: 'skipped' };
}

export function memoryPaths() { return { dir: MEMORY_DIR, memory: MEMORY_MD, history: HISTORY, cursor: CURSOR, prompt: PROMPT }; }
