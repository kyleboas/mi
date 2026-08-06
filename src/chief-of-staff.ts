import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, rename, writeFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { backup as sqliteBackup, DatabaseSync } from 'node:sqlite';
import { redactSecrets } from './redact.js';
import { logEvent } from './state.js';

export type CommitmentStatus = 'needs_clarification' | 'proposed' | 'active' | 'blocked' | 'completed' | 'cancelled';
export type ActionStatus = 'proposed' | 'approved' | 'executing' | 'verification_required' | 'completed' | 'failed' | 'cancelled';
export type RiskClass = 'internal' | 'external' | 'destructive' | 'financial' | 'publication' | 'infrastructure';
export type Owner = 'kyle' | 'mi' | string;

export type Person = {
  id: string; name: string; relationship?: string; notes?: string; confidence: number; sourceKey?: string;
  createdAt: string; updatedAt: string;
};
export type Project = { id: string; name: string; context?: string; sourceKey?: string; createdAt: string; updatedAt: string };
export type Commitment = {
  id: string; title: string; detail?: string; status: CommitmentStatus; owner: Owner; dueAt?: string; reviewAt?: string;
  confidence: number; sourceKey?: string; sourceType?: string; sourceExcerpt?: string; projectId?: string; personId?: string;
  completionVerified: boolean; completionEvidence?: string; createdAt: string; updatedAt: string; completedAt?: string;
};
export type Action = {
  id: string; kind: string; title: string; payload: Record<string, unknown>; status: ActionStatus; riskClass: RiskClass;
  approvalRequired: boolean; approvedAt?: string; approvalConsumedAt?: string; idempotencyKey: string; sourceKey?: string;
  commitmentId?: string; attempts: number; result?: string; error?: string; externalRef?: string; createdAt: string; updatedAt: string;
};
export type MemoryFact = {
  id: string; subject: string; fact: string; confidence: number; sourceKey: string; sourceType?: string; sourceExcerpt?: string;
  supersedesId?: string; supersededAt?: string; createdAt: string; updatedAt: string;
};
export type FollowUp = { id: string; personId?: string; commitmentId?: string; reason: string; dueAt: string; status: 'open' | 'completed' | 'cancelled'; sourceKey?: string; createdAt: string; updatedAt: string };
export type StoreOptions = { path?: string; now?: () => Date };
export type ActionHandlerResult = { result: string; verified?: boolean };
export type ActionHandler = (action: Action, store: ChiefOfStaffStore) => Promise<ActionHandlerResult> | ActionHandlerResult;

const handlers = new Map<string, ActionHandler>();
const consequentialRisks = new Set<RiskClass>(['external', 'destructive', 'financial', 'publication', 'infrastructure']);

