#!/usr/bin/env node
import assert from 'node:assert/strict';
import { access, chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const repo = path.resolve(import.meta.dirname, '..');
const text = await readFile(path.join(repo, 'scripts/deploy-mi.sh'), 'utf8');
assert.match(text, /git fetch --no-tags origin main:refs\/remotes\/origin\/main/, 'deploy fetches only origin/main');
assert.match(text, /git merge --ff-only origin\/main/, 'deploy cannot overwrite local main commits');
assert.match(text, /Refusing to update or deploy Mi from a dirty tree/, 'deploy rejects every dirty tree before fetch');
assert.match(text, /github\.com\/kyleboas\/mi/, 'deploy validates the expected GitHub origin');
assert.match(text, /npm ci/, 'deploy updates dependencies for the fetched revision');
assert.match(text, /node scripts\/test-mi-tick\.mjs/, 'deploy keeps focused tick canary');
assert.match(text, /node dist\/src\/cli\.js tick/, 'deploy runs deployed CLI tick canary');
assert.match(text, /MI_DAEMON_SYSTEMD=0/, 'the direct canary uses the reviewed source daemon path');
assert.match(text, /sudo systemctl restart "\$unit"/, 'active system bridge uses interactive sudo');
assert.match(text, /restart_system_unit mi-photon-bridge\.service/, 'deploy refreshes only an active Photon bridge');
assert.match(text, /Update did not complete\. To return this checkout/, 'post-update failures include a rollback instruction');
assert.match(text, /Mi deploy complete at \$deployed_commit/, 'deploy prints the deployed revision');
assert.match(text, /Mi execution files remain under \$ROOT\/pi\/extensions/, 'deploy states the reviewed execution location');
assert.doesNotMatch(text, /\.pi\/agent\/extensions/, 'deploy cannot recreate Pi global extension contamination');
assert.doesNotMatch(text, /install -m .*mi-daemon\.mjs/, 'deploy does not copy the daemon into an auto-load folder');
await assert.rejects(access(path.join(repo, 'scripts/deploy-mi-pr-62.sh')), 'obsolete one-off updater is absent');

const temp = await mkdtemp(path.join(os.tmpdir(), 'mi-deploy-'));
try {
  const bin = path.join(temp, 'bin');
  const calls = path.join(temp, 'calls');
  await mkdir(bin);
  await writeFile(path.join(bin, 'git'), `#!/bin/sh
printf 'git %s\\n' "$*" >> ${JSON.stringify(calls)}
case "$1" in
  diff|ls-files|status) exit 0 ;;
  remote) printf '%s\\n' "\${ORIGIN_URL:-https://github.com/kyleboas/mi.git}"; exit 0 ;;
  symbolic-ref) printf 'main\\n'; exit 0 ;;
  rev-parse) printf '0123456789012345678901234567890123456789\\n'; exit 0 ;;
  show-ref|fetch|switch|merge) exit 0 ;;
esac
exit 1
`);
  await writeFile(path.join(bin, 'npm'), '#!/bin/sh\ncase "$1" in ci|test) exit 0;; esac\nexit 1\n');
  await writeFile(path.join(bin, 'node'), '#!/bin/sh\nexit 0\n');
  await writeFile(path.join(bin, 'systemctl'), `#!/bin/sh
printf 'systemctl %s\\n' "$*" >> ${JSON.stringify(calls)}
case "$*" in *is-active*) exit 3;; esac
exit 0
`);
  await writeFile(path.join(bin, 'sudo'), '#!/bin/sh\nexec "$@"\n');
  for (const name of ['git', 'npm', 'node', 'systemctl', 'sudo']) await chmod(path.join(bin, name), 0o700);

  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
  const result = spawnSync('bash', ['scripts/deploy-mi.sh'], { cwd: repo, env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  let recorded = await readFile(calls, 'utf8');
  assert.match(recorded, /git fetch --no-tags origin main:refs\/remotes\/origin\/main/, 'only origin/main is fetched');
  assert.match(recorded, /git merge --ff-only origin\/main/, 'main update is fast-forward only');
  assert.match(recorded, /systemctl --user is-active --quiet mi-daemon\.service/, 'inactive daemon is checked');
  assert.match(recorded, /systemctl is-active --quiet mi-photon-bridge\.service/, 'inactive bridge is checked through sudo');
  assert.doesNotMatch(recorded, /(?:restart|try-restart)/, 'inactive services are never started by deploy');

  await writeFile(calls, '');
  const rejected = spawnSync('bash', ['scripts/deploy-mi.sh'], {
    cwd: repo,
    env: { ...env, ORIGIN_URL: 'https://github.com/other/repo.git' },
    encoding: 'utf8',
  });
  assert.notEqual(rejected.status, 0, 'unexpected origins are rejected');
  assert.match(rejected.stderr, /origin must identify github\.com\/kyleboas\/mi/, 'unexpected origin failure is clear');
  recorded = await readFile(calls, 'utf8');
  assert.doesNotMatch(recorded, /git fetch/, 'unexpected origin is rejected before fetch');
} finally {
  await rm(temp, { recursive: true, force: true });
}
console.log('Mi deploy canary checks passed.');
