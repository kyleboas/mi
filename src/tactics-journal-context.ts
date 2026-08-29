import { randomBytes } from 'node:crypto';
import { appendFile, chmod, mkdir, open, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const TACTICS_JOURNAL_BRIEF_VERSION = 1;
export const TACTICS_JOURNAL_BRIEF_MAX_AGE_MS = 30 * 60 * 1000;
export const TACTICS_JOURNAL_BRIEF_MAX_BYTES = 24 * 1024;
export const DIVERNOTE_COMMAND = '/home/kyle/.local/bin/divernote';
const FLOCK_COMMAND = '/usr/bin/flock';
const LOCK_CONFLICT_CODE = 75;
const LOCK_WAIT_MS = 2_000;
const MAX_EVENT_BYTES = 256 * 1024;

type JsonRecord = Record<string, unknown>;
export type ProcessResult = { stdout: string; stderr: string; code: number | null; killed?: boolean };
export type DivernoteRunner = (file: string, args: string[], options: { timeout: number; signal?: AbortSignal }) => Promise<ProcessResult>;
export type ItemInvoke = (operation: string, input: JsonRecord, signal?: AbortSignal) => Promise<unknown>;
export type ProjectInvoke = (group: string, operation: string, input: JsonRecord, signal?: AbortSignal) => Promise<unknown>;
export type ContextFailureClass = 'lock-timeout' | 'command-timeout' | 'oversized-output' | 'malformed-output' | 'command-failed' | 'unavailable';
export type TacticsJournalContext = {
  scope: 'Tactics Journal';
  notes: Array<{ text: string; date?: unknown }>;
  tasks: Array<{ text: string; state?: unknown; date?: unknown }>;
  projects: Array<{ name: unknown; lifecycle?: unknown; updatedAt?: unknown; tasks: Array<{ text: string; status?: unknown; date?: unknown }> }>;
  projectCount: number;
  availability: { notes: boolean; tasks: boolean; projects: boolean };
  diagnostics: { failures: ContextFailureClass[]; failedSources: string[]; projectReads: number; projectFailures: number };
};
export type TacticsJournalBriefSnapshot = {
  version: 1;
  checkedAt: string;
  context: TacticsJournalContext;
};

type CollectDependencies = { invokeItem: ItemInvoke; invokeProject: ProjectInvoke };
type RefreshDependencies = Partial<CollectDependencies> & {
  now?: Date;
  statePath?: string;
  eventPath?: string;
  maxAgeMs?: number;
  force?: boolean;
};

function stateRoot() {
  return process.env.MI_ROOT || join(homedir(), 'assistant');
}

export function defaultTacticsJournalBriefPath() {
  return resolve(stateRoot(), 'state', 'tactics-journal-brief-state.json');
}

function defaultEventPath() {
  return resolve(stateRoot(), 'state', 'tactics-journal-brief-events.jsonl');
}

function defaultDivernoteLockPath() {
  return resolve(stateRoot(), 'state', 'divernote-cli.lock');
}

function compactText(value: unknown, limit = 600) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function records(value: unknown, key: string): JsonRecord[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const list = (value as JsonRecord)[key];
  return Array.isArray(list) ? list.filter((item): item is JsonRecord => Boolean(item && typeof item === 'object' && !Array.isArray(item))) : [];
}

function relevantText(value: unknown) {
  return /\b(?:tactics journal|board|community|ama|sponsor|coach|growth)\b/i.test(String(value || ''));
}

export function classifyTacticsJournalContextFailure(error: unknown): ContextFailureClass {
  const text = String(error instanceof Error ? error.message : error).toLowerCase();
  if (text.includes('lock timeout')) return 'lock-timeout';
  if (text.includes('timeout') || text.includes('timed out') || text.includes('killed')) return 'command-timeout';
  if (text.includes('oversized') || text.includes('maxbuffer')) return 'oversized-output';
  if (text.includes('malformed') || text.includes('non-object')) return 'malformed-output';
  if (text.includes('command failed') || text.includes('approved command failed')) return 'command-failed';
  return 'unavailable';
}

export function createLockedDivernoteRunner(baseRunner: DivernoteRunner, options: {
  command?: string;
  lockPath?: string;
  waitMs?: number;
  retries?: number;
  jitterMs?: () => number;
} = {}): DivernoteRunner {
  const command = options.command || DIVERNOTE_COMMAND;
  const lockPath = options.lockPath || defaultDivernoteLockPath();
  const waitMs = Math.max(1, Math.min(10_000, Math.floor(options.waitMs ?? LOCK_WAIT_MS)));
  const retries = Math.max(0, Math.min(2, Math.floor(options.retries ?? 1)));
  const jitterMs = options.jitterMs || (() => 40 + Math.floor(Math.random() * 81));
  if (!isAbsolute(command) || !isAbsolute(lockPath)) throw new Error('Divernote command and lock paths must be absolute.');

  let prepared: Promise<void> | undefined;
  const prepare = () => prepared ||= (async () => {
    await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
    const handle = await open(lockPath, 'a', 0o600);
    await handle.close();
    await chmod(lockPath, 0o600);
  })();

  return async (_file, args, execution) => {
    await prepare();
    let result: ProcessResult = { stdout: '', stderr: 'Divernote lock timeout.', code: LOCK_CONFLICT_CODE };
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      result = await baseRunner(FLOCK_COMMAND, [
        '--exclusive', '--timeout', String(waitMs / 1000), '--conflict-exit-code', String(LOCK_CONFLICT_CODE), '--no-fork',
        lockPath, command, ...args,
      ], { ...execution, timeout: execution.timeout + waitMs + 1_000 });
      if (result.code !== LOCK_CONFLICT_CODE) return result;
      if (attempt < retries) await new Promise((resolveDelay) => setTimeout(resolveDelay, Math.max(0, Math.min(500, jitterMs()))));
    }
    return { ...result, stderr: 'Divernote lock timeout.' };
  };
}

