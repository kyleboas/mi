import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
const runsDir = path.resolve('state', 'runs');
const runsLog = path.resolve('state', 'runs.jsonl');
export function createRunRecord(assistant, trigger) {
    return {
        id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        assistant,
        trigger,
        status: 'started',
        startedAt: new Date().toISOString(),
        toolCalls: [],
        workerResults: [],
        approvals: [],
    };
}
export function finishRunRecord(run, status, result) {
    return {
        ...run,
        status,
        result,
        finishedAt: new Date().toISOString(),
    };
}
export function addToolCall(run, call) {
    return {
        ...run,
        toolCalls: [...run.toolCalls, { ...call, startedAt: call.startedAt || new Date().toISOString() }],
    };
}
export function addWorkerResult(run, result) {
    return {
        ...run,
        workerResults: [...run.workerResults, result],
    };
}
export function addApproval(run, approval) {
    return {
        ...run,
        approvals: [...run.approvals, { ...approval, createdAt: approval.createdAt || new Date().toISOString() }],
    };
}
export async function writeRunRecord(run) {
    await mkdir(runsDir, { recursive: true });
    const file = path.join(runsDir, `${run.id}.json`);
    await writeFile(file, JSON.stringify(run, null, 2));
    await appendFile(runsLog, JSON.stringify(run) + '\n');
}
export async function readRunRecords(limit = 50) {
    try {
        const text = await readFile(runsLog, 'utf8');
        return text
            .trim()
            .split('\n')
            .filter(Boolean)
            .slice(-limit)
            .map((line) => JSON.parse(line));
    }
    catch {
        return [];
    }
}
export function defineTool(tool) {
    return tool;
}
export function defineWorker(worker) {
    return worker;
}