function iso(value?: string | Date) {
  if (!value) return undefined;
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`invalid timestamp: ${value}`);
  return parsed.toISOString();
}
function clean(value: unknown, max = 1000) {
  const text = String(redactSecrets(String(value ?? ''))).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
function excerpt(value: unknown, max = 1000) {
  const text = String(redactSecrets(String(value ?? ''))).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  if (text.length <= max) return text;
  const boundary = text.lastIndexOf(' ', max);
  return `${text.slice(0, boundary > max * 0.7 ? boundary : max).trimEnd()}\n[Additional context remains in the original source.]`;
}
function hash(value: string) { return createHash('sha256').update(value).digest('hex'); }
function id(prefix: string) { return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 16)}`; }
function bool(value: unknown) { return Number(value) === 1; }
function json(value: unknown) { try { return JSON.parse(String(value || '{}')); } catch { return {}; } }
function rowPerson(row: any): Person { return { id: row.id, name: row.name, relationship: row.relationship || undefined, notes: row.notes || undefined, confidence: row.confidence, sourceKey: row.source_key || undefined, createdAt: row.created_at, updatedAt: row.updated_at }; }
function rowCommitment(row: any): Commitment { return { id: row.id, title: row.title, detail: row.detail || undefined, status: row.status, owner: row.owner, dueAt: row.due_at || undefined, reviewAt: row.review_at || undefined, confidence: row.confidence, sourceKey: row.source_key || undefined, sourceType: row.source_type || undefined, sourceExcerpt: row.source_excerpt || undefined, projectId: row.project_id || undefined, personId: row.person_id || undefined, completionVerified: bool(row.completion_verified), completionEvidence: row.completion_evidence || undefined, createdAt: row.created_at, updatedAt: row.updated_at, completedAt: row.completed_at || undefined }; }
function rowAction(row: any): Action { return { id: row.id, kind: row.kind, title: row.title, payload: json(row.payload_json), status: row.status, riskClass: row.risk_class, approvalRequired: bool(row.approval_required), approvedAt: row.approved_at || undefined, approvalConsumedAt: row.approval_consumed_at || undefined, idempotencyKey: row.idempotency_key, sourceKey: row.source_key || undefined, commitmentId: row.commitment_id || undefined, attempts: row.attempts, result: row.result || undefined, error: row.error || undefined, externalRef: row.external_ref || undefined, createdAt: row.created_at, updatedAt: row.updated_at }; }
function rowFact(row: any): MemoryFact { return { id: row.id, subject: row.subject, fact: row.fact, confidence: row.confidence, sourceKey: row.source_key, sourceType: row.source_type || undefined, sourceExcerpt: row.source_excerpt || undefined, supersedesId: row.supersedes_id || undefined, supersededAt: row.superseded_at || undefined, createdAt: row.created_at, updatedAt: row.updated_at }; }

export function chiefOfStaffPath() {
  const root = process.env.MI_ROOT || join(homedir(), 'assistant');
  return process.env.MI_CHIEF_OF_STAFF_DB || join(resolve(root), 'state', 'chief-of-staff.sqlite');
}

export function classifyActionRisk(text: string, explicit?: RiskClass): RiskClass {
  if (explicit) return explicit;
  const value = text.toLowerCase();
  if (/\b(pay|purchase|buy|charge|refund|invoice|financial|money|subscription)\b/.test(value)) return 'financial';
  if (/\b(delete|destroy|erase|drop|remove permanently|revoke)\b/.test(value)) return 'destructive';
  if (/\b(deploy|dns|cloudflare|railway|server|production|infrastructure|restart service)\b/.test(value)) return 'infrastructure';
  if (/\b(publish|post publicly|merge|push|release|open (?:a )?pr|create (?:a )?pr)\b/.test(value)) return 'publication';
  if (/\b(send|message|email|text|call|contact|invite|share)\b/.test(value)) {
    if (/\b(?:to\s+)?kyle\b/.test(value) && !/\b(?:public|publish|post)\b/.test(value)) return 'internal';
    return 'external';
  }
  return 'internal';
}

export class ChiefOfStaffStore {
  readonly path: string;
  readonly db: DatabaseSync;
  private readonly nowFn: () => Date;

  constructor(options: StoreOptions = {}) {
    this.path = resolve(options.path || chiefOfStaffPath());
    this.nowFn = options.now || (() => new Date());
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(this.path);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA synchronous=NORMAL;');
    this.migrate();
  }
  now() { return this.nowFn().toISOString(); }
  close() { this.db.close(); }
  private migrate() {
    const version = Number((this.db.prepare('PRAGMA user_version').get() as any)?.user_version || 0);
    if (version < 1) {
      this.db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE IF NOT EXISTS people (id TEXT PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE, relationship TEXT, notes TEXT, confidence REAL NOT NULL DEFAULT 1, source_key TEXT UNIQUE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE UNIQUE INDEX IF NOT EXISTS people_name_unique ON people(lower(name));
        CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, context TEXT, source_key TEXT UNIQUE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS commitments (id TEXT PRIMARY KEY, title TEXT NOT NULL, detail TEXT, status TEXT NOT NULL CHECK(status IN ('needs_clarification','proposed','active','blocked','completed','cancelled')), owner TEXT NOT NULL, due_at TEXT, review_at TEXT, confidence REAL NOT NULL, source_key TEXT UNIQUE, source_type TEXT, source_excerpt TEXT, project_id TEXT REFERENCES projects(id), person_id TEXT REFERENCES people(id), completion_verified INTEGER NOT NULL DEFAULT 0, completion_evidence TEXT, completed_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS commitments_status_due ON commitments(status,due_at,review_at);
        CREATE TABLE IF NOT EXISTS actions (id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, payload_json TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL CHECK(status IN ('proposed','approved','executing','verification_required','completed','failed','cancelled')), risk_class TEXT NOT NULL CHECK(risk_class IN ('internal','external','destructive','financial','publication','infrastructure')), approval_required INTEGER NOT NULL, approved_at TEXT, approval_consumed_at TEXT, idempotency_key TEXT NOT NULL UNIQUE, source_key TEXT UNIQUE, commitment_id TEXT REFERENCES commitments(id), attempts INTEGER NOT NULL DEFAULT 0, result TEXT, error TEXT, external_ref TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS actions_status ON actions(status,updated_at);
        CREATE TABLE IF NOT EXISTS memory_facts (id TEXT PRIMARY KEY, subject TEXT NOT NULL, fact TEXT NOT NULL, confidence REAL NOT NULL, source_key TEXT NOT NULL UNIQUE, source_type TEXT, source_excerpt TEXT, supersedes_id TEXT REFERENCES memory_facts(id), superseded_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS memory_subject ON memory_facts(subject,superseded_at);
        CREATE TABLE IF NOT EXISTS follow_ups (id TEXT PRIMARY KEY, person_id TEXT REFERENCES people(id), commitment_id TEXT REFERENCES commitments(id), reason TEXT NOT NULL, due_at TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('open','completed','cancelled')), source_key TEXT UNIQUE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS deliveries (id TEXT PRIMARY KEY, kind TEXT NOT NULL, dedupe_key TEXT NOT NULL UNIQUE, entity_type TEXT, entity_id TEXT, delivered_at TEXT NOT NULL, channel TEXT NOT NULL, payload_excerpt TEXT);
        CREATE TABLE IF NOT EXISTS audit_history (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, event TEXT NOT NULL, before_json TEXT, after_json TEXT, source TEXT);
        CREATE TABLE IF NOT EXISTS cursors (source TEXT PRIMARY KEY, cursor TEXT NOT NULL, updated_at TEXT NOT NULL);
        PRAGMA user_version=1; COMMIT;`);
    }
  }
  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.db.exec('COMMIT'); return value; } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private audit(entityType: string, entityId: string, event: string, before: unknown, after: unknown, source = 'chief-of-staff') {
    const safeBefore = before == null ? null : JSON.stringify(redactSecrets(before));
    const safeAfter = after == null ? null : JSON.stringify(redactSecrets(after));
    this.db.prepare('INSERT INTO audit_history(ts,entity_type,entity_id,event,before_json,after_json,source) VALUES(?,?,?,?,?,?,?)').run(this.now(), entityType, entityId, event, safeBefore, safeAfter, clean(source, 120));
    void logEvent(`mi.chief_of_staff.${entityType}.${event}`, { entityId, before, after, source }).catch(() => undefined);
  }
  schemaVersion() { return Number((this.db.prepare('PRAGMA user_version').get() as any)?.user_version || 0); }
  getCursor(source: string) { return (this.db.prepare('SELECT cursor FROM cursors WHERE source=?').get(source) as any)?.cursor as string | undefined; }
  setCursor(source: string, cursor: string) { this.db.prepare('INSERT INTO cursors(source,cursor,updated_at) VALUES(?,?,?) ON CONFLICT(source) DO UPDATE SET cursor=excluded.cursor,updated_at=excluded.updated_at').run(clean(source, 300), clean(cursor, 2000), this.now()); }

  upsertPerson(input: { name: string; relationship?: string; notes?: string; confidence?: number; sourceKey?: string }): Person {
    const name = clean(input.name, 160); if (!name) throw new Error('person name required');
    const now = this.now();
    return this.transaction(() => {
      const existing = input.sourceKey ? this.db.prepare('SELECT * FROM people WHERE source_key=? OR lower(name)=lower(?)').get(input.sourceKey, name) : this.db.prepare('SELECT * FROM people WHERE lower(name)=lower(?)').get(name);
      if (existing) {
        const before = rowPerson(existing); this.db.prepare('UPDATE people SET relationship=COALESCE(?,relationship),notes=COALESCE(?,notes),confidence=?,updated_at=? WHERE id=?').run(input.relationship ? clean(input.relationship, 240) : null, input.notes ? clean(input.notes, 1000) : null, input.confidence ?? before.confidence, now, before.id);
        const result = this.getPerson(before.id)!; this.audit('person', result.id, 'updated', before, result); return result;
      }
      const personId = id('per'); this.db.prepare('INSERT INTO people(id,name,relationship,notes,confidence,source_key,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(personId, name, input.relationship ? clean(input.relationship, 240) : null, input.notes ? clean(input.notes, 1000) : null, input.confidence ?? 1, input.sourceKey || null, now, now);
      const result = this.getPerson(personId)!; this.audit('person', personId, 'created', null, result); return result;
    });
  }
  getPerson(selector: string) { const row = this.db.prepare('SELECT * FROM people WHERE id=? OR lower(name)=lower(?)').get(selector, selector); return row ? rowPerson(row) : undefined; }
  listPeople() { return (this.db.prepare('SELECT * FROM people ORDER BY lower(name)').all() as any[]).map(rowPerson); }
  updatePerson(selector: string, patch: { name?: string; relationship?: string | null; notes?: string | null; confidence?: number }): Person {
    const current = this.getPerson(selector); if (!current) throw new Error(`person not found: ${selector}`);
    return this.transaction(() => { this.db.prepare('UPDATE people SET name=?,relationship=?,notes=?,confidence=?,updated_at=? WHERE id=?').run(clean(patch.name ?? current.name, 160), patch.relationship === undefined ? current.relationship || null : patch.relationship ? clean(patch.relationship, 240) : null, patch.notes === undefined ? current.notes || null : patch.notes ? clean(patch.notes, 1000) : null, patch.confidence ?? current.confidence, this.now(), current.id); const next = this.getPerson(current.id)!; this.audit('person', current.id, 'updated', current, next, 'manual'); return next; });
  }
  upsertProject(input: { name: string; context?: string; sourceKey?: string }): Project {
    const name = clean(input.name, 200); if (!name) throw new Error('project name required'); const now = this.now();
    return this.transaction(() => {
      const existing = input.sourceKey ? this.db.prepare('SELECT * FROM projects WHERE source_key=?').get(input.sourceKey) as any : this.db.prepare('SELECT * FROM projects WHERE lower(name)=lower(?)').get(name) as any;
      if (existing) { const before = this.getProject(existing.id)!; this.db.prepare('UPDATE projects SET name=?,context=COALESCE(?,context),updated_at=? WHERE id=?').run(name, input.context ? clean(input.context, 3000) : null, now, existing.id); const result = this.getProject(existing.id)!; this.audit('project', existing.id, 'updated', before, result); return result; }
      const projectId = id('pro'); this.db.prepare('INSERT INTO projects(id,name,context,source_key,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(projectId, name, input.context ? clean(input.context, 3000) : null, input.sourceKey || null, now, now); const result = this.getProject(projectId)!; this.audit('project', projectId, 'created', null, result); return result;
    });
  }
  getProject(selector: string): Project | undefined { const row = this.db.prepare('SELECT * FROM projects WHERE id=? OR source_key=? OR lower(name)=lower(?)').get(selector, selector, selector) as any; return row ? { id: row.id, name: row.name, context: row.context || undefined, sourceKey: row.source_key || undefined, createdAt: row.created_at, updatedAt: row.updated_at } : undefined; }
  listProjects(): Project[] { return (this.db.prepare('SELECT * FROM projects ORDER BY lower(name)').all() as any[]).map((row) => ({ id: row.id, name: row.name, context: row.context || undefined, sourceKey: row.source_key || undefined, createdAt: row.created_at, updatedAt: row.updated_at })); }

  createCommitment(input: { title: string; detail?: string; status?: CommitmentStatus; owner?: Owner; dueAt?: string | Date; reviewAt?: string | Date; confidence?: number; sourceKey?: string; sourceType?: string; sourceExcerpt?: string; projectId?: string; personId?: string }): Commitment {
    const title = clean(input.title, 300); if (!title) throw new Error('commitment title required');
    if (input.sourceKey) { const existing = this.db.prepare('SELECT * FROM commitments WHERE source_key=?').get(input.sourceKey); if (existing) return rowCommitment(existing); }
    const now = this.now(), commitmentId = id('com');
    return this.transaction(() => { this.db.prepare(`INSERT INTO commitments(id,title,detail,status,owner,due_at,review_at,confidence,source_key,source_type,source_excerpt,project_id,person_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(commitmentId, title, input.detail ? excerpt(input.detail, 8000) : null, input.status || 'proposed', clean(input.owner || 'kyle', 80), iso(input.dueAt) || null, iso(input.reviewAt) || null, input.confidence ?? 1, input.sourceKey || null, input.sourceType ? clean(input.sourceType, 100) : null, input.sourceExcerpt ? excerpt(input.sourceExcerpt, 8000) : null, input.projectId || null, input.personId || null, now, now); const result = this.getCommitment(commitmentId)!; this.audit('commitment', commitmentId, 'created', null, result, input.sourceType); return result; });
  }
  getCommitment(selector: string) { const exact = this.db.prepare('SELECT * FROM commitments WHERE id=? OR source_key=?').get(selector, selector); if (exact) return rowCommitment(exact); const prefix = this.db.prepare('SELECT * FROM commitments WHERE id LIKE ? ORDER BY created_at DESC LIMIT 2').all(`${selector}%`) as any[]; if (prefix.length > 1) throw new Error(`ambiguous commitment id: ${selector}`); return prefix[0] ? rowCommitment(prefix[0]) : undefined; }
  listCommitments(filter: { status?: CommitmentStatus | CommitmentStatus[]; owner?: string; limit?: number } = {}) {
    const statuses = filter.status ? (Array.isArray(filter.status) ? filter.status : [filter.status]) : [];
    const where: string[] = [], args: any[] = [];
    if (statuses.length) { where.push(`status IN (${statuses.map(() => '?').join(',')})`); args.push(...statuses); }
    if (filter.owner) { where.push('owner=?'); args.push(filter.owner); }
    args.push(Math.max(1, Math.min(filter.limit || 200, 1000)));
    return (this.db.prepare(`SELECT * FROM commitments ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY CASE status WHEN 'needs_clarification' THEN 0 WHEN 'blocked' THEN 1 WHEN 'active' THEN 2 ELSE 3 END, COALESCE(due_at,review_at,'9999'),created_at LIMIT ?`).all(...args) as any[]).map(rowCommitment);
  }
  updateCommitment(selector: string, patch: Partial<Pick<Commitment, 'title' | 'detail' | 'status' | 'owner' | 'dueAt' | 'reviewAt' | 'confidence' | 'projectId' | 'personId'>>): Commitment {
    const current = this.getCommitment(selector); if (!current) throw new Error(`commitment not found: ${selector}`);
    return this.transaction(() => { const nextStatus = patch.status || current.status; const completedAt = nextStatus === 'completed' ? current.completedAt || this.now() : null; this.db.prepare(`UPDATE commitments SET title=?,detail=?,status=?,owner=?,due_at=?,review_at=?,confidence=?,project_id=?,person_id=?,completed_at=?,updated_at=? WHERE id=?`).run(clean(patch.title ?? current.title, 300), patch.detail === undefined ? current.detail || null : patch.detail ? excerpt(patch.detail, 8000) : null, nextStatus, clean(patch.owner ?? current.owner, 80), patch.dueAt === undefined ? current.dueAt || null : iso(patch.dueAt) || null, patch.reviewAt === undefined ? current.reviewAt || null : iso(patch.reviewAt) || null, patch.confidence ?? current.confidence, patch.projectId === undefined ? current.projectId || null : patch.projectId, patch.personId === undefined ? current.personId || null : patch.personId, completedAt, this.now(), current.id); const result = this.getCommitment(current.id)!; this.audit('commitment', current.id, 'transitioned', current, result, 'manual'); return result; });
  }
  completeCommitment(selector: string, evidence: string, verified = true): Commitment {
    const current = this.getCommitment(selector); if (!current) throw new Error(`commitment not found: ${selector}`); if (!clean(evidence, 1000)) throw new Error('completion evidence required');
    return this.transaction(() => { this.db.prepare(`UPDATE commitments SET status='completed',completion_verified=?,completion_evidence=?,completed_at=?,updated_at=? WHERE id=?`).run(verified ? 1 : 0, clean(evidence, 1000), this.now(), this.now(), current.id); const result = this.getCommitment(current.id)!; this.audit('commitment', current.id, 'completed', current, result, 'manual'); return result; });
  }

  createAction(input: { kind: string; title: string; payload?: Record<string, unknown>; riskClass?: RiskClass; approvalRequired?: boolean; idempotencyKey?: string; sourceKey?: string; commitmentId?: string; externalRef?: string }): Action {
    const title = clean(input.title, 300); if (!title) throw new Error('action title required');
    const key = input.idempotencyKey || hash(`${input.kind}:${input.sourceKey || title}`); const existing = this.db.prepare('SELECT * FROM actions WHERE idempotency_key=?').get(key); if (existing) return rowAction(existing);
    const risk = classifyActionRisk(title, input.riskClass), approvalRequired = input.approvalRequired ?? consequentialRisks.has(risk); const now = this.now(), actionId = id('act');
    return this.transaction(() => { this.db.prepare(`INSERT INTO actions(id,kind,title,payload_json,status,risk_class,approval_required,idempotency_key,source_key,commitment_id,external_ref,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(actionId, clean(input.kind, 100), title, JSON.stringify(redactSecrets(input.payload || {})), 'proposed', risk, approvalRequired ? 1 : 0, key, input.sourceKey || null, input.commitmentId || null, input.externalRef || null, now, now); const result = this.getAction(actionId)!; this.audit('action', actionId, 'created', null, result); return result; });
  }
  getAction(selector: string) { const exact = this.db.prepare('SELECT * FROM actions WHERE id=? OR idempotency_key=? OR source_key=?').get(selector, selector, selector); if (exact) return rowAction(exact); const rows = this.db.prepare('SELECT * FROM actions WHERE id LIKE ? ORDER BY created_at DESC LIMIT 2').all(`${selector}%`) as any[]; if (rows.length > 1) throw new Error(`ambiguous action id: ${selector}`); return rows[0] ? rowAction(rows[0]) : undefined; }
  listActions(filter: { status?: ActionStatus | ActionStatus[]; limit?: number } = {}) { const statuses = filter.status ? (Array.isArray(filter.status) ? filter.status : [filter.status]) : []; const args: any[] = []; const where = statuses.length ? `WHERE status IN (${statuses.map(() => '?').join(',')})` : ''; args.push(...statuses, Math.max(1, Math.min(filter.limit || 200, 1000))); return (this.db.prepare(`SELECT * FROM actions ${where} ORDER BY CASE status WHEN 'failed' THEN 0 WHEN 'verification_required' THEN 1 WHEN 'proposed' THEN 2 ELSE 3 END,updated_at DESC LIMIT ?`).all(...args) as any[]).map(rowAction); }
  approveAction(selector: string, approvalNote = 'explicit user approval'): Action { const current = this.getAction(selector); if (!current) throw new Error(`action not found: ${selector}`); if (current.status !== 'proposed') throw new Error(`action ${current.id} is ${current.status}, not proposed`); return this.transaction(() => { this.db.prepare(`UPDATE actions SET status='approved',approved_at=?,result=?,updated_at=? WHERE id=?`).run(this.now(), clean(approvalNote, 500), this.now(), current.id); const result = this.getAction(current.id)!; this.audit('action', current.id, 'approved', current, result, 'user'); return result; }); }
  transitionAction(selector: string, status: ActionStatus, patch: { result?: string; error?: string; externalRef?: string } = {}) { const current = this.getAction(selector); if (!current) throw new Error(`action not found: ${selector}`); if (status === 'executing' && current.approvalRequired && !current.approvedAt) throw new Error(`approval required for ${current.id} (${current.riskClass})`); return this.transaction(() => { this.db.prepare('UPDATE actions SET status=?,result=COALESCE(?,result),error=?,external_ref=COALESCE(?,external_ref),updated_at=? WHERE id=?').run(status, patch.result ? clean(patch.result, 2000) : null, patch.error ? clean(patch.error, 2000) : null, patch.externalRef || null, this.now(), current.id); const result = this.getAction(current.id)!; this.audit('action', current.id, 'transitioned', current, result); return result; }); }
  verifyAction(selector: string, evidence: string): Action {
    const current = this.getAction(selector); if (!current) throw new Error(`action not found: ${selector}`); if (current.status !== 'verification_required') throw new Error(`action ${current.id} is ${current.status}, not verification_required`); if (!clean(evidence, 1000)) throw new Error('verification evidence required');
    const result = this.transitionAction(current.id, 'completed', { result: `${current.result ? `${current.result}; ` : ''}Verified: ${clean(evidence, 1000)}` });
    if (result.commitmentId) { const commitment = this.getCommitment(result.commitmentId); if (commitment && !['completed', 'cancelled'].includes(commitment.status)) this.completeCommitment(commitment.id, evidence, true); }
    return result;
  }
  async dispatchAction(selector: string): Promise<Action> {
    let action = this.getAction(selector); if (!action) throw new Error(`action not found: ${selector}`);
    if (action.status === 'completed') return action;
    if (action.approvalRequired && (!action.approvedAt || action.status !== 'approved')) throw new Error(`approval required for ${action.id} (${action.riskClass})`);
    if (!action.approvalRequired && action.status === 'proposed') action = this.transitionAction(action.id, 'approved', { result: 'internal action auto-approved by policy' });
    if (action.status !== 'approved' && action.status !== 'failed') throw new Error(`action ${action.id} cannot execute from ${action.status}`);
    const handler = handlers.get(action.kind); if (!handler) throw new Error(`no registered handler for action kind: ${action.kind}`);
    action = this.transaction(() => { const before = this.getAction(action!.id)!; this.db.prepare(`UPDATE actions SET status='executing',approval_consumed_at=CASE WHEN approval_required=1 THEN COALESCE(approval_consumed_at,?) ELSE approval_consumed_at END,attempts=attempts+1,error=NULL,updated_at=? WHERE id=?`).run(this.now(), this.now(), before.id); const next = this.getAction(before.id)!; this.audit('action', before.id, 'executing', before, next); return next; });
    try {
      const output = await handler(action, this);
      return this.transitionAction(action.id, output.verified === false ? 'verification_required' : 'completed', { result: output.result });
    } catch (error) {
      return this.transitionAction(action.id, 'failed', { error: error instanceof Error ? error.message : String(error) });
    }
  }

  upsertMemoryFact(input: { subject: string; fact: string; confidence?: number; sourceKey: string; sourceType?: string; sourceExcerpt?: string; supersedesId?: string }): MemoryFact {
    const existing = this.db.prepare('SELECT * FROM memory_facts WHERE source_key=?').get(input.sourceKey); if (existing) return rowFact(existing);
    const subject = clean(input.subject, 200), fact = clean(input.fact, 1000); if (!subject || !fact) throw new Error('memory subject and fact required'); const now = this.now(), factId = id('mem');
    return this.transaction(() => { if (input.supersedesId) this.db.prepare('UPDATE memory_facts SET superseded_at=?,updated_at=? WHERE id=?').run(now, now, input.supersedesId); this.db.prepare(`INSERT INTO memory_facts(id,subject,fact,confidence,source_key,source_type,source_excerpt,supersedes_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(factId, subject, fact, input.confidence ?? 1, input.sourceKey, input.sourceType ? clean(input.sourceType, 100) : null, input.sourceExcerpt ? excerpt(input.sourceExcerpt, 4000) : null, input.supersedesId || null, now, now); const result = this.getMemoryFact(factId)!; this.audit('memory', factId, 'created', null, result, input.sourceType); return result; });
  }
  getMemoryFact(selector: string) { const row = this.db.prepare('SELECT * FROM memory_facts WHERE id=? OR source_key=?').get(selector, selector); return row ? rowFact(row) : undefined; }
  listMemoryFacts(limit = 100) { return (this.db.prepare('SELECT * FROM memory_facts WHERE superseded_at IS NULL ORDER BY updated_at DESC LIMIT ?').all(Math.min(Math.max(limit, 1), 500)) as any[]).map(rowFact); }
  createFollowUp(input: { personId?: string; commitmentId?: string; reason: string; dueAt: string | Date; sourceKey?: string }): FollowUp { if (input.sourceKey) { const existing = this.db.prepare('SELECT * FROM follow_ups WHERE source_key=?').get(input.sourceKey) as any; if (existing) return { id: existing.id, personId: existing.person_id || undefined, commitmentId: existing.commitment_id || undefined, reason: existing.reason, dueAt: existing.due_at, status: existing.status, sourceKey: existing.source_key || undefined, createdAt: existing.created_at, updatedAt: existing.updated_at }; } const now = this.now(), followId = id('fol'); this.db.prepare('INSERT INTO follow_ups(id,person_id,commitment_id,reason,due_at,status,source_key,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run(followId, input.personId || null, input.commitmentId || null, clean(input.reason, 500), iso(input.dueAt) || null, 'open', input.sourceKey || null, now, now); this.audit('follow_up', followId, 'created', null, input); return this.listFollowUps().find((item) => item.id === followId)!; }
  listFollowUps(status: 'open' | 'completed' | 'cancelled' = 'open') { return (this.db.prepare('SELECT * FROM follow_ups WHERE status=? ORDER BY due_at').all(status) as any[]).map((row) => ({ id: row.id, personId: row.person_id || undefined, commitmentId: row.commitment_id || undefined, reason: row.reason, dueAt: row.due_at, status: row.status, sourceKey: row.source_key || undefined, createdAt: row.created_at, updatedAt: row.updated_at } as FollowUp)); }

  shouldDeliver(dedupeKey: string, intervalMs: number, now = this.now()) { const row = this.db.prepare('SELECT delivered_at FROM deliveries WHERE dedupe_key=?').get(dedupeKey) as any; return !row || Date.parse(now) - Date.parse(row.delivered_at) >= intervalMs; }
  recordDelivery(input: { kind: string; dedupeKey: string; entityType?: string; entityId?: string; channel?: string; payloadExcerpt?: string }) { const now = this.now(); this.db.prepare(`INSERT INTO deliveries(id,kind,dedupe_key,entity_type,entity_id,delivered_at,channel,payload_excerpt) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(dedupe_key) DO UPDATE SET delivered_at=excluded.delivered_at,channel=excluded.channel,payload_excerpt=excluded.payload_excerpt`).run(id('del'), clean(input.kind, 100), clean(input.dedupeKey, 500), input.entityType || null, input.entityId || null, now, clean(input.channel || 'main-thread', 100), input.payloadExcerpt ? clean(input.payloadExcerpt, 500) : null); }
  recentAudit(limit = 100) { return this.db.prepare('SELECT * FROM audit_history ORDER BY id DESC LIMIT ?').all(Math.min(Math.max(limit, 1), 1000)); }

  context(maxChars = 5000) {
    const commitments = this.listCommitments({ status: ['needs_clarification', 'blocked', 'active', 'proposed'], limit: 20 });
    const facts = this.listMemoryFacts(20);
    const people = this.listPeople().slice(0, 12);
    const lines = ['Structured chief-of-staff context (local, provenance-backed):'];
    if (commitments.length) lines.push('Commitments:', ...commitments.map((item) => `- [${item.status}] ${item.title}${item.dueAt ? ` (due ${item.dueAt})` : ''}; owner=${item.owner}; confidence=${item.confidence.toFixed(2)}`));
    if (facts.length) lines.push('Facts:', ...facts.map((item) => `- ${item.subject}: ${item.fact} (confidence ${item.confidence.toFixed(2)})`));
    if (people.length) lines.push('People:', ...people.map((item) => `- ${item.name}${item.relationship ? `: ${item.relationship}` : ''}`));
    const text = String(redactSecrets(lines.join('\n')));
    return text.length > maxChars ? `${text.slice(0, maxChars - 24)}\n[context truncated]` : text;
  }
  statusSummary() { const commitments = this.listCommitments({ limit: 1000 }), actions = this.listActions({ limit: 1000 }); return { schemaVersion: this.schemaVersion(), path: this.path, commitments: Object.fromEntries(['needs_clarification','proposed','active','blocked','completed','cancelled'].map((status) => [status, commitments.filter((item) => item.status === status).length])), actions: Object.fromEntries(['proposed','approved','executing','verification_required','completed','failed','cancelled'].map((status) => [status, actions.filter((item) => item.status === status).length])), people: this.listPeople().length, projects: this.listProjects().length, memories: this.listMemoryFacts(500).length, followUps: this.listFollowUps().length }; }

  async export(directory: string) {
    const target = resolve(directory); await mkdir(target, { recursive: true, mode: 0o700 });
    const data = { exportedAt: this.now(), schemaVersion: this.schemaVersion(), people: this.listPeople(), projects: this.listProjects(), commitments: this.listCommitments({ limit: 1000 }), actions: this.listActions({ limit: 1000 }), memories: this.listMemoryFacts(500), followUps: this.listFollowUps(), audit: this.recentAudit(1000) };
    const jsonPath = join(target, 'chief-of-staff.json'), markdownPath = join(target, 'chief-of-staff.md');
    await writeFile(jsonPath, JSON.stringify(redactSecrets(data), null, 2), { mode: 0o600 });
    const md = ['# Mi chief-of-staff export', '', `Exported: ${data.exportedAt}`, '', '## Commitments', ...data.commitments.map((item) => `- [${item.status}] ${item.title} — ${item.owner}${item.dueAt ? ` — due ${item.dueAt}` : ''}`), '', '## Actions', ...data.actions.map((item) => `- [${item.status}] ${item.title} — risk ${item.riskClass}`), '', '## People', ...data.people.map((item) => `- ${item.name}${item.relationship ? ` — ${item.relationship}` : ''}`), '', '## Projects', ...data.projects.map((item) => `- ${item.name}${item.context ? ` — ${item.context}` : ''}`), '', '## Durable facts', ...data.memories.map((item) => `- ${item.subject}: ${item.fact}`), ''].join('\n');
    await writeFile(markdownPath, String(redactSecrets(md)), { mode: 0o600 }); return { directory: target, jsonPath, markdownPath };
  }
  async backup(destination?: string) { const target = resolve(destination || join(dirname(this.path), 'backups', `chief-of-staff-${this.now().replace(/[:.]/g, '-')}.sqlite`)); await mkdir(dirname(target), { recursive: true, mode: 0o700 }); const tmp = `${target}.${process.pid}.tmp`; await sqliteBackup(this.db, tmp); await chmod(tmp, 0o600); await rename(tmp, target); return target; }
}

export function registerActionHandler(kind: string, handler: ActionHandler) { if (!kind.trim()) throw new Error('action handler kind required'); handlers.set(kind, handler); }
export function unregisterActionHandler(kind: string) { handlers.delete(kind); }
export function registeredActionHandlers() { return [...handlers.keys()].sort(); }
registerActionHandler('organize', (action) => ({ result: `Organized locally: ${action.title}`, verified: true }));
registerActionHandler('reminder', (action) => ({ result: `Reminder recorded locally: ${action.title}`, verified: true }));
registerActionHandler('private_update', (action) => ({ result: `Private state updated: ${action.title}`, verified: true }));

export async function withChiefOfStaff<T>(fn: (store: ChiefOfStaffStore) => Promise<T> | T, options: StoreOptions = {}) { await mkdir(dirname(resolve(options.path || chiefOfStaffPath())), { recursive: true, mode: 0o700 }); const store = new ChiefOfStaffStore(options); try { return await fn(store); } finally { store.close(); } }
