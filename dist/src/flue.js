import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { capabilityGrantExpiresAt } from './capability-gc.js';
const secretPatterns = [
    /\b[A-Za-z0-9_]*TOKEN[A-Za-z0-9_]*\s*=\s*[^\s]+/gi,
    /\b[A-Za-z0-9_]*SECRET[A-Za-z0-9_]*\s*=\s*[^\s]+/gi,
    /\b[A-Za-z0-9_]*PASSWORD[A-Za-z0-9_]*\s*=\s*[^\s]+/gi,
    /\b[A-Za-z0-9_]*API_KEY[A-Za-z0-9_]*\s*=\s*[^\s]+/gi,
    /sk-[A-Za-z0-9_-]{20,}/g,
    /[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{24,}/g,
];
function redactSecrets(text) {
    let redacted = text;
    for (const pattern of secretPatterns)
        redacted = redacted.replace(pattern, '[redacted]');
    return redacted;
}
function fallbackReply(message, error) {
    const trimmed = currentUserText(message).trim();
    const reply = /^(hi|hello|hey|yo)\.?$/i.test(trimmed) ? 'Hello.' : 'Got it.';
    return { reply, ok: false, source: 'fallback', error };
}
function currentUserText(message) {
    return message.split(/(?:^|\n)Current user message:\n/i).pop() || message;
}
const safePiEnvKeys = ['PATH', 'HOME', 'USER', 'LOGNAME', 'HOSTNAME', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TERM', 'TMPDIR', 'TMP', 'TEMP', 'PI_PROVIDER', 'PI_MODEL', 'PI_CONFIG_DIR', 'PI_GATEWAY_URL', 'AGENT_GATEWAY_URL', 'FLUE_URL', 'FLUE_CHAT_URL', 'FLUE_CMD'];
function reducedPiEnv(extra = {}) {
    const env = {};
    for (const key of safePiEnvKeys) {
        const value = process.env[key];
        if (value !== undefined)
            env[key] = value;
    }
    return { ...env, ...extra };
}
function miRoot() {
    return process.env.MI_ROOT || path.join(process.env.HOME || process.cwd(), 'assistant');
}
function miRuntimeDir() {
    return process.env.MI_RUNTIME_DIR || path.join(process.env.HOME || process.cwd(), '.pi', 'agent', 'mi');
}
function capabilityGuardPath() {
    return process.env.MI_CAPABILITY_GUARD || path.join(miRoot(), 'pi', 'extensions', 'mi-capability-guard.ts');
}
async function writeCapabilityGrantsFile(cwd, profile = 'chat-read') {
    const dir = path.join(miRuntimeDir(), 'capabilities');
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, `${profile}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.json`);
    const createdAt = new Date().toISOString();
    const grant = {
        id: `${profile}-${Date.now().toString(36)}`,
        resource: `file://${path.resolve(cwd)}`,
        rights: ['read'],
        constraints: { recursive: true, profile },
        principal: { id: 'mi-chat', type: 'web', displayName: 'Mi chat' },
        createdAt,
        expiresAt: capabilityGrantExpiresAt(createdAt),
    };
    await writeFile(file, JSON.stringify({ profile, grants: [grant] }, null, 2), { mode: 0o600 });
    return file;
}
function directChatReply(message) {
    const trimmed = currentUserText(message).trim();
    if (/^(hi|hello|hey|yo)\.?$/i.test(trimmed))
        return 'Hello.';
    if (/^(thanks|thank you|ty)\.?$/i.test(trimmed))
        return 'You’re welcome.';
    if (/^(ok|okay|got it|cool|nice)\.?$/i.test(trimmed))
        return 'Got it.';
    return '';
}
function enabledFlag(value) {
    return value === '1' || value === 'true' || value === 'yes';
}
function wantsLookup(message) {
    return /\b(look\s*up|lookup|check|verify|find\s*out|search|current|today|tonight|tomorrow|latest|schedule|score|game|weather|news|time)\b/i.test(currentUserText(message));
}
function easternDate() {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
    const get = (type) => parts.find((part) => part.type === type)?.value || '';
    return `${get('year')}-${get('month')}-${get('day')}`;
}
function easternTime(iso) {
    return new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(new Date(iso));
}
function decodeHtml(text) {
    return text
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&nbsp;/g, ' ');
}
async function philliesGamesToday() {
    const date = easternDate();
    const res = await fetch(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&teamId=143&date=${date}`);
    if (!res.ok)
        return { date, games: [] };
    const data = await res.json();
    const games = data?.dates?.flatMap((day) => day.games || []) || [];
    return { date, games };
}
async function directLookupAnswer(message) {
    const query = currentUserText(message);
    if (!/\b(phillies|phils)\b/i.test(query) || !/\b(when|play|game|schedule|today|tonight|time)\b/i.test(query))
        return '';
    const { games } = await philliesGamesToday();
    if (games.length === 0)
        return 'The Phillies do not have a game listed today.';
    const game = games[0];
    const away = game?.teams?.away?.team?.name || 'Away';
    const home = game?.teams?.home?.team?.name || 'Home';
    const opponent = /Phillies/i.test(home) ? away : home;
    const venue = game?.venue?.name || 'venue TBD';
    const time = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(new Date(game.gameDate));
    const status = game?.status?.detailedState || '';
    const statusText = /scheduled|preview/i.test(status) ? '' : ` (${status})`;
    return `The Phillies play the ${opponent} today at ${time} at ${venue}.${statusText}`;
}
async function mlbLookupContext(query) {
    if (!/\b(phillies|phils)\b/i.test(query))
        return '';
    const { date, games } = await philliesGamesToday();
    if (games.length === 0)
        return `MLB schedule lookup for Philadelphia Phillies on ${date}: no game listed.`;
    const lines = games.map((game) => {
        const away = game?.teams?.away?.team?.name || 'Away';
        const home = game?.teams?.home?.team?.name || 'Home';
        const venue = game?.venue?.name || 'venue TBD';
        const status = game?.status?.detailedState || game?.status?.abstractGameState || 'scheduled';
        return `${away} at ${home} — ${easternTime(game.gameDate)} — ${venue} — ${status}`;
    });
    return `MLB schedule lookup for Philadelphia Phillies on ${date}:\n${lines.join('\n')}`;
}
async function searchLookupContext(query) {
    const res = await fetch(`https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
        headers: { 'User-Agent': 'Mozilla/5.0 Mi private lookup' },
    });
    if (!res.ok)
        return '';
    const html = await res.text();
    const snippets = [...html.matchAll(/<a[^>]+class="result__a"[^>]*>(.*?)<\/a>|<a[^>]+class="result-link"[^>]*>(.*?)<\/a>|<div[^>]+class="result__snippet"[^>]*>(.*?)<\/div>/gis)]
        .map((match) => decodeHtml(String(match[1] || match[2] || match[3] || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()))
        .filter(Boolean)
        .slice(0, 8);
    return snippets.length ? `Search snippets for ${query}:\n- ${snippets.join('\n- ')}` : '';
}
async function lookupContextFor(message) {
    const query = currentUserText(message).trim();
    const sections = [await mlbLookupContext(query), await searchLookupContext(query)].filter(Boolean);
    return sections.join('\n\n').slice(0, 6000);
}
async function runPiChat(message, error) {
    const cmd = process.env.PI_CMD || 'pi';
    const needsLookup = (process.env.MI_CHAT_LOOKUP_TOOLS === '1' || process.env.MI_CHAT_LOOKUP_TOOLS === 'true') && wantsLookup(message);
    const directAnswer = needsLookup ? await directLookupAnswer(message).catch(() => '') : directChatReply(message);
    if (directAnswer)
        return { reply: directAnswer, ok: true, source: 'fallback' };
    const lookupContext = needsLookup ? await lookupContextFor(message).catch(() => '') : '';
    const prompt = needsLookup
        ? `You are Mi in a private chat. Be concise. Use the lookup context below to answer the current user request. Do not output tool calls, JSON, commands, or code blocks. If the lookup context is insufficient, say you couldn't verify it.\n\nLookup context:\n${lookupContext || 'No lookup results available.'}\n\nUser: ${message}`
        : `You are Mi in a private chat. Be concise. You may use the exposed tools when the current user request explicitly asks you to inspect, check, verify, or monitor local files, logs, state, or service status. Tool use is read-only: use read, grep, find, and ls only. Do not use bash, edit files, write files, deploy, publish, merge, delete, spend money, send external messages, kill processes, restart services, or change settings without explicit approval. Never expose secrets. If you use tools, summarize only safe findings.\n\nUser: ${message}`;
    const cwd = process.env.HOME || process.cwd();
    const grantsFile = await writeCapabilityGrantsFile(cwd, 'chat-read');
    const auditFile = path.join(miRuntimeDir(), 'capability-audit.jsonl');
    return await new Promise((resolve) => {
        const model = process.env.PI_CHAT_MODEL || process.env.PI_MODEL;
        const guard = capabilityGuardPath();
        const guardArgs = existsSync(guard) ? ['--no-extensions', '--extension', guard] : ['--no-extensions'];
        const baseArgs = ['--mode', 'json', '--no-session', '--no-context-files', ...guardArgs, '--no-skills', '--no-prompt-templates', '--no-themes'];
        const chatTools = process.env.MI_CHAT_TOOLS || 'read,grep,find,ls';
        const args = model ? [...baseArgs, '--model', model, '--tools', chatTools, prompt] : [...baseArgs, '--tools', chatTools, prompt];
        const child = spawn(cmd, args, {
            cwd,
            env: reducedPiEnv({ MI_CAPABILITY_GRANTS_FILE: grantsFile, MI_CAPABILITY_AUDIT_FILE: auditFile, MI_CAPABILITY_PROFILE: 'chat-read' }),
            shell: false,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        let text = '';
        let settled = false;
        const finish = (result) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            resolve({
                ...result,
                reply: redactSecrets(result.reply),
                error: result.error ? redactSecrets(result.error) : undefined,
            });
        };
        const consume = () => {
            const lines = stdout.split('\n');
            stdout = lines.pop() || '';
            for (const line of lines) {
                if (!line.trim())
                    continue;
                try {
                    const event = JSON.parse(line);
                    if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta')
                        text += event.assistantMessageEvent.delta || '';
                }
                catch { }
            }
        };
        const timer = setTimeout(() => {
            child.kill('SIGTERM');
            consume();
            finish(text.trim() ? { reply: text.trim(), ok: true, source: 'fallback', error } : fallbackReply(message, error || 'pi chat timed out'));
        }, Number(process.env.PI_CHAT_TIMEOUT_MS || 45_000));
        child.stdout.on('data', (d) => { stdout += d.toString(); consume(); });
        child.stderr.on('data', (d) => (stderr += d.toString()));
        child.on('error', (e) => finish(fallbackReply(message, `${error || ''} ${e.message}`.trim())));
        child.on('close', () => {
            consume();
            finish(text.trim() ? { reply: text.trim(), ok: true, source: 'fallback', error } : fallbackReply(message, error || stderr.trim()));
        });
    });
}
function flueCommand() {
    if (process.env.FLUE_CMD)
        return { cmd: process.env.FLUE_CMD, argsPrefix: [] };
    const localBin = path.join(process.cwd(), 'node_modules', '.bin', 'flue');
    if (existsSync(localBin))
        return { cmd: localBin, argsPrefix: [] };
    return { cmd: 'flue', argsPrefix: [] };
}
function extractReply(raw) {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (typeof parsed === 'string')
        return parsed;
    if (typeof parsed?.reply === 'string')
        return parsed.reply;
    if (typeof parsed?.text === 'string')
        return parsed.text;
    if (typeof parsed?.result === 'string')
        return parsed.result;
    if (typeof parsed?.result?.reply === 'string')
        return parsed.result.reply;
    return JSON.stringify(parsed);
}
async function runPersistentFlueChat(message, payload, timeoutMs, id) {
    const url = process.env.FLUE_URL || process.env.FLUE_CHAT_URL;
    if (!url)
        return undefined;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const base = url.replace(/\/$/, '');
        const res = await fetch(`${base}/agents/chat/${encodeURIComponent(id)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: payload,
            signal: controller.signal,
        });
        const body = await res.text();
        if (!res.ok)
            return { reply: '', ok: false, source: 'fallback', error: body.slice(0, 500) };
        return { reply: extractReply(body), ok: true, source: 'flue' };
    }
    catch (e) {
        return { reply: '', ok: false, source: 'fallback', error: e instanceof Error ? e.message : String(e) };
    }
    finally {
        clearTimeout(timer);
    }
}
export async function runFlueChat(message) {
    const flueConfigured = Boolean(process.env.FLUE_URL || process.env.FLUE_CHAT_URL || process.env.FLUE_CMD || enabledFlag(process.env.FLUE_ENABLED));
    if (process.env.FLUE_ENABLED === 'false' || !flueConfigured)
        return runPiChat(message, process.env.FLUE_ENABLED === 'false' ? 'FLUE_ENABLED=false' : 'Flue not configured');
    const timeoutMs = Number(process.env.FLUE_TIMEOUT_MS || 30_000);
    const id = process.env.FLUE_CHAT_SESSION || 'mi-chat';
    const payload = JSON.stringify({
        message,
        role: 'normal conversational chat only; no host filesystem writes; no secrets in replies',
    });
    const persistent = await runPersistentFlueChat(message, payload, timeoutMs, id);
    if (persistent?.ok) {
        return {
            ...persistent,
            reply: redactSecrets(persistent.reply),
            error: persistent.error ? redactSecrets(persistent.error) : undefined,
        };
    }
    const { cmd, argsPrefix } = flueCommand();
    const args = [
        ...argsPrefix,
        'run',
        'chat',
        '--target',
        'node',
        '--id',
        id,
        '--payload',
        payload,
        '--workspace',
        path.join(process.cwd(), '.flue'),
        '--output',
        path.join(process.cwd(), 'state', 'flue-node'),
    ];
    return await new Promise((resolve) => {
        const child = spawn(cmd, args, {
            cwd: process.cwd(),
            env: reducedPiEnv(),
            shell: false,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        let settled = false;
        const finish = (result) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            resolve({
                ...result,
                reply: redactSecrets(result.reply),
                error: result.error ? redactSecrets(result.error) : undefined,
            });
        };
        const timer = setTimeout(() => {
            child.kill('SIGTERM');
            finish(fallbackReply(message, `Flue timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        child.stdout.on('data', (d) => (stdout += d.toString()));
        child.stderr.on('data', (d) => (stderr += d.toString()));
        child.on('error', (e) => finish(fallbackReply(message, e.message)));
        child.on('close', async (code) => {
            if (settled)
                return;
            const raw = stdout.trim();
            if (code !== 0 || !raw) {
                finish(await runPiChat(message, stderr.trim() || `Flue exited ${code}`));
                return;
            }
            try {
                finish({ reply: extractReply(raw), ok: true, source: 'flue' });
            }
            catch (e) {
                finish(await runPiChat(message, e instanceof Error ? e.message : String(e)));
            }
        });
    });
}
