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
  const normalizeVisual = (text) => stripAnsi(text)
    .replace(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/g, '●')
    .replace(/\b\d+s\b/g, '<time>')
    .replace(/\b\d+m\b/g, '<time>')
    .replace(/\b\d+h\b/g, '<time>')
    .replace(/\b\d+d\b/g, '<time>');
  const visible = (frame) => frame.lines.map(normalizeVisual);
  const taskRows = (frame) => visible(frame).filter((line) => /^\s*(?:→\s*)?[●○✓ ]\s+render-/.test(line));
  const countTaskRows = (frame, name) => taskRows(frame).filter((line) => line.includes(name)).length;
  const rowIndex = (frame, name) => taskRows(frame).findIndex((line) => line.includes(name));
  const assertVisibleOnce = (frame, names, message = frame.event) => {
    for (const name of names) assert.equal(countTaskRows(frame, name), 1, `${message}: ${name} should appear exactly once`);
  };
  const assertBefore = (frame, first, second, message) => {
    assert.ok(rowIndex(frame, first) >= 0, `${message}: missing ${first}`);
    assert.ok(rowIndex(frame, second) >= 0, `${message}: missing ${second}`);
    assert.ok(rowIndex(frame, first) < rowIndex(frame, second), message);
  };
  const runRender = (fixture, events = '', options = {}) => {
    const result = spawnSync(process.execPath, ['node_modules/.bin/tsx', 'src/cli.ts', 'agents'], {
      cwd: new URL('..', import.meta.url),
      env: {
        ...process.env,
        MI_AGENT_RENDER_TEST: '1',
        MI_AGENT_RENDER_TEST_TASKS: fixture,
        MI_AGENT_RENDER_TEST_EVENTS: events,
        MI_AGENT_RENDER_TEST_ROWS: String(options.rows || 20),
        MI_AGENT_RENDER_TEST_COLS: String(options.cols || 80),
        MI_AGENT_RENDER_TEST_NOW: options.now || iso(120000),
        ...(options.env || {}),
      },
      encoding: 'utf8',
      timeout: 60000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return JSON.parse(result.stdout);
  };

  const shortcutTasksPath = join(root, 'shortcut-tasks.json');
  await writeFile(shortcutTasksPath, JSON.stringify([
    { id: 'shortcut-a', name: 'render-shortcut-a', status: 'complete', text: 'shortcut output A', finishedAt: iso(21000), updatedAt: iso(21000) },
    { id: 'shortcut-b', name: 'render-shortcut-b', status: 'complete', text: 'shortcut output B', finishedAt: iso(22000), updatedAt: iso(22000) },
  ], null, 2));
  const shortcutSnapshot = runRender(shortcutTasksPath, 'ctrlF,ctrlF,ctrlM,space,down,space,escape', { rows: 14, cols: 80 });
  assert.match(shortcutSnapshot.frames[1].status, /Full output/, '^F enters full-output mode');
  assert.match(visible(shortcutSnapshot.frames[1]).join('\n'), /shortcut output B/, '^F shows selected task output');
  assert.doesNotMatch(shortcutSnapshot.frames[2].status, /Full output/, 'second ^F exits full-output mode');
  assert.match(shortcutSnapshot.frames[3].status, /0 selected/, '^M enters multi-select mode');
  assert.match(shortcutSnapshot.frames[4].status, /1 selected/, 'space selects a task in multi-select mode');
  assert.match(shortcutSnapshot.frames[6].status, /2 selected/, 'multi-select can select more than one task');
  assert.match(shortcutSnapshot.frames[7].status, /Removed 2 tasks from list/, 'Esc bulk-clears selected tasks');
  assert.equal(taskRows(shortcutSnapshot.frames[7]).filter((line) => line.includes('render-shortcut-')).length, 0, 'bulk-cleared tasks disappear immediately');

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
    workingSortRows.findIndex((line) => line.includes('render-work-old'))
      < workingSortRows.findIndex((line) => line.includes('render-work-mid'))
      && workingSortRows.findIndex((line) => line.includes('render-work-mid'))
      < workingSortRows.findIndex((line) => line.includes('render-work-new')),
    'working section sorts newest start/continuation/activity at top and oldest at bottom',
  );

  assert.ok(
    workingSortRows.findIndex((line) => line.includes('render-done-new'))
      < workingSortRows.findIndex((line) => line.includes('render-done-mid'))
      && workingSortRows.findIndex((line) => line.includes('render-done-mid'))
      < workingSortRows.findIndex((line) => line.includes('render-done-old')),
    'completed section sorts newest finish at top and oldest at bottom, even when updatedAt differs',
  );

  assert.equal(snapshot.frames[1].selectedTask, 'render-run-04', 'PageDown moves selection through task rows');
  assert.equal(snapshot.frames[2].selectedTask, 'render-paused-01', 'PageUp moves selection back through task rows');

  const firstEsc = snapshot.frames[3];
  assert.equal(firstEsc.event, 'escape');
  assert.equal(firstEsc.selectedTask, 'render-done-01');
  assert.match(firstEsc.status, /Removed render-paused-01 from list/, 'Esc clears already paused tasks from the view');
  assert.equal(countTaskRows(firstEsc, 'render-paused-01'), 0, 'cleared paused task is removed from the view');

  const secondEsc = snapshot.frames[4];
  assert.equal(secondEsc.event, 'escape');
  assert.equal(secondEsc.selectedTask, 'render-run-08');
  assert.match(secondEsc.status, /Removed render-done-01 from list/, 'Esc clears terminal tasks');
  assert.equal(countTaskRows(secondEsc, 'render-done-01'), 0, 'cleared task row is removed immediately');

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
  assert.ok(fullFrame.lines.length > 0, 'full output renders for native terminal scrollback');
  assert.ok(visible(fullFrame)[0].includes('mi agents'), 'mi agents header is above full output');
  assert.ok(fullVisible.includes('next task output'), 'initial full output shows the selected task output');
  const fullLines = visible(fullFrame);
  const lastInputLine = fullLines.findIndex((line) => line.includes('next input'));
  const firstOutputLine = fullLines.findIndex((line) => line.includes('next task output'));
  assert.ok(firstOutputLine > lastInputLine + 1 && fullLines.slice(lastInputLine + 1, firstOutputLine).some((line) => line.trim() === ''), 'blank line separates last input from full output viewport');
  assert.ok(visible(fullFrame).at(-1)?.trim(), 'model/footer remains last so the visible screen lands at bottom');
  assert.equal(fullSnapshot.frames[2].selectedTask, 'render-full-output-next', 'PageDown at the end keeps the selected task in full output mode');
  assert.ok(visible(fullSnapshot.frames[2]).join('\n').includes('next task output'), 'PageDown keeps the selected task output visible');
  assert.equal(fullSnapshot.frames[3].selectedTask, 'render-full-output', 'PageUp switches to the previous task output');
  const previousFullOutput = visible(fullSnapshot.frames[3]).join('\n');
  assert.ok(previousFullOutput.includes('full output line 30'), 'PageUp shows the previous task full output');
  assert.ok(visible(fullSnapshot.frames[3]).filter((line) => line.includes('full output line')).every((line) => !line.startsWith(' ')), 'final output lines have no leading indentation');
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
      MI_AGENT_RENDER_TEST_EVENTS: `down,reload:${jumpReloadPath},up`,
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
  assert.equal(jumpFrames[3].selectedTask, 'render-jump-a', 'next Up follows the refreshed newest-first visible section order after preserving the selected logical task');

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

  const stoppedSessionPath = join(root, 'stopped-session.jsonl');
  await writeFile(stoppedSessionPath, [
    JSON.stringify({ type: 'message', message: { role: 'user', content: 'please do work' } }),
    JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'hidden-ish thinking' }] } }),
    JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'call', name: 'bash', arguments: { command: 'echo random-bash-final-area' } }] } }),
    '',
  ].join('\n'));
  const stoppedNotice = 'Pi session is no longer running and no final assistant response was recorded. Last prompt: please do work. Next: reply to this task with whether to continue, revise, or mark it done based on the session state.';
  const stoppedTasksPath = join(root, 'stopped-pi-tasks.json');
  await writeFile(stoppedTasksPath, JSON.stringify([
    { id: 'pi-session:stopped-no-final', source: 'pi-session', name: 'render-stopped-no-final', status: 'paused', needsUser: true, needsUserReason: stoppedNotice, sessionFile: stoppedSessionPath, progress: 'bash', updatedAt: iso(12900) },
    { id: 'pi-session:legacy-thinking', source: 'pi-session', name: 'render-legacy-thinking', status: 'paused', needsUser: true, needsUserReason: 'needs input', sessionFile: stoppedSessionPath, progress: 'thinking', updatedAt: iso(12800) },
    { id: 'pi-session:legacy-shell', source: 'pi-session', name: 'render-legacy-shell', status: 'paused', needsUser: true, needsUserReason: 'needs input', sessionFile: stoppedSessionPath, progress: 'running shell command', updatedAt: iso(12700) },
  ], null, 2));
  const stoppedResult = spawnSync(process.execPath, ['node_modules/.bin/tsx', 'src/cli.ts', 'agents'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env,
      MI_AGENT_RENDER_TEST: '1',
      MI_AGENT_RENDER_TEST_TASKS: stoppedTasksPath,
      MI_AGENT_RENDER_TEST_EVENTS: 'ctrlL',
      MI_AGENT_RENDER_TEST_ROWS: '14',
      MI_AGENT_RENDER_TEST_COLS: '100',
    },
    encoding: 'utf8',
    timeout: 60000,
  });
  assert.equal(stoppedResult.status, 0, stoppedResult.stderr || stoppedResult.stdout);
  const stoppedFrames = JSON.parse(stoppedResult.stdout).frames;
  const stoppedCollapsed = visible(stoppedFrames[0]).join('\n');
  assert.ok(stoppedCollapsed.includes('Pi session is no longer running'), 'collapsed stopped-session view shows the actionable notice');
  assert.ok(!stoppedCollapsed.includes('needs input: Pi session is no longer running') || !stoppedCollapsed.includes(' — bash'), 'collapsed stopped-session row does not append random bash progress');
  assert.doesNotMatch(stoppedCollapsed, /random-bash-final-area|hidden-ish thinking/, 'collapsed stopped-session view does not leak non-final session activity');
  const stoppedFull = visible(stoppedFrames[1]).join('\n');
  assert.ok(stoppedFull.includes('Pi session is no longer running'), 'full stopped-session output shows the actionable notice');
  assert.doesNotMatch(stoppedFull, /random-bash-final-area|hidden-ish thinking|^bash$/m, 'full stopped-session output does not show random bash/thinking as final output');

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

  const visualContractPath = join(root, 'visual-contract-tasks.json');
  const visualContractReloadPath = join(root, 'visual-contract-reload.json');
  await writeFile(visualContractPath, JSON.stringify([
    { id: 'needs-old', name: 'render-needs-old-ct', status: 'paused', needsUser: true, needsUserReason: 'old needs input', notifiedNeedsUserAt: iso(1000), updatedAt: iso(9000) },
    { id: 'needs-new', name: 'render-needs-new-ct', status: 'paused', needsUser: true, needsUserReason: 'new needs input', notifiedNeedsUserAt: iso(3000), updatedAt: iso(7000) },
    { id: 'work-old', name: 'render-work-old-ct', status: 'running', startedAt: iso(1000), updatedAt: iso(8000) },
    { id: 'work-new', name: 'render-work-new-ct', status: 'running', startedAt: iso(3000), updatedAt: iso(9000) },
    { id: 'done-old', name: 'render-done-old-ct', status: 'complete', finishedAt: iso(1000), updatedAt: iso(11000), text: 'old done' },
    { id: 'done-new', name: 'render-done-new-ct', status: 'complete', finishedAt: iso(3000), updatedAt: iso(5000), text: 'new done' },
  ], null, 2));
  await writeFile(visualContractReloadPath, JSON.stringify([
    { id: 'work-old', name: 'render-work-old-ct', status: 'running', startedAt: iso(1000), continuedAt: iso(7000), updatedAt: iso(7000) },
    { id: 'work-new', name: 'render-work-new-ct', status: 'paused', needsUser: true, needsUserReason: 'now needs input', notifiedNeedsUserAt: iso(9000), startedAt: iso(3000), updatedAt: iso(9000) },
    { id: 'needs-old', name: 'render-needs-old-ct', status: 'complete', finishedAt: iso(10000), updatedAt: iso(10000), text: 'completed after reply' },
    { id: 'needs-new', name: 'render-needs-new-ct', status: 'paused', needsUser: true, needsUserReason: 'still needs input', notifiedNeedsUserAt: iso(3000), updatedAt: iso(9500) },
    { id: 'done-old', name: 'render-done-old-ct', status: 'complete', finishedAt: iso(1000), updatedAt: iso(11000), text: 'old done' },
    { id: 'done-new', name: 'render-done-new-ct', status: 'complete', finishedAt: iso(3000), updatedAt: iso(5000), text: 'new done' },
    { id: 'work-added', name: 'render-work-added-ct', status: 'running', startedAt: iso(11000), updatedAt: iso(11000) },
  ], null, 2));
  const visualContract = runRender(visualContractPath, `reload:${visualContractReloadPath}`, { rows: 24, now: iso(120000) });
  const contractInitial = visualContract.frames[0];
  assertVisibleOnce(contractInitial, ['render-needs-new-ct', 'render-needs-old-ct', 'render-work-new-ct', 'render-work-old-ct', 'render-done-new-ct', 'render-done-old-ct'], 'initial visual contract');
  assertBefore(contractInitial, 'render-needs-new-ct', 'render-needs-old-ct', 'needs-input section is newest to oldest');
  assertBefore(contractInitial, 'render-work-new-ct', 'render-work-old-ct', 'working section is newest to oldest');
  assertBefore(contractInitial, 'render-done-new-ct', 'render-done-old-ct', 'completed section is newest to oldest');
  const contractReload = visualContract.frames[1];
  assertVisibleOnce(contractReload, ['render-work-new-ct', 'render-needs-new-ct', 'render-work-added-ct', 'render-work-old-ct', 'render-needs-old-ct'], 'reload visual contract');
  assertBefore(contractReload, 'render-work-new-ct', 'render-needs-new-ct', 'task entering needs-input appears at top of needs-input section');
  assertBefore(contractReload, 'render-work-added-ct', 'render-work-old-ct', 'newest working task appears before older working task after reload');
  assertBefore(contractReload, 'render-needs-old-ct', 'render-done-new-ct', 'newest completed task appears before older completed task after section move');

  const completedCapPath = join(root, 'completed-cap-tasks.json');
  await writeFile(completedCapPath, JSON.stringify(Array.from({ length: 5 }, (_, index) => ({
    id: `cap-${index + 1}`,
    name: `render-done-cap-${index + 1}`,
    status: 'complete',
    finishedAt: iso((index + 1) * 1000),
    updatedAt: iso((index + 1) * 1000),
    text: `done ${index + 1}`,
  })), null, 2));
  const completedCap = runRender(completedCapPath, '', { rows: 18 });
  const capRows = taskRows(completedCap.frames[0]).filter((line) => line.includes('render-done-cap-'));
  assert.equal(capRows.length, 5, 'when selected section is completed, completed rows are not capped as disappearance');
  assertBefore(completedCap.frames[0], 'render-done-cap-5', 'render-done-cap-4', 'completed cap fixture remains newest first');

  const optimisticPath = join(root, 'optimistic-tasks.json');
  const optimisticReloadPath = join(root, 'optimistic-reload.json');
  await writeFile(optimisticPath, JSON.stringify([
    { id: 'pending_same', name: 'render-optimistic-agent', status: 'queued', progress: '/new do it', lastInput: '/new do it', startedAt: iso(1000), updatedAt: iso(1000) },
  ], null, 2));
  await writeFile(optimisticReloadPath, JSON.stringify([
    { id: 'real_same', name: 'render-optimistic-agent', sessionName: 'render-optimistic-agent', status: 'running', progress: 'real daemon row', lastInput: '/new do it', startedAt: iso(1000), updatedAt: iso(3000) },
  ], null, 2));
  const optimistic = runRender(optimisticPath, `reload:${optimisticReloadPath}`, { rows: 14 });
  assert.equal(countTaskRows(optimistic.frames[1], 'render-optimistic-agent'), 1, 'optimistic pending row is replaced by daemon row instead of disappearing or duplicating');
  assert.equal(optimistic.frames[1].selectedTask, 'render-optimistic-agent', 'selection follows optimistic row to daemon row');

  const multiSelectPath = join(root, 'multi-select-tasks.json');
  await writeFile(multiSelectPath, JSON.stringify([
    { id: 'multi-a', name: 'render-multi-a', status: 'running', startedAt: iso(1000), updatedAt: iso(1000) },
    { id: 'multi-b', name: 'render-multi-b', status: 'running', startedAt: iso(2000), updatedAt: iso(2000) },
    { id: 'multi-c', name: 'render-multi-c', status: 'running', startedAt: iso(3000), updatedAt: iso(3000) },
  ], null, 2));
  const multi = runRender(multiSelectPath, 'ctrlM,space,down,space,ctrlC,ctrlM,space,escape', { rows: 18 });
  assert.match(multi.frames[1].status, /0 selected/, 'Ctrl-M opens multi-select mode');
  assert.ok(taskRows(multi.frames[2]).some((line) => /→\s*✓\s+render-multi-c/.test(line)), 'Space checks the selected row in multi-select mode');
  assert.ok(taskRows(multi.frames[4]).some((line) => /✓\s+render-multi-b/.test(line)), 'Down then Space checks another row in multi-select mode');
  assert.equal(countTaskRows(multi.frames[5], 'render-multi-c'), 1, 'Ctrl-C exits multi-select without clearing checked rows');
  assert.equal(countTaskRows(multi.frames[8], 'render-multi-b'), 0, 'Esc clears checked rows in multi-select mode');
  assert.equal(countTaskRows(multi.frames[8], 'render-multi-c'), 1, 'Esc only clears currently checked rows');
  const thinking = runRender(multiSelectPath, 'shiftTab', { rows: 12 });
  assert.match(thinking.frames[1].status, /Thinking level:/, 'Shift+Tab cycles thinking level and updates visible status');
  assert.ok(visible(thinking.frames[1]).join('\n').includes(':'), 'Shift+Tab keeps model/thinking footer visible');

  const resumeSessionsPath = join(root, 'resume-sessions.json');
  await writeFile(resumeSessionsPath, JSON.stringify([
    { id: 'resume-old', name: 'render-resume-old', source: 'pi-session', status: 'complete', sessionName: 'render-resume-old', updatedAt: iso(1000) },
    { id: 'resume-new', name: 'render-resume-new', source: 'pi-session', status: 'complete', sessionName: 'render-resume-new', updatedAt: iso(3000), openPiSession: true },
  ], null, 2));
  const emptyTasksPath = join(root, 'empty-tasks.json');
  await writeFile(emptyTasksPath, '[]');
  const resume = runRender(emptyTasksPath, 'slash:/resume', { rows: 14, env: { MI_AGENT_RENDER_TEST_RESUME_SESSIONS: resumeSessionsPath } });
  const resumeText = visible(resume.frames[1]).join('\n');
  assert.ok(resumeText.includes('resume pi sessions'), 'resume picker renders its heading');
  assert.ok(resumeText.includes('render-resume-new'), 'resume picker renders injected newest session');
  assert.ok(resumeText.includes('render-resume-old'), 'resume picker renders injected older session');
  assertBefore(resume.frames[1], 'render-resume-new', 'render-resume-old', 'resume picker sorts sessions newest to oldest');
  assert.ok(taskRows(resume.frames[1]).some((line) => /→\s*✓\s+render-resume-new/.test(line)), 'resume picker preselects the open/newest session');
  const resumeEmpty = runRender(emptyTasksPath, 'slash:/resume', { rows: 12, env: { MI_AGENT_RENDER_TEST_RESUME_SESSIONS: emptyTasksPath } });
  assert.ok(visible(resumeEmpty.frames[1]).join('\n').includes('No pi sessions found'), 'resume picker renders empty state');
  const resumeError = runRender(emptyTasksPath, 'slash:/resume', { rows: 12, env: { MI_AGENT_RENDER_TEST_RESUME_ERROR: 'render resume failed' } });
  assert.match(resumeError.frames[1].status, /render resume failed/, 'resume picker render-test can cover load error state');

  const chromeNormal = visible(contractInitial).join('\n');
  assert.match(chromeNormal, /^mi agents/m, 'normal golden chrome has mi agents header');
  assert.match(chromeNormal, /needs input[\s\S]*working[\s\S]*completed/, 'normal golden chrome keeps section order');
  const chromeMulti = visible(multi.frames[2]).join('\n');
  assert.match(chromeMulti, /0 selected|1 selected/, 'multi-select golden chrome shows selected count');
  const chromeFull = visible(fullFrame).join('\n');
  assert.match(chromeFull, /mi agents[\s\S]*next input[\s\S]*next task output/, 'full-output golden chrome keeps header, input, and output order');

  console.log('Mi agent render snapshot checks passed.');
} finally {
  await rm(root, { recursive: true, force: true });
}
