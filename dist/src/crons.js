import { appendFile, chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { notify } from './notify.js';
import { appendThreadMessage } from './threads.js';
import { redactSecrets } from './redact.js';
const HOME = process.env.HOME || homedir();
const STATE_DIR = join(HOME, 'mi', 'state');
const CRONS_PATH = join(STATE_DIR, 'crons.json');
const LOG_PATH = join(STATE_DIR, 'cron-runs.jsonl');
function now() { return new Date().toISOString(); }
export function intervalToMs(value) {
    const match = value.trim().match(/^(\d+)\s*(s|m|h|d)$/i);
    if (!match)
        return undefined;
    const amount = Number(match[1]);
    const unit = match[2].toLowerCase();
    if (unit === 's')
        return amount * 1000;
    if (unit === 'm')
        return amount * 60_000;
    if (unit === 'h')
        return amount * 60 * 60_000;
    if (unit === 'd')
        return amount * 24 * 60 * 60_000;
    return undefined;
}
async function ensureState() {
    await mkdir(dirname(CRONS_PATH), { recursive: true, mode: 0o700 });
    await chmod(dirname(CRONS_PATH), 0o700).catch(() => undefined);
}
export async function readCrons() {
    await ensureState();
    if (!existsSync(CRONS_PATH))
        return [];
    return JSON.parse(await readFile(CRONS_PATH, 'utf8'));
}
export async function writeCrons(crons) {
    await ensureState();
    await writeFile(CRONS_PATH, JSON.stringify(crons, null, 2), { mode: 0o600 });
    await chmod(CRONS_PATH, 0o600).catch(() => undefined);
}
export async function upsertCron(cron) {
    if (cron.every) {
        const ms = intervalToMs(cron.every);
        if (!ms || ms < 60_000)
            throw new Error('cron interval must be like 1m, 10m, 1h, 1d and at least 1m');
    }
    else if (cron.at) {
        if (!Number.isFinite(Date.parse(cron.at)))
            throw new Error('reminder time must be an ISO timestamp');
    }
    else {
        throw new Error('cron needs either every or at');
    }
    const crons = await readCrons();
    const index = crons.findIndex((item) => item.name === cron.name);
    if (index >= 0)
        crons[index] = { ...crons[index], ...cron };
    else
        crons.push(cron);
    await writeCrons(crons);
    return cron;
}
export async function removeCron(name) {
    const crons = await readCrons();
    const next = crons.filter((cron) => cron.name !== name);
    await writeCrons(next);
    return crons.length - next.length;
}
function due(cron, at = Date.now()) {
    if (!cron.enabled)
        return false;
    if (cron.at)
        return Date.parse(cron.at) <= at;
    const ms = cron.every ? intervalToMs(cron.every) : undefined;
    if (!ms)
        return false;
    if (!cron.lastRunAt)
        return true;
    return at - Date.parse(cron.lastRunAt) >= ms;
}
function formatCronErrorMessage(cron, output) {
    const detail = output.trim() || 'No output captured.';
    return `Mi cron error: ${cron.name}\n\n${detail}\n\nState: ${CRONS_PATH}\nLog: ${LOG_PATH}`;
}
async function surfaceCronError(cron, output) {
    const message = formatCronErrorMessage(cron, output);
    await appendThreadMessage('main', 'assistant', message, { unread: true, source: 'mi-cron' });
    await notify(`Mi cron error: ${cron.name}`, message).catch(() => ({ skipped: true }));
}
function redactOutput(output) {
    return String(redactSecrets(output));
}
function splitCronCommand(command) {
    const parts = [];
    let current = '';
    let quote;
    let escaped = false;
    for (const char of command.trim()) {
        if (escaped) {
            current += char;
            escaped = false;
            continue;
        }
        if (char === '\\' && quote !== 'single') {
            escaped = true;
            continue;
        }
        if (char === "'" && quote !== 'double') {
            quote = quote === 'single' ? undefined : 'single';
            continue;
        }
        if (char === '"' && quote !== 'single') {
            quote = quote === 'double' ? undefined : 'double';
            continue;
        }
        if (!quote && /\s/.test(char)) {
            if (current)
                parts.push(current);
            current = '';
            continue;
        }
        current += char;
    }
    if (escaped || quote)
        throw new Error('cron command has unfinished escape or quote');
    if (current)
        parts.push(current);
    if (!parts.length)
        throw new Error('cron command is empty');
    if (parts.some((part) => /[;&|`$<>]/.test(part)))
        throw new Error('cron command contains shell metacharacters; use a simple executable plus args');
    return { file: parts[0], args: parts.slice(1) };
}
function cronEnv() {
    const keys = ['HOME', 'USER', 'LOGNAME', 'PATH', 'SHELL', 'LANG', 'LC_ALL', 'TERM'];
    return Object.fromEntries(keys.flatMap((key) => process.env[key] ? [[key, process.env[key]]] : []));
}
async function appendCronLog(record) {
    await ensureState();
    await appendFile(LOG_PATH, `${JSON.stringify(redactSecrets(record))}\n`, { mode: 0o600 });
    await chmod(LOG_PATH, 0o600).catch(() => undefined);
}
export async function runCron(cron) {
    const startedAt = now();
    if (cron.message && !cron.command) {
        await appendThreadMessage('main', 'assistant', cron.message, { unread: true, source: 'mi-reminder' });
        const sent = await notify('Mi reminder', cron.message).catch(() => ({ skipped: true }));
        const result = { status: 'ok', output: `Reminder: ${cron.message}${sent?.skipped ? ' (notification skipped)' : ''}` };
        await appendCronLog({ name: cron.name, startedAt, finishedAt: now(), ...result });
        return result;
    }
    if (!cron.command)
        throw new Error(`cron ${cron.name} has no command`);
    const { file, args } = splitCronCommand(cron.command);
    const result = await new Promise((resolve) => {
        const child = spawn(file, args, { cwd: cron.cwd || HOME, shell: false, env: cronEnv() });
        let output = '';
        child.stdout.on('data', (data) => { output += data.toString(); });
        child.stderr.on('data', (data) => { output += data.toString(); });
        child.on('error', (error) => resolve({ status: 'error', output: redactOutput(String(error)) }));
        child.on('close', (code) => resolve({ status: code === 0 ? 'ok' : 'error', output: redactOutput(output.slice(-4000)) }));
    });
    await appendCronLog({ name: cron.name, startedAt, finishedAt: now(), ...result });
    if (result.status === 'error')
        await surfaceCronError(cron, result.output);
    return result;
}
export async function tickCrons() {
    const crons = await readCrons();
    const ran = [];
    for (const cron of crons) {
        if (!due(cron))
            continue;
        const result = await runCron(cron);
        cron.lastRunAt = now();
        cron.lastStatus = result.status;
        cron.lastOutput = redactOutput(result.output).slice(-1000);
        if (cron.at)
            cron.enabled = false;
        ran.push({ name: cron.name, status: result.status });
    }
    await writeCrons(crons);
    return ran;
}
export function cronPaths() { return { cronsPath: CRONS_PATH, logPath: LOG_PATH }; }
