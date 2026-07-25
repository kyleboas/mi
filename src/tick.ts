import { open, rm, mkdir } from 'node:fs/promises';
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

async function withTickLock<T>(fn: () => Promise<T>): Promise<T> {
  await mkdir(dirname(lockPath), { recursive: true });
  let handle;
  try {
    handle = await open(lockPath, 'wx', 0o600);
  } catch {
    throw new Error(`Mi tick already running: ${lockPath}`);
  }
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    return await fn();
  } finally {
    await handle.close().catch(() => undefined);
    await rm(lockPath, { force: true }).catch(() => undefined);
  }
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
