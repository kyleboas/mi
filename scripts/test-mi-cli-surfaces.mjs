#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHermeticMiEnv, runCli, runCliAsync, startFakeDaemon, readJsonl } from './mi-test-harness.mjs';

const fixture = await createHermeticMiEnv('mi-cli-surfaces-');
let daemon;
try {
  const env = fixture.env;
  const cwd = fixture.root;

  let result = runCli(['help'], { env, cwd });
  assert.match(result.stdout, /Mi - tiny private assistant harness/);
  assert.match(result.stdout, /mi agents/);

  result = runCli(['definitely-not-a-command'], { env, cwd, check: false });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unknown command/);

  result = runCli(['--once', 'hi'], { env, cwd });
  assert.match(result.stdout, /Hello\./);

  result = runCli(['ask', '--thread', 'main', 'thanks'], { env, cwd });
  assert.match(result.stdout, /welcome|Got it|Hello/i);

  result = runCli(['inbox'], { env, cwd });
  assert.match(result.stdout, /Mi/);
  assert.match(result.stdout, /main/);

  result = runCli(['threads'], { env, cwd });
  assert.match(result.stdout, /main/);

  result = runCli(['temp'], { env, cwd });
  assert.match(result.stdout, /No temporary conversations/);

  result = runCli(['temp', 'Scratch Space'], { env, cwd, input: '/exit\n', timeout: 45000 });
  assert.match(result.stdout, /Mi \/ Scratch Space/);

  result = runCli(['chat', 'temp-scratch-space'], { env, cwd, input: '/exit\n', timeout: 45000 });
  assert.match(result.stdout, /Mi \/ Scratch Space/);

  result = runCli(['compact', 'main'], { env, cwd });
  assert.match(result.stdout, /Compacted/);

  result = runCli(['make', 'watch test fixtures', '--name', 'fixture'], { env, cwd });
  assert.match(result.stdout, /Created assistants\/fixture\.md/);

  result = runCli(['check', 'fixture'], { env, cwd });
  assert.match(result.stdout, /assistants\/fixture\.md: ok/);

  result = runCli(['run', 'fixture'], { env, cwd });
  assert.match(result.stdout, /fixture: ok/);

  result = runCli(['edit', 'fixture', 'mention concise reporting'], { env, cwd });
  assert.match(result.stdout, /Updated assistants\/fixture\.md/);
  assert.match(await readFile(join(cwd, 'assistants', 'fixture.md'), 'utf8'), /concise reporting/i);

  result = runCli(['logs', 'fixture', '10'], { env, cwd });
  assert.match(result.stdout, /fixture/);

  result = runCli(['cron', 'list'], { env, cwd });
  assert.match(result.stdout, /No Mi crons configured/);

  result = runCli(['cron', 'add', 'standup', '--every', '1m', '--message', 'stand up'], { env, cwd });
  assert.match(result.stdout, /Saved standup/);

  result = runCli(['cron', 'list'], { env, cwd });
  assert.match(result.stdout, /standup\s+enabled\s+every 1m/);

  result = runCli(['cron', 'check'], { env, cwd });
  assert.match(result.stdout, /standup: ok/);
  const mainMessages = await readJsonl(join(fixture.miRoot, 'state', 'threads', 'main.jsonl'));
  assert.ok(mainMessages.some((message) => message.source === 'mi-reminder' && message.text === 'stand up'), 'cron reminders append to main thread');

  result = runCli(['cron', 'add', 'too-fast', '--every', '1s', '--message', 'bad'], { env, cwd, check: false });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /at least 1m/);

  result = runCli(['cron', 'remove', 'standup'], { env, cwd });
  assert.match(result.stdout, /Removed standup/);

  daemon = await startFakeDaemon(env.MI_SOCKET_PATH, (request) => {
    if (request.type === 'list_tasks') return { tasks: [{ id: 'task-1', name: 'fixture task', status: 'running', startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }] };
    if (request.type === 'run_worker') return { text: 'Started fixture task', taskId: 'task-2', sessionFile: '/tmp/fixture.jsonl' };
    if (request.type === 'continue_worker') return { text: 'Continued fixture task', taskId: request.taskId };
    return { text: 'ok' };
  });

  result = await runCliAsync(['task', 'list'], { env, cwd, timeout: 45000 });
  assert.match(result.stdout, /fixture task/);

  result = await runCliAsync(['task', 'new-fixture', '--cwd', fixture.home, '--', 'inspect this fixture'], { env, cwd, timeout: 45000 });
  assert.match(result.stdout, /Started fixture task/);

  result = await runCliAsync(['task', 'reply', 'task-1', '--', 'continue fixture'], { env, cwd, timeout: 45000 });
  assert.match(result.stdout, /Continued fixture task/);

  assert.ok(daemon.requests.some((request) => request.type === 'list_tasks'), 'task list uses daemon list_tasks');
  assert.ok(daemon.requests.some((request) => request.type === 'run_worker' && request.name === 'new-fixture'), 'task creation uses daemon run_worker');
  assert.ok(daemon.requests.some((request) => request.type === 'continue_worker' && request.taskId === 'task-1'), 'task reply uses daemon continue_worker');

  await mkdir(join(fixture.miRoot, 'state'), { recursive: true });
  await writeFile(join(fixture.miRoot, 'state', 'events.jsonl'), '');

  console.log('mi CLI surface tests passed');
} finally {
  if (daemon) await daemon.close();
  await fixture.cleanup();
}
