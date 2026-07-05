import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = await mkdtemp(join(tmpdir(), 'mi-context-governance-'));
const child = join(root, 'exercise.mjs');
const extensionUrl = pathToFileURL(join(process.cwd(), 'pi/extensions/auto-compact-cost.ts')).href;

await writeFile(child, `
  import assert from 'node:assert/strict';
  import { mkdir, writeFile, stat } from 'node:fs/promises';
  import { existsSync } from 'node:fs';
  import { join } from 'node:path';
  const mod = await import(${JSON.stringify(extensionUrl)});
  const {
    decideToolResultOffload,
    microcompactMessages,
    pruneOffloadRoot,
    hasSecretLikeContent,
    shouldWholeCompact,
  } = mod;

  assert.equal(decideToolResultOffload({ toolName: 'read', input: { path: '/tmp/a' }, text: 'short', minChars: 10, pointer: '/tmp/out.txt' }).offload, false);
  const large = 'a'.repeat(40);
  const offload = decideToolResultOffload({ toolName: 'read', input: { path: '/tmp/a' }, text: large, minChars: 10, pointer: '/tmp/out.txt' });
  assert.equal(offload.offload, true);
  assert.ok(offload.excerpt.includes('full output persisted to /tmp/out.txt')); 
  assert.equal(decideToolResultOffload({ toolName: 'read', input: { path: '/tmp/.pi/offload/session/tool.txt' }, text: large, minChars: 10, pointer: '/tmp/out.txt' }).reason, 'offload-read-exempt');
  assert.equal(decideToolResultOffload({ toolName: 'read_file', input: { path: '/tmp/.pi/offload/session/tool.txt' }, text: large, minChars: 10, pointer: '/tmp/out.txt' }).reason, 'tool-not-compactable');
  assert.equal(decideToolResultOffload({ toolName: 'read', input: { path: '/tmp/a' }, text: 'sk-test-12345678901234567890', minChars: 10, pointer: '/tmp/out.txt' }).reason, 'secret-like-content');
  assert.equal(hasSecretLikeContent('tokenization docs mention token but no credential'), false);
  assert.equal(shouldWholeCompact(70_000, 80_000, 0.85), true);
  assert.equal(shouldWholeCompact(60_000, 80_000, 0.85), false);

  const messages = Array.from({ length: 6 }, (_, i) => ({ toolName: 'read', toolCallId: 'call' + i, content: 'x'.repeat(100) }));
  messages[1] = { toolName: 'read', content: 'sk-test-12345678901234567890'.repeat(3) };
  const micro = microcompactMessages(messages, { keepRecent: 2, minChars: 50 });
  assert.equal(micro.changed, 3);
  assert.match(micro.messages[0].content, /microcompacted/);
  assert.equal(micro.messages[1].content, messages[1].content, 'secret-like older results are not compacted');
  assert.equal(micro.messages[4].content, messages[4].content, 'recent window is preserved');
  assert.equal(micro.messages[5].content, messages[5].content, 'recent window is preserved');

  const root = ${JSON.stringify(root)};
  const offloadRoot = join(root, 'offload');
  await mkdir(join(offloadRoot, 'old'), { recursive: true });
  await mkdir(join(offloadRoot, 'new'), { recursive: true });
  await writeFile(join(offloadRoot, 'old', 'a.txt'), 'a'.repeat(2048));
  await writeFile(join(offloadRoot, 'new', 'b.txt'), 'b'.repeat(2048));
  const oldTime = new Date(Date.now() - 60_000);
  await import('node:fs/promises').then((fs) => fs.utimes(join(offloadRoot, 'old'), oldTime, oldTime));
  const pruned = pruneOffloadRoot(offloadRoot, 0.003);
  assert.equal(pruned.pruned, 1);
  assert.equal(existsSync(join(offloadRoot, 'old')), false);
  assert.equal(existsSync(join(offloadRoot, 'new')), true);
`);

const { spawnSync } = await import('node:child_process');
const result = spawnSync(process.execPath, ['--import', 'tsx', child], { cwd: process.cwd(), encoding: 'utf8' });
if (result.status !== 0) {
  process.stdout.write(result.stdout || '');
  process.stderr.write(result.stderr || '');
  throw new Error(`context governance exercise failed with status ${result.status}`);
}

console.log('test-mi-pi-context-governance ok');
