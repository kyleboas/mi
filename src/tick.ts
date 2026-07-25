import { open, rm, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { runCapabilityGrantGc, writeCapabilityGrantGcMarker } from './capability-gc.js';
import { tickReminderCrons } from './crons.js';
import { runImessageMonitor } from './imessage-monitor.js';
import { runDreamConsolidation } from './memory.js';
import { logEvent } from './state.js';

export type MiTickResult = {
  reminders: Array<{ name: string; status: 'ok' | 'error' | 'skipped' }>;
  imessageMonitor: Awaited<ReturnType<typeof runImessageMonitor>>;
  capabilityGrantGc: Awaited<ReturnType<typeof runCapabilityGrantGc>>;
  memory: Awaited<ReturnType<typeof runDreamConsolidation>>;
};

const miRoot = process.env.MI_ROOT || join(homedir(), 'assistant');
const stateDir = resolve(miRoot, 'state');
const lockPath = process.env.MI_TICK_LOCK_PATH || join(stateDir, 'tick.lock');

const TICK_LOCK_STALE_MS = 30 * 1000;
const MAX_LOCK_BYTES = 512;
const MAX_PID = 4_194_304;

type TickLockMetadata = { pid: number; createdAt: number; nonce: string };

function parseTickLock(text: string): TickLockMetadata | null {
  if (Buffer.byteLength(text) > MAX_LOCK_BYTES) return null;
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== 'object') return null;
    const item = value as Partial<TickLockMetadata>;
    if (typeof item.pid !== 'number' || !Number.isSafeInteger(item.pid) || item.pid <= 0 || item.pid > MAX_PID) return null;
    if (typeof item.createdAt !== 'number' || !Number.isSafeInteger(item.createdAt) || item.createdAt <= 0) return null;
    if (typeof item.nonce !== 'string' || !/^[a-f0-9]{32}$/u.test(item.nonce)) return null;
    return { pid: item.pid, createdAt: item.createdAt, nonce: item.nonce };
  } catch { return null; }
}

function tickOwnerAlive(pid: number) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

async function tickLockSnapshot(file: string) {
  const info = await stat(file).catch(() => undefined);
  if (!info) return null;
  const text = info.size <= MAX_LOCK_BYTES ? await readFile(file, 'utf8').catch(() => undefined) : undefined;
  return { info, text, metadata: text === undefined ? null : parseTickLock(text) };
}

async function recoverTickRecovery(recovery: string) {
  const info = await stat(recovery).catch(() => undefined);
  if (!info || !info.isDirectory()) return false;
  const ownerFile = join(recovery, 'owner');
  const ownerText = await readFile(ownerFile, 'utf8').catch(() => undefined);
  const owner = ownerText === undefined ? null : parseTickLock(ownerText);
  if (ownerText !== undefined && !owner) return false;
  const ageMs = Date.now() - Math.max(info.mtimeMs, owner?.createdAt || 0);
  if (ageMs < TICK_LOCK_STALE_MS || (owner && tickOwnerAlive(owner.pid))) return false;
  const current = await stat(recovery).catch(() => undefined);
  if (!current || current.ino !== info.ino || current.mtimeMs !== info.mtimeMs) return false;
  const quarantine = `${recovery}.reclaim-${randomBytes(8).toString('hex')}`;
  try { await rename(recovery, quarantine); }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT'; }
  await rm(quarantine, { recursive: true, force: true });
  return true;
}

async function recoverTickLock() {
  const first = await tickLockSnapshot(lockPath);
  if (!first) return false;
  const ageMs = Date.now() - Math.max(first.info.mtimeMs, first.metadata?.createdAt || 0);
  if (ageMs < TICK_LOCK_STALE_MS || (first.metadata && tickOwnerAlive(first.metadata.pid))) return false;
  const recovery = `${lockPath}.recovery`;
  try { await mkdir(recovery, { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    await recoverTickRecovery(recovery);
    return false;
  }
  try {
    await writeFile(join(recovery, 'owner'), JSON.stringify({ pid: process.pid, createdAt: Date.now(), nonce: randomBytes(16).toString('hex') }), { mode: 0o600, flag: 'wx' });
    const current = await tickLockSnapshot(lockPath);
    if (!current || current.info.ino !== first.info.ino || current.info.mtimeMs !== first.info.mtimeMs || current.text !== first.text) return false;
    await rm(lockPath, { force: false });
    return true;
  } finally {
    await rm(recovery, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function withTickLock<T>(fn: () => Promise<T>): Promise<T> {
  await mkdir(dirname(lockPath), { recursive: true });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    let handle;
    try {
      handle = await open(lockPath, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      await recoverTickLock();
      await new Promise((resolve) => setTimeout(resolve, 10));
      continue;
    }
    const metadata: TickLockMetadata = { pid: process.pid, createdAt: Date.now(), nonce: randomBytes(16).toString('hex') };
    try {
      await handle.writeFile(JSON.stringify(metadata));
      await handle.sync();
      return await fn();
    } finally {
      await handle.close().catch(() => undefined);
      await rm(lockPath, { force: true }).catch(() => undefined);
    }
  }
  throw new Error(`Mi tick already running: ${lockPath}`);
}

export async function runMiTick(): Promise<MiTickResult> {
  return withTickLock(async () => {
    const reminders = await tickReminderCrons();
    const capabilityGrantGc = await runCapabilityGrantGc();
    await writeCapabilityGrantGcMarker(capabilityGrantGc);
    const memory = await runDreamConsolidation().catch((error) => ({
      status: 'error' as const,
      error: error instanceof Error ? error.message : String(error),
    }));
    const imessageMonitor = await runImessageMonitor();

    await logEvent('mi.tick.complete', {
      reminders: reminders.length,
      capabilityGrantGc,
      memory: memory.status,
      imessageMonitor: imessageMonitor.status,
    });
    return { reminders, imessageMonitor, capabilityGrantGc, memory };
  });
}
