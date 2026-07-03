import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const monitorSource = await import('node:fs/promises').then((fs) => fs.readFile(new URL('../src/imessage-monitor.ts', import.meta.url), 'utf8'));
assert.match(monitorSource, /state\/imessage-monitor\.jsonl|imessage-monitor\.jsonl/, 'monitor has a dedicated incident JSONL log');
assert.match(monitorSource, /sudo'\, \['-n', 'systemctl', 'restart'/, 'monitor supports a narrow noninteractive privileged bridge restart path');
assert.match(monitorSource, /MI_IMESSAGE_MONITOR_INTERVAL_MS \|\| 15 \* 60_000/, 'monitor defaults to a 15-minute cadence');
assert.match(monitorSource, /imessageNotify\('Mi iMessage bridge fixed'/, 'successful repair is confirmed over iMessage');
assert.match(monitorSource, /pushoverNotify\('Mi iMessage bridge needs help'/, 'unrepaired bridge failures fall back to Pushover');

const root = await mkdtemp(join(tmpdir(), 'mi-imessage-monitor-'));
try {
  const runner = join(root, 'run-monitor-tests.mjs');
  await writeFile(runner, `
    import assert from 'node:assert/strict';
    process.env.MI_ROOT = ${JSON.stringify(join(root, 'assistant'))};
    process.env.HOME = ${JSON.stringify(root)};
    process.env.MI_IMESSAGE_MONITOR_VERIFY_DELAY_MS = '0';
    process.env.MI_IMESSAGE_MONITOR_INTERVAL_MS = '900000';
    const monitor = await import(${JSON.stringify(new URL('../src/imessage-monitor.ts', import.meta.url).href)});

    const now = new Date('2026-06-24T12:00:00Z');
    const oldUser = { id: '1', threadId: 'main', role: 'user', text: 'personal secret message body that should only preview', ts: new Date(now.getTime() - 240000).toISOString(), source: 'imessage' };
    assert.equal(monitor.analyzeThreadMessages([oldUser], now, 180000)[0].code, 'imessage-stuck-reply', 'stuck iMessage messages are detected');
    assert.equal(monitor.serviceNeedsRestart([{ code: 'photon-log-error', severity: 'error', detail: 'x' }]), true, 'photon send errors are repairable by restart');
    const redacted = monitor.analyzePhotonLogs('photon send failed permanently: TOKEN=abc123456789 https://example.com/private?x=1')[0].detail;
    assert.equal(redacted.includes('https://example.com'), false, 'log previews omit URLs');
    assert.equal(redacted.includes('abc123456789'), false, 'log previews redact secret-looking values');

    let notifyCalls = 0;
    let commandCalls = 0;
    const healthyDeps = {
      now: () => now,
      fetch: async () => new Response('not found', { status: 404 }),
      readMessages: async () => [],
      notifyImessage: async () => { notifyCalls += 1; return { ok: true }; },
      notifyPushover: async () => ({ skipped: true }),
      appendMain: async () => undefined,
      runCommand: async (cmd, args) => {
        commandCalls += 1;
        if (args.includes('is-active')) return { ok: true, code: 0, stdout: 'active\\n', stderr: '' };
        if (cmd === 'journalctl') return { ok: true, code: 0, stdout: 'photon send ok\\n', stderr: '' };
        return { ok: true, code: 0, stdout: '', stderr: '' };
      },
    };
    const first = await monitor.runImessageMonitor(healthyDeps);
    const second = await monitor.runImessageMonitor(healthyDeps);
    assert.equal(first.status, 'healthy', 'healthy bridge stays silent');
    assert.equal(second.status, 'skipped', 'second run is skipped by interval state');
    assert.equal(notifyCalls, 0, 'healthy checks do not send test iMessages or notifications');
    assert.ok(commandCalls > 0, 'first healthy run inspected the bridge');

    process.env.MI_IMESSAGE_MONITOR_INTERVAL_MS = '0';
    let phase = 'before';
    const repairs = [];
    let successNotify = 0;
    const repaired = await monitor.runImessageMonitor({
      now: () => new Date('2026-06-24T12:20:00Z'),
      fetch: async () => new Response('not found', { status: 404 }),
      readMessages: async () => [],
      appendMain: async () => { throw new Error('should not fall back on repaired bridge'); },
      notifyImessage: async (_title, message) => { successNotify += 1; assert.match(message, /looks healthy again/, 'success notification is human-readable'); return { ok: true }; },
      notifyPushover: async () => { throw new Error('pushover should not be used on successful iMessage confirmation'); },
      runCommand: async (cmd, args) => {
        if (cmd === 'systemctl' && args.includes('restart')) { repairs.push(args.at(-1)); phase = 'after'; return { ok: true, code: 0, stdout: 'restarted', stderr: '' }; }
        if (cmd === 'sudo') { repairs.push(args.at(-1)); phase = 'after'; return { ok: true, code: 0, stdout: 'restarted', stderr: '' }; }
        if (args.includes('is-active')) return phase === 'before' ? { ok: false, code: 3, stdout: 'inactive\\n', stderr: '' } : { ok: true, code: 0, stdout: 'active\\n', stderr: '' };
        if (cmd === 'journalctl') return { ok: true, code: 0, stdout: phase === 'before' ? 'photon send failed permanently: network\\n' : 'photon send ok\\n', stderr: '' };
        return { ok: true, code: 0, stdout: '', stderr: '' };
      },
    });
    assert.equal(repaired.status, 'repaired', 'repairable anomalies are restarted and verified');
    assert.ok(repairs.includes('mi-photon-bridge.service'), 'bridge service is restarted');
    assert.ok(repairs.includes('mi-web-chat.service'), 'Mi web user service is restarted as part of safe repair');
    assert.equal(successNotify, 1, 'successful repair sends exactly one iMessage confirmation');

    let appended = '';
    let pushover = 0;
    const unrepaired = await monitor.runImessageMonitor({
      now: () => new Date('2026-06-24T12:40:00Z'),
      fetch: async () => { throw new Error('connection refused'); },
      readMessages: async () => [],
      appendMain: async (text) => { appended = text; },
      notifyImessage: async () => { throw new Error('iMessage should not be used for unrepaired fallback'); },
      notifyPushover: async (_title, text) => { pushover += 1; assert.match(text, /could not repair/i); return { ok: true }; },
      runCommand: async (cmd, args) => {
        if (args.includes('restart')) return { ok: false, code: 1, stdout: '', stderr: 'permission denied' };
        if (cmd === 'sudo') return { ok: false, code: 1, stdout: '', stderr: 'sudo unavailable' };
        if (args.includes('is-active')) return { ok: false, code: 3, stdout: 'inactive\\n', stderr: '' };
        if (cmd === 'journalctl') return { ok: true, code: 0, stdout: 'mi photon fatal auth failed\\n', stderr: '' };
        return { ok: false, code: 1, stdout: '', stderr: '' };
      },
    });
    assert.equal(unrepaired.status, 'unrepaired', 'unfixed failures are reported as unrepaired');
    assert.match(appended, /could not repair/i, 'unrepaired failures are written to Mi main');
    assert.equal(pushover, 1, 'unrepaired failures send Pushover fallback');
  `);
  const tsx = new URL('../node_modules/.bin/tsx', import.meta.url).pathname;
  const result = spawnSync(process.execPath, [tsx, runner], { cwd: root, env: { ...process.env, HOME: root, MI_ROOT: join(root, 'assistant'), PUSHOVER_USER: '', PUSHOVER_TOKEN: '' }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log('Mi iMessage monitor checks passed.');
