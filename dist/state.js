import { access, appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
const stateDir = path.resolve('state');
const eventsFile = path.join(stateDir, 'events.jsonl');
const approvalsFile = path.join(stateDir, 'approvals.json');
const pausedFile = path.join(stateDir, 'PAUSED');
const killFile = path.join(stateDir, 'KILL');
export async function ensureState() {
    await mkdir(stateDir, { recursive: true });
}
export async function logEvent(type, data) {
    await ensureState();
    await appendFile(eventsFile, JSON.stringify({ ts: new Date().toISOString(), type, data }) + '\n');
}
export async function readApprovals() {
    await ensureState();
    try {
        return JSON.parse(await readFile(approvalsFile, 'utf8'));
    }
    catch {
        return [];
    }
}
export async function writeApprovals(items) {
    await ensureState();
    await writeFile(approvalsFile, JSON.stringify(items, null, 2));
}
export async function isPaused() {
    await ensureState();
    try {
        await access(pausedFile);
        return true;
    }
    catch {
        return false;
    }
}
export async function isKilled() {
    await ensureState();
    try {
        await access(killFile);
        return true;
    }
    catch {
        return false;
    }
}
export async function readRecentEvents(limit = 100) {
    await ensureState();
    try {
        const text = await readFile(eventsFile, 'utf8');
        return text.trim().split('\n').filter(Boolean).slice(-limit).map((line) => JSON.parse(line));
    }
    catch {
        return [];
    }
}
export async function createApproval(prompt, reason) {
    const items = await readApprovals();
    const approval = {
        id: Math.random().toString(36).slice(2, 10),
        createdAt: new Date().toISOString(),
        status: 'pending',
        prompt,
        reason,
    };
    items.unshift(approval);
    await writeApprovals(items);
    await logEvent('approval.created', approval);
    return approval;
}
