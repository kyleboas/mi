#!/usr/bin/env node
import assert from 'node:assert/strict';
import { access, chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const repo = path.resolve(import.meta.dirname, '..');
const text = await readFile(path.join(repo, 'scripts/deploy-mi.sh'), 'utf8');
assert.match(text, /git fetch --no-tags origin main:refs\/remotes\/origin\/main/, 'deploy fetches only origin/main');
assert.match(text, /deployment_branch="deploy\/mi"/, 'deploy uses an owned deployment branch');
assert.match(text, /git switch -c "\$deployment_branch" --track origin\/main/, 'first deploy bootstraps the deployment branch from origin/main');
assert.match(text, /git merge-base --is-ancestor "\$deployment_branch" origin\/main/, 'existing deployment branch must be fast-forwardable');
assert.match(text, /git switch "\$deployment_branch"\n  git merge --ff-only origin\/main/, 'later deploys fast-forward only the deployment branch');
assert.doesNotMatch(text, /git switch main/, 'deploy never switches to local main');
assert.match(text, /Refusing to update or deploy Mi from a dirty tree/, 'deploy rejects every dirty tree before fetch');
assert.match(text, /github\.com\/kyleboas\/mi/, 'deploy validates the expected GitHub origin');
assert.match(text, /npm ci\nnpm run build\nnpm test\n\n# Mi runs from this reviewed tree/, 'deploy builds and runs the full test suite after npm ci, before canaries');
assert.match(text, /node scripts\/test-mi-tick\.mjs/, 'deploy keeps focused tick canary');
assert.match(text, /node dist\/src\/cli\.js tick/, 'deploy runs deployed CLI tick canary');
assert.match(text, /MI_DAEMON_SYSTEMD=0/, 'the direct canary uses the reviewed source daemon path');
assert.match(text, /sudo systemctl restart "\$unit"/, 'active system bridge uses interactive sudo');
assert.match(text, /restart_system_unit mi-photon-bridge\.service/, 'deploy refreshes only an active Photon bridge');
assert.match(text, /git branch "\$rollback_branch" "\$prior_commit"/, 'deploy preserves the prior commit in a durable rollback branch');
assert.match(text, /Recovery: git switch --detach \$rollback_branch && npm ci && npm run build/, 'post-update failures include a usable recovery command');
assert.match(text, /does not roll them back automatically/, 'deploy does not claim to roll restarted services back automatically');
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
  symbolic-ref) printf '%s\\n' "\${PRIOR_BRANCH:-checkpoint/imessage-v2-before-simplification}"; exit 0 ;;
  rev-parse) printf '0123456789012345678901234567890123456789\\n'; exit 0 ;;
  show-ref) [ "\${DEPLOY_BRANCH_EXISTS:-1}" = 1 ] && exit 0 || exit 1 ;;
  merge-base) [ "\${DEPLOY_BRANCH_ANCESTOR:-1}" = 1 ] && exit 0 || exit 1 ;;
  branch|fetch|merge) exit 0 ;;
  switch) [ "$2" = main ] && [ "\${LOCAL_MAIN_DIVERGENT:-0}" = 1 ] && exit 1; exit 0 ;;
esac
exit 1
`);
  await writeFile(path.join(bin, 'npm'), `#!/bin/sh
printf 'npm %s\\n' "$*" >> ${JSON.stringify(calls)}
if [ "$*" = 'run build' ] && [ "\${FAIL_BUILD:-0}" = 1 ]; then exit 1; fi
case "$*" in ci|'run build'|test) exit 0;; esac
exit 1
`);
  await writeFile(path.join(bin, 'node'), `#!/bin/sh
printf 'node %s\\n' "$*" >> ${JSON.stringify(calls)}
exit 0
`);
  await writeFile(path.join(bin, 'systemctl'), `#!/bin/sh
