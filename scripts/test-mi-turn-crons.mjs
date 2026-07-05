import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'mi-turn-crons-'));
process.chdir(root);
process.env.HOME = root;
process.env.MI_ROOT = root;
process.env.FLUE_ENABLED = 'false';
process.env.MI_TURN_CRONS_PER_TICK = '1';

const { upsertCron, tickCrons, readCrons, runCron } = await import('../dist/src/crons.js');
const { readThreadMessages } = await import('../dist/src/threads.js');

await assert.rejects(() => upsertCron({ name: 'bad', enabled: true, every: '1m', message: 'x', prompt: 'y' }), /exactly one/);
await assert.rejects(() => upsertCron({ name: 'bad-thread', enabled: true, every: '1m', message: 'x', thread: 'main' }), /thread/);

await upsertCron({ name: 'turn', enabled: true, every: '1m', prompt: 'summarize', thread: 'main' });
let ran = await tickCrons({ flueChat: async (prompt) => ({ ok: true, source: 'test', reply: `saw ${prompt.includes('Scheduled Mi turn cron fired')}` }) });
assert.deepEqual(ran, [{ name: 'turn', status: 'ok' }]);
let messages = await readThreadMessages('main');
assert.equal(messages.at(-1).source, 'cron:turn');
assert.equal(messages.at(-1).text, 'saw true');
let log = await readFile(join(root, 'mi/state/cron-runs.jsonl'), 'utf8');
assert.match(log, /"status":"ok"/);
assert.match(await readFile(join(process.cwd(), 'state/events.jsonl'), 'utf8').catch(() => ''), /mi\.cron\.turn/);

await upsertCron({ name: 'err', enabled: true, every: '1m', prompt: 'fail' });
ran = await tickCrons({ turnCronLimit: 5, flueChat: async () => ({ ok: false, source: 'test', reply: '', error: 'model down' }) });
assert.ok(ran.some((item) => item.name === 'err' && item.status === 'error'));
assert.equal((await readCrons()).find((cron) => cron.name === 'err').enabled, true);

await upsertCron({ name: 'cap1', enabled: true, every: '1m', prompt: 'one' });
await upsertCron({ name: 'cap2', enabled: true, every: '1m', prompt: 'two' });
ran = await tickCrons({ turnCronLimit: 1, flueChat: async () => ({ ok: true, source: 'test', reply: 'ok' }) });
assert.equal(ran.filter((item) => item.status === 'ok').length, 1);
assert.ok(ran.some((item) => item.status === 'skipped'));

const long = 'x'.repeat(4100);
const result = await runCron({ name: 'long', enabled: true, every: '1m', prompt: 'long' }, { flueChat: async () => ({ ok: true, source: 'test', reply: long }) });
assert.ok(result.output.length < long.length);
assert.match(result.output, /truncated to 4000 chars/);

const slow = runCron({ name: 'overlap', enabled: true, every: '1m', prompt: 'slow' }, { flueChat: async () => new Promise((resolve) => setTimeout(() => resolve({ ok: true, source: 'test', reply: 'done' }), 100)) });
const skipped = await runCron({ name: 'overlap', enabled: true, every: '1m', prompt: 'slow' }, { flueChat: async () => ({ ok: true, source: 'test', reply: 'never' }) });
assert.equal(skipped.status, 'skipped');
await slow;

console.log('test-mi-turn-crons ok');
