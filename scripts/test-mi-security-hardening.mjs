import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const cronSource = await readFile(new URL('../src/crons.ts', import.meta.url), 'utf8');
const daemonSource = await readFile(new URL('../pi/extensions/mi-daemon.mjs', import.meta.url), 'utf8');

assert.doesNotMatch(cronSource, /shell:\s*true/, 'Mi cron must not execute commands through a shell');
assert.match(cronSource, /spawn\(file, args, \{ cwd: cron\.cwd \|\| HOME, shell: false, env: cronEnv\(\) \}\)/, 'Mi cron must spawn parsed executable/args with shell disabled and reduced env');
assert.match(cronSource, /redactSecrets\(record\)/, 'Mi cron logs must redact secrets');
assert.match(cronSource, /writeFile\(CRONS_PATH,[\s\S]*mode: 0o600/, 'Mi cron state file must be written private');
assert.match(cronSource, /chmod\(dirname\(CRONS_PATH\), 0o700\)/, 'Mi cron state directory must be private');

assert.match(daemonSource, /chmod\(SOCKET_PATH, 0o600\)/, 'Mi daemon socket must be owner-only');
assert.match(daemonSource, /open\(LOCK_PATH, "wx", 0o600\)/, 'Mi daemon lock file must be private');
assert.match(daemonSource, /chmod\(dirname\(SOCKET_PATH\), 0o700\)/, 'Mi daemon runtime directory must be private');

console.log('Mi security hardening checks passed.');
