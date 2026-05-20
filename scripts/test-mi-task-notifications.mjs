#!/usr/bin/env node
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../pi/extensions/mi-daemon.mjs', import.meta.url), 'utf8');
const cliSource = await readFile(new URL('../src/cli.ts', import.meta.url), 'utf8');
const cronSource = await readFile(new URL('../src/crons.ts', import.meta.url), 'utf8');

function assertCliIncludes(needle, message) {
  if (!cliSource.includes(needle)) throw new Error(message);
}

function assertCliNotIncludes(needle, message) {
  if (cliSource.includes(needle)) throw new Error(message);
}

function assertIncludes(needle, message) {
  if (!source.includes(needle)) throw new Error(message);
}

function assertMatches(regex, message) {
  if (!regex.test(source)) throw new Error(message);
}

assertIncludes('async function deliverTaskMessage(title, text)', 'Mi daemon must have a task delivery path.');
assertMatches(/async function deliverTaskMessage[\s\S]*appendMainThreadMessage\(text\)[\s\S]*sendPushover\(title, text\)/, 'Task delivery must append to the main Mi thread and attempt push notification.');
assertMatches(/unread: true[\s\S]*source: "mi-task"/, 'Task messages must be unread Mi task messages in the main thread.');
if (/appendMainThreadMessage\(`\$\{kind\}: \$\{name\}/.test(source) || /deliverTaskMessage\(`Mi task complete:/.test(source)) {
  throw new Error('Background task completions must stay in task state/resume, not be posted into the main Mi thread.');
}
assertMatches(/done\.then\([\s\S]*catch\(async \(error\)[\s\S]*status: "error"[\s\S]*deliverTaskMessage\(`Mi task failed:/, 'Background task errors must be surfaced to the user immediately after being recorded.');
assertMatches(/continueWorker[\s\S]*catch\(async \(error\)[\s\S]*status: "error"[\s\S]*deliverTaskMessage\(`Mi task failed:/, 'Background task follow-up errors must be surfaced to the user immediately after being recorded.');
assertIncludes('safeNotificationText', 'Task notifications must sanitize obvious secrets before push delivery.');
assertCliIncludes("const payload = { type: 'run_worker', name, cwd, message, background: true };", 'New Mi task workers must use the raw task name as the session name so /resume shows only <task>.');
assertCliNotIncludes("name: `Mi task: ${name}`", 'New Mi task workers must not prefix session names with "Mi task:".');
assertMatches(/entry\.name === `Mi task: \$\{taskId\}`/, 'Existing prefixed Mi task records must remain addressable by unprefixed task id/name.');
assertIncludes('const activeWorkers = new Map();', 'Mi daemon must track active task workers so follow-ups can queue into the running session.');
assertMatches(/activeWorker[\s\S]*streamingBehavior: "steer"[\s\S]*Queued message for background task/, 'Mi task replies to running workers must use pi normal queued-message behavior (Enter while streaming = steer) instead of opening a competing session.');
assertIncludes('function trackActiveWorker(task, fallbackName, worker)', 'Mi daemon must track both newly-started and continued background workers while they are active.');
if (!/if \(cron\.message && !cron\.command\) \{[\s\S]*appendThreadMessage\('main', 'assistant', cron\.message, \{ unread: true, source: 'mi-reminder' \}\)[\s\S]*notify\('Mi reminder', cron\.message\)\.catch\(\(\) => \(\{ skipped: true \}\)\)[\s\S]*status: 'ok'/.test(cronSource)) {
  throw new Error('Reminder-only crons must append an unread assistant message to the main Mi thread and still attempt external notification without failing the cron when notify fails.');
}

if (!/function isActiveTask[\s\S]*task\.finishedAt[\s\S]*complete[\s\S]*completed[\s\S]*done[\s\S]*error[\s\S]*\['running', 'waiting', 'active'\]\.includes\(status\)/.test(cliSource)) {
  throw new Error('Mi TUI status-bar task list must exclude completed/terminal tasks and only show active tasks.');
}

console.log('Mi task notification behavior checks passed.');
