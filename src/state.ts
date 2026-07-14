import { access, appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { type CapabilityAuditEvent, type CapabilityGrant, type CapabilityRight, type Principal, mintCapabilityGrant } from './capabilities.js';
import { redactSecrets } from './redact.js';

const stateDir = path.resolve('state');
const eventsFile = path.join(stateDir, 'events.jsonl');
const approvalsJsonlFile = path.join(stateDir, 'approvals.jsonl');
const approvalsJsonFile = path.join(stateDir, 'approvals.json');
const pausedFile = path.join(stateDir, 'PAUSED');
const killFile = path.join(stateDir, 'KILL');

export type Approval = {
  id: string;
  createdAt: string;
  status: 'pending' | 'approved' | 'rejected' | 'completed' | 'failed';
  prompt: string;
  reason: string;
  result?: string;
  resource?: string;
  rights?: CapabilityRight[];
  principal?: Principal;
  expiresAt?: string;
  capabilityId?: string;
  v2PendingAction?: {
    threadId: string;
    objective: string;
    capability: string;
    confirmationId: string;
    consumedAt?: string;
  };
};

export async function ensureState() {
  await mkdir(stateDir, { recursive: true });
}

export async function logEvent(type: string, data: unknown) {
  await ensureState();
  await appendFile(eventsFile, JSON.stringify({ ts: new Date().toISOString(), type, data: redactSecrets(data) }) + '\n');
}

function dedupeApprovals(items: Approval[]) {
  const seen = new Set<string>();
  const out: Approval[] = [];
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

export async function readApprovals(): Promise<Approval[]> {
  await ensureState();
  const items: Approval[] = [];
  try {
    const lines = (await readFile(approvalsJsonlFile, 'utf8')).trim().split('\n').filter(Boolean);
    items.push(...lines.map((line) => JSON.parse(line) as Approval));
  } catch {}
  try {
    items.push(...(JSON.parse(await readFile(approvalsJsonFile, 'utf8')) as Approval[]));
  } catch {}
  return dedupeApprovals(items);
}

export async function writeApprovals(items: Approval[]) {
  await ensureState();
  const deduped = dedupeApprovals(items);
  await writeFile(approvalsJsonlFile, deduped.map((item) => JSON.stringify(item)).join('\n') + (deduped.length ? '\n' : ''));
  await writeFile(approvalsJsonFile, JSON.stringify(deduped, null, 2));
}

export async function isPaused() {
  await ensureState();
  try {
    await access(pausedFile);
    return true;
  } catch {
    return false;
  }
}

export async function isKilled() {
  await ensureState();
  try {
    await access(killFile);
    return true;
  } catch {
    return false;
  }
}

export async function readRecentEvents(limit = 100) {
  await ensureState();
  try {
    const text = await readFile(eventsFile, 'utf8');
    return text.trim().split('\n').filter(Boolean).slice(-limit).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

export async function createApproval(prompt: string, reason: string, capabilityRequest: Partial<Pick<Approval, 'resource' | 'rights' | 'principal' | 'expiresAt'>> = {}) {
  const items = await readApprovals();
  const approval: Approval = {
    id: Math.random().toString(36).slice(2, 10),
    createdAt: new Date().toISOString(),
    status: 'pending',
    prompt: String(redactSecrets(prompt)),
    reason: String(redactSecrets(reason)),
    resource: capabilityRequest.resource,
    rights: capabilityRequest.rights,
    principal: capabilityRequest.principal,
    expiresAt: capabilityRequest.expiresAt,
  };
  items.unshift(approval);
  await writeApprovals(items);
  await logEvent('approval.created', approval);
  return approval;
}

export async function resolveApproval(approvalId: string, status: 'approved' | 'rejected', result?: string): Promise<Approval | undefined> {
  const items = await readApprovals();
  const approval = items.find((item) => item.id === approvalId || item.id.startsWith(approvalId));
  if (!approval) return undefined;
  approval.status = status;
  approval.result = result ? String(redactSecrets(result)) : approval.result;
  await writeApprovals(items);
  await logEvent(`approval.${status}`, { approvalId: approval.id, result: approval.result });
  return approval;
}

export async function approveAsCapability(approvalId: string): Promise<CapabilityGrant | undefined> {
  const items = await readApprovals();
  const approval = items.find((item) => item.id === approvalId || item.id.startsWith(approvalId));
  if (!approval?.resource || !approval.rights?.length) {
    if (approval) await resolveApproval(approval.id, 'approved');
    return undefined;
  }
  const grant = mintCapabilityGrant({
    id: approval.capabilityId,
    resource: approval.resource,
    rights: approval.rights,
    principal: approval.principal,
    createdAt: new Date().toISOString(),
    expiresAt: approval.expiresAt,
  });
  approval.status = 'approved';
  approval.capabilityId = grant.id;
  approval.expiresAt = grant.expiresAt || approval.expiresAt;
  await writeApprovals(items);
  await logEvent('capability.granted', { approvalId, grant });
  return grant;
}

export async function logCapabilityAudit(event: CapabilityAuditEvent) {
  await logEvent('capability.audit', event);
}
