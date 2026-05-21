#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = await mkdtemp(join(tmpdir(), 'mi-main-queue-render-'));

const stripAnsi = (text) => text
  .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
  .replace(/\x1b_[^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
  .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');

try {
  const result = spawnSync(process.execPath, ['node_modules/.bin/tsx', 'src/cli.ts', 'ui'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env,
      HOME: root,
      MI_TUI_RENDER_TEST: '1',
      MI_TUI_RENDER_TEST_ROWS: '12',
      MI_TUI_RENDER_TEST_COLS: '60',
      MI_TUI_RENDER_TEST_PENDING: '1',
      MI_TUI_RENDER_TEST_QUEUE: 'first queued message\nsecond queued message',
    },
    encoding: 'utf8',
    timeout: 60000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const snapshot = JSON.parse(result.stdout);
  const visible = snapshot.lines.map(stripAnsi);
  const statusIndex = visible.findIndex((line) => line.includes('openai-codex/gpt-5.5'));
  const headingIndex = visible.findIndex((line) => line.includes('Steering messages:'));
  const firstIndex = visible.findIndex((line) => line.includes('• first queued message'));
  const secondIndex = visible.findIndex((line) => line.includes('• second queued message'));
  const escapeHintIndex = visible.findIndex((line) => line.includes('Esc to cancel and edit'));

  assert.ok(statusIndex >= 0, 'Mi status/model bar is rendered');
  assert.ok(headingIndex > statusIndex, 'steering-message list appears below the status bar');
  assert.equal(firstIndex, headingIndex + 1, 'first queued message is a list item under the heading');
  assert.equal(secondIndex, headingIndex + 2, 'second queued message is a list item under the first');
  assert.equal(escapeHintIndex, headingIndex + 3, 'escape hint appears under the queued steering list');
  assert.ok(!visible[statusIndex].includes('q2'), 'queued count is not hidden in the status bar instead of the list');

  const escapeResult = spawnSync(process.execPath, ['node_modules/.bin/tsx', 'src/cli.ts', 'ui'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env,
      HOME: root,
      MI_TUI_RENDER_TEST: '1',
      MI_TUI_RENDER_TEST_ROWS: '12',
      MI_TUI_RENDER_TEST_COLS: '60',
      MI_TUI_RENDER_TEST_PENDING: '1',
      MI_TUI_RENDER_TEST_QUEUE: 'first queued message\nsecond queued message',
      MI_TUI_RENDER_TEST_EVENT: 'escape',
    },
    encoding: 'utf8',
    timeout: 60000,
  });
  assert.equal(escapeResult.status, 0, escapeResult.stderr || escapeResult.stdout);
  const escapeSnapshot = JSON.parse(escapeResult.stdout);
  assert.equal(escapeSnapshot.queueLength, 0, 'Esc removes queued steering so it will not send');
  assert.equal(escapeSnapshot.input, 'first queued message\n\nsecond queued message', 'Esc restores queued steering to the editor for editing');
  assert.ok(
    !escapeSnapshot.lines.map(stripAnsi).some((line) => line.includes('Steering messages:')),
    'Esc hides the queued steering list after restoring it to the editor',
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
