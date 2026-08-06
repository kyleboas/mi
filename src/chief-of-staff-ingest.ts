import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { ChiefOfStaffStore, classifyActionRisk, type CommitmentStatus } from './chief-of-staff.js';
import { listThreads, readThreadMessages, type ThreadMessage } from './threads.js';
import { redactSecrets } from './redact.js';

export type ExtractedCommitment = { title: string; detail?: string; status: CommitmentStatus; owner: 'kyle' | 'mi'; confidence: number; dueAt?: string; actionKind?: 'reminder' | 'private_update'; excerpt: string };
export type ExtractedRelationship = { name: string; relationship: string; confidence: number; excerpt: string };
export type IngestResult = { messagesScanned: number; commitmentsCreated: number; peopleUpdated: number; factsCreated: number; artifactsScanned: number; tasksReconciled: number };

function clean(value: string, max = 500) { const text = String(redactSecrets(value)).replace(/\s+/g, ' ').trim(); return text.length > max ? `${text.slice(0, max - 1)}…` : text; }
function digest(value: string) { return createHash('sha256').update(value).digest('hex').slice(0, 24); }
function completeText(value: string, max = 8000) {
  const text = String(redactSecrets(value)).replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  const boundary = text.lastIndexOf(' ', max);
  return `${text.slice(0, boundary > max * 0.7 ? boundary : max).trimEnd()} [Additional context remains in the source conversation.]`;
}
function originalExcerpt(value: string, max = 8000) {
  const text = String(redactSecrets(value)).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  if (text.length <= max) return text;
  return `${text.slice(0, max).trimEnd()}\n[Additional context remains in the source conversation.]`;
}
function stripTitle(value: string) { return clean(value.replace(/^(?:that\s+)?/i, '').replace(/[.!?]+$/, ''), 300); }
function titleAndDetail(value: string) {
  const full = completeText(value.replace(/^(?:that\s+)?/i, '').replace(/[.!?]+$/, ''));
  if (full.length <= 300) return { title: full };
  const colon = full.indexOf(':');
  if (colon >= 12 && colon <= 220) return { title: full.slice(0, colon).trim(), detail: full };
  const sentence = full.slice(0, 280).match(/^(.{40,}?[.!?])(?:\s|$)/)?.[1];
  if (sentence) return { title: sentence, detail: full };
  const boundary = full.lastIndexOf(' ', 260);
  return { title: `${full.slice(0, boundary > 100 ? boundary : 260).trimEnd()} (see details)`, detail: full };
}
function dueFromText(text: string, now = new Date()) {
  const iso = text.match(/\b(?:by|before|on)\s+(20\d{2}-\d{2}-\d{2})\b/i)?.[1];
  if (iso) return new Date(`${iso}T17:00:00`).toISOString();
  if (/\btomorrow\b/i.test(text)) { const date = new Date(now); date.setDate(date.getDate() + 1); date.setHours(17, 0, 0, 0); return date.toISOString(); }
  return undefined;
}
function safeCandidate(text: string) {
  const value = text.trim();
  if (!value || value.length < 5 || value.length > 2000) return false;
  if (/\b(?:password|secret|token|api[_ -]?key|\.env)\b/i.test(value)) return false;
  if (/^(?:>|assistant:|mi:)/i.test(value)) return false;
  return true;
}