export async function loadCanonicalDivernoteClient(): Promise<CollectDependencies> {
  const adapterUrl = pathToFileURL(join(homedir(), '.pi', 'agent', 'extensions', 'divernote', 'adapter.ts')).href;
  const adapter = await import(adapterUrl) as JsonRecord;
  const invokeItem = (adapter.invokeDivernote || (adapter.default as JsonRecord | undefined)?.invokeDivernote) as ItemInvoke & ((operation: string, input: JsonRecord, signal?: AbortSignal, runner?: DivernoteRunner) => Promise<unknown>);
  const invokeProject = (adapter.invokeProjectContent || (adapter.default as JsonRecord | undefined)?.invokeProjectContent) as ProjectInvoke & ((group: string, operation: string, input: JsonRecord, signal?: AbortSignal, runner?: DivernoteRunner) => Promise<unknown>);
  const baseRunner = (adapter.execDivernote || (adapter.default as JsonRecord | undefined)?.execDivernote) as DivernoteRunner;
  if (typeof invokeItem !== 'function' || typeof invokeProject !== 'function' || typeof baseRunner !== 'function') throw new Error('Canonical Divernote adapter is unavailable.');
  const lockedRunner = createLockedDivernoteRunner(baseRunner);
  return {
    invokeItem: (operation, input, signal) => invokeItem(operation, input, signal, lockedRunner),
    invokeProject: (group, operation, input, signal) => invokeProject(group, operation, input, signal, lockedRunner),
  };
}

export async function collectTacticsJournalContext({ invokeItem, invokeProject }: CollectDependencies): Promise<TacticsJournalContext> {
  const failures: ContextFailureClass[] = [];
  const failedSources: string[] = [];
  const read = async (source: string, request: () => Promise<unknown>) => {
    try { return await request(); }
    catch (error) {
      failures.push(classifyTacticsJournalContextFailure(error));
      failedSources.push(source);
      return undefined;
    }
  };

  // These calls must remain sequential. The encrypted vault CLI is serialized
  // across processes as well, but sequential collection also bounds memory.
  const notesValue = await read('notes', () => invokeItem('retrieve', { itemType: 'note' }));
  const tasksValue = await read('tasks', () => invokeItem('retrieve', { itemType: 'task' }));
  const projectsValue = await read('projects', () => invokeProject('projects', 'list', {}));
  if (notesValue === undefined && tasksValue === undefined && projectsValue === undefined) throw new Error(`Tactics Journal context unavailable: ${failures.join(',')}`);

  const relevantProjects = records(projectsValue, 'projects')
    .filter((project) => /\b(?:tactics journal|board|community|ama)\b/i.test(String(project.name || '')))
    .slice(0, 6);
  const projectValues: unknown[] = [];
  let projectFailures = 0;
  for (const project of relevantProjects) {
    const reference = String(project.id || project.slug || '');
    if (!reference) continue;
    const value = await read('project-detail', () => invokeProject('projects', 'read', { project: reference }));
    if (value === undefined) projectFailures += 1;
    else projectValues.push(value);
  }

  const notes = records(notesValue, 'notes')
    .filter((note) => relevantText(note.text))
    .slice(-8)
    .map((note) => ({ text: compactText(note.text, 360), date: note.date }));
  const tasks = records(tasksValue, 'tasks')
    .filter((task) => task.state !== 'completed' && relevantText(task.text))
    .slice(-8)
    .map((task) => ({ text: compactText(task.text, 220), state: task.state, date: task.date }));
  const projects = projectValues.map((value) => {
    const project = value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord).project as JsonRecord | undefined : undefined;
    if (!project) return undefined;
    return {
      name: project.name,
      lifecycle: project.lifecycle,
      updatedAt: project.updatedAt,
      tasks: records(project, 'tasks')
        .filter((task) => !/^(?:complete|completed|done)$/i.test(String(task.status || '')))
        .slice(0, 6)
        .map((task) => ({ text: compactText(task.text || task.title, 220), status: task.status, date: task.date })),
    };
  }).filter((project): project is NonNullable<typeof project> => Boolean(project));

  return {
    scope: 'Tactics Journal', notes, tasks, projects,
    projectCount: records(projectsValue, 'projects').length,
    availability: { notes: notesValue !== undefined, tasks: tasksValue !== undefined, projects: projectsValue !== undefined },
    diagnostics: {
      failures: [...new Set(failures)], failedSources: [...new Set(failedSources)],
      projectReads: relevantProjects.length, projectFailures,
    },
  };
}

