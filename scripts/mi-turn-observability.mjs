import { createHash } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

export const TURN_STAGES = new Set(['inbound', 'decision', 'ack', 'task-start', 'task-terminal', 'result-formatted', 'send', 'cleanup', 'terminal']);
const OUTCOMES = new Set(['ok', 'error', 'skipped', 'fallback', 'blocked']);
export function turnHash(value) { return createHash('sha256').update(String(value || '')).digest('hex').slice(0, 16); }
export function sanitizeTurnEvent(value = {}) {
  const stage = TURN_STAGES.has(value.stage) ? value.stage : 'terminal';
  const outcome = OUTCOMES.has(value.outcome) ? value.outcome : 'ok';
  const event = { schema: 'mi.turn.v1', stage, outcome, ts: new Date().toISOString() };
  if (Number.isInteger(value.durationMs) && value.durationMs >= 0 && value.durationMs <= 86_400_000) event.durationMs = value.durationMs;
  if (['v1', 'v2', 'web', 'photon'].includes(value.route)) event.route = value.route;
  if (['mi-concierge', 'legacy', 'none'].includes(value.modelProfile)) event.modelProfile = value.modelProfile;
  if (value.turn) event.turn = turnHash(value.turn);
  return event;
}
export async function emitTurnEvent(root, value) {
  const event = sanitizeTurnEvent(value);
  const file = path.join(root, 'state', 'mi-turn-events.jsonl');
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await appendFile(file, `${JSON.stringify(event)}\n`, { mode: 0o600 });
  return event;
}
