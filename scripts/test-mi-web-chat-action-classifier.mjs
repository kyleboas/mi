#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { v2LooksLikeActionText } from './mi-web-chat-action-classifier.mjs';

const canonical = (message) => String(message).replace(/\s+/g, ' ').trim().toLowerCase();
const looksLikeAction = (message) => v2LooksLikeActionText(canonical(message));

// Capability questions are conversation, not actions. An unanchored courtesy
// alternation matched the embedded “can you do” and answered “What can you do”
// with a canned clarification instead of consulting Pi.
for (const question of ['What can you do', 'What can you do?', 'what can you help with', 'so what can you do for me']) {
  assert.equal(looksLikeAction(question), false, `capability question must not be an action: ${question}`);
}

// A courtesy request that starts the message and names a target stays an action.
for (const request of [
  'Can you fix the daemon',
  'Hey can you update the bridge script',
  'Could you please patch the relay',
  'Would you configure the workspace root',
]) {
  assert.equal(looksLikeAction(request), true, `courtesy action must stay an action: ${request}`);
}

// A bare imperative remains action-looking so the existing no-plan
// clarification path still runs.
for (const imperative of ['fix it', 'please check the logs', 'do it']) {
  assert.equal(looksLikeAction(imperative), true, `imperative must stay an action: ${imperative}`);
}

// A courtesy verb with no object is not an actionable request.
assert.equal(looksLikeAction('can you do'), false, 'courtesy verb without an object is not an action');
assert.equal(looksLikeAction('/skill:advisor fix the daemon'), false, 'skill commands are routed elsewhere');

// The high-impact confirmation gate is unchanged and still runs before the
// action classifier, so an outbound message request cannot skip confirmation.
// The gate now lives with the rest of the pure v2 routing decision.
const source = await readFile(new URL('./mi-web-chat-v2-route.mjs', import.meta.url), 'utf8');
assert.equal(looksLikeAction('Can you send Kyle a message'), false, 'sending is not handled by the action classifier');
assert.match(source, /\\bsend\\b[\s\S]*\\bmessage\\b[\s\S]*return \{ kind: 'confirm', objective, actionClass: 'confirmed-high-impact' \}/, 'send/message requests must still require confirmation');
const confirmIndex = source.indexOf("if (risk.kind === 'confirm')");
const clarifyIndex = source.indexOf('if (v2LooksLikeAction(message)');
assert.ok(confirmIndex > 0 && clarifyIndex > confirmIndex, 'the confirmation gate must run before the action clarification branch');

// Production must route through the tested helper rather than a private copy.
const serverSource = await readFile(new URL('./mi-web-chat.mjs', import.meta.url), 'utf8');
assert.match(serverSource, /import \{ messageHasLocalWorkTarget, v2RouteDecision \} from '\.\/mi-web-chat-v2-route\.mjs'/, 'web chat must use the shared v2 route helper');
assert.match(serverSource, /const route = v2RouteDecision\(\{ message, workspace, coordinatorObjectiveMaxChars, confirmationObjectiveMaxChars \}\)/, 'handleImessageV2 must decide the turn with the shared helper');

console.log('mi web chat action classifier tests passed');
