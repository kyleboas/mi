import { chmod, mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';

export type PendingConfirmation = {
  id: string;
  threadId: string;
  summary: string;
  riskReason: string;
  createdAt: string;
  expiresAt: string;
  continuationRef?: string;
  objective?: string;
  actionClass?: string;
};

export type ConfirmationResult =
  | { kind: 'confirm' | 'deny'; record: PendingConfirmation }
  | { kind: 'unclear' | 'not_found' | 'expired' };

type StoredState = { version: 1; records: PendingConfirmation[] };
export type PendingConfirmationOptions = {
  statePath?: string;
  now?: Date;
  ttlMs?: number;
};

const MAX_FILE_BYTES = 64 * 1024;
const MAX_RECORDS = 100;
const MAX_TEXT = 240;
const MAX_THREAD = 160;
const MAX_REFERENCE = 160;
const MAX_ACTION_CLASS = 80;
const DEFAULT_TTL_MS = 10 * 60 * 1000;
const MAX_TTL_MS = 24 * 60 * 60 * 1000;
// A lock must be old before recovery is even considered. This covers the
// short window where a process created the file but has not written metadata.
const LOCK_STALE_MS = 30 * 1000;
const MAX_LOCK_BYTES = 512;
const MAX_PID = 4_194_304;

type LockMetadata = { pid: number; createdAt: number; nonce: string };

function statePath(override?: string) {
  return override || path.join(process.env.MI_ROOT || path.join(os.homedir(), 'assistant'), 'state', 'pending-confirmations.json');
}

function checkText(value: unknown, max: number, name: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`Invalid ${name}`);
  }
  // These records can resume work later, so do not store material that could be a secret or model/tool data.
  if (/(?:api[ _-]?key|access[ _-]?token|bearer|password|passcode|secret|private[ _-]?key|\.env\b|environment\s+value|model\s+prompt|tool\s+output|authorization:)/iu.test(value)) {
    throw new Error(`Sensitive ${name} is not allowed`);
  }
  return value;
}

function checkThread(value: unknown) {
  const result = checkText(value, MAX_THREAD, 'thread id');
  if (!/^[A-Za-z0-9._:@/+ -]+$/u.test(result)) throw new Error('Invalid thread id');
  return result;
}

function checkReference(value: unknown) {
  const result = checkText(value, MAX_REFERENCE, 'continuation reference');
  if (!/^[A-Za-z0-9._:/-]+$/u.test(result)) throw new Error('Invalid continuation reference');
  return result;
}

function checkActionClass(value: unknown) {
  const result = checkText(value, MAX_ACTION_CLASS, 'action class');
  if (!/^[a-z][a-z0-9_-]*$/u.test(result)) throw new Error('Invalid action class');
  return result;
}

function validRecord(value: unknown): value is PendingConfirmation {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<PendingConfirmation>;
  try {
    if (typeof record.id !== 'string' || !/^[a-f0-9]{32}$/u.test(record.id)) return false;
    checkThread(record.threadId);
    checkText(record.summary, MAX_TEXT, 'summary');
    checkText(record.riskReason, MAX_TEXT, 'risk reason');
    if (typeof record.createdAt !== 'string' || Number.isNaN(Date.parse(record.createdAt))) return false;
    if (typeof record.expiresAt !== 'string' || Number.isNaN(Date.parse(record.expiresAt))) return false;
    if (record.continuationRef !== undefined) checkReference(record.continuationRef);
    if (record.objective !== undefined) checkText(record.objective, MAX_TEXT, 'objective');
    if (record.actionClass !== undefined) checkActionClass(record.actionClass);
    return true;
  } catch {
    return false;
  }
}

async function readState(file: string): Promise<StoredState | null> {
  try {
    const info = await stat(file);
    if (info.size > MAX_FILE_BYTES || (info.mode & 0o077) !== 0) return null;
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || (parsed as StoredState).version !== 1 || !Array.isArray((parsed as StoredState).records)) return null;
    const records = (parsed as StoredState).records;
    if (records.length > MAX_RECORDS || records.some((record) => !validRecord(record))) return null;
    if (new Set(records.map((record) => record.id)).size !== records.length || new Set(records.map((record) => record.threadId)).size !== records.length) return null;
    return { version: 1, records: records as PendingConfirmation[] };
  } catch {
    return null;
  }
}

