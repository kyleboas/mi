#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = await mkdtemp(join(tmpdir(), 'mi-agent-render-'));
const tasksPath = join(root, 'tasks.json');

function iso(offsetMs = 0) {
  return new Date(Date.UTC(2026, 0, 1, 0, 0, 0) + offsetMs).toISOString();
}

const tasks = [];
for (let i = 1; i <= 8; i++) {
  tasks.push({
    id: `run-${i}`,
    name: `render-run-${String(i).padStart(2, '0')}`,
    status: 'running',
    progress: `working ${i}`,
    startedAt: iso(i * 1000),
    updatedAt: iso(i * 1000),
  });
}
tasks.push({ id: 'paused-1', name: 'render-paused-01', status: 'paused', needsUser: true, needsUserReason: 'stopped by Escape', progress: 'stopped', updatedAt: iso(9000) });
tasks.push({ id: 'done-1', name: 'render-done-01', status: 'complete', text: Array.from({ length: 12 }, (_, index) => `done line ${String(index + 1).padStart(2, '0')}`).join('\n'), finishedAt: iso(10000), updatedAt: iso(10000) });

try {
  await writeFile(tasksPath, JSON.stringify(tasks, null, 2));
  const result = spawnSync(process.execPath, ['node_modules/.bin/tsx', 'src/cli.ts', 'agents'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env,
      MI_AGENT_RENDER_TEST: '1',
      MI_AGENT_RENDER_TEST_TASKS: tasksPath,
      MI_AGENT_RENDER_TEST_EVENTS: 'pageDown,pageUp,escape,escape,add:render-added-01,pageDown',
      MI_AGENT_RENDER_TEST_ROWS: '20',
      MI_AGENT_RENDER_TEST_COLS: '80',
    },
    encoding: 'utf8',
    timeout: 60000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const snapshot = JSON.parse(result.stdout);
  assert.equal(snapshot.width, 80);
  assert.equal(snapshot.height, 20);
  assert.equal(snapshot.frames.length, 7);

  const stripAnsi = (text) => text
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b_[^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
  const visible = (frame) => frame.lines.map(stripAnsi);
  const taskRows = (frame) => visible(frame).filter((line) => /^\s*(?:→\s*)?[●○✓⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏ ]\s+render-/.test(line));
  const countTaskRows = (frame, name) => taskRows(frame).filter((line) => line.includes(name)).length;

  for (const frame of snapshot.frames) {
    assert.equal(frame.lines.length, 20, `${frame.event}: frame height changed`);
    for (const name of tasks.map((task) => task.name)) {
      assert.ok(countTaskRows(frame, name) <= 1, `${frame.event}: duplicated task row for ${name}`);
    }
  }

  const identityTasksPath = join(root, 'identity-tasks.json');
  await writeFile(identityTasksPath, JSON.stringify([
    { id: 'generic-a', name: 'user', sessionName: 'user', cwd: '/repo-a', status: 'complete', text: 'a', finishedAt: iso(14000), updatedAt: iso(14000) },
    { id: 'generic-b', name: 'user', sessionName: 'user', cwd: '/repo-b', status: 'complete', text: 'b', finishedAt: iso(15000), updatedAt: iso(15000) },
    { id: 'stored-duplicate', name: 'render-logical-duplicate', sessionName: 'render-logical-duplicate', cwd: '/repo-c', status: 'running', progress: 'stored copy', lastInput: 'same prompt', updatedAt: iso(16000) },
    { id: 'pi-session:logical-duplicate', source: 'pi-session', name: 'render-logical-duplicate', sessionName: 'render-logical-duplicate', cwd: '/repo-c', status: 'running', progress: 'session copy', lastInput: 'same prompt', sessionFile: '/tmp/logical-duplicate.jsonl', updatedAt: iso(17000) },
  ], null, 2));
  const identityResult = spawnSync(process.execPath, ['node_modules/.bin/tsx', 'src/cli.ts', 'agents'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env,
      MI_AGENT_RENDER_TEST: '1',
      MI_AGENT_RENDER_TEST_TASKS: identityTasksPath,
      MI_AGENT_RENDER_TEST_EVENTS: 'pageDown',
      MI_AGENT_RENDER_TEST_ROWS: '16',
      MI_AGENT_RENDER_TEST_COLS: '80',
    },
    encoding: 'utf8',
    timeout: 60000,
  });
  assert.equal(identityResult.status, 0, identityResult.stderr || identityResult.stdout);
  const identityInitial = JSON.parse(identityResult.stdout).frames[0];
  const identityRows = visible(identityInitial).filter((line) => /^\s*(?:→\s*)?[●○✓⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏ ]\s+/.test(line));
  assert.equal(identityRows.filter((line) => line.includes(' user ')).length, 2, 'generic same-name sessions in different cwd are not over-deduped');
  assert.equal(identityRows.filter((line) => line.includes('render-logical-duplicate')).length, 1, 'logical duplicate rows are merged before rendering');

  const workingSortTasksPath = join(root, 'working-sort-tasks.json');
  await writeFile(workingSortTasksPath, JSON.stringify([
    { id: 'needs-oldest-transition', name: 'render-needs-old', status: 'paused', needsUser: true, needsUserReason: 'needs reply', startedAt: iso(30000), updatedAt: iso(90000), notifiedNeedsUserAt: iso(30000) },
    { id: 'needs-newest-transition', name: 'render-needs-new', status: 'paused', needsUser: true, needsUserReason: 'needs reply', startedAt: iso(1000), updatedAt: iso(40000), notifiedNeedsUserAt: iso(50000) },
    { id: 'needs-middle-transition', name: 'render-needs-mid', status: 'paused', needsUser: true, needsUserReason: 'needs reply', startedAt: iso(20000), updatedAt: iso(100000), notifiedNeedsUserAt: iso(45000) },
    { id: 'working-oldest-start', name: 'render-work-old', status: 'running', startedAt: iso(10000), updatedAt: iso(70000) },
    { id: 'working-newest-start', name: 'render-work-new', status: 'running', startedAt: iso(30000), updatedAt: iso(31000) },
    { id: 'working-middle-start', name: 'render-work-mid', status: 'running', startedAt: iso(20000), updatedAt: iso(60000) },
    { id: 'completed-oldest-finish', name: 'render-done-old', status: 'complete', startedAt: iso(10000), updatedAt: iso(90000), finishedAt: iso(30000), text: 'old done' },
    { id: 'completed-newest-finish', name: 'render-done-new', status: 'complete', startedAt: iso(1000), updatedAt: iso(40000), finishedAt: iso(50000), text: 'new done' },
    { id: 'completed-middle-finish', name: 'render-done-mid', status: 'complete', startedAt: iso(20000), updatedAt: iso(100000), finishedAt: iso(45000), text: 'mid done' },
  ], null, 2));
  const workingSortResult = spawnSync(process.execPath, ['node_modules/.bin/tsx', 'src/cli.ts', 'agents'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env,
      MI_AGENT_RENDER_TEST: '1',
      MI_AGENT_RENDER_TEST_TASKS: workingSortTasksPath,
      MI_AGENT_RENDER_TEST_EVENTS: '',
      MI_AGENT_RENDER_TEST_ROWS: '26',
      MI_AGENT_RENDER_TEST_COLS: '80',
    },
    encoding: 'utf8',
    timeout: 60000,
  });
  assert.equal(workingSortResult.status, 0, workingSortResult.stderr || workingSortResult.stdout);
  const workingSortRows = taskRows(JSON.parse(workingSortResult.stdout).frames[0]);
  assert.ok(
    workingSortRows.findIndex((line) => line.includes('render-needs-new'))
      < workingSortRows.findIndex((line) => line.includes('render-needs-mid'))
      && workingSortRows.findIndex((line) => line.includes('render-needs-mid'))
      < workingSortRows.findIndex((line) => line.includes('render-needs-old')),
    'needs input section sorts newest needs-input transition at top and oldest at bottom, even when updatedAt differs',
  );
  assert.ok(
    workingSortRows.findIndex((line) => line.includes('render-work-new'))
      < workingSortRows.findIndex((line) => line.includes('render-work-mid'))
      && workingSortRows.findIndex((line) => line.includes('render-work-mid'))
      < workingSortRows.findIndex((line) => line.includes('render-work-old')),
    'working section sorts newest task start/continuation at top and oldest at bottom, even when updatedAt differs',
  );

  assert.ok(
    workingSortRows.findIndex((line) => line.includes('render-done-new'))
      < workingSortRows.findIndex((line) => line.includes('render-done-mid'))
      && workingSortRows.findIndex((line) => line.includes('render-done-mid'))
      < workingSortRows.findIndex((line) => line.includes('render-done-old')),
    'completed section sorts newest finish at top and oldest at bottom, even when updatedAt differs',
  );

  assert.equal(snapshot.frames[1].selectedTask, 'render-done-01', 'PageDown moves selection through task rows');
  const doneVisible = visible(snapshot.frames[1]).join('\n');
  assert.ok(doneVisible.includes('done line 01'), 'normal detail view shows the top of final output');
  assert.ok(!doneVisible.includes('done line 12'), 'normal detail view does not jump to the bottom of long final output');
  assert.equal(snapshot.frames[2].selectedTask, 'render-run-05', 'PageUp moves selection back through task rows');

  const firstEsc = snapshot.frames[3];
  assert.equal(firstEsc.event, 'escape');
  assert.equal(firstEsc.selectedTask, 'render-run-05');
  assert.match(firstEsc.status, /Stopped render-run-05; moved to needs input/, 'Esc pauses active tasks');
  assert.equal(countTaskRows(firstEsc, 'render-run-05'), 1, 'paused active task remains as one row');
  assert.ok(taskRows(firstEsc).find((line) => line.includes('render-run-05') && line.includes('stopped by Escape')), 'paused task row shows stopped state');

  const secondEsc = snapshot.frames[4];
  assert.equal(secondEsc.event, 'escape');
  assert.match(secondEsc.status, /Removed render-run-05 from list/, 'Esc clears needs-input tasks');
  assert.equal(countTaskRows(secondEsc, 'render-run-05'), 0, 'cleared task row is removed immediately');

  const added = snapshot.frames[5];
  assert.equal(countTaskRows(added, 'render-added-01'), 1, 'added task appears once');

  const fullTasksPath = join(root, 'full-output-tasks.json');
  const longOutput = Array.from({ length: 30 }, (_, index) => `full output line ${String(index + 1).padStart(2, '0')}`).join('\n');
  await writeFile(fullTasksPath, JSON.stringify([
    { id: 'full-1', name: 'render-full-output', status: 'complete', lastInput: 'last user input before output', text: longOutput, finishedAt: iso(11000), updatedAt: iso(11000) },
    { id: 'full-2', name: 'render-full-output-next', status: 'complete', lastInput: 'next input', text: 'next task output', finishedAt: iso(12000), updatedAt: iso(12000) },
  ], null, 2));
  const fullResult = spawnSync(process.execPath, ['node_modules/.bin/tsx', 'src/cli.ts', 'agents'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env,
      MI_AGENT_RENDER_TEST: '1',
      MI_AGENT_RENDER_TEST_TASKS: fullTasksPath,
      MI_AGENT_RENDER_TEST_EVENTS: 'ctrlL,pageDown,pageUp,text:reply text',
      MI_AGENT_RENDER_TEST_ROWS: '16',
      MI_AGENT_RENDER_TEST_COLS: '80',
    },
    encoding: 'utf8',
    timeout: 60000,
  });
  assert.equal(fullResult.status, 0, fullResult.stderr || fullResult.stdout);
  const fullSnapshot = JSON.parse(fullResult.stdout);
  const fullFrame = fullSnapshot.frames[1];
  const fullVisible = visible(fullFrame).join('\n');
  assert.equal(fullFrame.lines.length, 16, 'full output is bounded to the terminal viewport');
  assert.ok(visible(fullFrame)[0].includes('mi agents'), 'mi agents header is above full output');
  assert.ok(!fullVisible.includes('full output line 01'), 'oldest output is outside the initial tail viewport');
  assert.ok(fullVisible.includes('full output line 30'), 'latest output is present before the footer');
  const fullLines = visible(fullFrame);
  const finalOutputLines = fullLines.filter((line) => line.includes('full output line'));
  assert.ok(finalOutputLines.length > 0, 'full output lines are visible');
  assert.ok(finalOutputLines.every((line) => !line.startsWith(' ')), 'final output lines have no leading indentation');
  const lastInputLine = fullLines.findIndex((line) => line.includes('last user input before output'));
  const firstOutputLine = fullLines.findIndex((line) => line.includes('full output line'));
  assert.ok(firstOutputLine > lastInputLine + 1 && fullLines.slice(lastInputLine + 1, firstOutputLine).some((line) => line.trim() === ''), 'blank line separates last input from full output viewport');
  assert.ok(visible(fullFrame).at(-1)?.trim(), 'model/footer remains last so the visible screen lands at bottom');
  assert.equal(fullSnapshot.frames[2].selectedTask, 'render-full-output', 'PageDown stays on the selected task in full output mode');
  assert.ok(visible(fullSnapshot.frames[2]).join('\n').includes('full output line 30'), 'PageDown at bottom keeps latest task output visible');
  assert.equal(fullSnapshot.frames[3].selectedTask, 'render-full-output', 'PageUp scrolls inside the selected task output');
  const withInput = visible(fullSnapshot.frames[4]).join('\n');
  assert.ok(withInput.includes('reply text'), 'input remains visible and usable in full output mode');

  const jumpTasksPath = join(root, 'jump-tasks.json');
  const jumpReloadPath = join(root, 'jump-tasks-reload.json');
  await writeFile(jumpTasksPath, JSON.stringify([
    { id: 'jump-a', name: 'render-jump-a', status: 'running', startedAt: iso(1000), updatedAt: iso(1000) },
    { id: 'jump-b', name: 'render-jump-b', status: 'running', startedAt: iso(2000), updatedAt: iso(2000) },
    { id: 'jump-c', name: 'render-jump-c', status: 'running', startedAt: iso(3000), updatedAt: iso(3000) },
  ], null, 2));
  await writeFile(jumpReloadPath, JSON.stringify([
    { id: 'jump-c', name: 'render-jump-c', status: 'running', startedAt: iso(3000), updatedAt: iso(9000) },
    { id: 'jump-a', name: 'render-jump-a', status: 'running', startedAt: iso(1000), updatedAt: iso(8000) },
    { id: 'jump-b', name: 'render-jump-b', status: 'running', startedAt: iso(2000), updatedAt: iso(7000) },
  ], null, 2));
  const jumpResult = spawnSync(process.execPath, ['node_modules/.bin/tsx', 'src/cli.ts', 'agents'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env,
      MI_AGENT_RENDER_TEST: '1',
      MI_AGENT_RENDER_TEST_TASKS: jumpTasksPath,
      MI_AGENT_RENDER_TEST_EVENTS: `down,reload:${jumpReloadPath},down`,
      MI_AGENT_RENDER_TEST_ROWS: '14',
      MI_AGENT_RENDER_TEST_COLS: '80',
    },
    encoding: 'utf8',
    timeout: 60000,
  });
  assert.equal(jumpResult.status, 0, jumpResult.stderr || jumpResult.stdout);
  const jumpFrames = JSON.parse(jumpResult.stdout).frames;
  assert.equal(jumpFrames[1].selectedTask, 'render-jump-b', 'first Down selects the second visible task');
  assert.equal(jumpFrames[2].selectedTask, 'render-jump-b', 'refresh/reorder preserves the selected logical task');
  assert.equal(jumpFrames[3].selectedTask, 'render-jump-c', 'next Down moves to the next stable visible task, not a refreshed random neighbor');

  const longActivitySessionPath = join(root, 'long-activity-session.jsonl');
  await writeFile(longActivitySessionPath, `${JSON.stringify({
    type: 'message',
    message: {
      role: 'assistant',
      content: [{
        type: 'toolCall',
        name: 'bash',
        arguments: {
          command: "python - <<'PY'\nprint('this is a long activity command that used to leak a newline into one rendered TUI row and push following rows down')\nPY",
        },
      }],
    },
  })}\n`);
  const longActivityTasksPath = join(root, 'long-activity-tasks.json');
  await writeFile(longActivityTasksPath, JSON.stringify([
    { id: 'long-activity-1', name: 'render-long-activity', status: 'running', sessionFile: longActivitySessionPath, progress: 'working', updatedAt: iso(12500) },
  ], null, 2));
  const longActivityResult = spawnSync(process.execPath, ['node_modules/.bin/tsx', 'src/cli.ts', 'agents'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env,
      MI_AGENT_RENDER_TEST: '1',
      MI_AGENT_RENDER_TEST_TASKS: longActivityTasksPath,
      MI_AGENT_RENDER_TEST_EVENTS: '',
      MI_AGENT_RENDER_TEST_ROWS: '12',
      MI_AGENT_RENDER_TEST_COLS: '60',
    },
    encoding: 'utf8',
    timeout: 60000,
  });
  assert.equal(longActivityResult.status, 0, longActivityResult.stderr || longActivityResult.stdout);
  const longActivityFrame = JSON.parse(longActivityResult.stdout).frames[0];
  assert.ok(visible(longActivityFrame).some((line) => line.includes('running: python')), 'fixture renders the long activity line');
  const physicalLongActivityRows = visible(longActivityFrame).flatMap((line) => line.split(/\r?\n/));
  assert.equal(
    physicalLongActivityRows.length,
    longActivityFrame.lines.length,
    'rendered mi agents lines must not contain embedded newlines because they shift following terminal rows',
  );

  const pasteTasksPath = join(root, 'paste-tasks.json');
  await writeFile(pasteTasksPath, JSON.stringify([
    { id: 'paste-1', name: 'render-paste-target', status: 'paused', needsUser: true, needsUserReason: 'needs reply', progress: 'waiting', updatedAt: iso(13000) },
  ], null, 2));
  const pasteResult = spawnSync(process.execPath, ['node_modules/.bin/tsx', 'src/cli.ts', 'agents'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env,
      MI_AGENT_RENDER_TEST: '1',
      MI_AGENT_RENDER_TEST_TASKS: pasteTasksPath,
      MI_AGENT_RENDER_TEST_EVENTS: 'paste:first line\\nsecond line',
      MI_AGENT_RENDER_TEST_ROWS: '14',
      MI_AGENT_RENDER_TEST_COLS: '80',
    },
    encoding: 'utf8',
    timeout: 60000,
  });
  assert.equal(pasteResult.status, 0, pasteResult.stderr || pasteResult.stdout);
  const pasteSnapshot = JSON.parse(pasteResult.stdout);
  const pasteFrame = pasteSnapshot.frames[1];
  const pasteVisible = visible(pasteFrame).join('\n');
  assert.equal(pasteFrame.inputMode, 'reply', 'multiline paste starts a reply instead of submitting');
  assert.match(pasteFrame.status, /Reply to render-paste-target/);
  assert.ok(pasteVisible.includes('first line'), 'first pasted line remains in input');
  assert.ok(pasteVisible.includes('second line'), 'second pasted line remains in input');

  console.log('Mi agent render snapshot checks passed.');
} finally {
  await rm(root, { recursive: true, force: true });
}
