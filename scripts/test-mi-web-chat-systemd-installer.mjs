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
  const stackInstaller = await readFile(path.resolve(import.meta.dirname, 'install-mi-imessage-stack-root.sh'), 'utf8');
  assert.match(stackInstaller, /override_lines\[@\][\s\S]*Environment=MI_WEB_URL=/, 'stack installer recognizes the obsolete single-setting override');
  assert.match(stackInstaller, /override_lines\[1\][\s\S]*127\.0\.0\.1:8787[\s\S]*rm -f/, 'stack installer preserves the canonical loopback value and removes stale values');
  console.log('Mi web chat systemd installer checks passed.');
} finally {
  await rm(tmp, { recursive: true, force: true });
}
