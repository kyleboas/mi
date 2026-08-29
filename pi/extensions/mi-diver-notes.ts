import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import type { invokeDivernote as InvokeDivernote, invokeProjectContent as InvokeProjectContent } from '../../../.pi/agent/extensions/divernote/adapter.ts';

const divernoteAdapter = await import('../../../.pi/agent/extensions/divernote/adapter.ts');
const adapterInvokeDivernote = (divernoteAdapter.invokeDivernote || divernoteAdapter.default?.invokeDivernote) as typeof InvokeDivernote;
const adapterInvokeProjectContent = (divernoteAdapter.invokeProjectContent || divernoteAdapter.default?.invokeProjectContent) as typeof InvokeProjectContent;
const adapterRunner = (divernoteAdapter.execDivernote || divernoteAdapter.default?.execDivernote) as Parameters<typeof InvokeDivernote>[3];
export const DIVERNOTE_COMMAND = '/home/kyle/.local/bin/divernote';
const absoluteRunner = (_file: string, args: string[], options: Parameters<NonNullable<typeof adapterRunner>>[2]) => adapterRunner(DIVERNOTE_COMMAND, args, options);
const invokeDivernote = ((operation, input, signal) => adapterInvokeDivernote(operation, input, signal, absoluteRunner)) as typeof InvokeDivernote;
const invokeProjectContent = ((group, operation, input, signal) => adapterInvokeProjectContent(group, operation, input, signal, absoluteRunner)) as typeof InvokeProjectContent;

export const DIVER_NOTES_BACKEND = 'canonical-pi-divernote';
const TOOL_CONTENT_CAP = 24 * 1024;

type Input = Record<string, unknown>;
type ItemInvoke = typeof invokeDivernote;
type ProjectInvoke = typeof invokeProjectContent;

type OperationSpec = {
  args: Record<string, string>;
  required?: string[];
  write?: boolean;
  itemType?: 'task' | 'note';
  itemOperation?: 'retrieve' | 'add' | 'edit';
  projectGroup?: 'projects' | 'project-tasks' | 'project-subtasks';
  projectOperation?: 'list' | 'read' | 'create' | 'add' | 'complete' | 'reopen';
  aggregate?: 'tactics-journal-context';
};

const operations: Record<string, OperationSpec> = {
  'tactics-journal.context': { args: {}, aggregate: 'tactics-journal-context' },
  'tasks.list': { args: {}, itemType: 'task', itemOperation: 'retrieve' },
  'tasks.add': { args: { text: 'text', date: 'date' }, required: ['text'], write: true, itemType: 'task', itemOperation: 'add' },
  'tasks.complete': { args: { id: 'id' }, required: ['id'], write: true, itemType: 'task', itemOperation: 'edit' },
  'tasks.reopen': { args: { id: 'id' }, required: ['id'], write: true, itemType: 'task', itemOperation: 'edit' },
  'notes.list': { args: {}, itemType: 'note', itemOperation: 'retrieve' },
  'notes.add': { args: { text: 'text', date: 'date' }, required: ['text'], write: true, itemType: 'note', itemOperation: 'add' },
  'projects.list': { args: {}, projectGroup: 'projects', projectOperation: 'list' },
  'projects.ensure': { args: { name: 'name', slug: 'slug' }, required: ['name', 'slug'], write: true, projectGroup: 'projects', projectOperation: 'create' },
  'project-tasks.list': { args: { project: 'project' }, required: ['project'], projectGroup: 'project-tasks', projectOperation: 'list' },
  'project-tasks.add': { args: { project: 'project', text: 'text', date: 'date' }, required: ['project', 'text'], write: true, projectGroup: 'project-tasks', projectOperation: 'add' },
  'project-tasks.complete': { args: { project: 'project', id: 'id' }, required: ['project', 'id'], write: true, projectGroup: 'project-tasks', projectOperation: 'complete' },
  'project-tasks.reopen': { args: { project: 'project', id: 'id' }, required: ['project', 'id'], write: true, projectGroup: 'project-tasks', projectOperation: 'reopen' },
  'project-subtasks.add': { args: { project: 'project', taskId: 'taskId', text: 'text' }, required: ['project', 'taskId', 'text'], write: true, projectGroup: 'project-subtasks', projectOperation: 'add' },
  'project-subtasks.complete': { args: { project: 'project', taskId: 'taskId', id: 'id' }, required: ['project', 'taskId', 'id'], write: true, projectGroup: 'project-subtasks', projectOperation: 'complete' },
  'project-subtasks.reopen': { args: { project: 'project', taskId: 'taskId', id: 'id' }, required: ['project', 'taskId', 'id'], write: true, projectGroup: 'project-subtasks', projectOperation: 'reopen' },
};