async function writeState(file: string, records: PendingConfirmation[]) {
  const directory = path.dirname(file);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const content = JSON.stringify({ version: 1, records } satisfies StoredState);
  if (Buffer.byteLength(content) > MAX_FILE_BYTES || records.length > MAX_RECORDS) throw new Error('Pending confirmation state is too large');
  const temporary = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(temporary, content, { mode: 0o600, flag: 'wx' });
    await chmod(temporary, 0o600);
    await rename(temporary, file);
    await chmod(file, 0o600);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

function parseLockMetadata(text: string): LockMetadata | null {
  if (Buffer.byteLength(text) > MAX_LOCK_BYTES) return null;
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== 'object') return null;
    const metadata = value as Partial<LockMetadata>;
    const pid = metadata.pid;
    const createdAt = metadata.createdAt;
    if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0 || pid > MAX_PID) return null;
    if (typeof createdAt !== 'number' || !Number.isSafeInteger(createdAt) || createdAt <= 0) return null;
    if (typeof metadata.nonce !== 'string' || !/^[a-f0-9]{32}$/u.test(metadata.nonce)) return null;
    return { pid, createdAt, nonce: metadata.nonce };
  } catch {
    return null;
  }
}

async function lockSnapshot(lock: string) {
  const info = await stat(lock).catch(() => undefined);
  if (!info) return null;
  // Oversized or unreadable metadata is invalid, but its age and inode still
  // let us recover it after the conservative stale period.
  if (info.size > MAX_LOCK_BYTES) return { info, text: undefined, metadata: null };
  const text = await readFile(lock, 'utf8').catch(() => undefined);
  return { info, text, metadata: text === undefined ? null : parseLockMetadata(text) };
}

function ownerIsAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but cannot be inspected. Treat every
    // other uncertainty as alive too; only ESRCH proves it is absent.
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function sameLockSnapshot(left: Awaited<ReturnType<typeof lockSnapshot>>, right: Awaited<ReturnType<typeof lockSnapshot>>) {
  return Boolean(left && right
    && left.info.ino === right.info.ino
    && left.info.size === right.info.size
    && left.info.mtimeMs === right.info.mtimeMs
    && left.text === right.text);
}

type RecoverySnapshot = {
  info: Awaited<ReturnType<typeof stat>>;
  ownerText: string | undefined;
};

async function recoverySnapshot(recovery: string): Promise<RecoverySnapshot | null> {
  const info = await stat(recovery).catch(() => undefined);
  if (!info || !info.isDirectory()) return null;
  const ownerText = await readFile(path.join(recovery, 'owner'), 'utf8').catch(() => undefined);
  return { info, ownerText };
}

function sameRecoverySnapshot(left: RecoverySnapshot | null, right: RecoverySnapshot | null) {
  return Boolean(left && right && left.info.ino === right.info.ino
    && left.info.mtimeMs === right.info.mtimeMs && left.ownerText === right.ownerText);
}

async function recoverStaleRecovery(recovery: string) {
  const first = await recoverySnapshot(recovery);
  if (!first) return false;
  const owner = first.ownerText === undefined ? null : parseLockMetadata(first.ownerText);
  // An empty owner file means a crash between mkdir and writeFile. It is safe
  // to reclaim only after the marker itself is old. Malformed metadata is
  // uncertainty, so it stays in place rather than being guessed dead.
  if (first.ownerText !== undefined && !owner) return false;
  const ageMs = Date.now() - Math.max(Number(first.info.mtimeMs), owner?.createdAt || 0);
  if (ageMs < LOCK_STALE_MS || (owner && ownerIsAlive(owner.pid))) return false;
  const current = await recoverySnapshot(recovery);
  if (!sameRecoverySnapshot(first, current)) return false;
  const quarantine = `${recovery}.reclaim-${randomBytes(8).toString('hex')}`;
  try {
    await rename(recovery, quarantine);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    return false;
  }
  await rm(quarantine, { recursive: true, force: true });
  return true;
}

