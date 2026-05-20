import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

export type ThreadKind = 'main' | 'temporary';
export type ThreadRole = 'user' | 'assistant' | 'system';

export type ThreadRecord = {
  id: string;
  title: string;
  kind: ThreadKind;
  createdAt: string;
  updatedAt: string;
  unread: number;
  archived?: boolean;
};

export type ThreadMessage = {
  id: string;
  threadId: string;
  role: ThreadRole;
  text: string;
  ts: string;
  unread?: boolean;
  source?: string;
};

export type CompactResult = {
  threadId: string;
  compacted: number;
  kept: number;
  archivePath?: string;
  summaryPath: string;
};

const miRoot = process.env.MI_ROOT || path.join(homedir(), 'assistant');
const threadsDir = path.join(miRoot, 'state', 'threads');
const indexPath = path.join(threadsDir, 'index.json');
const defaultRecentLimit = 60;

function now() {
  return new Date().toISOString();
}

function id(prefix = 'msg') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function safeThreadId(value: string) {
  const safe = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!safe) throw new Error('thread title required');
  return safe;
}

function threadPath(threadId: string) {
  return path.join(threadsDir, `${threadId}.jsonl`);
}

function summaryPath(threadId: string) {
  return path.join(threadsDir, `${threadId}.summary.md`);
}

function archivePath(threadId: string) {
  return path.join(threadsDir, `${threadId}.archive.jsonl`);
}

export async function ensureThreads() {
  await mkdir(threadsDir, { recursive: true });
  const threads = await readThreadIndex();
  if (!threads.some((thread) => thread.id === 'main')) {
    const ts = now();
    threads.unshift({ id: 'main', title: 'main', kind: 'main', createdAt: ts, updatedAt: ts, unread: 0 });
    await writeThreadIndex(threads);
  }
}

export async function readThreadIndex(): Promise<ThreadRecord[]> {
  await mkdir(threadsDir, { recursive: true });
  try {
    return JSON.parse(await readFile(indexPath, 'utf8')) as ThreadRecord[];
  } catch {
    return [];
  }
}

async function writeThreadIndex(threads: ThreadRecord[]) {
  await mkdir(threadsDir, { recursive: true });
  await writeFile(indexPath, JSON.stringify(threads, null, 2));
}

export async function listThreads() {
  await ensureThreads();
  return (await readThreadIndex()).filter((thread) => !thread.archived);
}

export async function getThread(threadId = 'main') {
  await ensureThreads();
  return (await readThreadIndex()).find((thread) => thread.id === threadId);
}

export async function createTempThread(title: string) {
  await ensureThreads();
  const threads = await readThreadIndex();
  let base = `temp-${safeThreadId(title)}`;
  let candidate = base;
  let suffix = 2;
  while (threads.some((thread) => thread.id === candidate)) candidate = `${base}-${suffix++}`;
  const ts = now();
  const record: ThreadRecord = { id: candidate, title, kind: 'temporary', createdAt: ts, updatedAt: ts, unread: 0 };
  threads.push(record);
  await writeThreadIndex(threads);
  await appendThreadMessage(candidate, 'system', `Temporary conversation created: ${title}`, { unread: false, source: 'mi' });
  return record;
}

export async function appendThreadMessage(
  threadId: string,
  role: ThreadRole,
  text: string,
  options: { unread?: boolean; source?: string } = {},
) {
  await ensureThreads();
  const threads = await readThreadIndex();
  const record = threads.find((thread) => thread.id === threadId);
  if (!record) throw new Error(`thread not found: ${threadId}`);

  const message: ThreadMessage = {
    id: id(),
    threadId,
    role,
    text,
    ts: now(),
    unread: options.unread ?? role === 'assistant',
    source: options.source,
  };
  await appendFile(threadPath(threadId), `${JSON.stringify(message)}\n`);

  record.updatedAt = message.ts;
  if (message.unread && role === 'assistant') record.unread += 1;
  await writeThreadIndex(threads);
  return message;
}

export async function readThreadMessages(threadId = 'main', limit?: number) {
  await ensureThreads();
  try {
    const messages = (await readFile(threadPath(threadId), 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as ThreadMessage);
    return typeof limit === 'number' ? messages.slice(-limit) : messages;
  } catch {
    return [];
  }
}

export async function markThreadRead(threadId = 'main') {
  await ensureThreads();
  const threads = await readThreadIndex();
  const record = threads.find((thread) => thread.id === threadId);
  if (record) {
    record.unread = 0;
    await writeThreadIndex(threads);
  }

  const messages = await readThreadMessages(threadId);
  if (messages.length === 0) return;
  const updated = messages.map((message) => ({ ...message, unread: false }));
  await writeFile(threadPath(threadId), updated.map((message) => JSON.stringify(message)).join('\n') + '\n');
}

export async function threadContext(threadId = 'main', recentLimit = defaultRecentLimit) {
  await ensureThreads();
  const summary = await readThreadSummary(threadId);
  const recent = await readThreadMessages(threadId, recentLimit);
  const lines = recent.map((message) => `${message.role}: ${message.text}`).join('\n');
  return [summary ? `Summary:\n${summary}` : '', lines ? `Recent messages:\n${lines}` : ''].filter(Boolean).join('\n\n');
}

export async function readThreadSummary(threadId = 'main') {
  try {
    return (await readFile(summaryPath(threadId), 'utf8')).trim();
  } catch {
    return '';
  }
}

export async function compactThread(threadId = 'main', keep = Number(process.env.MI_COMPACT_KEEP || 100)): Promise<CompactResult> {
  await ensureThreads();
  const messages = await readThreadMessages(threadId);
  const protectedStart = Math.max(0, messages.length - keep);
  const compactable = messages.slice(0, protectedStart).filter((message) => !message.unread);
  const protectedMessages = messages.filter((message, index) => index >= protectedStart || message.unread);
  const outSummaryPath = summaryPath(threadId);

  if (compactable.length === 0) {
    return { threadId, compacted: 0, kept: messages.length, summaryPath: outSummaryPath };
  }

  const existingSummary = await readThreadSummary(threadId);
  const first = compactable[0];
  const last = compactable[compactable.length - 1];
  const excerpt = compactable
    .slice(-20)
    .map((message) => `- ${message.ts} ${message.role}: ${message.text.replace(/\s+/g, ' ').slice(0, 240)}`)
    .join('\n');
  const section = `## Compacted ${now()}\n\nRange: ${first.ts} to ${last.ts}\nMessages: ${compactable.length}\n\nRecent compacted excerpt:\n${excerpt}\n`;
  await writeFile(outSummaryPath, [existingSummary, section].filter(Boolean).join('\n\n'));
  await appendFile(archivePath(threadId), compactable.map((message) => JSON.stringify(message)).join('\n') + '\n');
  await writeFile(threadPath(threadId), protectedMessages.map((message) => JSON.stringify(message)).join('\n') + '\n');

  return {
    threadId,
    compacted: compactable.length,
    kept: protectedMessages.length,
    archivePath: archivePath(threadId),
    summaryPath: outSummaryPath,
  };
}

export async function archiveThread(threadId: string) {
  if (threadId === 'main') throw new Error('main thread cannot be archived');
  await ensureThreads();
  const threads = await readThreadIndex();
  const record = threads.find((thread) => thread.id === threadId);
  if (!record) throw new Error(`thread not found: ${threadId}`);
  record.archived = true;
  record.updatedAt = now();
  await writeThreadIndex(threads);
}
