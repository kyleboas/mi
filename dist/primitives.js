import { appendFile, mkdir, readFile } from 'node:fs/promises';
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
export async function writeRunRecord(run) {
    await mkdir(runsDir, { recursive: true });
    const file = path.join(runsDir, `${run.id}.json`);
    await BunWriteCompat(file, JSON.stringify(run, null, 2));
    await appendFile(runsLog, JSON.stringify(run) + '\n');
}
async function BunWriteCompat(file, content) {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(file, content);
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
