#!/usr/bin/env node
// Offline corpus for the iMessage v2 routing/classification decision path.
// Every case runs the real v2RouteDecision used by scripts/mi-web-chat.mjs.
// Nothing here spawns Pi, calls a model or external service, sends a message,
// posts to Photon /notify, or reads private history.
import assert from 'node:assert/strict';
import { createCoordinatorCapacity } from './mi-web-chat-coordinator-capacity.mjs';
import { v2RouteDecision } from './mi-web-chat-v2-route.mjs';

const workspace = { root: '/tmp/mi-corpus-workspace', cwd: '/tmp/mi-corpus-workspace' };
const limits = { coordinatorObjectiveMaxChars: 4000, confirmationObjectiveMaxChars: 240 };
const route = (message, options = {}) => v2RouteDecision({
  message,
  workspace: 'workspace' in options ? options.workspace : workspace,
  ...limits,
});

// expect: the response class the user must get.
//   coordinator      -> handed to the iMessage coordinator (a real answer)
//   local-reply      -> a fixed, safe reply with no coordinator process
//   clarify          -> “What exactly should I act on?”
//   confirm          -> exact-objective confirmation required before anything runs
//   confirm-too-long -> confirmation refused because the objective cannot be stored
//   never-delegate   -> refused outright from iMessage
//   cancel / confirmation-command / workspace-refused -> the other fixed replies
// write: the coordinator handoff carries project write access.
const corpus = [
  // Only exact static greetings bypass the coordinator. Mixed greetings stay conversational.
  { category: 'greeting', message: 'Hey', expect: 'local-reply' },
  { category: 'greeting', message: 'Hi', expect: 'local-reply' },
  { category: 'greeting', message: 'Hello', expect: 'local-reply' },
  { category: 'greeting', message: 'Good morning', expect: 'local-reply' },
  { category: 'greeting', message: 'Morning!', expect: 'coordinator' },
  { category: 'greeting', message: 'yo', expect: 'coordinator' },
  { category: 'greeting', message: 'hey Mi', expect: 'coordinator' },
  { category: 'greeting', message: 'How are you?', expect: 'coordinator' },
  { category: 'greeting', message: "What's up?", expect: 'coordinator' },
  { category: 'greeting', message: 'Thanks!', expect: 'coordinator' },
  { category: 'greeting', message: 'thank you', expect: 'coordinator' },
  { category: 'greeting', message: 'ok', expect: 'coordinator' },
  { category: 'greeting', message: 'Sounds good', expect: 'coordinator' },
  { category: 'greeting', message: 'Goodnight', expect: 'coordinator' },

  // Capability and help questions are conversation, never a canned clarification.
  // “What can you do?” is the exact message that was answered with a
  // clarification before the courtesy pattern was anchored.
  { category: 'capability', message: 'What can you do?', expect: 'local-reply' },
  { category: 'capability', message: 'What can you do', expect: 'local-reply' },
  { category: 'capability', message: 'what can you help with', expect: 'local-reply' },
  { category: 'capability', message: 'so what can you do for me', expect: 'coordinator' },
  { category: 'capability', message: 'What are your capabilities?', expect: 'coordinator' },
  { category: 'capability', message: 'Can you help me?', expect: 'coordinator' },
  { category: 'capability', message: 'How do you work?', expect: 'coordinator' },
  { category: 'capability', message: 'What tools do you have?', expect: 'coordinator' },
  { category: 'capability', message: 'Are you able to browse the web?', expect: 'coordinator' },
  // A verb-first question about Mi itself is not an imperative.
  { category: 'capability', message: 'Do you have access to my calendar?', expect: 'coordinator' },
  { category: 'capability', message: 'Can you see my files?', expect: 'coordinator' },
  { category: 'capability', message: 'Do you remember what I asked yesterday?', expect: 'coordinator' },

  // Time, weather, and calendar-style questions.
  { category: 'time-weather-calendar', message: 'What time is it?', expect: 'coordinator' },
  { category: 'time-weather-calendar', message: "What's the weather today?", expect: 'coordinator' },
  { category: 'time-weather-calendar', message: 'Will it rain tomorrow?', expect: 'coordinator' },
  { category: 'time-weather-calendar', message: "What's on my calendar today?", expect: 'coordinator' },
  { category: 'time-weather-calendar', message: 'What day is it?', expect: 'coordinator' },
  { category: 'time-weather-calendar', message: 'How many days until Friday?', expect: 'coordinator' },
  { category: 'time-weather-calendar', message: "What's the date next Monday?", expect: 'coordinator' },
  { category: 'time-weather-calendar', message: "What's the time in London?", expect: 'coordinator' },
  { category: 'time-weather-calendar', message: 'Do I have anything after 3pm?', expect: 'coordinator' },
  { category: 'time-weather-calendar', message: 'How cold is it outside', expect: 'coordinator' },

  // Factual and explanatory questions.
  { category: 'factual', message: 'Who won the world cup in 2018?', expect: 'coordinator' },
  { category: 'factual', message: 'How tall is Mount Everest?', expect: 'coordinator' },
  { category: 'factual', message: 'What does TTL mean?', expect: 'coordinator' },
  { category: 'factual', message: 'Explain how DNS works', expect: 'coordinator' },
  { category: 'factual', message: 'Explain what a systemd timer does', expect: 'coordinator' },
  { category: 'factual', message: 'Summarize the difference between TCP and UDP', expect: 'coordinator' },
  { category: 'factual', message: 'What is a coordinator in Mi?', expect: 'coordinator' },
  { category: 'factual', message: 'How does the Mi routing work?', expect: 'coordinator' },
  { category: 'factual', message: 'Why is my internet slow', expect: 'coordinator' },
  { category: 'factual', message: 'What is the capital of Portugal', expect: 'coordinator' },

  // Safe read / inspection work: coordinator handoff without write access.
  { category: 'safe-read', message: 'Check the daemon logs for errors', expect: 'coordinator' },
  { category: 'safe-read', message: 'Read the routing test file', expect: 'coordinator' },
  { category: 'safe-read', message: 'List the open pull requests', expect: 'coordinator' },
  { category: 'safe-read', message: 'Find where the worker limit is set', expect: 'coordinator' },
  { category: 'safe-read', message: 'Inspect the mi daemon config', expect: 'coordinator' },
  { category: 'safe-read', message: 'Verify the tests pass', expect: 'coordinator' },
  { category: 'safe-read', message: 'Research detect candidates', expect: 'coordinator' },
  { category: 'safe-read', message: 'Summarize the latest research notes', expect: 'coordinator' },
  { category: 'safe-read', message: 'List the files in the project', expect: 'coordinator' },
  { category: 'safe-read', message: 'please check the logs', expect: 'coordinator' },
  { category: 'safe-read', message: 'Explain what the mi routing code does', expect: 'coordinator' },
  { category: 'safe-read', message: 'Find the failing test in the repo', expect: 'coordinator' },
  // “service” is one of the high-impact words, so even a read phrased around a
  // service asks first. That is deliberately fail-closed.
  { category: 'safe-read', message: 'Check if the web chat service is running', expect: 'confirm' },

  // Safe local write work: coordinator handoff with project write access.
  { category: 'safe-write', message: 'Fix the routing bug in the worker', expect: 'coordinator', write: true },
  { category: 'safe-write', message: 'Update the mi daemon config file', expect: 'coordinator', write: true },
  { category: 'safe-write', message: 'Add a test for the classifier', expect: 'coordinator', write: true },
  { category: 'safe-write', message: 'Implement the reminder feature in the app', expect: 'coordinator', write: true },
  { category: 'safe-write', message: 'Change the favicon', expect: 'coordinator', write: true },
  { category: 'safe-write', message: 'Improve the chat UI alignment', expect: 'coordinator', write: true },
  { category: 'safe-write', message: 'Tighten the routing rules', expect: 'coordinator', write: true },
  { category: 'safe-write', message: 'Wire the notification button', expect: 'coordinator', write: true },
  { category: 'safe-write', message: 'Create a test for the calendar sync', expect: 'coordinator', write: true },
  { category: 'safe-write', message: 'Make the icon centered', expect: 'coordinator', write: true },
  { category: 'safe-write', message: 'Build the project tests', expect: 'coordinator', write: true },
  { category: 'safe-write', message: 'Can you fix the daemon', expect: 'coordinator', write: false },
  // A write verb with no local target has nothing to act on yet.
  { category: 'safe-write', message: 'Patch the relay script', expect: 'clarify' },
  { category: 'safe-write', message: 'Make dinner reservations', expect: 'clarify' },

  // Advisor wording routes to the coordinator with named advisor lenses.
  { category: 'advisor', message: 'Ask Seth what he thinks about the pricing page', expect: 'coordinator', advisors: ['Seth'] },
  { category: 'advisor', message: 'What would Alex do about churn?', expect: 'coordinator', advisors: ['Alex'] },
  { category: 'advisor', message: 'What would Hormozi charge for this', expect: 'coordinator', advisors: ['Alex'] },
  { category: 'advisor', message: 'Ask the advisors about my offer', expect: 'coordinator', advisors: ['Seth', 'Alex'] },
  { category: 'advisor', message: 'Ask Seth and Alex about the landing page', expect: 'coordinator', advisors: ['Seth', 'Alex'] },
  { category: 'advisor', message: '/skill:advisor how should I price this', expect: 'coordinator', advisors: ['Seth', 'Alex'] },
  { category: 'advisor', message: 'Ask Terra to look at the funnel', expect: 'coordinator' },
  // “email list” contains a high-impact word, so it asks before consulting.
  { category: 'advisor', message: 'What would Seth say about my email list', expect: 'confirm' },

  // Follow-ups and references to earlier turns stay conversational.
  { category: 'followup', message: 'same as before', expect: 'coordinator' },
  { category: 'followup', message: 'that one', expect: 'coordinator' },
  { category: 'followup', message: 'also the other one', expect: 'coordinator' },
  { category: 'followup', message: 'again please', expect: 'coordinator' },
  { category: 'followup', message: 'one more thing', expect: 'coordinator' },
  { category: 'followup', message: 'and the second part?', expect: 'coordinator' },
  { category: 'followup', message: 'why did that take so long', expect: 'coordinator' },
  { category: 'followup', message: 'that answer was wrong', expect: 'coordinator' },
  { category: 'followup', message: 'still broken', expect: 'coordinator' },
  { category: 'followup', message: 'what happened with that task', expect: 'coordinator' },

  // Ambiguous imperatives must ask what to act on instead of guessing.
  { category: 'ambiguous-imperative', message: 'fix it', expect: 'clarify' },
  { category: 'ambiguous-imperative', message: 'do it', expect: 'clarify' },
  { category: 'ambiguous-imperative', message: 'handle that', expect: 'clarify' },
  { category: 'ambiguous-imperative', message: 'make it better', expect: 'clarify' },
  { category: 'ambiguous-imperative', message: 'clean that up', expect: 'clarify' },
  { category: 'ambiguous-imperative', message: 'fix', expect: 'clarify' },
  { category: 'ambiguous-imperative', message: 'update', expect: 'clarify' },
  { category: 'ambiguous-imperative', message: 'run it', expect: 'clarify' },
  { category: 'ambiguous-imperative', message: 'debug this', expect: 'clarify' },
  { category: 'ambiguous-imperative', message: 'improve it', expect: 'clarify' },
  // No action verb at all, so this is ordinary conversation.
  { category: 'ambiguous-imperative', message: 'just do the thing', expect: 'coordinator' },
  { category: 'ambiguous-imperative', message: 'take care of it', expect: 'coordinator' },

  // Communication, external, and high-impact actions require confirmation of
  // the exact objective before anything can run.
  { category: 'confirmation-required', message: "Send Kyle a message that I'll be late", expect: 'confirm' },
  { category: 'confirmation-required', message: 'Email the team the update', expect: 'confirm' },
  { category: 'confirmation-required', message: 'Post this on X', expect: 'confirm' },
  { category: 'confirmation-required', message: 'Schedule a tweet for tomorrow', expect: 'confirm' },
  { category: 'confirmation-required', message: 'Text mom happy birthday', expect: 'confirm' },
  { category: 'confirmation-required', message: 'DM Sarah the link', expect: 'confirm' },
  { category: 'confirmation-required', message: "Tell Sarah I'll call her back", expect: 'confirm' },
  { category: 'confirmation-required', message: 'Notify the team about the outage', expect: 'confirm' },
  { category: 'confirmation-required', message: 'Contact support about the refund', expect: 'confirm' },
  { category: 'confirmation-required', message: 'Forward that to my accountant', expect: 'confirm' },
  { category: 'confirmation-required', message: 'Share the doc with Kyle', expect: 'confirm' },
  { category: 'confirmation-required', message: 'Upload the file to the server', expect: 'confirm' },
  { category: 'confirmation-required', message: 'Deploy the site to production', expect: 'confirm' },
  { category: 'confirmation-required', message: 'Publish the release notes', expect: 'confirm' },
  { category: 'confirmation-required', message: 'Merge the PR', expect: 'confirm' },
  { category: 'confirmation-required', message: 'Restart the daemon', expect: 'confirm' },
  { category: 'confirmation-required', message: 'Install the new package', expect: 'confirm' },
  { category: 'confirmation-required', message: 'Run systemctl restart on the bridge', expect: 'confirm' },
  // Too long to store the exact objective for confirmation.
  { category: 'confirmation-required', message: `Send the whole team a message about ${'the quarterly rollout plan '.repeat(12)}`, expect: 'confirm-too-long' },

  // Actions Mi must never delegate from iMessage.
  { category: 'never-delegate', message: 'Delete the old logs', expect: 'never-delegate' },
  { category: 'never-delegate', message: 'Wipe the database', expect: 'never-delegate' },
  { category: 'never-delegate', message: 'Remove all project data', expect: 'never-delegate' },
  { category: 'never-delegate', message: 'rm the temp folder', expect: 'never-delegate' },
  { category: 'never-delegate', message: 'Purge the cache', expect: 'never-delegate' },
  { category: 'never-delegate', message: "What's my password for the router?", expect: 'never-delegate' },
  { category: 'never-delegate', message: 'Show me the API token', expect: 'never-delegate' },
  { category: 'never-delegate', message: 'Log in to my bank', expect: 'never-delegate' },
  { category: 'never-delegate', message: 'Buy me a new keyboard', expect: 'never-delegate' },
  { category: 'never-delegate', message: 'Pay the invoice', expect: 'never-delegate' },
  { category: 'never-delegate', message: 'Transfer money to savings', expect: 'never-delegate' },

  // Cancellations and confirmation commands.
  { category: 'cancel', message: 'cancel', expect: 'cancel' },
  { category: 'cancel', message: 'cancel that', expect: 'cancel' },
  { category: 'cancel', message: 'Cancel it.', expect: 'cancel' },
  { category: 'cancel', message: 'never mind', expect: 'cancel' },
  { category: 'cancel', message: 'nevermind', expect: 'cancel' },
  { category: 'cancel', message: "don't do it", expect: 'cancel' },
  { category: 'confirmation-command', message: 'confirm 0123456789abcdef0123456789abcdef', expect: 'confirmation-command' },
  { category: 'confirmation-command', message: 'deny 0123456789abcdef0123456789abcdef', expect: 'confirmation-command' },
  { category: 'confirmation-command', message: 'CONFIRM 0123456789ABCDEF0123456789ABCDEF', expect: 'confirmation-command' },

  // Malformed and empty-ish inputs still land on a deterministic reply.
  { category: 'malformed', message: '?', expect: 'clarify' },
  { category: 'malformed', message: '...', expect: 'clarify' },
  { category: 'malformed', message: '👍', expect: 'clarify' },
  { category: 'malformed', message: 'ok?', expect: 'coordinator' },
  { category: 'malformed', message: 'hm', expect: 'coordinator' },
  { category: 'malformed', message: 'wait', expect: 'coordinator' },
  { category: 'malformed', message: 'and?', expect: 'coordinator' },
  { category: 'malformed', message: 'asdkjhasd', expect: 'coordinator' },
  // A malformed confirmation id is not a confirmation command.
  { category: 'malformed', message: 'confirm abc', expect: 'coordinator' },
  { category: 'malformed', message: '', expect: 'clarify' },
  { category: 'malformed', message: '   ', expect: 'clarify' },
  { category: 'malformed', message: '\n\t', expect: 'clarify' },
];

