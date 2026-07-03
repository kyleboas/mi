import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AssistantFile, Permissions, TriggerConfig } from './assistant.js';
import type { CapabilityAuditEvent, CapabilityGrant, Principal } from './capabilities.js';
import type { WorkerRequest, WorkerResult } from './workers.js';

export type Assistant = AssistantFile;
export type Trigger = TriggerConfig;
export type PermissionMap = Permissions;

export type ToolContext = {
  runId: string;
  assistant: Pick<Assistant, 'name' | 'permissions'>;
};

export type Tool<I = unknown, O = unknown> = {
  name: string;
  description: string;
  permissions?: string[];
  run(input: I, context: ToolContext): Promise<O>;
};

export type Worker = {
  kind: WorkerRequest['kind'];
  description: string;
  run(request: WorkerRequest): Promise<WorkerResult>;
};

export type RunStatus = 'started' | 'ok' | 'needs_attention' | 'approval_required' | 'error';

export type RunToolCall = {
  name: string;
  startedAt: string;
  finishedAt?: string;
  input?: unknown;
  output?: unknown;
  error?: string;
  capabilityIds?: string[];
};

export type RunApproval = {
  id?: string;
  status: 'pending' | 'approved' | 'rejected' | 'completed' | 'failed';
  reason: string;
  createdAt: string;
  resource?: string;
  rights?: string[];
  principal?: Principal;
  expiresAt?: string;
  capabilityId?: string;
};

export type RunRecord = {
  id: string;
  assistant: string;
  trigger: Trigger;
  status: RunStatus;
  startedAt: string;
  finishedAt?: string;
  principal?: Principal;
  capabilities: CapabilityGrant[];
  capabilityAudit: CapabilityAuditEvent[];
  toolCalls: RunToolCall[];
  workerResults: WorkerResult[];
  approvals: RunApproval[];
  result?: string;
};

const runsDir = path.resolve('state', 'runs');
const runsLog = path.resolve('state', 'runs.jsonl');

export function createRunRecord(assistant: string, trigger: Trigger): RunRecord {
  return {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    assistant,
    trigger,
    status: 'started',
    startedAt: new Date().toISOString(),
    capabilities: [],
    capabilityAudit: [],
    toolCalls: [],
    workerResults: [],
    approvals: [],
  };
}

export function finishRunRecord(run: RunRecord, status: Exclude<RunStatus, 'started'>, result: string): RunRecord {
  return {
    ...run,
    status,
    result,
    finishedAt: new Date().toISOString(),
  };
}

export function addToolCall(run: RunRecord, call: Omit<RunToolCall, 'startedAt'> & { startedAt?: string }): RunRecord {
  return {
    ...run,
    toolCalls: [...run.toolCalls, { ...call, startedAt: call.startedAt || new Date().toISOString() }],
  };
}

export function addWorkerResult(run: RunRecord, result: WorkerResult): RunRecord {
  return {
    ...run,
    workerResults: [...run.workerResults, result],
  };
}

export function addApproval(run: RunRecord, approval: Omit<RunApproval, 'createdAt'> & { createdAt?: string }): RunRecord {
  return {
    ...run,
    approvals: [...run.approvals, { ...approval, createdAt: approval.createdAt || new Date().toISOString() }],
  };
}

export function addCapabilityAudit(run: RunRecord, event: CapabilityAuditEvent): RunRecord {
  return {
    ...run,
    capabilityAudit: [...(run.capabilityAudit || []), event],
  };
}

export async function writeRunRecord(run: RunRecord) {
  await mkdir(runsDir, { recursive: true });
  const file = path.join(runsDir, `${run.id}.json`);
  await writeFile(file, JSON.stringify(run, null, 2));
  await appendFile(runsLog, JSON.stringify(run) + '\n');
}

export async function readRunRecords(limit = 50): Promise<RunRecord[]> {
  try {
    const text = await readFile(runsLog, 'utf8');
    return text
      .trim()
      .split('\n')
      .filter(Boolean)
      .slice(-limit)
      .map((line) => JSON.parse(line) as RunRecord);
  } catch {
    return [];
  }
}

export function defineTool<I, O>(tool: Tool<I, O>): Tool<I, O> {
  return tool;
}

export function defineWorker(worker: Worker): Worker {
  return worker;
}
