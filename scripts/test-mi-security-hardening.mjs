import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const cronSource = await readFile(new URL('../src/crons.ts', import.meta.url), 'utf8');
const daemonSource = await readFile(new URL('../pi/extensions/mi-daemon.mjs', import.meta.url), 'utf8');
const flueSource = await readFile(new URL('../src/flue.ts', import.meta.url), 'utf8');

assert.doesNotMatch(cronSource, /shell:\s*true/, 'Mi cron must not execute commands through a shell');
assert.match(cronSource, /spawn\(file, args, \{ cwd: cron\.cwd \|\| HOME, shell: false, env: cronEnv\(\) \}\)/, 'Mi cron must spawn parsed executable/args with shell disabled and reduced env');
assert.match(cronSource, /redactSecrets\(record\)/, 'Mi cron logs must redact secrets');
assert.match(cronSource, /writeFile\(CRONS_PATH,[\s\S]*mode: 0o600/, 'Mi cron state file must be written private');
assert.match(cronSource, /chmod\(dirname\(CRONS_PATH\), 0o700\)/, 'Mi cron state directory must be private');

assert.match(daemonSource, /chmod\(SOCKET_PATH, 0o600\)/, 'Mi daemon socket must be owner-only');
assert.match(daemonSource, /open\(LOCK_PATH, "wx", 0o600\)/, 'Mi daemon lock file must be private');
assert.match(daemonSource, /chmod\(dirname\(SOCKET_PATH\), 0o700\)/, 'Mi daemon runtime directory must be private');

assert.match(flueSource, /const flueConfigured = Boolean\(process\.env\.FLUE_URL \|\| process\.env\.FLUE_CHAT_URL \|\| process\.env\.FLUE_CMD/, 'Mi chat must not try slow Flue CLI unless Flue is configured');
assert.match(flueSource, /return runPiChat\(message,[\s\S]*'Flue not configured'/, 'Mi chat must default to the pi fallback when Flue is unconfigured');
assert.match(flueSource, /function directChatReply\(message: string\)/, 'Mi chat must fast-path simple conversational replies');
assert.match(flueSource, /const chatTools = process\.env\.MI_CHAT_TOOLS \|\| 'read,bash'/, 'Mi chat fallback must expose read-only inspection tools by default');
assert.match(flueSource, /Tool use is read-only:[\s\S]*[Dd]o not edit files/, 'Mi chat fallback must constrain tool use to safe inspection');
assert.doesNotMatch(flueSource, /--tools', '', prompt/, 'Mi chat fallback must not disable all tools');

console.log('Mi security hardening checks passed.');
