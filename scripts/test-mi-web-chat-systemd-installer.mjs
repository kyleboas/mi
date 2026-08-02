import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, chmod, rm, symlink, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repo = path.resolve(import.meta.dirname, '..');
const tmp = await mkdtemp(path.join(os.tmpdir(), 'mi-web-unit-'));
const bin = path.join(tmp, 'bin');
const systemctlCalls = path.join(tmp, 'systemctl-calls');
const runtimeDropin = await readFile(path.join(repo, 'systemd/mi-web-chat.service.d/10-mi-runtime.conf'), 'utf8');

const exists = async (value) => {
  try { await stat(value); return true; } catch { return false; }
};
const run = (home, root, config = path.join(home, '.config')) => spawnSync('bash', ['scripts/install-mi-web-chat-systemd.sh'], {
  cwd: repo,
  env: {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: config,
    MI_APP_DIR: root,
    MI_WEB_MAINTENANCE: '1',
    PATH: `${bin}:${process.env.PATH}`,
  },
  encoding: 'utf8',
});
const makeRoot = async (name) => {
  const root = path.join(tmp, name);
  await mkdir(path.join(root, 'systemd/mi-web-chat.service.d'), { recursive: true });
  await writeFile(path.join(root, 'systemd/mi-web-chat.service.d/10-mi-runtime.conf'), runtimeDropin);
  return root;
};
const assertFailedClosed = async ({ name, prepare, outsidePath }) => {
  const home = path.join(tmp, `${name}-home`);
  const root = await makeRoot(`${name}-root`);
  const outside = path.join(tmp, `${name}-outside`);
  await mkdir(home);
  await mkdir(outside);
  const insideSentinel = path.join(home, 'inside-sentinel');
  const outsideSentinel = path.join(outside, 'outside-sentinel');
  await writeFile(insideSentinel, `inside ${name}\n`);
  await writeFile(outsideSentinel, `outside ${name}\n`);
  await writeFile(systemctlCalls, '');
  await prepare({ home, root, outside });
  const beforeInside = await readFile(insideSentinel);
  const beforeOutside = await readFile(outsideSentinel);
  const result = run(home, root);
  assert.notEqual(result.status, 0, `${name} must fail closed`);
  assert.match(result.stderr, /symlink component/, `${name} reports the rejected link`);
  assert.deepEqual(await readFile(insideSentinel), beforeInside, `${name} leaves inside sentinel byte-for-byte unchanged`);
  assert.deepEqual(await readFile(outsideSentinel), beforeOutside, `${name} leaves outside sentinel byte-for-byte unchanged`);
  assert.equal(await exists(outsidePath({ home, root, outside })), false, `${name} creates no directory outside its approved root`);
  assert.equal(await readFile(systemctlCalls, 'utf8'), '', `${name} makes no systemctl call`);
};

