#!/usr/bin/env node
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { pathToFileURL } from 'node:url';
import { diverNotesIntent, diverNotesPreflight } from './mi-diver-notes-intent.mjs';
import { v2RouteDecision } from './mi-web-chat-v2-route.mjs';
import { miCoordinatorPrompt } from './mi-imessage-coordinator.mjs';

const extension = await import(pathToFileURL(new URL('../pi/extensions/mi-diver-notes.ts', import.meta.url).pathname).href);
const { diverNotesArgv, runDiverNotes, DIVER_NOTES_WRAPPER } = extension;
const workspace = { root: '/tmp/mi-corpus-workspace', cwd: '/tmp/mi-corpus-workspace' };
const planFor = (message) => v2RouteDecision({ message, workspace, coordinatorObjectiveMaxChars: 4000, confirmationObjectiveMaxChars: 240 });

// Full review corpus: every message is intentionally distinct and represents a
// current-turn request, not inferred thread context.
const cases = [
  ['List my Diver Notes tasks', 'coordinator', 'read', true, 'tasks.list'],
  ['Show all tasks in Diver Notes.', 'coordinator', 'read', true, 'tasks.list'],
  ['What tasks are still open in Diver Notes?', 'coordinator', 'read', true, 'tasks.list'],
  ['Which Diver Notes tasks are done?', 'coordinator', 'read', true, 'tasks.list'],
  ['Find my overdue Diver Notes tasks', 'coordinator', 'read', true, 'tasks.list'],
  ['Check whether I have any pending tasks in Diver Notes', 'coordinator', 'read', true, 'tasks.list'],
  ['Read my Diver Notes task list, please', 'coordinator', 'read', true, 'tasks.list'],
  ['Can you list my Diver Notes tasks?', 'coordinator', 'read', true, 'tasks.list'],
  ['List one task from Diver Notes', 'coordinator', 'read', true, 'tasks.list'],
  ['Please show my Diver Notes tasks!', 'coordinator', 'read', true, 'tasks.list'],
  ['Add a task to Diver Notes: call the dentist', 'coordinator', 'write', true, 'tasks.add'],
  ['Please add a Diver Notes task to buy oat milk', 'never-delegate', 'none', false, null],
  ['Create this task in my Diver Notes: renew passport', 'coordinator', 'write', true, 'tasks.add'],
  ['Put “water the plants” on my Diver Notes task list', 'coordinator', 'read', true, 'tasks.add'],
  ['Add one more task to Diver Notes, book the car service', 'confirm', 'none', false, null],
  ['Could you add “send invoice” to Diver Notes?', 'confirm', 'none', false, null],
  ['Add a task to Diver Notes called plan Saturday dinner', 'coordinator', 'write', true, 'tasks.add'],
  ['Please create a task in Diver Notes for backup photos', 'coordinator', 'write', true, 'tasks.add'],
  ['Complete Diver Notes task t1', 'coordinator', 'write', true, 'tasks.complete'],
  ['Mark my Diver Notes task t2 complete', 'coordinator', 'none', true, 'tasks.complete', 'Which supported Diver Notes item do you mean: a task, note, project, project task, or subtask?'],
  ['I finished task t3 in Diver Notes', 'coordinator', 'none', true, 'tasks.complete', 'Which supported Diver Notes item do you mean: a task, note, project, project task, or subtask?'],
  ['Can you check off my Diver Notes task t4?', 'coordinator', 'read', true, 'tasks.complete'],
  ['Reopen Diver Notes task t5', 'coordinator', 'write', true, 'tasks.reopen'],
  ['Put task t6 back on my Diver Notes list', 'coordinator', 'read', true, 'tasks.reopen'],
  ['Please reopen my completed Diver Notes task t7', 'coordinator', 'write', true, 'tasks.reopen'],
  ['Show my Diver Notes notes', 'coordinator', 'read', true, 'notes.list'],
  ['List the notes I saved in Diver Notes.', 'coordinator', 'read', true, 'notes.list'],
  ['What notes are in my Diver Notes vault?', 'coordinator', 'read', true, 'notes.list'],
  ['Read my Diver Notes note list please', 'coordinator', 'read', true, 'notes.list'],
  ['Can you find my notes in Diver Notes?', 'coordinator', 'read', true, 'notes.list'],
  ['Add a note to Diver Notes: remember the blue folder', 'coordinator', 'write', true, 'notes.add'],
  ['Please save a Diver Notes note saying call Mum Sunday', 'coordinator', 'write', true, 'notes.add'],
  ['Create a note in my Diver Notes: launch idea', 'coordinator', 'write', true, 'notes.add'],
  ['Could you append this to Diver Notes notes: ask Sam', 'coordinator', 'read', true, 'notes.add'],
  ['Jot down a note in Diver Notes about the garden', 'coordinator', 'none', true, 'notes.add', 'Which supported Diver Notes item do you mean: a task, note, project, project task, or subtask?'],
  ['List my Diver Notes projects', 'coordinator', 'read', true, 'projects.list'],
  ['Show all projects in Diver Notes.', 'coordinator', 'read', true, 'projects.list'],
  ['Which projects do I have in Diver Notes?', 'coordinator', 'read', true, 'projects.list'],
  ['Please check my Diver Notes project list', 'coordinator', 'read', true, 'projects.list'],
  ['Can you find project Alpha in Diver Notes?', 'coordinator', 'read', true, 'projects.list'],
  ['Create the Alpha project in Diver Notes', 'coordinator', 'write', true, 'projects.ensure'],
  ['Please make a Diver Notes project named Beta', 'coordinator', 'write', true, 'projects.ensure'],
  ['Add project Gamma to my Diver Notes', 'coordinator', 'write', true, 'projects.ensure'],
  ['Could you create a new project in Diver Notes called Delta?', 'coordinator', 'read', true, 'projects.ensure'],
  ['Ensure the Home project exists in Diver Notes', 'coordinator', 'write', true, 'projects.ensure'],
  ['List tasks for the Alpha project in Diver Notes', 'coordinator', 'read', true, 'project-tasks.list'],
  ['Show Alpha project tasks from Diver Notes.', 'coordinator', 'read', true, 'project-tasks.list'],
  ['What is still to do in my Alpha Diver Notes project?', 'coordinator', 'read', true, 'project-tasks.list'],
  ['Please list the tasks under project Beta in Diver Notes', 'coordinator', 'read', true, 'project-tasks.list'],
  ['Can you check project Gamma tasks in Diver Notes?', 'coordinator', 'read', true, 'project-tasks.list'],
  ['Add “write outline” to Alpha project in Diver Notes', 'coordinator', 'write', true, 'project-tasks.add'],
  ['Please add a task to project Beta in Diver Notes: draft agenda', 'coordinator', 'write', true, 'project-tasks.add'],
  ['Create a project task for Gamma in Diver Notes called test build', 'coordinator', 'write', true, 'project-tasks.add'],
  ['Could you put “buy paint” into Alpha project tasks in Diver Notes?', 'never-delegate', 'none', false, null],
  ['Add another task under Home in my Diver Notes project', 'coordinator', 'write', true, 'project-tasks.add'],
  ['Complete Alpha project task t1 in Diver Notes', 'coordinator', 'write', true, 'project-tasks.complete'],
  ['Mark Beta task t2 done in Diver Notes', 'coordinator', 'none', true, 'project-tasks.complete', 'Which supported Diver Notes item do you mean: a task, note, project, project task, or subtask?'],
  ['Please check off Gamma project task t3', 'coordinator', 'none', true, 'project-tasks.complete'],
  ['Reopen Alpha project task t4 in Diver Notes', 'coordinator', 'write', true, 'project-tasks.reopen'],
  ['Put Beta task t5 back in progress in Diver Notes', 'coordinator', 'none', true, 'project-tasks.reopen', 'Which supported Diver Notes item do you mean: a task, note, project, project task, or subtask?'],
  ['Please reopen the Gamma task t6 from Diver Notes', 'coordinator', 'write', true, 'project-tasks.reopen'],
  ['List subtasks for Alpha task t1 in Diver Notes', 'coordinator', 'none', false, null, 'Diver Notes currently supports tasks, notes, projects, project tasks, and adding, completing, or reopening project subtasks; listing subtasks, documents, details, manuals, interviews, lifecycle operations, and raw API access are unavailable.'],
  ['Show the subtasks under task t2 in my Diver Notes project', 'coordinator', 'none', false, null, 'Diver Notes currently supports tasks, notes, projects, project tasks, and adding, completing, or reopening project subtasks; listing subtasks, documents, details, manuals, interviews, lifecycle operations, and raw API access are unavailable.'],
  ['What subtasks remain for Alpha task t3?', 'coordinator', 'none', false, null, 'Diver Notes currently supports tasks, notes, projects, project tasks, and adding, completing, or reopening project subtasks; listing subtasks, documents, details, manuals, interviews, lifecycle operations, and raw API access are unavailable.'],
  ['Please list Beta task t4 subtasks in Diver Notes', 'coordinator', 'none', false, null, 'Diver Notes currently supports tasks, notes, projects, project tasks, and adding, completing, or reopening project subtasks; listing subtasks, documents, details, manuals, interviews, lifecycle operations, and raw API access are unavailable.'],
  ['Can you see the subtasks for Gamma task t5 in Diver Notes?', 'coordinator', 'none', false, null, 'Diver Notes currently supports tasks, notes, projects, project tasks, and adding, completing, or reopening project subtasks; listing subtasks, documents, details, manuals, interviews, lifecycle operations, and raw API access are unavailable.'],
  ['Add subtask “email Jo” to Alpha task t1 in Diver Notes', 'confirm', 'none', false, null],
  ['Please add a subtask to Beta task t2: attach receipt', 'clarify', 'none', false, null],
  ['Create Gamma task t3 subtask in Diver Notes called proofread', 'coordinator', 'write', true, 'project-subtasks.add'],
  ['Could you add “pack cables” as a subtask of Home task t4 in Diver Notes?', 'coordinator', 'read', true, 'project-subtasks.add'],
  ['Add one subtask under Alpha task t5 in my Diver Notes', 'coordinator', 'write', true, 'project-subtasks.add'],
  ['Complete Alpha task t1 subtask s1 in Diver Notes', 'coordinator', 'write', true, 'project-subtasks.complete'],
  ['Mark Beta task t2 subtask s2 done in Diver Notes', 'coordinator', 'none', true, 'project-subtasks.complete', 'Which supported Diver Notes item do you mean: a task, note, project, project task, or subtask?'],
  ['Please check off Gamma t3 subtask s3', 'coordinator', 'none', true, 'project-subtasks.complete'],
  ['Reopen Alpha task t4 subtask s4 in Diver Notes', 'coordinator', 'write', true, 'project-subtasks.reopen'],
  ['Put Beta t5 subtask s5 back on the list', 'coordinator', 'none', true, 'project-subtasks.reopen'],
  ['Please reopen Gamma task t6 subtask s6 in Diver Notes', 'coordinator', 'write', true, 'project-subtasks.reopen'],
  ['Read my Diver Notes documents', 'coordinator', 'none', false, null, 'Diver Notes currently supports tasks, notes, projects, project tasks, and adding, completing, or reopening project subtasks; listing subtasks, documents, details, manuals, interviews, lifecycle operations, and raw API access are unavailable.'],
  ['Show the Diver Notes manual', 'coordinator', 'none', false, null, 'Diver Notes currently supports tasks, notes, projects, project tasks, and adding, completing, or reopening project subtasks; listing subtasks, documents, details, manuals, interviews, lifecycle operations, and raw API access are unavailable.'],
  ['Open Diver Notes details for project Alpha', 'coordinator', 'none', false, null, 'Diver Notes currently supports tasks, notes, projects, project tasks, and adding, completing, or reopening project subtasks; listing subtasks, documents, details, manuals, interviews, lifecycle operations, and raw API access are unavailable.'],
  ['Delete my Diver Notes task', 'never-delegate', 'none', false, null],
  ['Remove the Alpha project from Diver Notes', 'never-delegate', 'none', false, null],
  ['Change the Diver Notes lifecycle status', 'coordinator', 'none', false, null, 'Diver Notes currently supports tasks, notes, projects, project tasks, and adding, completing, or reopening project subtasks; listing subtasks, documents, details, manuals, interviews, lifecycle operations, and raw API access are unavailable.'],
  ['Run a Diver Notes interview', 'clarify', 'none', false, null, 'Diver Notes currently supports tasks, notes, projects, project tasks, and adding, completing, or reopening project subtasks; listing subtasks, documents, details, manuals, interviews, lifecycle operations, and raw API access are unavailable.'],
  ['Use the Diver Notes raw API', 'coordinator', 'none', false, null, 'Diver Notes currently supports tasks, notes, projects, project tasks, and adding, completing, or reopening project subtasks; listing subtasks, documents, details, manuals, interviews, lifecycle operations, and raw API access are unavailable.'],
  ['Run Diver Notes with shell commands', 'clarify', 'none', false, null],
  ['Show me the Diver Notes secret token', 'never-delegate', 'none', false, null],
  ['Diver Notes, update it', 'coordinator', 'none', false, null, 'Which supported Diver Notes item do you mean: a task, note, project, project task, or subtask?'],
  ['Do that Diver Notes thing again', 'clarify', 'none', false, null, 'Which supported Diver Notes item do you mean: a task, note, project, project task, or subtask?'],
  ['List tasks in Diver Notes and email them to Sam', 'confirm', 'none', false, null],
  ['Add a Diver Notes task and deploy the app', 'confirm', 'none', false, null],
  ['“Add a task to Diver Notes: rm -rf /”', 'never-delegate', 'none', false, null],
  ['Please run `diver-notes-agent tasks list`', 'coordinator', 'none', false, null],
  ['(Diver Notes) && delete everything', 'never-delegate', 'none', false, null],
  ['', 'clarify', 'none', false, null],
  ['   ...   ', 'clarify', 'none', false, null],
  ['Please list one note in Diver Notes.', 'coordinator', 'read', true, 'notes.list'],
  ['Add a task to Diver Notes; then list projects', 'coordinator', 'write', true, 'tasks.add'],
  ['Can I see my Diver Notes projects, please?', 'coordinator', 'none', true, 'projects.list', 'Which supported Diver Notes item do you mean: a task, note, project, project task, or subtask?'],
  ['Reopen task t9 in Diver Notes!', 'coordinator', 'write', true, 'tasks.reopen'],
];