function validSnapshot(value: unknown): value is TacticsJournalBriefSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const snapshot = value as Partial<TacticsJournalBriefSnapshot>;
  if (snapshot.version !== TACTICS_JOURNAL_BRIEF_VERSION || typeof snapshot.checkedAt !== 'string' || !Number.isFinite(Date.parse(snapshot.checkedAt))) return false;
  const context = snapshot.context;
  return Boolean(context && context.scope === 'Tactics Journal' && Array.isArray(context.notes) && Array.isArray(context.tasks) && Array.isArray(context.projects) && context.availability && context.diagnostics);
}

export async function readTacticsJournalBriefSnapshot(statePath = defaultTacticsJournalBriefPath(), now = new Date(), maxAgeMs = TACTICS_JOURNAL_BRIEF_MAX_AGE_MS) {
  try {
    const text = await readFile(statePath, 'utf8');
    if (Buffer.byteLength(text) > TACTICS_JOURNAL_BRIEF_MAX_BYTES) return null;
    const value: unknown = JSON.parse(text);
    if (!validSnapshot(value)) return null;
    const ageMs = Math.max(0, now.getTime() - Date.parse(value.checkedAt));
    return { snapshot: value, ageMs, fresh: ageMs <= maxAgeMs };
  } catch { return null; }
}

export async function writeTacticsJournalBriefSnapshot(snapshot: TacticsJournalBriefSnapshot, statePath = defaultTacticsJournalBriefPath()) {
  const text = `${JSON.stringify(snapshot)}\n`;
  if (Buffer.byteLength(text) > TACTICS_JOURNAL_BRIEF_MAX_BYTES) throw new Error('Tactics Journal brief snapshot is oversized.');
  await mkdir(dirname(statePath), { recursive: true, mode: 0o700 });
  const temporary = `${statePath}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  await writeFile(temporary, text, { mode: 0o600, flag: 'wx' });
  await rename(temporary, statePath);
}

async function recordOutcome(eventPath: string, event: JsonRecord) {
  try {
    await mkdir(dirname(eventPath), { recursive: true, mode: 0o700 });
    const info = await stat(eventPath).catch(() => undefined);
    if (info && info.size >= MAX_EVENT_BYTES) return;
    await appendFile(eventPath, `${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: 0o600 });
  } catch { /* Diagnostics must not break brief generation. */ }
}

export async function refreshTacticsJournalBriefSnapshot(dependencies: RefreshDependencies = {}) {
  const now = dependencies.now || new Date();
  const statePath = dependencies.statePath || defaultTacticsJournalBriefPath();
  const eventPath = dependencies.eventPath || defaultEventPath();
  const maxAgeMs = dependencies.maxAgeMs ?? TACTICS_JOURNAL_BRIEF_MAX_AGE_MS;
  const existing = await readTacticsJournalBriefSnapshot(statePath, now, maxAgeMs);
  if (existing?.fresh && dependencies.force !== true) return { status: 'skipped' as const, snapshot: existing.snapshot, fresh: true };
  const startedAt = Date.now();
  try {
    const client = dependencies.invokeItem && dependencies.invokeProject
      ? { invokeItem: dependencies.invokeItem, invokeProject: dependencies.invokeProject }
      : await loadCanonicalDivernoteClient();
    const context = await collectTacticsJournalContext(client);
    const snapshot: TacticsJournalBriefSnapshot = { version: 1, checkedAt: now.toISOString(), context };
    await writeTacticsJournalBriefSnapshot(snapshot, statePath);
    await recordOutcome(eventPath, {
      type: 'tactics-journal-context', status: 'ok', checkedAt: snapshot.checkedAt,
      durationMs: Date.now() - startedAt, availability: context.availability,
      failures: context.diagnostics.failures, failedSources: context.diagnostics.failedSources,
      projectReads: context.diagnostics.projectReads, projectFailures: context.diagnostics.projectFailures,
    });
    return { status: 'ok' as const, snapshot, fresh: true };
  } catch (error) {
    const failure = classifyTacticsJournalContextFailure(error);
    await recordOutcome(eventPath, { type: 'tactics-journal-context', status: 'error', checkedAt: now.toISOString(), durationMs: Date.now() - startedAt, failure });
    if (existing) return { status: 'stale' as const, snapshot: existing.snapshot, fresh: false, failure };
    throw new Error(`Tactics Journal context unavailable: ${failure}`);
  }
}