try {
  await mkdir(bin);
  await writeFile(systemctlCalls, '');
  await writeFile(path.join(bin, 'tailscale'), '#!/bin/sh\nprintf \'%s\\n\' \'{"Self":{"DNSName":"main.example.ts.net."}}\'\n');
  await writeFile(path.join(bin, 'systemctl'), `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(systemctlCalls)}\nexit 0\n`);
  await chmod(path.join(bin, 'tailscale'), 0o755);
  await chmod(path.join(bin, 'systemctl'), 0o755);

  // These five fixtures cover each destination-chain link. The first and
  // fourth reproduce the two reported escaping writes directly.
  await assertFailedClosed({
    name: 'escaping-config',
    prepare: async ({ home, outside }) => symlink(outside, path.join(home, '.config')),
    outsidePath: ({ outside }) => path.join(outside, 'systemd/user/mi-web-chat.service'),
  });
  await assertFailedClosed({
    name: 'escaping-systemd',
    prepare: async ({ home, outside }) => {
      await mkdir(path.join(home, '.config'));
      await symlink(outside, path.join(home, '.config/systemd'));
    },
    outsidePath: ({ outside }) => path.join(outside, 'user/mi-web-chat.service'),
  });
  await assertFailedClosed({
    name: 'escaping-unit-directory',
    prepare: async ({ home, outside }) => {
      await mkdir(path.join(home, '.config/systemd'), { recursive: true });
      await symlink(outside, path.join(home, '.config/systemd/user'));
    },
    outsidePath: ({ outside }) => path.join(outside, 'mi-web-chat.service'),
  });
  await assertFailedClosed({
    name: 'escaping-mi-state',
    prepare: async ({ root, outside }) => symlink(outside, path.join(root, 'state')),
    outsidePath: ({ outside }) => path.join(outside, 'tls'),
  });
  await assertFailedClosed({
    name: 'escaping-tls-parent',
    prepare: async ({ root, outside }) => {
      await mkdir(path.join(root, 'state'));
      await symlink(outside, path.join(root, 'state/tls'));
    },
    outsidePath: ({ outside }) => path.join(outside, 'main.example.ts.net.crt'),
  });

  // A new service home and a new Mi state tree are allowed. A repeat run stays
  // contained and does not activate the service.
  const home = path.join(tmp, 'safe-home');
  const root = await makeRoot('safe-root');
  await mkdir(home);
  await writeFile(systemctlCalls, '');
  let result = run(home, root);
  assert.equal(result.status, 0, result.stderr);
  const unitPath = path.join(home, '.config/systemd/user/mi-web-chat.service');
  const dropinDir = path.join(home, '.config/systemd/user/mi-web-chat.service.d');
  const unit = await readFile(unitPath, 'utf8');
  const dropin = await readFile(path.join(dropinDir, '10-mi-runtime.conf'), 'utf8');
  assert.match(unit, /tailscale cert[^\n]+main\.example\.ts\.net\.crt[^\n]+main\.example\.ts\.net\.key main\.example\.ts\.net/);
  assert.doesNotMatch(unit, /hermes/);
  assert.match(unit, /Wants=llm-gateway\.service/);
  assert.match(unit, /After=network-online\.target llm-gateway\.service/);
  assert.match(unit, /Environment=MI_WEB_MAINTENANCE=1/);
  const expectedNvmPiBin = `${home}/.nvm/versions/node/v24.15.0/bin`;
  assert.match(dropin, /Environment=MI_GATEWAY_CLIENT=.*\.local\/share\/mi\/mi-gateway-client\.py/);
  assert.match(dropin, /Environment=PI_CMD=.*\/bin\/pi-gateway/);
  assert.match(dropin, new RegExp(`Environment=PATH=${expectedNvmPiBin.replace(/[./]/g, '\\$&')}:/usr/local/bin:/usr/bin:/bin`));
  assert.equal(dropin.split('Environment=PATH=')[1].split(':')[0], expectedNvmPiBin, 'deployed service PATH resolves pi from the supported NVM directory first');
  assert.equal(await exists(path.join(root, 'state/tls')), true, 'valid missing Mi state and TLS directories are created inside the canonical Mi root');
  const firstUnit = await readFile(unitPath);
  const firstDropin = await readFile(path.join(dropinDir, '10-mi-runtime.conf'));
  await writeFile(path.join(dropinDir, '20-mi-gateway-client.conf'), `[Service]\nEnvironment=MI_GATEWAY_CLIENT=${home}/.local/share/mi/mi-gateway-client.py\n`);
  await writeFile(path.join(dropinDir, '30-nvm-pi-path.conf'), '[Service]\nEnvironment=OPERATOR_OVERRIDE=preserve\n');
  result = run(home, root);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(await readFile(unitPath), firstUnit, 'safe rerun keeps the unit byte-for-byte stable');
  assert.deepEqual(await readFile(path.join(dropinDir, '10-mi-runtime.conf')), firstDropin, 'safe rerun keeps the drop-in byte-for-byte stable');
  await assert.rejects(readFile(path.join(dropinDir, '20-mi-gateway-client.conf')), /ENOENT/, 'exact known helper duplicate is removed');
  assert.match(await readFile(path.join(dropinDir, '30-nvm-pi-path.conf'), 'utf8'), /OPERATOR_OVERRIDE/, 'unknown override is preserved');
  assert.equal(await readFile(systemctlCalls, 'utf8'), '', 'web unit install writes files without daemon-reload, enable, start, or restart');

  const stackInstaller = await readFile(path.resolve(import.meta.dirname, 'install-mi-imessage-stack-root.sh'), 'utf8');
  assert.doesNotMatch(stackInstaller, /MI_WEB_URL|localhost:8787/, 'Photon installer has no Web relay dependency');
  const webInstaller = await readFile(path.resolve(import.meta.dirname, 'install-mi-web-chat-systemd.sh'), 'utf8');
  assert.match(webInstaller, /MI_WEB_MAINTENANCE/, 'Web installer requires explicit maintenance mode');
  console.log('Mi web chat systemd installer checks passed.');
} finally {
  await rm(tmp, { recursive: true, force: true });
}
