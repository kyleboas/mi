#!/usr/bin/env node
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const repo = path.resolve(import.meta.dirname, '..');
const text = await readFile(path.join(repo, 'scripts/deploy-mi.sh'), 'utf8');
assert.match(text, /node scripts\/test-mi-tick\.mjs/, 'deploy keeps focused tick canary');
assert.match(text, /node dist\/src\/cli\.js tick/, 'deploy runs deployed CLI tick canary');
assert.match(text, /MI_DAEMON_SYSTEMD=0/, 'the direct canary uses the reviewed source daemon path');
assert.match(text, /Mi execution files remain under \$ROOT\/pi\/extensions/, 'deploy states the reviewed execution location');
assert.doesNotMatch(text, /\.pi\/agent\/extensions/, 'deploy cannot recreate Pi global extension contamination');
assert.doesNotMatch(text, /install -m .*mi-daemon\.mjs/, 'deploy does not copy the daemon into an auto-load folder');

const temp = await mkdtemp(path.join(os.tmpdir(), 'mi-deploy-'));
try {
  const bin = path.join(temp, 'bin');
  const calls = path.join(temp, 'systemctl-calls');
  await (await import('node:fs/promises')).mkdir(bin);
  await writeFile(path.join(bin, 'git'), '#!/bin/sh\ncase "$1" in diff|ls-files) exit 0;; status) exit 0;; esac\n');
  await writeFile(path.join(bin, 'npm'), '#!/bin/sh\n[ "$1" = test ] && exit 0\nexit 1\n');
  await writeFile(path.join(bin, 'node'), '#!/bin/sh\nexit 0\n');
  await writeFile(path.join(bin, 'systemctl'), `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(calls)}\n[ "$2" = is-active ] && exit 3\nexit 0\n`);
  for (const name of ['git', 'npm', 'node', 'systemctl']) await chmod(path.join(bin, name), 0o700);
  const result = spawnSync('bash', ['scripts/deploy-mi.sh'], { cwd: repo, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const recorded = await readFile(calls, 'utf8');
  assert.match(recorded, /--user is-active --quiet mi-daemon\.service/, 'inactive daemon is checked');
  assert.doesNotMatch(recorded, /(?:restart|try-restart)/, 'inactive daemon is never started by deploy');
} finally {
  await rm(temp, { recursive: true, force: true });
}
console.log('Mi deploy canary checks passed.');
