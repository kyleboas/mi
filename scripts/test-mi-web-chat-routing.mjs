#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('./mi-web-chat.mjs', import.meta.url), 'utf8');

assert.match(source, /function messageLooksConversational\(message\)[\s\S]*what\\s\+time\\s\+is\\s\+it/, 'web chat routing must classify time questions as conversational');
assert.match(source, /function messageLooksConversational\(message\)[\s\S]*let me see it/, 'web chat routing must classify view-only requests as conversational');
assert.match(source, /function messageLooksConversational\(message\)[\s\S]*handoff[\s\S]*worker/, 'web chat routing must classify handoff meta-questions as conversational');
assert.match(source, /function shouldStartBackgroundWorker\(message\)[\s\S]*messageLooksConversational\(message\)[\s\S]*return false/, 'conversational messages must not start background workers');
assert.doesNotMatch(source, /return estimatedWorkSeconds\(message\) >= workerThresholdSeconds;/, 'worker routing must not be only a naive duration threshold');
assert.match(source, /function messageLooksLikeInlineMiWork\(message\)[\s\S]*draft\|write\|rewrite\|compose\|wordsmith[\s\S]*return true/, 'writing/drafting requests must be handled inline unless they are code work');
assert.match(source, /function workerRoutingDecision\(message\)[\s\S]*messageLooksLikeInlineMiWork\(message\)[\s\S]*start: false, reason: 'inline-chat'/, 'inline chat/drafting requests must stay in Mi instead of worker');
assert.match(source, /function workerRoutingDecision\(message\)[\s\S]*localTarget && \(actionable \|\| complaint\)[\s\S]*repo\/app work/, 'local actionable complaints can still start workers');
assert.match(source, /function messageLooksActionable\(message\)[\s\S]*inspect\|check\|verify[\s\S]*save\|remember\|remind\|schedule/, 'check/inspect and save/reminder requests must be actionable so web chat routes them to workers');
assert.match(source, /function workerRoutingDecision\(message\)[\s\S]*research\|investigate\|inspect\|check\|verify/, 'local check/inspect/verify requests must route to workers instead of no-tool chat');
assert.match(source, /function contextAwareWorkerRoutingDecision\(threadId, message\)[\s\S]*you should be able to[\s\S]*contextual tool-backed task/, 'web chat must route contextual “you should be able to” / tool-access corrections to workers');
assert.match(source, /function contextAwareWorkerRoutingDecision\(threadId, message\)[\s\S]*tool access is allowed[\s\S]*heartbeat\|monitor/, 'web chat must pass “tool access is allowed / implement it” follow-ups to workers with context');
assert.match(source, /function contextAwareWorkerRoutingDecision\(threadId, message\)[\s\S]*corner\\s\*case[\s\S]*contextual routing\/worker behavior feedback/, 'web chat must route contextual “fix that” routing-principle feedback to a dedicated routing worker instead of brittle one-off rules');
assert.match(source, /if \(decision\.start && \(messageLooksLikeRoutingFeedback\(message\) \|\| \/routing\\\/worker behavior feedback\//, 'routing/worker behavior feedback must start a dedicated worker before active-worker follow-up capture');
assert.match(source, /function messageLooksLikeWorkerFollowup\(message, worker\)[\s\S]*messageLooksConversational\(message\)[\s\S]*return false/, 'conversational messages must not continue background workers');
assert.match(source, /if \(activeWorker && messageLooksLikeWorkerFollowup\(message, activeWorker\)\)/, 'active workers must only receive smartly detected follow-ups');
assert.doesNotMatch(source, /if \(activeWorker\) return continueBackgroundWorker/, 'active workers must not capture every chat message');
assert.match(source, /const miDaemonSystemdUnit = process\.env\.MI_DAEMON_SYSTEMD_UNIT \|\| 'mi-daemon\.service'/, 'web chat has a dedicated Mi daemon systemd unit name');
assert.match(source, /async function startMiDaemonWithSystemd\(\)[\s\S]*systemctl'[\s\S]*'--user', 'start', unit[\s\S]*waitForMiDaemonHealth/, 'web chat starts Mi daemon via user systemd before falling back to child process');
assert.match(source, /async function recentThreadContextForWorker\(threadId, currentMessage\)[\s\S]*readMessages\(threadId, 16\)[\s\S]*needsPronounContext \? 10 : 4[\s\S]*slice\(-12\)[\s\S]*remaining = 3600/, 'background worker handoff context must include a larger recent window for pronoun/follow-up handoffs while still being capped');
assert.match(source, /filter\(\(message\) => message\.role !== 'assistant' \|\| !\['web-worker-ack'\]/, 'background worker context must omit noisy worker acks but keep worker results for reply context');
assert.match(source, /async function buildWorkerFollowupPrompt\(threadId, message\)[\s\S]*Plan for the background worker:[\s\S]*Relevant chat context, newest last:[\s\S]*message: workerPrompt/, 'worker follow-ups must pass a plan plus recent Mi web context, not just the raw latest sentence');
assert.match(source, /Handoff reason: \$\{decision\.reason/, 'background worker prompts must include why Mi routed to a worker');
assert.match(source, /function handoffActionSummary\(message\)[\s\S]*tighten Mi routing\/hand-off behavior/, 'worker acknowledgements must summarize the actual request');
assert.match(source, /function workerAck\(message, kind = 'start', decision = workerRoutingDecision\(message\), worker = undefined\)[\s\S]*cleaner, scannable format[\s\S]*make those handoff replies sound natural[\s\S]*handoffReasonSentence\(decision\)/, 'worker acknowledgements must be natural and specific instead of quoting/truncating follow-ups');
assert.match(source, /function workerPlanForMessage\(message, problem = ''\)[\s\S]*Reformat the briefing as a concise, scannable daily brief[\s\S]*workerPlanForMessage\(message, problem\)/, 'briefing formatting follow-ups must pass a formatting-specific plan to the worker');
const forbiddenAckPhrases = new RegExp(['I’ll work on “\\$\\{quoted\\}”', 'sent that context to the active worker', 'I sent that context'].join('|'));
assert.doesNotMatch(source, forbiddenAckPhrases, 'worker acknowledgements must not echo truncated prompts or mention internal context forwarding');
assert.match(source, /body: JSON\.stringify\(\{ thread, name: file\.name, type: file\.type, dataUrl, attachOnly: true \}\)/, 'photo picker must upload as an attachment draft instead of sending immediately');
assert.match(source, /if \(body\.send === true\)[\s\S]*queueSendJob\(threadId, message\)/, 'photo upload endpoint must only send immediately when explicitly requested');
assert.match(source, /return sendJson\(res, 200, \{ ok: true, filePath, attached: true/, 'default photo upload endpoint behavior must attach only');
assert.match(source, /const decision = await contextAwareWorkerRoutingDecision\(threadId, message\);[\s\S]*startBackgroundWorker\(threadId, message, \{ decision \}\)/, 'runWebTurn must pass the routing decision into the handoff ack/prompt');

console.log('Mi web chat routing checks passed.');