export const DIVER_NOTES_READ_OPERATIONS = new Set(Object.entries(operations).filter(([, value]) => !value.write).map(([key]) => key));
export const DIVER_NOTES_WRITE_OPERATIONS = new Set(Object.entries(operations).filter(([, value]) => value.write).map(([key]) => key));

function canonicalInput(operation: string, input: Input) {
  const spec = operations[operation];
  if (!spec) throw new Error('Divernote operation is not allowed.');
  const permitted = new Set(['operation', ...Object.keys(spec.args)]);
  if (Object.keys(input).some((key) => !permitted.has(key))) throw new Error('Divernote input is invalid.');
  for (const required of spec.required || []) if (typeof input[required] !== 'string' || !String(input[required]).trim()) throw new Error('Divernote input is incomplete.');
  return { spec, values: Object.fromEntries(Object.keys(spec.args).filter((key) => input[key] !== undefined).map((key) => [key, input[key]])) };
}

function recordList(value: unknown, key: string) {
  if (!value || typeof value !== 'object' || !Array.isArray((value as Record<string, unknown>)[key])) return [];
  return (value as Record<string, unknown>)[key] as Array<Record<string, unknown>>;
}

function compactText(value: unknown, limit = 700) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function compactTacticsJournalContext(notesValue: unknown, tasksValue: unknown, projectsValue: unknown, projectValues: unknown[]) {
  const relevant = /\b(?:tactics journal|newsletter|football clubs?|board|community|ama)\b/i;
  const notes = recordList(notesValue, 'notes')
    .filter((note) => relevant.test(String(note.text || '')))
    .slice(-8)
    .map((note) => ({ text: compactText(note.text, 360), date: note.date }));
  const tasks = recordList(tasksValue, 'tasks')
    .filter((task) => relevant.test(String(task.text || '')))
    .slice(-8)
    .map((task) => ({ text: compactText(task.text, 220), state: task.state, date: task.date }));
  const projects = projectValues.map((value) => {
    const project = value && typeof value === 'object' ? (value as Record<string, unknown>).project as Record<string, unknown> : undefined;
    if (!project) return undefined;
    return {
      name: compactText(project.name, 160), lifecycle: project.lifecycle, updatedAt: project.updatedAt,
      tasks: recordList(project, 'tasks')
        .filter((task) => task.completed !== true && String(task.status || '').toLowerCase() !== 'completed')
        .slice(0, 6)
        .map((task) => ({ text: compactText(task.text || task.title, 220), status: task.status, date: task.date })),
    };
  }).filter(Boolean);
  return { scope: 'Tactics Journal', notes, tasks, projects, projectCount: recordList(projectsValue, 'projects').length };
}

