import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { cronPaths, readCrons } from './crons.js';
import { notify as sendNotification } from './notify.js';
import { logEvent, readApprovals } from './state.js';
import { appendThreadMessage } from './threads.js';
import { redactSecrets } from './redact.js';
const DEFAULT_DEDUPE_MS = Number(process.env.MI_PROACTIVE_DEDUPE_MS || 6 * 60 * 60_000);
const DAILY_DEDUPE_MS = 36 * 60 * 60_000;
const miRoot = process.env.MI_ROOT || join(homedir(), 'assistant');
const stateDir = resolve(miRoot, 'state');
const dedupePath = join(stateDir, 'proactive-dedupe.json');
function today() {
    return new Date().toISOString().slice(0, 10);
}
function compactLines(lines, empty = 'None.') {
    return lines.length > 0 ? lines.join('\n') : empty;
}
function noticeHash(checkId, notice) {
    return createHash('sha256')
        .update([checkId, notice.dedupeKey || notice.message].join('\u001f'))
        .digest('hex');
}
async function readDedupe() {
    try {
        return JSON.parse(await readFile(dedupePath, 'utf8'));
    }
    catch {
        return {};
    }
}
async function writeDedupe(state) {
    await mkdir(dirname(dedupePath), { recursive: true });
    await writeFile(dedupePath, JSON.stringify(state, null, 2));
}
async function alreadySeen(checkId, notice, force = false) {
    if (force)
        return false;
    const state = await readDedupe();
    const seen = state[noticeHash(checkId, notice)];
    if (!seen)
        return false;
    const ttl = notice.dedupeKey?.startsWith('dailyBrief:') ? DAILY_DEDUPE_MS : DEFAULT_DEDUPE_MS;
    return Date.now() - Date.parse(seen.lastSeenAt) < ttl;
}
async function remember(checkId, notice) {
    const state = await readDedupe();
    state[noticeHash(checkId, notice)] = { lastSeenAt: new Date().toISOString() };
    await writeDedupe(state);
}
export async function pendingApprovals() {
    const pending = (await readApprovals()).filter((approval) => approval.status === 'pending');
    if (pending.length === 0)
        return null;
    return {
        message: [
            pending.length === 1 ? 'Mi noticed 1 pending approval.' : `Mi noticed ${pending.length} pending approvals.`,
            'Pending:',
            compactLines(pending.slice(0, 10).map((approval) => `- ${approval.id}: ${approval.reason}`)),
        ].join('\n'),
        notify: true,
        dedupeKey: `pendingApprovals:${pending.map((approval) => approval.id).sort().join(',')}`,
    };
}
export async function failedCrons() {
    const crons = await readCrons().catch(() => []);
    const failed = crons.filter((cron) => cron.lastStatus === 'error');
    if (failed.length === 0)
        return null;
    const paths = cronPaths();
    return {
        message: [
            failed.length === 1 ? 'Mi noticed 1 failed cron run.' : `Mi noticed ${failed.length} failed cron runs.`,
            'Failed:',
            compactLines(failed.map((cron) => `- ${cron.name}: ${cron.lastOutput || 'failed'}`)),
            `State: ${paths.cronsPath}`,
            `Log: ${paths.logPath}`,
        ].join('\n'),
        notify: true,
        dedupeKey: `failedCrons:${failed.map((cron) => `${cron.name}:${cron.lastRunAt || ''}:${cron.lastOutput || ''}`).sort().join('|')}`,
    };
}
export async function dailyBrief() {
    if (process.env.MI_DAILY_BRIEF === 'false')
        return null;
    const pending = (await readApprovals()).filter((approval) => approval.status === 'pending');
    const crons = await readCrons().catch(() => []);
    const failed = crons.filter((cron) => cron.lastStatus === 'error');
    return {
        message: [
            'Daily Mi brief.',
            `Pending approvals: ${pending.length}`,
            `Failed crons: ${failed.length}`,
        ].join('\n'),
        notify: process.env.MI_DAILY_BRIEF_NOTIFY !== 'false',
        dedupeKey: `dailyBrief:${today()}`,
    };
}
export const checks = [
    { id: 'pendingApprovals', run: pendingApprovals },
    { id: 'failedCrons', run: failedCrons },
    { id: 'dailyBrief', run: dailyBrief },
];
const checkRegistry = new Map([
    ...checks.map((check) => [check.id, check]),
    ['pending-approvals', { id: 'pendingApprovals', run: pendingApprovals }],
    ['approval-reminders', { id: 'pendingApprovals', run: pendingApprovals }],
    ['failed-crons', { id: 'failedCrons', run: failedCrons }],
    ['crons', { id: 'failedCrons', run: failedCrons }],
    ['daily-brief', { id: 'dailyBrief', run: dailyBrief }],
    ['brief', { id: 'dailyBrief', run: dailyBrief }],
]);
function resolveChecks(ids) {
    if (!ids || ids.length === 0 || ids.includes('all'))
        return checks;
    return ids.map((id) => {
        const check = checkRegistry.get(id);
        if (!check)
            throw new Error(`unknown Mi proactive check: ${id}`);
        return check;
    });
}
function formatCheckMessage(notices) {
    if (notices.length === 0)
        return 'Mi check found no new notices.';
    const body = notices.map(({ notice }) => notice.message).join('\n\n');
    return String(redactSecrets(`${body}\n\nNo action taken.`));
}
export async function runMiCheck(options = {}) {
    const selectedChecks = resolveChecks(options.checkIds);
    const notices = [];
    const skipped = [];
    for (const check of selectedChecks) {
        let notice = null;
        try {
            notice = await check.run();
        }
        catch (error) {
            notice = {
                message: `Mi proactive check failed: ${check.id}\n${error instanceof Error ? error.message : String(error)}`,
                notify: true,
                dedupeKey: `checkError:${check.id}:${error instanceof Error ? error.message : String(error)}`,
            };
        }
        if (!notice)
            continue;
        if (await alreadySeen(check.id, notice, options.force)) {
            skipped.push({ checkId: check.id, notice, reason: 'deduped' });
            await logEvent('mi.check.deduped', { checkId: check.id, notice });
            continue;
        }
        notices.push({ checkId: check.id, notice });
        if (!options.dryRun)
            await remember(check.id, notice);
    }
    const message = formatCheckMessage(notices);
    let appended = false;
    let notified = false;
    if (notices.length > 0 && !options.dryRun) {
        await appendThreadMessage('main', 'assistant', message, { unread: true, source: 'mi:check' });
        appended = true;
    }
    if (options.notify !== false && notices.some(({ notice }) => notice.notify) && !options.dryRun) {
        await sendNotification('Mi check', message).catch(() => ({ skipped: true }));
        notified = true;
    }
    await logEvent('mi.check.complete', { checked: selectedChecks.map((check) => check.id), notices: notices.length, skipped: skipped.length, appended, notified });
    return {
        checked: selectedChecks.map((check) => check.id),
        notices,
        skipped,
        message,
        appended,
        notified,
    };
}
