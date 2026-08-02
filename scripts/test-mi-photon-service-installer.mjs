#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

const repo = path.resolve(import.meta.dirname, '..');
const root = await mkdtemp(path.join(tmpdir(), 'mi-photon-service-installer-'));
const systemRoot = path.join(root, 'system');
const secretEnv = path.join(systemRoot, 'etc/agent-secrets/projects/assistant/photon.secret');
const unit = path.join(systemRoot, 'etc/systemd/system/mi-photon-bridge.service');
try {
  await mkdir(path.dirname(secretEnv), { recursive: true, mode: 0o700 });
  await writeFile(secretEnv, 'PHOTON_PROJECT_ID=test-project\nPHOTON_PROJECT_SECRET=test-secret\nPHOTON_ALLOWED_USERS=test-user\n', { mode: 0o600 });
  const env = {
    ...process.env,
    MI_SYSTEM_ROOT: systemRoot,
    MI_APP_DIR: '/srv/assistant',
    MI_SERVICE_USER: 'mi-test',
    MI_SERVICE_HOME: '/srv/mi-test',
    MI_NODE_BIN: '/opt/mi/bin/node',
    MI_PHOTON_SECRET_ENV: secretEnv,
    MI_WORKFLOWS_DIR: '/srv/mi-test/workflows',
    MI_RUNTIME_DIR: '/srv/assistant/state/imessage/runtime',
  };
  let result = spawnSync('bash', [path.join(repo, 'scripts/install-mi-photon-service-root.sh')], { env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  let content = await readFile(unit, 'utf8');
  assert.match(content, /Environment=PI_CMD=\/opt\/mi\/bin\/pi/, 'Photon uses the Pi binary beside the configured Node binary');
  assert.match(content, /Environment=PATH=\/opt\/mi\/bin:\/usr\/local\/sbin:\/usr\/local\/bin:\/usr\/sbin:\/usr\/bin:\/snap\/bin/, 'Photon puts the configured Node directory first on PATH');
  assert.match(content, /ExecStart=\/opt\/mi\/bin\/node \/srv\/assistant\/scripts\/mi-photon-bridge\.mjs/);

  result = spawnSync('bash', [path.join(repo, 'scripts/install-mi-photon-service-root.sh')], {
    env: { ...env, MI_PI_BIN: '/custom/mi/pi' },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  content = await readFile(unit, 'utf8');
  assert.match(content, /Environment=PI_CMD=\/custom\/mi\/pi/, 'MI_PI_BIN provides an explicit Pi path override');
  assert.doesNotMatch(content, /PHOTON_PROJECT_SECRET=test-secret/, 'the generated unit keeps credentials in EnvironmentFile');
  console.log('Mi Photon service installer checks passed.');
} finally {
  await rm(root, { recursive: true, force: true });
}
