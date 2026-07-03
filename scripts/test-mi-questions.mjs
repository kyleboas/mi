import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'mi-questions-'));
try {
  await mkdir(join(root, 'mi', 'state'), { recursive: true });
  await mkdir(join(root, 'assistant', 'state'), { recursive: true });
  await writeFile(join(root, 'mi', 'current.md'), '# Current\nTactics Journal research pipeline needs better detect candidate decisions.');
  await writeFile(join(root, 'mi', 'tasks.md'), '# Tasks\n- Grow Tactics Journal newsletter subscribers.\n- Improve research detect candidates.');
  await writeFile(join(root, 'mi', 'TODO.md'), '# TODO\n- Clarify which candidate should be approved next.');

  const runner = join(root, 'run-questions.mjs');
  await writeFile(runner, `
    import assert from 'node:assert/strict';
    import { projectQuestion, questionLooksUseful, sanitizeProjectQuestion } from ${JSON.stringify(new URL('../src/questions.ts', import.meta.url).href)};
    const first = await projectQuestion();
    assert.ok(first, 'fallback creates a project question');
    assert.equal(first.suppressActionFooter, true, 'question suppresses action footer');
    assert.equal((first.message.match(/\\?/g) || []).length, 1, 'question has exactly one question mark');
    assert.doesNotMatch(first.message, /[—–]/, 'question avoids em and en dashes');
    assert.match(first.message, /Tactics Journal|research|detect|newsletter|revenue|Mi/, 'question is project or goal specific');
    assert.equal(questionLooksUseful('What do you want to do today?'), false, 'generic questions are rejected');
    assert.equal(sanitizeProjectQuestion('For Tactics Journal — approve candidate 1? Also another?'), 'For Tactics Journal - approve candidate 1?', 'sanitizer keeps one question and removes long dash');
    const history = JSON.parse(await (await import('node:fs/promises')).readFile(process.env.MI_QUESTIONS_STATE_PATH, 'utf8'));
    assert.equal(history.questions.length, 1, 'question history records asked questions');
    console.log(JSON.stringify({ message: first.message }));
  `);

  const tsx = new URL('../node_modules/.bin/tsx', import.meta.url).pathname;
  const result = spawnSync(process.execPath, [tsx, runner], {
    cwd: root,
    env: {
      ...process.env,
      HOME: root,
      MI_ROOT: join(root, 'assistant'),
      MI_CONTEXT_DIR: join(root, 'mi'),
      MI_QUESTIONS_STATE_PATH: join(root, 'assistant', 'state', 'questions.json'),
      MI_QUESTIONS_USE_FLUE: 'false',
      PUSHOVER_USER: '',
      PUSHOVER_TOKEN: '',
    },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log('Mi question checks passed.');
