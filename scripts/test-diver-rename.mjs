import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const env = await readFile(new URL('../src/env.ts', import.meta.url), 'utf8');
const imessage = await readFile(new URL('./mi-imessage-v2.mjs', import.meta.url), 'utf8');
const coordinator = await readFile(new URL('./mi-imessage-coordinator.mjs', import.meta.url), 'utf8');
const runtime = await readFile(new URL('./mi-imessage-runtime.mjs', import.meta.url), 'utf8');
assert.equal(pkg.name, 'diver-chat');
assert.equal(pkg.bin.diver, 'dist/src/cli.js');
assert.equal(pkg.bin.mi, 'dist/src/cli.js');
assert.match(env, /DIVER_\$\{key\.slice\(3\)\}/);
assert.match(env, /legacyKey = `MI_\$\{key\.slice\(6\)\}`/);
assert.match(imessage, /You are Diver, a private personal assistant/);
assert.match(coordinator, /You are Diver’s Pi coordinator/);
assert.match(runtime, /DIVER_WORKER_MODEL \|\| process\.env\.MI_WORKER_MODEL \|\| 'openai-codex\/gpt-5\.6-luna:high'/);
console.log('Diver CLI compatibility checks passed.');
