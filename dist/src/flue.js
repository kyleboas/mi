import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
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
    const trimmed = message.trim();
    const reply = /^(hi|hello|hey|yo)\.?$/i.test(trimmed) ? 'Hello.' : 'Got it.';
    return { reply, ok: false, source: 'fallback', error };
}
async function runPiChat(message, error) {
    const cmd = process.env.PI_CMD || 'pi';
    const prompt = `Normal chat only. Do not use tools. Do not inspect local files. Do not modify anything. Do not expose secrets. Keep the reply concise.\n\nUser: ${message}`;
    return await new Promise((resolve) => {
        const model = process.env.PI_CHAT_MODEL || process.env.PI_MODEL;
        const args = model ? ['--mode', 'json', '--model', model, '--tools', '', prompt] : ['--mode', 'json', '--tools', '', prompt];
        const child = spawn(cmd, args, {
            cwd: process.env.HOME || process.cwd(),
            env: process.env,
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
            finish(text.trim() ? { reply: text.trim(), ok: false, source: 'fallback', error } : fallbackReply(message, error || 'pi chat timed out'));
        }, Number(process.env.PI_CHAT_TIMEOUT_MS || 45_000));
        child.stdout.on('data', (d) => { stdout += d.toString(); consume(); });
        child.stderr.on('data', (d) => (stderr += d.toString()));
        child.on('error', (e) => finish(fallbackReply(message, `${error || ''} ${e.message}`.trim())));
        child.on('close', () => {
            consume();
            finish(text.trim() ? { reply: text.trim(), ok: false, source: 'fallback', error } : fallbackReply(message, error || stderr.trim()));
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
    if (process.env.FLUE_ENABLED === 'false')
        return runPiChat(message, 'FLUE_ENABLED=false');
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
            env: process.env,
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
