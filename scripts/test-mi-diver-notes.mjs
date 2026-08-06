#!/usr/bin/env node
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { diverNotesIntent } from './mi-diver-notes-intent.mjs';

const mod = await import(pathToFileURL(new URL('../pi/extensions/mi-diver-notes.ts', import.meta.url).pathname).href);
const { diverNotesArgv, verifyDiverNotesWrapper, runDiverNotes, DIVER_NOTES_READ_OPERATIONS, DIVER_NOTES_WRITE_OPERATIONS, DIVER_NOTES_WRAPPER } = mod;

const samples = {
  'tasks.list': {}, 'tasks.add': { text: 'buy milk' }, 'tasks.complete': { id: 't1' }, 'tasks.reopen': { id: 't1' },
  'notes.list': {}, 'notes.add': { text: 'idea' }, 'projects.list': {}, 'projects.ensure': { name: 'Alpha', slug: 'alpha' },
  'project-tasks.list': { project: 'alpha' }, 'project-tasks.add': { project: 'alpha', text: 'task' }, 'project-tasks.complete': { project: 'alpha', id: 't1' }, 'project-tasks.reopen': { project: 'alpha', id: 't1' },
  'project-subtasks.add': { project: 'alpha', taskId: 't1', text: 'subtask' }, 'project-subtasks.complete': { project: 'alpha', taskId: 't1', id: 's1' }, 'project-subtasks.reopen': { project: 'alpha', taskId: 't1', id: 's1' },
};
for (const [operation, fields] of Object.entries(samples)) {
  const argv = diverNotesArgv({ operation, ...fields });
  assert.deepEqual(argv.slice(0, 2), operation.split('.'), `${operation} uses its installed command family`);
  assert.equal(argv.at(-1), '--json');
}
assert.deepEqual([...DIVER_NOTES_READ_OPERATIONS].sort(), ['notes.list', 'project-tasks.list', 'projects.list', 'tasks.list']);
assert.equal(DIVER_NOTES_READ_OPERATIONS.size + DIVER_NOTES_WRITE_OPERATIONS.size, Object.keys(samples).length);
for (const bad of [
  { operation: 'tasks.list', argv: ['x'] }, { operation: 'tasks.list', command: 'x' }, { operation: 'tasks.list', path: '/tmp/x' }, { operation: 'tasks.list', url: 'https://bad' },
  { operation: 'tasks.add', text: 'x\u0000' }, { operation: 'tasks.add' }, { operation: 'projects.ensure', name: 'Alpha' }, { operation: 'project-tasks.add', project: 'a', text: 'x', input: '-' },
  { operation: 'tasks.add-many', input: '-' }, { operation: 'project-documents.read', project: 'a', document: 'x' }, { operation: 'wat.no' },
]) assert.throws(() => diverNotesArgv({ operation: 'project-subtasks.index', project: 'alpha', taskId: 't1' }));
assert.throws(() => diverNotesArgv(bad));

const good = { isSymbolicLink: () => false, isFile: () => true, uid: 0, mode: 0o100755 };
verifyDiverNotesWrapper(DIVER_NOTES_WRAPPER, { lstat: () => good, stat: () => good, realpath: () => DIVER_NOTES_WRAPPER });
for (const bad of [{ ...good, uid: 1 }, { ...good, mode: 0o100775 }, { ...good, mode: 0o100644 }, { ...good, isSymbolicLink: () => true }]) {
  assert.throws(() => verifyDiverNotesWrapper(DIVER_NOTES_WRAPPER, { lstat: () => bad, stat: () => bad, realpath: () => DIVER_NOTES_WRAPPER }));
}
assert.throws(() => verifyDiverNotesWrapper('/tmp/not-the-wrapper', { lstat: () => good, stat: () => good, realpath: () => DIVER_NOTES_WRAPPER }));

