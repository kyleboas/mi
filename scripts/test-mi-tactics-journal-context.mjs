#!/usr/bin/env node
import assert from 'node:assert/strict';
const mod = await import('../src/tactics-journal-context.ts');
const { collectTacticsJournalContext, createLockedDivernoteRunner, writeTacticsJournalBriefSnapshot, readTacticsJournalBriefSnapshot } = mod;
let active = 0;
let maxActive = 0;
const context = await collectTacticsJournalContext({
  invokeItem: async (_op, input) => { active++; maxActive = Math.max(maxActive, active); await new Promise(r => setTimeout(r, 1)); active--; return input.itemType === 'note' ? { notes: [{ text: 'Board activation plan' }] } : { tasks: [] }; },
  invokeProject: async (_group, operation, input) => { active++; maxActive = Math.max(maxActive, active); await new Promise(r => setTimeout(r, 1)); active--; if (operation === 'list') return { projects: [{ id: 'board', name: 'Board' }, { id: 'ama', name: 'AMA' }] }; if (input.project === 'ama') throw new Error('temporary project failure'); return { project: { name: 'Board', tasks: [{ text: 'Ship activation test', status: 'open' }] } }; },
});
assert.equal(maxActive, 1);
assert.deepEqual(context.availability, { notes: true, tasks: true, projects: true });
assert.equal(context.diagnostics.projectFailures, 1);
let calls = 0;
const locked = createLockedDivernoteRunner(async (_file, args) => { calls++; return calls === 1 ? { stdout: '', stderr: 'busy', code: 75 } : { stdout: '{}', stderr: '', code: 0 }; }, { lockPath: '/tmp/mi-divernote-test.lock', jitterMs: () => 0 });
const result = await locked('divernote', ['projects', 'list', '--json'], { timeout: 1000 });
assert.equal(result.code, 0);
assert.equal(calls, 2);
const path = '/tmp/mi-tactics-journal-test.json';
await writeTacticsJournalBriefSnapshot({ version: 1, checkedAt: new Date().toISOString(), context }, path);
const snapshot = await readTacticsJournalBriefSnapshot(path);
assert.equal(snapshot?.fresh, true);
console.log('Tactics Journal context and lock checks passed.');
