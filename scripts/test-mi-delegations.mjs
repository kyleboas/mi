import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseDelegations, readDelegations, matchDelegation, alwaysAskReason } from '../dist/src/delegations.js';
import { reserveDelegation, recordDelegatedAction } from '../dist/src/delegated-actions.js';
import { classify, classifyWithDelegations } from '../dist/src/policy.js';

const source = await readFile(new URL('../assistants/delegations.md', import.meta.url), 'utf8');
const miDocs = await readFile(new URL('../docs/mi.md', import.meta.url), 'utf8');
const architectureDocs = await readFile(new URL('../docs/architecture.md', import.meta.url), 'utf8');
const delegations = parseDelegations(source);
assert.ok(delegations.length >= 6, 'standing delegations file declares initial approved delegation classes');
assert.ok(delegations.some((item) => item.actionClass === 'restart_mi_owned_service' && item.mode === 'delegated'), 'Mi-owned service restarts are delegated');
assert.ok(/Always ask[\s\S]*merge[\s\S]*deploy[\s\S]*secrets[\s\S]*_posts/.test(source), 'delegations file records always-ask actions');
assert.doesNotMatch(`${miDocs}\n${architectureDocs}`, /Proactive Mi does not act on its own|It creates awareness only|never acts/i, 'docs no longer claim proactive Mi never acts');
assert.match(`${miDocs}\n${architectureDocs}`, /read-only[\s\S]*delegated[\s\S]*approval-required/, 'docs describe the three-tier runtime model');
assert.match(architectureDocs, /assistants\/delegations\.md[\s\S]*merge[\s\S]*deploy[\s\S]*secrets/, 'architecture docs name delegations and always-ask examples');

const serviceDelegation = matchDelegation('restart mi-web-chat.service and report to Kyle after it is active', delegations);
assert.equal(serviceDelegation?.actionClass, 'restart_mi_owned_service');
assert.equal(matchDelegation('deploy the site', delegations), undefined, 'always-ask action does not match delegation');
assert.match(alwaysAskReason('edit /home/kyle/code/tacticsjournal/_posts/example.md'), /always-ask/, 'Tactics Journal posts are always ask');

assert.equal(classify('deploy the site').mode, 'approval-required', 'sync classify keeps always-ask behavior');

const root = await mkdtemp(join(tmpdir(), 'mi-delegations-'));
try {
  const assistantDir = join(root, 'assistant', 'assistants');
  await mkdir(assistantDir, { recursive: true });
  await writeFile(join(assistantDir, 'delegations.md'), source);
  const loaded = await readDelegations(join(assistantDir, 'delegations.md'));
  assert.equal(loaded.length, delegations.length, 'readDelegations loads the markdown table');
} finally {
  await rm(root, { recursive: true, force: true });
}

const delegated = await classifyWithDelegations('restart mi-daemon.service, verify it is active, then report to Kyle');
assert.equal(delegated.mode, 'delegated');
assert.equal(delegated.delegationId, 'mi-service-restart');

const risky = await classifyWithDelegations('merge and deploy this branch');
assert.equal(risky.mode, 'approval-required');

const readOnly = await classifyWithDelegations('check service status');
assert.equal(readOnly.mode, 'pi-read-only');

const budgetRoot = await mkdtemp(join(tmpdir(), 'mi-delegation-budget-'));
try {
  process.env.MI_ROOT = join(budgetRoot, 'assistant');
  process.env.MI_DELEGATIONS_PATH = join(budgetRoot, 'assistant', 'assistants', 'delegations.md');
  process.env.MI_DELEGATION_BUDGET_PATH = join(budgetRoot, 'assistant', 'state', 'delegation-budget.json');
  await mkdir(join(budgetRoot, 'assistant', 'assistants'), { recursive: true });
  await writeFile(process.env.MI_DELEGATIONS_PATH, source.replace('| mi-service-restart | restart_mi_owned_service | mi-daemon.service, mi-web-chat.service, mi-flue.service, mi-tick.timer, mi-photon-bridge.service | 5 |', '| mi-service-restart | restart_mi_owned_service | mi-daemon.service, mi-web-chat.service, mi-flue.service, mi-tick.timer, mi-photon-bridge.service | 1 |'));
  const first = await reserveDelegation('restart mi-web-chat.service and report to Kyle');
  assert.equal(first.ok, true, 'first delegated action reserves budget');
  const second = await reserveDelegation('restart mi-web-chat.service and report to Kyle');
  assert.equal(second.ok, false, 'second delegated action is blocked by budget');
  assert.match(second.reason, /daily budget exhausted/, 'budget exhaustion has explicit reason');
  const run = await recordDelegatedAction({ prompt: 'restart mi-web-chat.service', delegation: first.delegation, verified: true, result: 'service active' });
  assert.equal(run.status, 'ok', 'verified delegated action records a successful run');
  assert.equal(run.toolCalls[0].input.delegationId, 'mi-service-restart', 'run record names the authorizing delegation');
} finally {
  delete process.env.MI_ROOT;
  delete process.env.MI_DELEGATIONS_PATH;
  delete process.env.MI_DELEGATION_BUDGET_PATH;
  await rm(budgetRoot, { recursive: true, force: true });
}

console.log('Mi delegation policy checks passed.');
