import { randomUUID } from 'node:crypto';

// This is deliberately only a short-lived adapter. Luna's durable pending
// confirmation module should replace these functions during integration.
const pendingByThread = new Map();
const pendingLifetimeMs = 30 * 60 * 1000;

function live(value) {
  return value && value.expiresAt > Date.now() ? value : undefined;
}

export function createPendingImessageConfirmation(threadId, action) {
  const pending = {
    id: randomUUID(),
    threadId: String(threadId || ''),
    objective: String(action?.objective || ''),
    capability: String(action?.capability || ''),
    cwd: String(action?.cwd || ''),
    createdAt: Date.now(),
    expiresAt: Date.now() + pendingLifetimeMs,
  };
  pendingByThread.set(pending.threadId, pending);
  return pending;
}

export function pendingImessageConfirmation(threadId) {
  const key = String(threadId || '');
  const pending = live(pendingByThread.get(key));
  if (!pending) pendingByThread.delete(key);
  return pending;
}

export function clearPendingImessageConfirmation(threadId) {
  pendingByThread.delete(String(threadId || ''));
}