function fakeChild({ stdout = '{"ok":true}', code = 0, emitError = false, close = true } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdout.destroy = () => { child.stdoutDestroyed = true; }; child.stderr.destroy = () => { child.stderrDestroyed = true; };
  child.exitCode = null; child.kills = []; child.kill = (signal) => { child.kills.push(signal); child.exitCode = 1; };
  if (close) queueMicrotask(() => { if (emitError) child.emit('error', new Error('private failure')); else { child.stdout.emit('data', Buffer.from(stdout)); child.exitCode = code; child.emit('close', code); } });
  return child;
}
let captured;
const result = await runDiverNotes({ operation: 'tasks.list' }, { verify: () => {}, spawnProcess: (command, argv, options) => { captured = { command, argv, options }; return fakeChild(); } });
assert.deepEqual(result, { ok: true, value: { ok: true } });
assert.equal(captured.command, DIVER_NOTES_WRAPPER); assert.equal(captured.options.shell, false); assert.deepEqual(captured.options.stdio, ['ignore', 'pipe', 'pipe']); assert.deepEqual(captured.options.env, { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' });
assert.equal((await runDiverNotes({ operation: 'tasks.list' }, { verify: () => {}, spawnProcess: () => fakeChild({ stdout: 'not json' }) })).error, 'Divernote returned an invalid response.');
assert.equal((await runDiverNotes({ operation: 'tasks.list' }, { verify: () => {}, spawnProcess: () => fakeChild({ code: 1 }) })).error, 'Divernote request failed.');
assert.equal((await runDiverNotes({ operation: 'tasks.list' }, { verify: () => {}, spawnProcess: () => fakeChild({ emitError: true }) })).error, 'Divernote is unavailable.');
assert.equal((await runDiverNotes({ operation: 'tasks.list' }, { verify: () => {}, spawnProcess: () => fakeChild({ stdout: 'x'.repeat(200) }), outputCap: 20 })).error, 'Divernote returned too much data.');
let timedChild;
const timed = await runDiverNotes({ operation: 'tasks.list' }, { verify: () => {}, timeoutMs: 1, spawnProcess: () => (timedChild = fakeChild({ close: false })) });
assert.equal(timed.error, 'Divernote request timed out.'); assert.deepEqual(timedChild.kills, ['SIGTERM']); assert.equal(timedChild.stdoutDestroyed, true, 'timeout cleans up captured output');

assert.deepEqual(diverNotesIntent({ message: 'List my tasks.', plan: { allowWrite: false } }), { access: 'read' });
assert.deepEqual(diverNotesIntent({ message: 'Find my Divernote tasks.', plan: { allowWrite: false } }), { access: 'read' });
assert.deepEqual(diverNotesIntent({ message: 'Add a task to Divernote.', plan: { allowWrite: true } }), { access: 'write' });
assert.deepEqual(diverNotesIntent({ message: 'Add a task to Divernote.', plan: { allowWrite: false } }), { access: 'read' });
assert.deepEqual(diverNotesIntent({ message: 'Update it.', plan: { allowWrite: true } }), { access: 'none', clarify: true });
assert.deepEqual(diverNotesIntent({ message: 'Read my Divernote documents.', plan: { allowWrite: false } }), { access: 'none', clarify: true });
assert.deepEqual(diverNotesIntent({ message: 'List my tasks.', plan: { allowWrite: true }, gate: 'confirm' }), { access: 'none' });

const temp = await mkdtemp(path.join(os.tmpdir(), 'mi-diver-guard-'));
const grants = path.join(temp, 'grants.json');
try {
  await writeFile(grants, JSON.stringify({ grants: [{ id: 'read-vault', resource: 'diver-notes://vault', rights: ['read'] }] }));
  process.env.MI_CAPABILITY_GRANTS_FILE = grants;
  const guardModule = await import(`${pathToFileURL(new URL('../pi/extensions/mi-capability-guard.ts', import.meta.url).pathname).href}?diver=${Date.now()}`);
  let guard;
  guardModule.default({ on: (_event, handler) => { guard = handler; } });
  assert.equal(await guard({ toolName: 'mi_diver_notes', input: { operation: 'tasks.list' } }, { cwd: temp }), undefined, 'read grant permits only vault reads');
  assert.equal((await guard({ toolName: 'mi_diver_notes', input: { operation: 'tasks.add', text: 'x' } }, { cwd: temp })).block, true, 'read grant cannot mutate the vault');
  assert.equal((await guard({ toolName: 'mi_diver_notes', input: { operation: 'project-documents.read' } }, { cwd: temp })).block, true, 'unknown operations remain denied');
} finally { delete process.env.MI_CAPABILITY_GRANTS_FILE; await rm(temp, { recursive: true, force: true }); }

console.log('Mi Divernote extension checks passed.');
