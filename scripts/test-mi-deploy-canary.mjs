#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const text = await readFile('scripts/deploy-mi.sh', 'utf8');
assert.match(text, /node scripts\/test-mi-tick\.mjs/, 'deploy keeps focused tick canary');
assert.match(text, /node dist\/src\/cli\.js tick/, 'deploy runs deployed CLI tick canary');
assert.match(text, /MI_DAEMON_SYSTEMD=0/, 'the direct canary uses the reviewed source daemon path');
assert.match(text, /Mi execution files remain under \$ROOT\/pi\/extensions/, 'deploy states the reviewed execution location');
assert.doesNotMatch(text, /\.pi\/agent\/extensions/, 'deploy cannot recreate Pi global extension contamination');
assert.doesNotMatch(text, /install -m .*mi-daemon\.mjs/, 'deploy does not copy the daemon into an auto-load folder');
assert.match(text, /if \[\[ \$\{MI_DEPLOY_ACTIVATE_TIMER:-0\} == 1 \]\]; then[\s\S]*restart_user_unit mi-tick\.timer/, 'deploy keeps timer activation behind a separate opt-in');
console.log('Mi deploy canary checks passed.');
