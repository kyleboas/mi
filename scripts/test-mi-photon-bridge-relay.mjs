#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const repoRoot = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const root = await mkdtemp(join(tmpdir(), 'mi-photon-runtime-'));
const miRoot = join(root, 'assistant');
const work = join(root, 'work');
const bin = join(root, 'bin');
const events = join(root, 'events.json');
const sends = join(root, 'sends.jsonl');
const prompts = join(root, 'prompts.jsonl');
try {
  await mkdir(join(miRoot, 'pi', 'extensions'), { recursive: true, mode: 0o700 });
  await cp(join(repoRoot, 'pi', 'extensions'), join(miRoot, 'pi', 'extensions'), { recursive: true });
  await mkdir(work, { recursive: true, mode: 0o700 });
  await mkdir(bin, { recursive: true, mode: 0o700 });
  const fakePi = join(bin, 'pi');
  await writeFile(fakePi, `#!/usr/bin/env node
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
let buffer = '';
let settled = false;
process.stdin.on('data', async (chunk) => {
  buffer += chunk.toString();
  if (settled || !buffer.includes('\\n')) return;
  settled = true;
  const session = process.argv[process.argv.indexOf('--session') + 1];
  await mkdir(dirname(session), { recursive: true });
  await appendFile(session + '.prompts', JSON.stringify({ argv: process.argv.slice(2) }) + '\\n');
  await writeFile(session, JSON.stringify({ type: 'session', prompt: JSON.parse(buffer).message }) + '\\n', { mode: 0o600 });
  console.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'The durable answer.' }] } }));
  console.log(JSON.stringify({ type: 'agent_settled' }));
});
`, { mode: 0o755 });
  const event = {
    space: { id: 'space-one', phone: '+15551234567' },
    message: { id: 'upstream-one', timestamp: '2026-01-01T00:00:00Z', direction: 'inbound', sender: { id: '+15551234567' }, content: { type: 'text', text: 'List my Divernote tasks' } },
  };
  const missingIdentity = {
    space: { id: 'space-one', phone: '+15551234567' },
    message: { timestamp: '2026-01-01T00:00:01Z', direction: 'inbound', sender: { id: '+15551234567' }, content: { type: 'text', text: 'retry me' } },
  };
  await writeFile(events, JSON.stringify([event, structuredClone(event), missingIdentity]));
  await writeFile(sends, '');
  const child = spawn(process.execPath, ['scripts/mi-photon-bridge.mjs'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      MI_ROOT: miRoot,
      MI_IMESSAGE_WORKSPACE_ROOT: work,
      MI_IMESSAGE_WORKSPACE_CWD: work,
      MI_DAEMON_PATH: join(miRoot, 'pi', 'extensions', 'mi-daemon.mjs'),
      PI_CMD: fakePi,
      PHOTON_PROJECT_ID: 'test-project',
      PHOTON_PROJECT_SECRET: 'test-secret',
      PHOTON_ALLOWED_USERS: '+15551234567',
      PHOTON_BOOT_TEST_SEND: '0',
      MI_PHOTON_NOTIFY_PORT: '0',
      MI_PHOTON_TEST: '1',
      MI_PHOTON_TEST_EVENTS: events,
      MI_PHOTON_TEST_SENDS: sends,
      MI_IMESSAGE_COORDINATOR_TIMEOUT_MS: '5000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  const status = await new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  assert.equal(status, 0, `${stdout}\n${stderr}`);
  const sent = (await readFile(sends, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse).filter((entry) => entry.kind === 'message');
  assert.equal(sent.length, 2, 'duplicate delivery starts no second Pi turn');
  assert.ok(sent.some((entry) => entry.text === 'The durable answer.'), `runtime sends the completed Pi reply: ${JSON.stringify(sent)}\n${stdout}\n${stderr}`);
  assert.ok(sent.some((entry) => entry.text === 'Please retry that message. I need its upstream ID and timestamp before I can process it.'), 'missing upstream identity gets the fixed retry request');
  const conversationRoot = join(miRoot, 'state', 'imessage', 'conversations');
  assert.ok(existsSync(conversationRoot), 'runtime state was created under state/imessage');
  const conversations = await (await import('node:fs/promises')).readdir(conversationRoot);
  const promptLines = (await readFile(join(conversationRoot, conversations[0], 'session.jsonl.prompts'), 'utf8')).trim().split('\n').filter(Boolean);
  assert.equal(promptLines.length, 1, 'one upstream delivery creates exactly one Pi prompt');
  const args = JSON.parse(promptLines[0]).argv;
  assert.ok(args.includes('--session'), 'Pi receives a durable session path');
  const coordinatorSession = JSON.parse(await readFile(join(conversationRoot, conversations[0], 'session.jsonl'), 'utf8'));
  assert.match(coordinatorSession.prompt, /Divernote access for this current objective is read/, 'the verified configured Photon sender receives the scoped Divernote prompt');
  assert.ok(!args.includes('--session-dir') && !args.includes('--no-session'), 'Pi receives no session fallback flags');
  assert.equal(conversations.length, 1, 'space identity creates one conversation directory');
  const deliveryRoot = join(conversationRoot, conversations[0], 'deliveries');
  const deliveryFiles = await (await import('node:fs/promises')).readdir(deliveryRoot);
  assert.equal(deliveryFiles.length, 1, 'delivery state is retained');
  const record = JSON.parse(await readFile(join(deliveryRoot, deliveryFiles[0]), 'utf8'));
  assert.equal(record.status, 'sent', 'delivery is marked sent after Photon send success');
  assert.equal('rawMessage' in record, false, 'completed delivery state erases raw message text');
  assert.equal((await stat(join(conversationRoot, conversations[0]))).mode & 0o777, 0o700, 'conversation directory is private');
  assert.equal((await stat(join(deliveryRoot, deliveryFiles[0]))).mode & 0o777, 0o600, 'delivery record is private');
  console.log('Mi Photon direct runtime checks passed.');
} finally {
  await rm(root, { recursive: true, force: true });
}