async function recoverStaleLock(lock: string) {
  const first = await lockSnapshot(lock);
  if (!first) return false;
  const ageMs = Date.now() - Math.max(first.info.mtimeMs, first.metadata?.createdAt || 0);
  if (ageMs < LOCK_STALE_MS) return false;
  if (first.metadata && ownerIsAlive(first.metadata.pid)) return false;

  const recovery = `${lock}.recovery`;
  try {
    await mkdir(recovery, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    // A crashed recovery attempt must not permanently block this lock.
    await recoverStaleRecovery(recovery);
    return false;
  }
  try {
    await writeFile(path.join(recovery, 'owner'), JSON.stringify({ pid: process.pid, createdAt: Date.now(), nonce: randomBytes(16).toString('hex') }), { mode: 0o600, flag: 'wx' });
    const current = await lockSnapshot(lock);
    if (!sameLockSnapshot(first, current)) return false;
    await rm(lock, { force: false });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  } finally {
    await rm(recovery, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function withLock<T>(file: string, action: () => Promise<T>): Promise<T> {
  const lock = `${file}.lock`;
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await chmod(path.dirname(file), 0o700);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const metadata: LockMetadata = { pid: process.pid, createdAt: Date.now(), nonce: randomBytes(16).toString('hex') };
      const handle = await open(lock, 'wx', 0o600);
      try {
        await handle.writeFile(JSON.stringify(metadata));
        await handle.sync();
        await chmod(lock, 0o600);
      } catch (error) {
        await rm(lock, { force: true }).catch(() => undefined);
        throw error;
      } finally {
        await handle.close();
      }
      try {
        return await action();
      } finally {
        await rm(lock, { force: true });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (await recoverStaleLock(lock)) continue;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error('Could not lock pending confirmation state');
}

function live(record: PendingConfirmation, now: Date) {
  return Date.parse(record.expiresAt) > now.getTime();
}

export async function createPendingConfirmation(input: {
  threadId: string;
  summary: string;
  riskReason: string;
  continuationRef?: string;
  objective?: string;
  actionClass?: string;
}, options: PendingConfirmationOptions = {}): Promise<PendingConfirmation> {
  const threadId = checkThread(input.threadId);
  const summary = checkText(input.summary, MAX_TEXT, 'summary');
  const riskReason = checkText(input.riskReason, MAX_TEXT, 'risk reason');
  const continuationRef = input.continuationRef === undefined ? undefined : checkReference(input.continuationRef);
  const objective = input.objective === undefined ? undefined : checkText(input.objective, MAX_TEXT, 'objective');
  const actionClass = input.actionClass === undefined ? undefined : checkActionClass(input.actionClass);
  const now = options.now || new Date();
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  if (!Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > MAX_TTL_MS) throw new Error('Invalid confirmation expiry');
  const file = statePath(options.statePath);
  return withLock(file, async () => {
    const current = await readState(file);
    const records = (current?.records || []).filter((record) => live(record, now) && record.threadId !== threadId);
    const record: PendingConfirmation = {
      id: randomUUID().replaceAll('-', ''), threadId, summary, riskReason,
      createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
      ...(continuationRef === undefined ? {} : { continuationRef }),
      ...(objective === undefined ? {} : { objective }),
      ...(actionClass === undefined ? {} : { actionClass }),
    };
    records.unshift(record);
    await writeState(file, records);
    return record;
  });
}

export async function readPendingConfirmation(threadId: string, options: PendingConfirmationOptions = {}): Promise<PendingConfirmation | null> {
  const checkedThread = checkThread(threadId);
  const now = options.now || new Date();
  const state = await readState(statePath(options.statePath));
  const record = state?.records.find((item) => item.threadId === checkedThread);
  return record && live(record, now) ? record : null;
}

export async function classifyConfirmationReply(input: { threadId: string; reply: string }, options: PendingConfirmationOptions = {}): Promise<ConfirmationResult> {
  const threadId = checkThread(input.threadId);
  const reply = typeof input.reply === 'string' ? input.reply.trim() : '';
  const match = /^(confirm|deny) ([a-f0-9]{32})$/u.exec(reply.toLowerCase());
  const file = statePath(options.statePath);
  return withLock(file, async () => {
    const state = await readState(file);
    if (!state) return { kind: 'not_found' };
    const now = options.now || new Date();
    const record = state.records.find((item) => item.threadId === threadId);
    if (!record) return { kind: 'not_found' };
    if (!live(record, now)) {
      await writeState(file, state.records.filter((item) => item.id !== record.id));
      return { kind: 'expired' };
    }
    if (!match) return { kind: 'unclear' };
    if (match[2] !== record.id) return { kind: 'not_found' };
    await writeState(file, state.records.filter((item) => item.id !== record.id));
    return { kind: match[1] as 'confirm' | 'deny', record };
  });
}

export async function clearPendingConfirmation(threadId: string, options: PendingConfirmationOptions = {}): Promise<boolean> {
  const checkedThread = checkThread(threadId);
  const file = statePath(options.statePath);
  return withLock(file, async () => {
    const state = await readState(file);
    if (!state) return false;
    const records = state.records.filter((record) => record.threadId !== checkedThread);
    if (records.length === state.records.length) return false;
    await writeState(file, records);
    return true;
  });
}
