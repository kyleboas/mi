import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export type DelegationMode = 'delegated' | 'ask';

export type Delegation = {
  id: string;
  actionClass: string;
  scope: string;
  dailyBudget: number;
  verification: string;
  mode: DelegationMode;
};

const miRoot = process.env.MI_ROOT || join(homedir(), 'assistant');
export const delegationsPath = process.env.MI_DELEGATIONS_PATH || join(resolve(miRoot), 'assistants', 'delegations.md');

export function parseDelegations(markdown: string): Delegation[] {
  const entries: Delegation[] = [];
  for (const line of markdown.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|') || trimmed.includes('---') || /^\|\s*id\s*\|/i.test(trimmed)) continue;
    const cells = trimmed.split('|').slice(1, -1).map((cell) => cell.trim());
    if (cells.length < 6) continue;
    const [id, actionClass, scope, budget, verification, mode] = cells;
    if (!id || !actionClass || !scope || !verification) continue;
    entries.push({ id, actionClass, scope, dailyBudget: Math.max(0, Number(budget) || 0), verification, mode: mode === 'delegated' ? 'delegated' : 'ask' });
  }
  return entries;
}

export async function readDelegations(path = delegationsPath) {
  return parseDelegations(await readFile(path, 'utf8').catch(() => ''));
}

const alwaysAskPatterns = [
  /\bmerge\b/i,
  /\bdeploy\b/i,
  /\bpublish\b/i,
  /\bdns\b/i,
  /\bsecret|token|password|api key\b/i,
  /\bspend|buy|purchase|payment\b/i,
  /\bmessage\b(?![\s\S]*\bKyle\b)/i,
  /\/home\/kyle\/code\/tacticsjournal\/_posts\//i,
  /\b_posts\//i,
];

const delegationPatterns: Array<{ actionClass: string; pattern: RegExp }> = [
  { actionClass: 'restart_mi_owned_service', pattern: /\brestart\b[\s\S]*\b(mi-daemon|mi-web-chat|mi-flue|mi-tick|mi-photon-bridge)\.service|\bmi-[\w-]+\.service[\s\S]*\brestart\b/i },
  { actionClass: 'rerun_transient_job_once', pattern: /\brerun\b[\s\S]*\b(transient|safe|non-side-effectful|failed job|cron|pipeline job)\b/i },
  { actionClass: 'start_scoped_repair_worker', pattern: /\b(start|open|create|queue)\b[\s\S]*\b(scoped repair|repair worker|branch and pr|pull request)\b/i },
  { actionClass: 'file_or_update_github_issue', pattern: /\b(file|open|update|create)\b[\s\S]*\b(github issue|issue)\b/i },
  { actionClass: 'organize_mi_owned_state', pattern: /\b(organize|clean up|archive)\b[\s\S]*\b(mi state|mi-owned state|\/home\/kyle\/assistant\/state|\/home\/kyle\/mi)\b/i },
  { actionClass: 'send_kyle_report', pattern: /\b(send|write|append)\b[\s\S]*\b(report|brief|message)\b[\s\S]*\b(Kyle|main thread|iMessage)\b/i },
];

export function alwaysAskReason(prompt: string) {
  const hit = alwaysAskPatterns.find((pattern) => pattern.test(prompt));
  return hit ? `Matched always-ask pattern: ${hit}` : undefined;
}

export function matchDelegation(prompt: string, delegations: Delegation[]) {
  if (alwaysAskReason(prompt)) return undefined;
  const hit = delegationPatterns.find((item) => item.pattern.test(prompt));
  if (!hit) return undefined;
  return delegations.find((delegation) => delegation.mode === 'delegated' && delegation.actionClass === hit.actionClass && delegation.dailyBudget > 0);
}
