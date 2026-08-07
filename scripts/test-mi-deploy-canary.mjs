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
if [ "$1" = remote ] && [ "$2" = get-url ] && [ "$3" = origin ]; then
  printf '%s\\n' "\${ORIGIN_URL:-https://github.com/kyleboas/mi.git}"
  exit 0
fi
exec /usr/bin/git "$@"
`);
  await writeFile(path.join(bin, 'npm'), `#!/bin/sh
printf 'npm %s\\n' "$*" >> ${JSON.stringify(calls)}
if [ "$*" = 'run build' ] && [ "\${FAIL_BUILD:-0}" = 1 ]; then exit 1; fi
exit 0
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

  const git = (cwd, args) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const setupRepo = async (name) => {
    const seed = path.join(temp, `${name}-seed`);
    const checkout = path.join(temp, name);
    const origin = path.join(temp, `${name}-origin.git`);
    git(temp, ['init', '--initial-branch=main', seed]);
    git(seed, ['config', 'user.email', 'test@example.com']);
    git(seed, ['config', 'user.name', 'Mi deploy canary']);
    await mkdir(path.join(seed, 'scripts'), { recursive: true });
    await mkdir(path.join(seed, 'pi/extensions'), { recursive: true });
    await mkdir(path.join(seed, 'dist/src'), { recursive: true });
    await writeFile(path.join(seed, 'scripts/deploy-mi.sh'), text, { mode: 0o700 });
    await writeFile(path.join(seed, 'package.json'), '{"private":true}\n');
    await writeFile(path.join(seed, 'scripts/test-mi-tick.mjs'), '');
    await writeFile(path.join(seed, 'dist/src/cli.js'), '');
    for (const file of ['mi-daemon.mjs', 'mi-capability-guard.ts', 'mi-orchestrator-adapter.ts', 'mi.ts']) {
      await writeFile(path.join(seed, 'pi/extensions', file), '');
    }
    git(seed, ['add', '.']);
    git(seed, ['commit', '-m', 'initial deploy fixture']);
    git(temp, ['clone', '--bare', seed, origin]);
    git(temp, ['clone', origin, checkout]);
    git(checkout, ['config', 'user.email', 'test@example.com']);
    git(checkout, ['config', 'user.name', 'Mi deploy canary']);
    git(checkout, ['remote', 'set-url', 'origin', 'https://github.com/kyleboas/mi.git']);
    return { checkout, origin };
  };
  const run = (cwd, origin, extra = {}) => spawnSync('bash', ['scripts/deploy-mi.sh'], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...extra,
      PATH: `${bin}:${process.env.PATH}`,
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: `url.file://${origin}.insteadOf`,
      GIT_CONFIG_VALUE_0: 'https://github.com/kyleboas/mi.git',
    },
  });

  const { checkout, origin } = await setupRepo('divergent-main');
  git(checkout, ['branch', 'deploy/mi', 'origin/main']);
  await writeFile(path.join(checkout, 'local-main-only'), 'do not deploy this commit\n');
  git(checkout, ['add', 'local-main-only']);
  git(checkout, ['commit', '-m', 'local main divergence']);
  const originalMain = git(checkout, ['rev-parse', 'main']);
  const originalMainRef = git(checkout, ['show-ref', '--verify', 'refs/heads/main']);

  const result = run(checkout, origin);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(git(checkout, ['rev-parse', 'main']), originalMain, 'the divergent local main commit remains unchanged');
  assert.equal(git(checkout, ['show-ref', '--verify', 'refs/heads/main']), originalMainRef, 'the local main ref remains unchanged');
  assert.equal(git(checkout, ['symbolic-ref', '--short', 'HEAD']), 'deploy/mi', 'the owned deployment branch is checked out, not main');
  assert.equal(git(checkout, ['rev-parse', 'deploy/mi']), git(checkout, ['rev-parse', 'origin/main']), 'deploy/mi reaches origin/main');
  assert.doesNotMatch(git(checkout, ['reflog', 'show', '--format=%gs', 'HEAD']), /moving from deploy\/mi to main/, 'the updater never checks out local main');
  let recorded = await readFile(calls, 'utf8');
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
  const bootstrapFixture = await setupRepo('bootstrap-deploy');
  const bootstrap = run(bootstrapFixture.checkout, bootstrapFixture.origin);
  assert.equal(bootstrap.status, 0, bootstrap.stderr);
  assert.equal(git(bootstrapFixture.checkout, ['symbolic-ref', '--short', 'HEAD']), 'deploy/mi', 'first deploy creates and checks out the owned deployment branch');
  assert.equal(git(bootstrapFixture.checkout, ['rev-parse', 'deploy/mi']), git(bootstrapFixture.checkout, ['rev-parse', 'origin/main']), 'first deploy creates deploy/mi at origin/main');

  await writeFile(calls, '');
  const divergentFixture = await setupRepo('divergent-deploy');
  const divergent = divergentFixture.checkout;
  git(divergent, ['branch', 'deploy/mi', 'origin/main']);
  git(divergent, ['switch', 'deploy/mi']);
  await writeFile(path.join(divergent, 'deploy-only'), 'divergent deployment branch\n');
  git(divergent, ['add', 'deploy-only']);
  git(divergent, ['commit', '-m', 'divergent deploy branch']);
  const divergentDeployCommit = git(divergent, ['rev-parse', 'deploy/mi']);
  git(divergent, ['switch', 'main']);
  const divergentDeploy = run(divergent, divergentFixture.origin);
  assert.notEqual(divergentDeploy.status, 0, 'a divergent deployment branch fails closed');
  assert.match(divergentDeploy.stderr, /deploy\/mi is not a fast-forward ancestor of origin\/main/, 'divergent deployment branch failure is clear');
  assert.equal(git(divergent, ['rev-parse', 'deploy/mi']), divergentDeployCommit, 'a divergent deployment branch is not rewritten');
  assert.equal(git(divergent, ['symbolic-ref', '--short', 'HEAD']), 'main', 'a divergent deployment branch is not checked out');
  recorded = await readFile(calls, 'utf8');
  assert.equal(recorded, '', 'a divergent deployment branch stops before dependency or service commands');

  const rejected = run(checkout, origin, { ORIGIN_URL: 'https://github.com/other/repo.git' });
  assert.notEqual(rejected.status, 0, 'unexpected origins are rejected');
  assert.match(rejected.stderr, /origin must identify github\.com\/kyleboas\/mi/, 'unexpected origin failure is clear');

  const failedBuild = run(checkout, origin, { FAIL_BUILD: '1' });
  assert.notEqual(failedBuild.status, 0, 'failed post-update build fails deploy');
  assert.match(failedBuild.stderr, /Recovery: git switch --detach mi-deploy-rollback-\d{8}T\d{6}Z && npm ci && npm run build/, 'failed post-update build prints the durable rollback recovery command');
  assert.match(failedBuild.stderr, /does not roll them back automatically/, 'failed post-update build does not claim automatic service rollback');
} finally {
  await rm(temp, { recursive: true, force: true });
}
console.log('Mi deploy canary checks passed.');
