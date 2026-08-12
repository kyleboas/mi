#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'pi-agents-'));
const state = join(root, 'agents.json');
const fakePi = join(root, 'fake-pi.mjs');
await writeFile(fakePi, `
let buffer = '';
process.stdin.on('data', (chunk) => {
 buffer += chunk;
 while (buffer.includes('\\n')) {
  const line = buffer.slice(0, buffer.indexOf('\\n')); buffer = buffer.slice(buffer.indexOf('\\n') + 1);
  const cmd = JSON.parse(line);
  if (cmd.type === 'get_state') console.log(JSON.stringify({type:'response', command:'get_state', success:true, data:{sessionFile:'/tmp/test.jsonl',sessionId:'test-id',sessionName:'test'}}));
  if (cmd.type === 'prompt') { console.log(JSON.stringify({type:'response',command:'prompt',success:true})); console.log(JSON.stringify({type:'agent_start'})); console.log(JSON.stringify({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'done'}})); console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'done'}]}})); setTimeout(() => console.log(JSON.stringify({type:'agent_settled'})), 150); }
  if (cmd.type === 'abort') console.log(JSON.stringify({type:'response',command:'abort',success:true}));
 }
});
`);
process.env.PI_AGENTS_STATE_PATH = state;
process.env.PI_AGENTS_PI_COMMAND = process.execPath;
process.env.PI_AGENTS_PI_ARGS = JSON.stringify([fakePi]);
const { PiAgentsManager } = await import('../dist/src/pi-agents-manager.js');
const manager = new PiAgentsManager();
try {
  const agent = await manager.start({ name: 'first', cwd: root, prompt: 'hello' });
  for (let i = 0; i < 20 && !manager.get(agent.id)?.text; i++) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(manager.get(agent.id)?.status, 'running');
  assert.equal(manager.get(agent.id)?.text, 'done');
  assert.equal(manager.get(agent.id)?.sessionFile, '/tmp/test.jsonl');
  await assert.rejects(() => manager.start({ name: 'collision', cwd: root, prompt: 'write' }), /write-capable Pi Agent/);
  await new Promise((resolve) => setTimeout(resolve, 180));
  assert.equal(manager.get(agent.id)?.status, 'complete');
  await assert.rejects(() => manager.start({ name: 'settled-collision', cwd: root, prompt: 'write' }), /write-capable Pi Agent/);
  const reviewer = await manager.start({ name: 'review', cwd: root, prompt: 'review', readOnly: true });
  assert.equal(manager.get(reviewer.id)?.readOnly, true);
  await manager.stop(reviewer.id);
  console.log('Pi Agents manager checks passed.');
} finally {
  manager.dispose();
  await rm(root, { recursive: true, force: true });
}