const seen = new Set();
const categoryCounts = new Map();
const classCounts = new Map();
for (const testCase of corpus) {
  assert.ok(!seen.has(testCase.message), `corpus messages must be distinct: ${JSON.stringify(testCase.message)}`);
  seen.add(testCase.message);
  const decision = route(testCase.message);
  assert.equal(decision.kind, testCase.expect, `${testCase.category}: ${JSON.stringify(testCase.message)} -> ${decision.kind}, expected ${testCase.expect}`);
  if (decision.kind === 'local-reply') {
    assert.ok(decision.reply.length > 0, `local replies must be non-empty: ${testCase.message}`);
  }
  if (decision.kind === 'coordinator') {
    assert.ok(decision.plan, `coordinator handoff must carry a plan: ${testCase.message}`);
    if ('write' in testCase) {
      assert.equal(Boolean(decision.plan.allowWrite), testCase.write, `write access mismatch: ${testCase.message}`);
    } else {
      assert.equal(Boolean(decision.plan.allowWrite), false, `unspecified cases must not gain write access: ${testCase.message}`);
    }
    if (testCase.advisors) {
      assert.deepEqual(decision.plan.advisorSelections, testCase.advisors, `advisor selection mismatch: ${testCase.message}`);
    }
  }
  if (decision.kind === 'confirm') {
    assert.equal(decision.actionClass, 'confirmed-high-impact', `confirmations must be labeled: ${testCase.message}`);
    assert.ok(decision.objective.length > 0 && decision.objective.length <= limits.confirmationObjectiveMaxChars, `confirmation objective must be storable: ${testCase.message}`);
  }
  categoryCounts.set(testCase.category, (categoryCounts.get(testCase.category) || 0) + 1);
  classCounts.set(decision.kind, (classCounts.get(decision.kind) || 0) + 1);
}
assert.ok(corpus.length >= 100, `corpus must hold at least 100 cases, found ${corpus.length}`);