printf 'systemctl %s\\n' "$*" >> ${JSON.stringify(calls)}
case "$*" in *is-active*) exit 3;; esac
exit 0
`);
  await writeFile(path.join(bin, 'sudo'), '#!/bin/sh\nexec "$@"\n');
  for (const name of ['git', 'npm', 'node', 'systemctl', 'sudo']) await chmod(path.join(bin, name), 0o700);

  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
  const run = (extra = {}) => spawnSync('bash', ['scripts/deploy-mi.sh'], {
    cwd: repo, env: { ...env, ...extra }, encoding: 'utf8',
  });

  const result = run({ LOCAL_MAIN_DIVERGENT: '1' });
  assert.equal(result.status, 0, result.stderr);
  let recorded = await readFile(calls, 'utf8');
  assert.match(recorded, /git fetch --no-tags origin main:refs\/remotes\/origin\/main/, 'only origin/main is fetched');
  assert.match(recorded, /git merge-base --is-ancestor deploy\/mi origin\/main/, 'existing deployment branch is checked before updating');
  assert.match(recorded, /git switch deploy\/mi\ngit merge --ff-only origin\/main/, 'existing deployment branch fast-forwards from origin/main');
  assert.doesNotMatch(recorded, /git (?:switch|merge) main(?:\n| )/, 'a divergent local main is never selected or modified');
  assert.match(recorded, /git branch mi-deploy-rollback-\d{8}T\d{6}Z 0123456789012345678901234567890123456789/, 'prior commit gets a durable rollback branch');
  const stages = ['npm ci', 'npm run build', 'npm test', 'node scripts/test-mi-tick.mjs', 'node dist/src/cli.js tick'];
  let previousStage = -1;
  for (const stage of stages) {
    const position = recorded.indexOf(stage);
    assert.ok(position > previousStage, `deploy runs ${stage} after the preceding validation stage`);
    previousStage = position;
  }
  assert.match(recorded, /systemctl --user is-active --quiet mi-daemon\.service/, 'inactive daemon is checked');
  assert.match(recorded, /systemctl is-active --quiet mi-photon-bridge\.service/, 'inactive bridge is checked through sudo');
  assert.doesNotMatch(recorded, /(?:restart|try-restart)/, 'inactive services are never started by deploy');

  await writeFile(calls, '');
  const bootstrap = run({ DEPLOY_BRANCH_EXISTS: '0' });
  assert.equal(bootstrap.status, 0, bootstrap.stderr);
  recorded = await readFile(calls, 'utf8');
  assert.match(recorded, /git switch -c deploy\/mi --track origin\/main/, 'first deploy creates deploy/mi directly from origin/main');
  assert.doesNotMatch(recorded, /git merge --ff-only origin\/main/, 'a newly bootstrapped deployment branch needs no merge');

  await writeFile(calls, '');
  const divergentDeploy = run({ DEPLOY_BRANCH_ANCESTOR: '0' });
  assert.notEqual(divergentDeploy.status, 0, 'a divergent deployment branch fails closed');
  assert.match(divergentDeploy.stderr, /deploy\/mi is not a fast-forward ancestor of origin\/main/, 'divergent deployment branch failure is clear');
  recorded = await readFile(calls, 'utf8');
  assert.doesNotMatch(recorded, /git switch/, 'a divergent deployment branch is not checked out');
  assert.doesNotMatch(recorded, /git merge --ff-only/, 'a divergent deployment branch is not rewritten');
  assert.doesNotMatch(recorded, /npm ci/, 'a divergent deployment branch stops before dependency changes');

  const failedBuild = run({ FAIL_BUILD: '1' });
  assert.notEqual(failedBuild.status, 0, 'failed post-update build fails deploy');
  assert.match(failedBuild.stderr, /Recovery: git switch --detach mi-deploy-rollback-\d{8}T\d{6}Z && npm ci && npm run build/, 'failed post-update build prints the durable rollback recovery command');
  assert.match(failedBuild.stderr, /does not roll them back automatically/, 'failed post-update build does not claim automatic service rollback');

  await writeFile(calls, '');
  const rejected = run({ ORIGIN_URL: 'https://github.com/other/repo.git' });
  assert.notEqual(rejected.status, 0, 'unexpected origins are rejected');
  assert.match(rejected.stderr, /origin must identify github\.com\/kyleboas\/mi/, 'unexpected origin failure is clear');
  recorded = await readFile(calls, 'utf8');
  assert.doesNotMatch(recorded, /git fetch/, 'unexpected origin is rejected before fetch');
} finally {
  await rm(temp, { recursive: true, force: true });
}
console.log('Mi deploy canary checks passed.');
