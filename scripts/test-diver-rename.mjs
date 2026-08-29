import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const env = await readFile(new URL('../src/env.ts', import.meta.url), 'utf8');
assert.equal(pkg.name, 'diver-chat');
assert.equal(pkg.bin.diver, 'dist/src/cli.js');
assert.equal(pkg.bin.mi, 'dist/src/cli.js');
assert.match(env, /DIVER_\$\{key\.slice\(3\)\}/);
assert.match(env, /legacyKey = `MI_\$\{key\.slice\(6\)\}`/);
console.log('Diver CLI compatibility checks passed.');