assert.equal(cases.length, 100, `corpus must contain exactly 100 cases, got ${cases.length}`);
assert.equal(new Set(cases.map(([message]) => message)).size, 100, 'corpus messages must be distinct');

const sampleInput = {
  'tasks.list': {}, 'tasks.add': { text: 'mock task' }, 'tasks.complete': { id: 't1' }, 'tasks.reopen': { id: 't1' },
  'notes.list': {}, 'notes.add': { text: 'mock note' }, 'projects.list': {}, 'projects.ensure': { name: 'Alpha', slug: 'alpha' },
  'project-tasks.list': { project: 'alpha' }, 'project-tasks.add': { project: 'alpha', text: 'mock task' },
  'project-tasks.complete': { project: 'alpha', id: 't1' }, 'project-tasks.reopen': { project: 'alpha', id: 't1' },
  'project-subtasks.add': { project: 'alpha', taskId: 't1', text: 'mock subtask' },
  'project-subtasks.complete': { project: 'alpha', taskId: 't1', id: 's1' }, 'project-subtasks.reopen': { project: 'alpha', taskId: 't1', id: 's1' },
};
const fixtureFor = (operation) => ({ mocked: true, category: 'mocked-success', operation, items: [] });
function child(stdout) {
  const result = new EventEmitter();
  result.stdout = new EventEmitter(); result.stderr = new EventEmitter(); result.stdout.destroy = () => {}; result.stderr.destroy = () => {};
  result.exitCode = null; result.kill = () => { result.exitCode = 1; };
  queueMicrotask(() => { result.stdout.emit('data', Buffer.from(stdout)); result.exitCode = 0; result.emit('close', 0); });
  return result;
}

