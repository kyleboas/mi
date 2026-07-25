#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { miCoordinatorLaunch, miCoordinatorPrompt } from './mi-imessage-coordinator.mjs';

const home = await mkdtemp(path.join(tmpdir(), 'mi-coordinator-fixture-'));
try {
  // These inert fixtures stand in for normal enabled and disabled Pi resources.
  // The coordinator deliberately lets Pi discover them through this HOME.
  const extensions = path.join(home, '.pi', 'agent', 'extensions');
  const skills = path.join(home, '.pi', 'agent', 'skills', 'fixture-skill');
  await mkdir(extensions, { recursive: true });
  await mkdir(skills, { recursive: true });
  await writeFile(path.join(extensions, 'fixture-enabled.ts'), 'export default function () {}\n');
  await writeFile(path.join(extensions, 'orchestrator.ts'), 'export default function () {}\n');
  await writeFile(path.join(extensions, 'fixture-disabled.ts.disabled'), 'export default function () {}\n');
  await writeFile(path.join(skills, 'SKILL.md'), '# Fixture skill\n');

  const guard = path.join(home, 'mi-capability-guard.ts');
  await writeFile(guard, 'export default function () {}\n');
  const launch = miCoordinatorLaunch({
    piCommand: '/fixture/bin/pi', cwd: path.join(home, 'workflows', 'project'), runtimeDir: path.join(home, 'runtime'), model: 'fixture-model', capabilityGuardPath: guard,
    env: { HOME: home, PI_CONFIG_DIR: path.join(home, '.pi') },
  });
  assert.equal(launch.env.HOME, home, 'coordinator keeps the normal Pi HOME for global resource discovery');
  assert.equal(launch.cwd, path.join(home, 'workflows', 'project'), 'coordinator uses the requested bounded project cwd so Pi applies normal project trust');
  assert.ok(launch.args.includes('--mode') && launch.args.includes('rpc'), 'coordinator is a noninteractive Pi RPC session');
  assert.ok(!launch.args.includes('--no-extensions'), 'coordinator does not suppress normal enabled global extensions');
  assert.ok(!launch.args.includes('--no-skills'), 'coordinator does not suppress normal enabled skills');
  assert.ok(!launch.args.includes('--no-context-files'), 'coordinator does not bypass normal project context or trust discovery');
  assert.deepEqual(launch.args.filter((value) => value === '--extension'), ['--extension'], 'coordinator explicitly adds only the Mi capability guard');
  assert.ok(launch.args.includes(guard), 'coordinator loads the Mi capability guard without disabling normal discovery');
  assert.ok(!launch.args.includes('--tools'), 'coordinator leaves normal discovered tools, including orchestrator tools, available');
  assert.equal(launch.env.MI_COORDINATOR_MODE, '1');

  const prompt = miCoordinatorPrompt({ message: 'Ask Terra to inspect this.', context: 'User: continue the earlier task' });
  assert.match(prompt, /orchestrator tools/, 'coordinator instructions expose the normal orchestrator path');
  assert.match(prompt, /Do not deploy/, 'coordinator instructions preserve Mi confirmation limits');
  assert.match(prompt, /continue the earlier task/, 'coordinator receives bounded conversation context');

  const daemonSource = await (await import('node:fs/promises')).readFile(new URL('../pi/extensions/mi-daemon.mjs', import.meta.url), 'utf8');
  assert.match(daemonSource, /"--no-extensions"/, 'restricted child workers still suppress ambient extensions');
  assert.match(daemonSource, /"--extension", MI_CAPABILITY_GUARD/, 'restricted child workers explicitly retain the Mi capability guard');
  console.log('Mi iMessage coordinator launch checks passed.');
} finally {
  await rm(home, { recursive: true, force: true });
}