export async function runDiverNotes(input: Input, { invokeItem = invokeDivernote, invokeProject = invokeProjectContent }: { invokeItem?: ItemInvoke; invokeProject?: ProjectInvoke } = {}): Promise<{ ok: boolean; value?: unknown; error?: string }> {
  try {
    const operation = String(input?.operation || '');
    const { spec, values } = canonicalInput(operation, input);
    let value: unknown;
    if (spec.aggregate === 'tactics-journal-context') {
      const read = async (request: () => Promise<unknown>) => {
        try { return await request(); } catch { return undefined; }
      };
      // The encrypted vault client is not safe to fan out across concurrent CLI
      // processes. Read sequentially and keep independent sources available when
      // one project cannot be read.
      const notesValue = await read(() => invokeItem('retrieve', { itemType: 'note' }));
      const tasksValue = await read(() => invokeItem('retrieve', { itemType: 'task' }));
      const projectsValue = await read(() => invokeProject('projects', 'list', {}));
      if (notesValue === undefined && tasksValue === undefined && projectsValue === undefined) throw new Error('Divernote context sources failed.');
      const relevantProjects = recordList(projectsValue, 'projects')
        .filter((project) => /\b(?:tactics journal|board|community|ama)\b/i.test(String(project.name || '')))
        .slice(0, 8);
      const projectValues: unknown[] = [];
      for (const project of relevantProjects) {
        const projectValue = await read(() => invokeProject('projects', 'read', { project: String(project.id || project.slug || '') }));
        if (projectValue !== undefined) projectValues.push(projectValue);
      }
      value = {
        ...compactTacticsJournalContext(notesValue, tasksValue, projectsValue, projectValues),
        availability: { notes: notesValue !== undefined, tasks: tasksValue !== undefined, projects: projectsValue !== undefined },
      };
    } else if (operation === 'project-tasks.list') {
      const projectValue = await invokeProject('projects', 'read', values as Parameters<ProjectInvoke>[2]);
      const project = projectValue && typeof projectValue === 'object' ? (projectValue as Record<string, unknown>).project as Record<string, unknown> : undefined;
      value = { project: project ? { name: project.name, lifecycle: project.lifecycle, updatedAt: project.updatedAt } : undefined, tasks: recordList(project, 'tasks') };
    } else if (spec.itemType && spec.itemOperation) {
      const itemInput = { ...values, itemType: spec.itemType } as Parameters<ItemInvoke>[1];
      if (operation === 'tasks.complete' || operation === 'tasks.reopen') itemInput.state = operation.endsWith('complete') ? 'completed' : 'open';
      value = await invokeItem(spec.itemOperation, itemInput);
    } else if (spec.projectGroup && spec.projectOperation) {
      value = await invokeProject(spec.projectGroup, spec.projectOperation, values as Parameters<ProjectInvoke>[2]);
    } else {
      throw new Error('Divernote operation is not allowed.');
    }
    return { ok: true, value };
  } catch {
    return { ok: false, error: 'Divernote request failed.' };
  }
}

export function boundedDivernoteResult(value: unknown) {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) <= TOOL_CONTENT_CAP) return text;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return JSON.stringify({ truncated: true });
  const record = value as Record<string, unknown>;
  const arrayKey = Object.keys(record).find((key) => Array.isArray(record[key]));
  if (!arrayKey) return JSON.stringify({ truncated: true });
  const source = record[arrayKey] as unknown[];
  const items: unknown[] = [];
  for (const item of source) {
    const candidate = JSON.stringify({ [arrayKey]: [...items, item], total: source.length, truncated: true });
    if (Buffer.byteLength(candidate) > TOOL_CONTENT_CAP) break;
    items.push(item);
  }
  return JSON.stringify({ [arrayKey]: items, total: source.length, truncated: items.length < source.length });
}

const toolVariants = Object.entries(operations).map(([operation, spec]) => Type.Object({
  operation: Type.Literal(operation),
  ...Object.fromEntries(Object.keys(spec.args).map((key) => [key, Type.Optional(Type.String({ maxLength: key === 'text' ? 12000 : 512 }))])),
}, { additionalProperties: false }));
export const diverNotesSchema = Type.Union(toolVariants);

export default function miDiverNotes(pi: ExtensionAPI) {
  pi.registerTool({
    name: 'mi_diver_notes',
    label: 'Divernote',
    description: 'Use the canonical Pi Divernote path to read or make the exact requested change in the owner’s private vault. For a Tactics Journal operating brief, use tactics-journal.context once.',
    parameters: diverNotesSchema,
    async execute(_id, params) {
      const result = await runDiverNotes(params as Input);
      return result.ok
        ? { content: [{ type: 'text', text: boundedDivernoteResult(result.value) }], details: { operation: params.operation, backend: DIVER_NOTES_BACKEND } }
        : { content: [{ type: 'text', text: result.error || 'Divernote request failed.' }], details: { operation: params.operation, backend: DIVER_NOTES_BACKEND, failed: true } };
    },
  });
}
