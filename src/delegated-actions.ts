import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { matchDelegation, readDelegations, type Delegation } from './delegations.js';
import { createRunRecord, finishRunRecord, writeRunRecord } from './primitives.js';
import { logEvent } from './state.js';

export type DelegatedActionDecision =
  | { ok: true; delegation: Delegation; remainingToday: number }
  | { ok: false; reason: string; delegation?: Delegation };

export type DelegatedActionResult = {
  status: 'delegated' | 'approval_required';
  message: string;
  delegationId?: string;
  runId?: string;
};

type BudgetState = {
  date?: string;
  counts?: Record<string, number>;
};

function delegationBudgetPath() {
  const miRoot = process.env.MI_ROOT || join(homedir(), 'assistant');
  const stateDir = resolve(miRoot, 'state');
  return process.env.MI_DELEGATION_BUDGET_PATH || join(stateDir, 'delegation-budget.json');
}

function configuredDelegationsPath() {
  const miRoot = process.env.MI_ROOT || join(homedir(), 'assistant');
  return process.env.MI_DELEGATIONS_PATH || join(resolve(miRoot), 'assistants', 'delegations.md');
}

function today() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

async function readBudgetState(): Promise<BudgetState> {
  try {
    const parsed = JSON.parse(await readFile(delegationBudgetPath(), 'utf8'));
    if (parsed?.date === today()) return parsed;
  } catch {}
  return { date: today(), counts: {} };
}

async function writeBudgetState(state: BudgetState) {
  const path = delegationBudgetPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(state, null, 2), { mode: 0o600 });
}

export async function reserveDelegation(prompt: string): Promise<DelegatedActionDecision> {
  const delegation = matchDelegation(prompt, await readDelegations(configuredDelegationsPath()));
  if (!delegation) return { ok: false, reason: 'no matching standing delegation' };
  const state = await readBudgetState();
  const used = state.counts?.[delegation.id] || 0;
  if (used >= delegation.dailyBudget) return { ok: false, reason: `daily budget exhausted for ${delegation.id}`, delegation };
  state.counts = { ...(state.counts || {}), [delegation.id]: used + 1 };
  await writeBudgetState(state);
  return { ok: true, delegation, remainingToday: delegation.dailyBudget - used - 1 };
}

export async function recordDelegatedAction(input: { prompt: string; result: string; verified: boolean; delegation: Delegation }) {
  let run = createRunRecord('delegated-action', { event: input.delegation.actionClass });
  run = {
    ...run,
    toolCalls: [{
      name: input.delegation.actionClass,
      startedAt: run.startedAt,
      input: { prompt: input.prompt, delegationId: input.delegation.id, verification: input.delegation.verification },
      output: { verified: input.verified, result: input.result },
    }],
  };
  const finished = finishRunRecord(run, input.verified ? 'ok' : 'needs_attention', `Delegation ${input.delegation.id}: ${input.result}`);
  await writeRunRecord(finished);
  await logEvent('delegated.action', { runId: finished.id, delegationId: input.delegation.id, verified: input.verified, result: input.result });
  return finished;
}

export async function planDelegatedAction(prompt: string): Promise<DelegatedActionResult> {
  const decision = await reserveDelegation(prompt);
  if (!decision.ok) return { status: 'approval_required', message: decision.reason, delegationId: decision.delegation?.id };
  const run = await recordDelegatedAction({
    prompt,
    delegation: decision.delegation,
    verified: false,
    result: `Delegated action reserved. Execute ${decision.delegation.actionClass}, verify: ${decision.delegation.verification}`,
  });
  return { status: 'delegated', delegationId: decision.delegation.id, runId: run.id, message: `Delegated under ${decision.delegation.id}; verification required: ${decision.delegation.verification}` };
}
