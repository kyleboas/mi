import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export type HealthSidecarStatus = 'ok' | 'degraded' | 'error' | 'human-required';

export type HealthSidecarPayload = {
  step: string;
  status: HealthSidecarStatus;
  checked_at?: string;
  reason?: string;
  counts?: Record<string, number>;
  error?: string;
  log_file?: string;
  exit_code?: number;
  human_action_required?: boolean;
};

export function normalizeHealthSidecar(payload: HealthSidecarPayload, now = new Date()) {
  const status = payload.status;
  const reason = payload.reason || (status === 'ok' ? 'ok' : status);
  return {
    version: 1,
    checked_at: payload.checked_at || now.toISOString(),
    step: payload.step,
    status,
    reason,
    counts: payload.counts || {},
    ...(payload.error ? { error: payload.error.slice(0, 500) } : {}),
    ...(payload.log_file ? { log_file: payload.log_file } : {}),
    ...(typeof payload.exit_code === 'number' ? { exit_code: payload.exit_code } : {}),
    ...(payload.human_action_required ? { human_action_required: true } : {}),
  };
}

export async function writeHealthSidecar(path: string, payload: HealthSidecarPayload, now = new Date()) {
  await mkdir(dirname(path), { recursive: true });
  const normalized = normalizeHealthSidecar(payload, now);
  await writeFile(path, `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600 });
  return normalized;
}