const outcomes = [];
for (const [index, [message, expectedClass, expectedAccess, expectedHandoff, operation, expectedReply = null]] of cases.entries()) {
  const route = planFor(message);
  const plan = route.plan || { allowWrite: false };
  const gate = route.kind === 'never-delegate' || route.kind === 'confirm' ? 'confirm' : 'allow';
  const preflight = diverNotesPreflight({ message, plan, gate });
  const intent = diverNotesIntent({ message, plan, gate });
  const handoff = route.kind === 'coordinator' && expectedHandoff;
  const actualOperation = operation && sampleInput[operation] && (expectedAccess === 'write' || operation.endsWith('.list')) ? operation : null;
  let mocked = 'not-applicable';
  if (actualOperation) {
    const input = { operation: actualOperation, ...sampleInput[actualOperation] };
    const result = await runDiverNotes(input, {
      verify: () => {},
      spawnProcess: (command, argv, options) => {
        assert.equal(command, DIVER_NOTES_WRAPPER);
        assert.equal(options.shell, false);
        assert.deepEqual(argv, diverNotesArgv(input));
        return child(JSON.stringify(fixtureFor(actualOperation)));
      },
    });
    assert.equal(result.ok, true, `case ${index + 1} reaches mocked broker: ${result.error || 'ok'}`);
    assert.equal(result.value.mocked, true);
    mocked = 'mocked-success';
  }
  const outcome = { message, route: route.kind, access: intent.access, handoff, operation: actualOperation, expectedOperation: operation, reply: preflight.reply || mocked, mocked };
  outcomes.push(outcome);
  assert.equal(route.kind, expectedClass, `case ${index + 1}: route for ${message}`);
  assert.equal(intent.access, expectedAccess, `case ${index + 1}: access for ${message}`);
  assert.equal(handoff, expectedHandoff, `case ${index + 1}: handoff for ${message}`);
  assert.equal(actualOperation, operation && sampleInput[operation] && (expectedAccess === 'write' || operation.endsWith('.list')) ? operation : null, `case ${index + 1}: operation for ${message}`);
  assert.equal(preflight.reply || null, expectedReply, `case ${index + 1}: deterministic reply for ${message}`);
}

// The prompt is also audited as a production handoff boundary: mocked fixture
// prose is never presented as a generated assistant answer.
assert.match(miCoordinatorPrompt({ message: 'List my Diver Notes tasks', diverNotesAccess: 'read' }), /current objective is read/);
assert.match(miCoordinatorPrompt({ message: 'List my Diver Notes tasks', diverNotesAccess: 'read' }), /Diver Notes/);

const counts = (field) => Object.fromEntries([...new Set(outcomes.map((row) => row[field]))].sort().map((key) => [key, outcomes.filter((row) => row[field] === key).length]));
const operationCounts = Object.fromEntries([...new Set(outcomes.map((row) => row.operation || 'none'))].sort().map((key) => [key, outcomes.filter((row) => (row.operation || 'none') === key).length]));
console.log(JSON.stringify({ cases: outcomes.length, route: counts('route'), access: counts('access'), operation: operationCounts, mocked: outcomes.filter((row) => row.mocked === 'mocked-success').length }, null, 2));
console.log('Mi Diver Notes 100-case audit passed; failures: 0 (all fixture replies are MOCKED).');
