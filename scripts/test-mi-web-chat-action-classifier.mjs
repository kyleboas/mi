#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { v2LooksLikeActionText } from './mi-web-chat-action-classifier.mjs';
import { v2RiskClassification, v2RouteDecision } from './mi-web-chat-v2-route.mjs';

assert.equal(v2LooksLikeActionText('Can you send Kyle a message'), false, 'sending is not handled by the action classifier');
assert.equal(v2RiskClassification('send Kyle a message').kind, 'confirm', 'send/message requests require confirmation');
assert.equal(v2RiskClassification('delete all data').kind, 'never-delegate', 'destructive requests are refused');
assert.equal(v2RouteDecision({ message: 'ordinary text', workspace: { root: '/tmp/work', cwd: '/tmp/work' } }).kind, 'coordinator', 'ordinary text uses the guarded coordinator');
const source = await readFile(new URL('./mi-web-chat.mjs', import.meta.url), 'utf8');
assert.match(source, /MI_WEB_MAINTENANCE/, 'Web chat has an explicit maintenance gate');
assert.doesNotMatch(source, /\/api\/imessage|\/api\/messages|v2RouteDecision/, 'Web chat has no iMessage route');
console.log('mi web chat action classifier tests passed');