// Every response class the path can produce must be represented, including the
// no-workspace refusal that only appears without an approved workspace.
for (const [message, expected] of [
  ['Check the daemon logs for errors', 'workspace-refused'],
  ['Fix the routing bug in the worker', 'workspace-refused'],
  ['fix it', 'clarify'],
  ['Send Kyle a message', 'confirm'],
  ['Delete the old logs', 'never-delegate'],
]) {
  assert.equal(route(message, { workspace: undefined }).kind, expected, `no-workspace routing: ${message}`);
}

// Restart accounting regressions. state/web-workers.json retains completed
// coordinators for history and deduplication; after a restart they must not
// reserve global or per-thread capacity. Before this fix, four retained
// completed records exhausted the limit and every new iMessage was answered
// with “I’m already working on that conversation.”
const completedRecord = (id) => ({
  id: `coordinator_${id}`, threadId: 'main', coordinator: true, coordinatorReserved: true,
  status: 'complete', completedAt: new Date().toISOString(),
});
const capacity = createCoordinatorCapacity({ globalLimit: 4, threadLimit: 1 });
for (const id of ['a', 'b', 'c', 'd', 'e']) capacity.adopt(completedRecord(id));
assert.equal(capacity.activeCount, 0, 'completed coordinators must not consume global capacity after a restart');
assert.equal(capacity.threadCount('main'), 0, 'completed coordinators must not consume thread capacity after a restart');
assert.equal(capacity.reserve('main'), true, '“What can you do?” must still start a coordinator after a restart with completed records');

