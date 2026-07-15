#!/usr/bin/env node
import assert from 'node:assert/strict';
import { parseWorkerCompletion, workerCompletionInstruction } from './mi-worker-completion.mjs';
import { sanitizeTurnEvent, turnHash } from './mi-turn-observability.mjs';
const good = parseWorkerCompletion('work complete\n{"version":1,"status":"complete","userSummary":"The status is healthy."}');
assert.deepEqual(good, { version: 1, status: 'complete', userSummary: 'The status is healthy.' });
assert.equal(parseWorkerCompletion('{"version":1,"status":"complete","userSummary":"Run this command now."}'), undefined);
assert.equal(parseWorkerCompletion('{"version":1,"status":"complete","userSummary":"See /home/kyle/private/report."}'), undefined);
assert.equal(parseWorkerCompletion('{"version":1,"status":"complete","userSummary":"TOKEN=not-safe"}'), undefined);
assert.equal(parseWorkerCompletion('plain legacy result'), undefined);
assert.match(workerCompletionInstruction(), /"version":1/);
const event = sanitizeTurnEvent({ stage: 'result-formatted', outcome: 'ok', route: 'v2', modelProfile: 'mi-concierge', turn: 'high-entropy-correlation', durationMs: 12, message: 'must not survive', taskId: 'must not survive' });
assert.deepEqual(Object.keys(event).sort(), ['durationMs', 'modelProfile', 'outcome', 'route', 'schema', 'stage', 'ts', 'turn'].sort());
assert.equal(event.turn, turnHash('high-entropy-correlation')); assert.equal(turnHash('same'), turnHash('same'));
console.log('Mi structured completion and observability checks passed.');
