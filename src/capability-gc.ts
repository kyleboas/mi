import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export type CapabilityGrantGcResult = {
  scanned: number;
  deleted: number;
  kept: number;
  dir: string;
};

const defaultRuntimeDir = () => process.env.MI_RUNTIME_DIR || join(homedir(), '.pi', 'agent', 'mi');
const defaultMaxAgeMs = () => Number(process.env.MI_CAPABILITY_GRANT_MAX_AGE_MS || 24 * 60 * 60_000);
const defaultMaxFiles = () => Math.max(1, Number(process.env.MI_CAPABILITY_GRANT_MAX_FILES || 200));
const defaultTtlMs = () => Number(process.env.MI_CAPABILITY_GRANT_TTL_MS || 6 * 60 * 60_000);

export function capabilityGrantExpiresAt(createdAt = new Date().toISOString(), ttlMs = defaultTtlMs()) {
  return new Date(Date.parse(createdAt) + ttlMs).toISOString();
}

function newestGrantExpiry(payload: any) {
  const grants = Array.isArray(payload?.grants) ? payload.grants : [];
  const expiries = grants
    .map((grant: { expiresAt?: unknown }) => Date.parse(String(grant?.expiresAt || '')))
    .filter((value: number) => Number.isFinite(value));
  return expiries.length > 0 ? Math.max(...expiries) : 0;
}

async function expiredOrTooOld(path: string, nowMs: number, maxAgeMs: number) {
  const info = await stat(path);
  try {
    const payload = JSON.parse(await readFile(path, 'utf8'));
    const expiry = newestGrantExpiry(payload);
    if (expiry > 0) return expiry <= nowMs;
  } catch {}
  return nowMs - info.mtimeMs > maxAgeMs;
}

export async function runCapabilityGrantGc(options: { dir?: string; now?: Date; maxAgeMs?: number; maxFiles?: number } = {}): Promise<CapabilityGrantGcResult> {
  const dir = options.dir || join(defaultRuntimeDir(), 'capabilities');
  const nowMs = (options.now || new Date()).getTime();
  const maxAgeMs = options.maxAgeMs ?? defaultMaxAgeMs();
  const maxFiles = options.maxFiles ?? defaultMaxFiles();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const entries = (await readdir(dir, { withFileTypes: true })).filter((entry) => entry.isFile() && entry.name.endsWith('.json'));
  let deleted = 0;
  const kept: Array<{ name: string; mtimeMs: number }> = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (await expiredOrTooOld(path, nowMs, maxAgeMs).catch(() => true)) {
      await rm(path, { force: true });
      deleted += 1;
      continue;
    }
    const info = await stat(path).catch(() => undefined);
    if (info) kept.push({ name: entry.name, mtimeMs: info.mtimeMs });
  }
  kept.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const stale of kept.slice(maxFiles)) {
    await rm(join(dir, stale.name), { force: true });
    deleted += 1;
  }
  return { scanned: entries.length, deleted, kept: Math.max(0, entries.length - deleted), dir };
}

export async function writeCapabilityGrantGcMarker(result: CapabilityGrantGcResult, markerPath = join(defaultRuntimeDir(), 'capability-gc.json')) {
  await mkdir(dirname(markerPath), { recursive: true });
  await writeFile(markerPath, JSON.stringify({ ...result, checkedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
}