// A genuinely active coordinator still blocks a second request on that thread.
const activeCapacity = createCoordinatorCapacity({ globalLimit: 4, threadLimit: 1 });
const activeRecord = { id: 'coordinator_live', threadId: 'main', coordinator: true, status: 'running', createdAt: new Date().toISOString() };
assert.equal(activeCapacity.adopt(activeRecord), true, 'an active coordinator keeps its reservation across a restart');
assert.equal(activeRecord.coordinatorReserved, true, 'an adopted active coordinator is marked reserved');
assert.equal(activeCapacity.activeCount, 1, 'active coordinators consume global capacity');
assert.equal(activeCapacity.reserve('main'), false, 'a second same-thread request must be refused while a coordinator is active');
assert.equal(activeCapacity.reserve('other'), true, 'another thread is unaffected by the per-thread limit');

// Release semantics stay exact: one release per reservation and no drift.
assert.equal(activeCapacity.release(activeRecord), true, 'releasing a reserved coordinator succeeds');
assert.equal(activeRecord.coordinatorReserved, false, 'release clears the reservation flag');
assert.equal(activeCapacity.release(activeRecord), false, 'a second release must be a no-op');
assert.equal(activeCapacity.threadCount('main'), 0, 'release frees the thread slot');
assert.equal(activeCapacity.activeCount, 1, 'release must not free another thread’s slot');
assert.equal(activeCapacity.reserve('main'), true, 'the thread accepts new work after release');

// Marking a completed record unreserved must not decrement anything.
const mixedCapacity = createCoordinatorCapacity({ globalLimit: 4, threadLimit: 1 });
const staleRecord = completedRecord('stale');
mixedCapacity.adopt(staleRecord);
assert.equal(staleRecord.coordinatorReserved, false, 'adoption marks a completed record unreserved so release cannot drift');
assert.equal(mixedCapacity.release(staleRecord), false, 'a completed record has nothing to release');
assert.equal(mixedCapacity.activeCount, 0, 'accounting stays at zero for completed records');

console.log(`mi web chat corpus tests passed: ${corpus.length} cases`);
console.log(`categories (${categoryCounts.size}): ${[...categoryCounts].map(([name, count]) => `${name}=${count}`).join(', ')}`);
console.log(`response classes: ${[...classCounts].map(([name, count]) => `${name}=${count}`).join(', ')}`);
