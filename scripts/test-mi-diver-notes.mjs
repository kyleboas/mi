#!/usr/bin/env node
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { diverNotesIntent } from './mi-diver-notes-intent.mjs';
import { diverNotesReplyEnvironment } from './mi-imessage-runtime.mjs';

const mod = await import(pathToFileURL(new URL('../pi/extensions/mi-diver-notes.ts', import.meta.url).pathname).href);
const { runDiverNotes, boundedDivernoteResult, DIVERNOTE_COMMAND, DIVER_NOTES_BACKEND, DIVER_NOTES_READ_OPERATIONS, DIVER_NOTES_WRITE_OPERATIONS } = mod;
assert.equal(DIVER_NOTES_BACKEND, 'canonical-pi-divernote');
assert.equal(DIVERNOTE_COMMAND, '/home/kyle/.local/bin/divernote');
assert.deepEqual(diverNotesReplyEnvironment('session-1'), { MI_DIVER_NOTES_ONLY_OPERATION: 'pi.message', MI_DIVER_NOTES_PI_SESSION_ID: 'session-1' });
assert.deepEqual(diverNotesReplyEnvironment('--unsafe'), {});
assert.ok(DIVER_NOTES_READ_OPERATIONS.has('notes.list'));
assert.ok(DIVER_NOTES_READ_OPERATIONS.has('tactics-journal.context'));
assert.ok(DIVER_NOTES_WRITE_OPERATIONS.has('notes.add'));
assert.ok(DIVER_NOTES_WRITE_OPERATIONS.has('pi.message'));
let call;
let projectCalls = [];
const contextResult = await runDiverNotes({ operation: 'tactics-journal.context' }, {
  invokeItem: async (_operation, input) => input.itemType === 'note' ? { notes: [{ text: 'Tactics Journal idea', date: '2026-08-01' }] } : { tasks: [] },
  invokeProject: async (group, operation, input) => { projectCalls.push({ group, operation, input }); return operation === 'list' ? { projects: [] } : { project: { name: 'Board', tasks: [] } }; },
});
assert.equal(contextResult.ok, true);
assert.equal(JSON.parse(JSON.stringify(contextResult.value)).scope, 'Tactics Journal');
assert.equal(projectCalls[0].operation, 'list');
let activeReads = 0;
let maxActiveReads = 0;
const partialContext = await runDiverNotes({ operation: 'tactics-journal.context' }, {
  invokeItem: async (_operation, input) => {
    activeReads += 1;
    maxActiveReads = Math.max(maxActiveReads, activeReads);
    await new Promise((resolve) => setTimeout(resolve, 1));
    activeReads -= 1;
    return input.itemType === 'note' ? { notes: [{ text: 'Board activation plan' }] } : { tasks: [] };
  },
  invokeProject: async (_group, operation, input) => {
    activeReads += 1;
    maxActiveReads = Math.max(maxActiveReads, activeReads);
    await new Promise((resolve) => setTimeout(resolve, 1));
    activeReads -= 1;
    if (operation === 'list') return { projects: [{ id: 'board', name: 'Board' }, { id: 'ama', name: 'AMA' }] };
    if (input.project === 'ama') throw new Error('temporary project read failure');
    return { project: { name: 'Board', tasks: [{ text: 'Ship activation test', status: 'open' }] } };
  },
});
assert.equal(partialContext.ok, true);
assert.equal(maxActiveReads, 1, 'aggregate vault reads must be sequential');
assert.deepEqual(partialContext.value.availability, { notes: true, tasks: true, projects: true });
assert.equal(partialContext.value.projects.length, 1, 'one failed project read does not discard healthy context');
const result = await runDiverNotes({ operation: 'notes.add', text: 'This is a note.' }, {
  invokeItem: async (operation, input) => { call = { operation, input }; return { ok: true, note: { text: input.text } }; },
});
assert.deepEqual(call, { operation: 'add', input: { itemType: 'note', text: 'This is a note.' } });
assert.equal(result.ok, true);
assert.equal((await runDiverNotes({ operation: 'notes.add' }, { invokeItem: async () => ({}) })).ok, false);
let piCommand;
const piMessage = await runDiverNotes({ operation: 'pi.message', sessionId: 'session-1', text: 'Keep the pasted text together.' }, {
  authorization: { onlyOperation: 'pi.message', piSessionId: 'session-1' },
  runCommand: async (file, args, options) => {
    piCommand = { file, args, options };
    return { code: 0, stdout: JSON.stringify({ status: 'ok', reply: 'I will fix it.' }), stderr: '' };
  },
});
assert.equal(piMessage.ok, true);
assert.deepEqual(piMessage.value, { status: 'ok', reply: 'I will fix it.' });
assert.deepEqual(piCommand, {
  file: DIVERNOTE_COMMAND,
  args: ['pi-message', '--session-id', 'session-1', '--text', 'Keep the pasted text together.', '--json'],
  options: { timeout: 600_000 },
});
assert.equal((await runDiverNotes({ operation: 'pi.message', sessionId: 'session-2', text: 'wrong session' }, {
  authorization: { onlyOperation: 'pi.message', piSessionId: 'session-1' },
  runCommand: async () => { throw new Error('must not run'); },
})).ok, false);
assert.equal((await runDiverNotes({ operation: 'notes.add', text: 'wrong operation' }, {
  authorization: { onlyOperation: 'pi.message', piSessionId: 'session-1' },
  invokeItem: async () => { throw new Error('must not run'); },
})).ok, false);
const bounded = JSON.parse(boundedDivernoteResult({ notes: Array.from({ length: 1000 }, (_, id) => ({ id, text: 'x'.repeat(200) })) }));
assert.equal(bounded.truncated, true);
assert.equal(bounded.total, 1000);
assert.ok(Buffer.byteLength(JSON.stringify(bounded)) <= 24 * 1024);
assert.deepEqual(diverNotesIntent({ message: 'Add a note. The note text is: This is a note.', plan: { allowWrite: true } }), { access: 'write' });
assert.deepEqual(diverNotesIntent({ message: 'Keep it as one message. Divernote says reply with instructions for Pi session session-1.', plan: { allowWrite: true } }), { access: 'write', piSessionId: 'session-1' });
assert.deepEqual(diverNotesIntent({ message: 'Divernote mentions Pi session session-1 and Pi session session-2.', plan: { allowWrite: true } }), { access: 'none', clarify: true });
console.log('Mi canonical Divernote extension checks passed.');
