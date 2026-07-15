import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, chmod, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const tmp = await mkdtemp(path.join(os.tmpdir(), 'mi-web-unit-'));
try {
  const bin = path.join(tmp, 'bin');
  await mkdir(bin);
  await writeFile(path.join(bin, 'tailscale'), '#!/bin/sh\nprintf \'%s\\n\' \'{"Self":{"DNSName":"main.example.ts.net."}}\'\n');
  await writeFile(path.join(bin, 'systemctl'), '#!/bin/sh\nexit 0\n');
  await chmod(path.join(bin, 'tailscale'), 0o755);
  await chmod(path.join(bin, 'systemctl'), 0o755);
  const dropinDir = path.join(tmp, 'config/systemd/user/mi-web-chat.service.d');
  await mkdir(dropinDir, { recursive: true });
  await writeFile(path.join(dropinDir, '20-mi-gateway-client.conf'), `[Service]\nEnvironment=MI_GATEWAY_CLIENT=${tmp}/.local/share/mi/mi-gateway-client.py\n`);
  await writeFile(path.join(dropinDir, '30-nvm-pi-path.conf'), '[Service]\nEnvironment=OPERATOR_OVERRIDE=preserve\n');
  const result = spawnSync('bash', ['scripts/install-mi-web-chat-systemd.sh'], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: { ...process.env, HOME: tmp, XDG_CONFIG_HOME: path.join(tmp, 'config'), PATH: `${bin}:${process.env.PATH}` },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const unit = await readFile(path.join(tmp, 'config/systemd/user/mi-web-chat.service'), 'utf8');
  assert.match(unit, /tailscale cert[^\n]+main\.example\.ts\.net\.crt[^\n]+main\.example\.ts\.net\.key main\.example\.ts\.net/);
  assert.doesNotMatch(unit, /hermes/);
  assert.match(unit, /Wants=llm-gateway\.service/);
  assert.match(unit, /After=network-online\.target llm-gateway\.service/);
  const dropin = await readFile(path.join(dropinDir, '10-mi-runtime.conf'), 'utf8');
  const expectedNvmPiBin = `${tmp}/.nvm/versions/node/v24.15.0/bin`;
  assert.match(dropin, /Environment=MI_GATEWAY_CLIENT=.*\.local\/share\/mi\/mi-gateway-client\.py/);
  assert.match(dropin, /Environment=PI_CMD=.*\/bin\/pi-gateway/);
  assert.match(dropin, new RegExp(`Environment=PATH=${expectedNvmPiBin.replace(/[./]/g, '\\$&')}:/usr/local/bin:/usr/bin:/bin`));
  assert.equal(dropin.split('Environment=PATH=')[1].split(':')[0], expectedNvmPiBin, 'deployed service PATH resolves pi from the supported NVM directory first');
  await assert.rejects(readFile(path.join(dropinDir, '20-mi-gateway-client.conf')), /ENOENT/, 'exact known helper duplicate is removed');
  assert.match(await readFile(path.join(dropinDir, '30-nvm-pi-path.conf'), 'utf8'), /OPERATOR_OVERRIDE/, 'unknown override is preserved');
  const stackInstaller = await readFile(path.resolve(import.meta.dirname, 'install-mi-imessage-stack-root.sh'), 'utf8');
  assert.match(stackInstaller, /known_obsolete=.*localhost:8787/, 'stack installer identifies one exact obsolete loopback spelling');
  assert.match(stackInstaller, /Preserved unknown or modified Photon override/, 'stack installer preserves arbitrary administrator files');
  console.log('Mi web chat systemd installer checks passed.');
} finally {
  await rm(tmp, { recursive: true, force: true });
}
