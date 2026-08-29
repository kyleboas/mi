#!/usr/bin/env node
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { diverNotesIntent } from './mi-diver-notes-intent.mjs';

const mod = await import(pathToFileURL(new URL('../pi/extensions/mi-diver-notes.ts', import.meta.url).pathname).href);
const { runDiverNotes, DIVER_NOTES_BACKEND, DIVER_NOTES_READ_OPERATIONS, DIVER_NOTES_WRITE_OPERATIONS } = mod;
assert.equal(DIVER_NOTES_BACKEND, 'canonical-pi-divernote');
assert.ok(DIVER_NOTES_READ_OPERATIONS.has('notes.list'));
assert.ok(DIVER_NOTES_WRITE_OPERATIONS.has('notes.add'));
let call;
const result = await runDiverNotes({ operation: 'notes.add', text: 'This is a note.' }, {
  invokeItem: async (operation, input) => { call = { operation, input }; return { ok: true, note: { text: input.text } }; },
});
assert.deepEqual(call, { operation: 'add', input: { itemType: 'note', text: 'This is a note.' } });
assert.equal(result.ok, true);
assert.equal((await runDiverNotes({ operation: 'notes.add' }, { invokeItem: async () => ({}) })).ok, false);
assert.deepEqual(diverNotesIntent({ message: 'Add a note. The note text is: This is a note.', plan: { allowWrite: true } }), { access: 'write' });
console.log('Mi canonical Divernote extension checks passed.');
