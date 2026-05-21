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

function assertNotMatches(regex, message) {
  if (regex.test(source)) throw new Error(message);
}

assertNotMatches(/appendMainThreadMessage\(`Task (started|updated|paused|needs)/, 'Background task status changes must not be posted into the main Mi thread.');
assertNotMatches(/appendMainThreadMessage\(`\$\{kind\} failed:/, 'Background task failures must stay in task state/resume, not main Mi thread.');
assertNotMatches(/mi-task-status/, 'Background task status messages must not use main-thread task status notifications.');
assertIncludes('notifiedNeedsUserAt', 'Task state should still record needs-user transitions without posting messages.');
assertIncludes('notifiedPausedAt', 'Task state should still record paused transitions without posting messages.');
assertCliIncludes("sendTaskSocketRequest({ type: 'run_worker', name, cwd, message, background: true }", 'New Mi task workers must use the raw task name as the session name so /resume shows only <task>.');
assertCliNotIncludes("name: `Mi task: ${name}`", 'New Mi task workers must not prefix session names with "Mi task:".');
assertNotMatches(/deliverTaskMessage\(`Mi task complete:/, 'Background task completions must stay in task state/resume, not be posted into the main Mi thread.');
assertIncludes('const activeWorkers = new Map();', 'Mi daemon must track active task workers so follow-ups can queue into the running session.');
if (!/activeWorker[\s\S]*streamingBehavior: isSlashCommand\(message\) \? undefined : "steer"[\s\S]*Queued message for background task/.test(source)) {
  throw new Error('Mi task replies to running workers must use pi normal queued-message behavior (Enter while streaming = steer) instead of opening a competing session.');
}
assertIncludes('function trackActiveWorker(task, fallbackName, worker)', 'Mi daemon must track both newly-started and continued background workers while they are active.');
if (!/if \(cron\.message && !cron\.command\) \{[\s\S]*appendThreadMessage\('main', 'assistant', cron\.message, \{ unread: true, source: 'mi-reminder' \}\)[\s\S]*notify\('Mi reminder', cron\.message\)\.catch\(\(\) => \(\{ skipped: true \}\)\)[\s\S]*status: 'ok'/.test(cronSource)) {
  throw new Error('Reminder-only crons must append an unread assistant message to the main Mi thread and still attempt external notification without failing the cron when notify fails.');
}

console.log('Mi task notification behavior checks passed.');