export function extractCommitmentsFromUserText(text: string, now = new Date()): ExtractedCommitment[] {
  if (!safeCandidate(text)) return [];
  const value = text.replace(/\s+/g, ' ').trim();
  if (/\b(?:assistant|mi)\s+(?:said|says|claimed|wrote|replied)\b[^.!?]{0,120}\bI\s+(?:will|'ll|must|need to|have to)\b/i.test(value) || /^(?:assistant|mi)\s*:/i.test(value)) return [];
  const out: ExtractedCommitment[] = [];
  const push = (raw: string, status: CommitmentStatus, owner: 'kyle' | 'mi', confidence: number, actionKind?: ExtractedCommitment['actionKind']) => {
    const { title, detail } = titleAndDetail(raw);
    if (!title || /^(?:not|never|no longer)\b/i.test(title) || /\b(?:password|secret|token|api[_ -]?key)\b/i.test(title)) return;
    out.push({ title, detail, status, owner, confidence, dueAt: dueFromText(value, now), actionKind, excerpt: originalExcerpt(text) });
  };

  let match = value.match(/\bremind me to\s+(.+?)(?:$|[.;])/i);
  if (match) push(match[1], 'active', 'mi', 0.98, 'reminder');

  match = value.match(/(?:^|[.!]\s+)(?:please\s+|can you\s+|could you\s+|would you\s+)(?!tell me|explain|show me|help me understand)(.+?)(?:$|[.;])/i);
  if (match) push(match[1], 'proposed', 'mi', 0.88, 'private_update');

  match = value.match(/\bI\s+(?:will|'ll|must|have to|need to|am going to|plan to|intend to)\s+(?!not\b|never\b|know\b|understand\b|ask\b|wonder\b)(.+?)(?:$|[.;])/i);
  if (match) {
    const uncertainPrefix = /\b(?:maybe|might|probably|I think|I guess)\b/i.test(value.slice(0, match.index ?? 0));
    push(match[1], uncertainPrefix ? 'needs_clarification' : 'active', 'kyle', uncertainPrefix ? 0.55 : 0.94);
  }

  match = value.match(/\b(?:maybe\s+)?I\s+(?:should|could|might)\s+(.+?)(?:$|[.;])/i);
  if (match) push(match[1], 'needs_clarification', 'kyle', 0.52);
  match = value.match(/\bwe\s+(?:should|need to|have to|might)\s+(.+?)(?:$|[.;])/i);
  if (match) push(match[1], 'needs_clarification', 'kyle', 0.45);

  const seen = new Set<string>();
  return out.filter((item) => { const key = item.title.toLowerCase(); if (seen.has(key)) return false; seen.add(key); return true; });
}

const sensitiveRelationships = /\b(?:diagnosis|medical|religion|politic|sexual|race|ethnic|disability|salary|debt|ssn|social security)\b/i;
export function extractRelationshipsFromUserText(text: string): ExtractedRelationship[] {
  if (!safeCandidate(text) || sensitiveRelationships.test(text)) return [];
  const out: ExtractedRelationship[] = [];
  const pattern = /(?:^|[.!]\s+)([A-Z][A-Za-z'’-]{1,40}(?:\s+[A-Z][A-Za-z'’-]{1,40})?)\s+is\s+my\s+(friend|partner|wife|husband|spouse|sister|brother|mother|father|mom|dad|colleague|coworker|manager|assistant|neighbor|client)\b/gi;
  for (const match of text.matchAll(pattern)) out.push({ name: clean(match[1], 100), relationship: clean(match[2], 100).toLowerCase(), confidence: 0.98, excerpt: originalExcerpt(text) });
  return out;
}

type ThreadCursor = { ts: string; id: string };
function parseThreadCursor(value?: string): ThreadCursor | undefined {
  if (!value) return undefined;
  const match = value.match(/^(\d{4}-\d{2}-\d{2}T[^\s]+Z):(.+)$/);
  return match ? { ts: match[1], id: match[2] } : undefined;
}
function compareMessageRef(left: Pick<ThreadMessage, 'ts' | 'id'>, right: ThreadCursor) {
  const leftTime = Date.parse(left.ts), rightTime = Date.parse(right.ts);
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) return leftTime - rightTime;
  if (left.ts !== right.ts) return left.ts.localeCompare(right.ts);
  return left.id.localeCompare(right.id);
}
function threadMessagesAfterCursor(messages: ThreadMessage[], cursorValue?: string) {
  const cursor = parseThreadCursor(cursorValue);
  if (!cursor) return messages;
  // The exact cursor message may have been compacted away. Timestamp/id
  // ordering still selects only genuinely newer records; source keys remain a
  // second idempotency boundary if old records are ever reconsidered.
  return messages.filter((message) => compareMessageRef(message, cursor) > 0);
}
function newestMessageRef(messages: ThreadMessage[], prior?: ThreadCursor) {
  let newest = prior;
  for (const message of messages) if (!newest || compareMessageRef(message, newest) > 0) newest = { ts: message.ts, id: message.id };
  return newest;
}
function sourceForMessage(message: ThreadMessage) { return `thread:${message.threadId}:message:${message.id}`; }
function createFromMessage(store: ChiefOfStaffStore, message: ThreadMessage) {
  if (message.role !== 'user') return { commitments: 0, people: 0, facts: 0 };
  const sourceKey = sourceForMessage(message); let commitments = 0, people = 0, facts = 0;
  for (const item of extractCommitmentsFromUserText(message.text, new Date(message.ts))) {
    const commitmentSource = `${sourceKey}:commitment:${digest(item.title)}`;
    const existed = Boolean(store.getCommitment(commitmentSource));
    const record = store.createCommitment({ ...item, sourceKey: commitmentSource, sourceType: message.source || 'thread', sourceExcerpt: item.excerpt, reviewAt: item.status === 'needs_clarification' ? new Date(Date.parse(message.ts) + 24 * 60 * 60_000) : undefined });
    if (!existed) commitments += 1;
    if (item.actionKind) {
      const riskClass = item.actionKind === 'reminder' ? 'internal' : classifyActionRisk(item.title);
      store.createAction({ kind: riskClass === 'internal' ? item.actionKind : 'requested_action', title: item.title, riskClass, sourceKey: `${sourceKey}:action:${digest(item.title)}`, idempotencyKey: `${sourceKey}:action:${digest(item.title)}`, commitmentId: record.id });
    }
  }
  for (const item of extractRelationshipsFromUserText(message.text)) {
    const personSource = `${sourceKey}:person:${digest(item.name)}`;
    const personExisted = Boolean(store.getPerson(item.name));
    store.upsertPerson({ name: item.name, relationship: item.relationship, confidence: item.confidence, sourceKey: personSource });
    if (!personExisted) people += 1;
    const factSource = `${sourceKey}:relationship:${digest(item.name)}`;
    const factExisted = Boolean(store.getMemoryFact(factSource));
    store.upsertMemoryFact({ subject: item.name, fact: `Relationship to Kyle: ${item.relationship}`, confidence: item.confidence, sourceKey: factSource, sourceType: message.source || 'thread', sourceExcerpt: item.excerpt });
    if (!factExisted) facts += 1;
  }
  return { commitments, people, facts };
}

async function ingestArtifacts(store: ChiefOfStaffStore) {
  const defaults = [join(homedir(), 'mi', 'TODO.md'), join(homedir(), 'mi', 'goals.md'), join(homedir(), 'pi-docs', 'PLANS.md')];
  const configured = (process.env.MI_CHIEF_OF_STAFF_ARTIFACTS || '').split(':').map((item) => item.trim()).filter(Boolean);
  let scanned = 0;
  for (const path of configured.length ? configured : defaults) {
    const text = await readFile(path, 'utf8').catch(() => '');
    if (!text) continue;
    const cursorKey = `artifact:${path}`;
    const contentDigest = digest(text);
    if (store.getCursor(cursorKey) === contentDigest) continue;
    scanned += 1;
    const project = store.upsertProject({ name: basename(path).replace(/\.md$/i, ''), context: `Local planning artifact: ${path}`, sourceKey: `artifact-project:${path}` });
    text.split('\n').forEach((line) => {
      const match = line.match(/^\s*[-*]\s+\[ \]\s+(.{5,300})$/); if (!match) return;
      const title = stripTitle(match[1]);
      const normalizedTitle = title.toLowerCase().replace(/\s+/g, ' ').trim();
      const sourceKey = `artifact:${path}:task:${digest(normalizedTitle)}`;
      const existing = store.listCommitments({ limit: 1000 }).find((item) => item.projectId === project.id && item.title.toLowerCase().replace(/\s+/g, ' ').trim() === normalizedTitle);
      if (!existing) store.createCommitment({ title, status: 'proposed', owner: 'kyle', confidence: 0.65, sourceKey, sourceType: 'artifact', sourceExcerpt: line, projectId: project.id });
    });
    store.setCursor(cursorKey, contentDigest);
  }
  return scanned;
}

type DaemonTask = { id?: string; name?: string; lastInput?: string; text?: string; status?: string; needsUser?: boolean; needsUserReason?: string; error?: string; result?: string; progress?: string; startedAt?: string; updatedAt?: string; finishedAt?: string };
async function reconcileTasks(store: ChiefOfStaffStore) {
  const paths = [...new Set([process.env.MI_TASKS_PATH, join(homedir(), 'mi', 'state', 'tasks.json'), join(process.env.MI_ROOT || join(homedir(), 'assistant'), 'state', 'web-workers.json')].filter(Boolean) as string[])];
  let count = 0;
  for (const path of paths) {
    const text = await readFile(path, 'utf8').catch(() => '');
    if (!text) continue;
    const cursorKey = `daemon-tasks:${path}`;
    const contentDigest = digest(text);
    if (store.getCursor(cursorKey) === contentDigest) continue;
    let tasks: DaemonTask[];
    try { tasks = JSON.parse(text); } catch { continue; }
    if (!Array.isArray(tasks)) continue;
    for (const task of tasks) {
      const taskId = String(task.id || ''); const title = clean(task.lastInput || task.name || '', 300); if (!taskId || !title || !safeCandidate(title)) continue;
      const sourceKey = `daemon-task:${taskId}`;
      const commitment = store.createCommitment({ title, status: task.needsUser ? 'blocked' : 'proposed', owner: 'mi', confidence: 0.72, sourceKey: `${sourceKey}:commitment`, sourceType: 'daemon-task', sourceExcerpt: title });
      const action = store.createAction({ kind: 'delegated_task', title, sourceKey, idempotencyKey: sourceKey, commitmentId: commitment.id, externalRef: taskId, riskClass: classifyActionRisk(title) });
      const status = String(task.status || '').toLowerCase();
      if (['error', 'failed'].includes(status)) { if (action.status !== 'failed') store.transitionAction(action.id, 'failed', { error: task.error || task.needsUserReason || 'daemon task failed' }); store.updateCommitment(commitment.id, { status: 'blocked' }); }
      else if (task.finishedAt || ['complete', 'completed', 'done'].includes(status)) { if (!['completed', 'verification_required'].includes(action.status)) store.transitionAction(action.id, 'verification_required', { result: task.text || task.result || task.progress || 'daemon reports completion; verification required' }); }
      else if (['running', 'active', 'queued', 'thinking'].includes(status) && !['executing', 'completed'].includes(action.status)) {
        if (action.approvalRequired && !action.approvedAt) store.updateCommitment(commitment.id, { status: 'blocked' });
        else store.transitionAction(action.id, 'executing', { result: task.progress || 'daemon task running' });
      }
      else if (task.needsUser) store.updateCommitment(commitment.id, { status: 'blocked' });
      count += 1;
    }
    store.setCursor(cursorKey, contentDigest);
  }
  return count;
}

export async function ingestChiefOfStaffSources(store: ChiefOfStaffStore): Promise<IngestResult> {
  let messagesScanned = 0, commitmentsCreated = 0, peopleUpdated = 0, factsCreated = 0;
  for (const thread of await listThreads()) {
    const cursorKey = `thread:${thread.id}`;
    const cursor = parseThreadCursor(store.getCursor(cursorKey));
    const messages = await readThreadMessages(thread.id);
    const pending = threadMessagesAfterCursor(messages, cursor ? `${cursor.ts}:${cursor.id}` : undefined);
    for (const message of pending) {
      messagesScanned += 1; const result = createFromMessage(store, message); commitmentsCreated += result.commitments; peopleUpdated += result.people; factsCreated += result.facts;
    }
    const newest = newestMessageRef(messages, cursor);
    if (newest && (!cursor || newest.ts !== cursor.ts || newest.id !== cursor.id)) store.setCursor(cursorKey, `${newest.ts}:${newest.id}`);
  }
  return { messagesScanned, commitmentsCreated, peopleUpdated, factsCreated, artifactsScanned: await ingestArtifacts(store), tasksReconciled: await reconcileTasks(store) };
}
