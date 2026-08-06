import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { lstatSync, realpathSync, statSync } from 'node:fs';
import { spawn as nodeSpawn } from 'node:child_process';
import { Type } from 'typebox';

export const DIVER_NOTES_WRAPPER = '/usr/local/bin/diver-notes-agent';
const OUTPUT_CAP = 128 * 1024;
const STDERR_CAP = 8 * 1024;
const TIMEOUT_MS = 12_000;
const VALUE_CAP = 8 * 1024;
const ID_CAP = 512;

type Input = Record<string, unknown>;
type SpawnLike = typeof nodeSpawn;
type StatLike = (path: string) => { isSymbolicLink(): boolean; isFile(): boolean; uid: number; mode: number };

// Only direct, non-batch commands can be exposed while stdin is deliberately
// ignored. The broker's batch commands require `--input -`, so they are not a
// safe fit for this fixed-executable tool.
const operations: Record<string, { args: Record<string, string>; required?: string[]; write?: boolean }> = {
  'tasks.list': { args: {} },
  'tasks.add': { args: { text: 'text', date: 'date' }, required: ['text'], write: true },
  'tasks.complete': { args: { id: 'id' }, required: ['id'], write: true },
  'tasks.reopen': { args: { id: 'id' }, required: ['id'], write: true },
  'notes.list': { args: {} },
  'notes.add': { args: { text: 'text', date: 'date' }, required: ['text'], write: true },
  'projects.list': { args: {} },
  'projects.ensure': { args: { name: 'name', slug: 'slug' }, required: ['name', 'slug'], write: true },
  'project-tasks.list': { args: { project: 'project' }, required: ['project'] },
  'project-tasks.add': { args: { project: 'project', text: 'text', date: 'date' }, required: ['project', 'text'], write: true },
  'project-tasks.complete': { args: { project: 'project', id: 'id' }, required: ['project', 'id'], write: true },
  'project-tasks.reopen': { args: { project: 'project', id: 'id' }, required: ['project', 'id'], write: true },
  'project-subtasks.add': { args: { project: 'project', taskId: 'task-id', text: 'text' }, required: ['project', 'taskId', 'text'], write: true },
  'project-subtasks.complete': { args: { project: 'project', taskId: 'task-id', id: 'id' }, required: ['project', 'taskId', 'id'], write: true },
  'project-subtasks.reopen': { args: { project: 'project', taskId: 'task-id', id: 'id' }, required: ['project', 'taskId', 'id'], write: true },
};

export const DIVER_NOTES_READ_OPERATIONS = new Set(Object.entries(operations).filter(([, value]) => !value.write).map(([key]) => key));
export const DIVER_NOTES_WRITE_OPERATIONS = new Set(Object.entries(operations).filter(([, value]) => value.write).map(([key]) => key));

