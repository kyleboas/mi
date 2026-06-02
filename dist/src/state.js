import { access, appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { redactSecrets } from './redact.js';
const stateDir = path.resolve('state');
const eventsFile = path.join(stateDir, 'events.jsonl');
const approvalsJsonlFile = path.join(stateDir, 'approvals.jsonl');
const approvalsJsonFile = path.join(stateDir, 'approvals.json');
const pausedFile = path.join(stateDir, 'PAUSED');
const killFile = path.join(stateDir, 'KILL');
export async function ensureState() {
    await mkdir(stateDir, { recursive: true });
}
export async function logEvent(type, data) {
    await ensureState();
    await appendFile(eventsFile, JSON.stringify({ ts: new Date().toISOString(), type, data: redactSecrets(data) }) + '\n');
}
function dedupeApprovals(items) {
    const seen = new Set();
    const out = [];
    for (const item of items) {
        if (seen.has(item.id))
            continue;
        seen.add(item.id);
        out.push(item);
    }
    return out;
}
export async function readApprovals() {
    await ensureState();
    const items = [];
    try {
        const lines = (await readFile(approvalsJsonlFile, 'utf8')).trim().split('\n').filter(Boolean);
        items.push(...lines.map((line) => JSON.parse(line)));
    }
    catch { }
    try {
        items.push(...JSON.parse(await readFile(approvalsJsonFile, 'utf8')));
    }
    catch { }
    return dedupeApprovals(items);
}
export async function writeApprovals(items) {
    await ensureState();
    const deduped = dedupeApprovals(items);
    await writeFile(approvalsJsonlFile, deduped.map((item) => JSON.stringify(item)).join('\n') + (deduped.length ? '\n' : ''));
    await writeFile(approvalsJsonFile, JSON.stringify(deduped, null, 2));
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
        prompt: String(redactSecrets(prompt)),
        reason: String(redactSecrets(reason)),
    };
    items.unshift(approval);
    await writeApprovals(items);
    await logEvent('approval.created', approval);
    return approval;
}
