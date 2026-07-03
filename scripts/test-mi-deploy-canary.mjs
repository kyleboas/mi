#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const text = await readFile('scripts/deploy-mi.sh', 'utf8');
assert.match(text, /BACKUP_DIR=/, 'deploy creates backup dir');
assert.match(text, /rollback_deploy\(\)/, 'deploy defines rollback function');
assert.match(text, /node scripts\/test-mi-tick\.mjs/, 'deploy keeps focused tick canary');
assert.match(text, /node dist\/src\/cli\.js tick/, 'deploy runs deployed CLI tick canary');
assert.match(text, /node dist\/src\/cli\.js task list/, 'deploy checks daemon round-trip when daemon is active');
assert.match(text, /rollback_deploy\n\s+exit 1/, 'canary failure rolls back and exits');
console.log('Mi deploy canary checks passed.');