function safeValue(value: unknown, name: string) {
  if (typeof value !== 'string' || !value || value.length > (name === 'id' || name === 'taskId' || name === 'subtaskId' ? ID_CAP : VALUE_CAP) || /[\u0000-\u001f\u007f]/.test(value)) throw new Error('Divernote input is invalid.');
  if (/^(?:https?:\/\/|file:|\/|~\/)|(?:^|\s)(?:--|[|&;`$<>])/.test(value) || value.includes('\\')) throw new Error('Divernote input is invalid.');
  return value;
}

export function diverNotesArgv(input: Input): string[] {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Divernote input is invalid.');
  const operation = input.operation;
  if (typeof operation !== 'string' || !Object.hasOwn(operations, operation)) throw new Error('Divernote operation is not allowed.');
  const spec = operations[operation];
  const permitted = new Set(['operation', ...Object.keys(spec.args)]);
  if (Object.keys(input).some((key) => !permitted.has(key))) throw new Error('Divernote input is invalid.');
  const [group, command] = operation.split('.');
  const argv = [group, command];
  for (const [property, option] of Object.entries(spec.args)) {
    const value = input[property];
    if (value === undefined) continue;
    argv.push(`--${option}`, safeValue(value, property));
  }
  for (const required of spec.required || []) if (!(required in input)) throw new Error('Divernote input is incomplete.');
  return [...argv, '--json'];
}

export function verifyDiverNotesWrapper(wrapper = DIVER_NOTES_WRAPPER, deps: { lstat?: StatLike; stat?: StatLike; realpath?: (path: string) => string } = {}) {
  const lstat = deps.lstat || lstatSync as unknown as StatLike;
  const stat = deps.stat || statSync as unknown as StatLike;
  const realpath = deps.realpath || realpathSync;
  try {
    if (wrapper !== DIVER_NOTES_WRAPPER || realpath(wrapper) !== DIVER_NOTES_WRAPPER) throw new Error();
    const link = lstat(wrapper);
    const info = stat(wrapper);
    if (link.isSymbolicLink() || !info.isFile() || info.uid !== 0 || (info.mode & 0o022) !== 0 || (info.mode & 0o111) === 0) throw new Error();
  } catch { throw new Error('Divernote is unavailable.'); }
}

export function runDiverNotes(input: Input, { spawnProcess = nodeSpawn, verify = verifyDiverNotesWrapper, timeoutMs = TIMEOUT_MS, outputCap = OUTPUT_CAP, stderrCap = STDERR_CAP } = {}): Promise<{ ok: boolean; value?: unknown; error?: string }> {
  let argv: string[];
  try { argv = diverNotesArgv(input); verify(); } catch (error) { return Promise.resolve({ ok: false, error: error instanceof Error ? error.message : 'Divernote is unavailable.' }); }
  return new Promise((resolve) => {
    const maxOutput = Math.max(1, Math.min(Number(outputCap) || OUTPUT_CAP, OUTPUT_CAP));
    const maxStderr = Math.max(1, Math.min(Number(stderrCap) || STDERR_CAP, STDERR_CAP));
    let child: ReturnType<SpawnLike>;
    let done = false; let stopped = false; let stdout = ''; let outputBytes = 0; let stderrBytes = 0;
    let timer: NodeJS.Timeout | undefined; let killTimer: NodeJS.Timeout | undefined;
    const finish = (result: { ok: boolean; value?: unknown; error?: string }) => {
      if (done) return; done = true;
      if (timer) clearTimeout(timer);
      if (!stopped && killTimer) clearTimeout(killTimer);
      try { child?.stdout?.destroy(); child?.stderr?.destroy(); } catch {}
      resolve(result);
    };
    const stop = () => {
      if (stopped) return;
      stopped = true;
      try { child?.kill('SIGTERM'); } catch {}
      killTimer = setTimeout(() => { try { if (child?.exitCode === null) child.kill('SIGKILL'); } catch {} }, 500);
      killTimer.unref?.();
    };
    try { child = spawnProcess(DIVER_NOTES_WRAPPER, argv, { shell: false, stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' } }); } catch { return finish({ ok: false, error: 'Divernote is unavailable.' }); }
    timer = setTimeout(() => { stop(); finish({ ok: false, error: 'Divernote request timed out.' }); }, Math.max(1000, Math.min(Number(timeoutMs) || TIMEOUT_MS, 30_000)));
    child.once('close', () => { if (killTimer) clearTimeout(killTimer); });
    child.stdout?.on('data', (chunk: Buffer) => { outputBytes += chunk.length; if (outputBytes > maxOutput) { stop(); finish({ ok: false, error: 'Divernote returned too much data.' }); } else stdout += chunk.toString('utf8'); });
    child.stderr?.on('data', (chunk: Buffer) => { stderrBytes += chunk.length; if (stderrBytes > maxStderr) { stop(); finish({ ok: false, error: 'Divernote request failed.' }); } });
    child.on('error', () => finish({ ok: false, error: 'Divernote is unavailable.' }));
    child.on('close', (code: number) => {
      if (done) return;
      if (code !== 0) return finish({ ok: false, error: 'Divernote request failed.' });
      try {
        if (Buffer.byteLength(stdout) > maxOutput) throw new Error();
        const value = JSON.parse(stdout);
        finish({ ok: true, value });
      } catch { finish({ ok: false, error: 'Divernote returned an invalid response.' }); }
    });
  });
}

const toolVariants = Object.entries(operations).map(([operation, spec]) => Type.Object({ operation: Type.Literal(operation), ...Object.fromEntries(Object.keys(spec.args).map((key) => [key, Type.Optional(Type.String({ maxLength: VALUE_CAP }))])) }, { additionalProperties: false }));
export const diverNotesSchema = Type.Union(toolVariants);

export default function miDiverNotes(pi: ExtensionAPI) {
  pi.registerTool({
    name: 'mi_diver_notes', label: 'Divernote', description: 'Read, search through listed results, or make the exact requested change in the owner’s private Divernote vault.', parameters: diverNotesSchema,
    async execute(_id, params) {
      const result = await runDiverNotes(params as Input);
      return result.ok
        ? { content: [{ type: 'text', text: JSON.stringify(result.value).slice(0, OUTPUT_CAP) }], details: { operation: params.operation } }
        : { content: [{ type: 'text', text: result.error || 'Divernote request failed.' }], details: { operation: params.operation, failed: true } };
    },
  });
}
