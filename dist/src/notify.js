import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
const secretPatterns = [
    /\b[A-Za-z0-9_]*(TOKEN|SECRET|PASSWORD|API_KEY)[A-Za-z0-9_]*\s*=\s*[^\s]+/gi,
    /sk-[A-Za-z0-9_-]{20,}/g,
    /[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{24,}/g,
];
export function safeNotificationText(text) {
    let safe = text.replace(/https?:\/\/\S+/gi, '[link omitted]');
    for (const pattern of secretPatterns)
        safe = safe.replace(pattern, '[redacted]');
    return safe.slice(0, 900);
}
async function readPushoverEnvFile() {
    try {
        const values = {};
        const text = await readFile(join(homedir(), '.config', 'pushover', 'env'), 'utf8');
        for (const line of text.split(/\r?\n/)) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#'))
                continue;
            const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
            if (!match)
                continue;
            let value = match[2].trim();
            if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
                value = value.slice(1, -1);
            values[match[1]] = value;
        }
        return values;
    }
    catch {
        return {};
    }
}
function usableSecret(value) {
    return value && !String(value).includes('${') ? String(value) : undefined;
}
async function pushoverCredentials() {
    const fileEnv = await readPushoverEnvFile();
    const token = usableSecret(process.env.PUSHOVER_APP_TOKEN) || usableSecret(fileEnv.PUSHOVER_APP_TOKEN) || usableSecret(process.env.PUSHOVER_TOKEN) || usableSecret(fileEnv.PUSHOVER_TOKEN);
    const user = usableSecret(process.env.PUSHOVER_USER_KEY) || usableSecret(fileEnv.PUSHOVER_USER_KEY) || usableSecret(process.env.PUSHOVER_USER) || usableSecret(fileEnv.PUSHOVER_USER);
    return token && user ? { token, user } : undefined;
}
export async function notifyImessage(title, message, options = {}) {
    if (options.requireEnabled !== false && !/^(1|true|yes|on)$/i.test(process.env.MI_PROACTIVE_IMESSAGE_NOTIFY || process.env.MI_IMESSAGE_NOTIFY || ''))
        return { skipped: true };
    const url = process.env.MI_PHOTON_NOTIFY_URL || `http://127.0.0.1:${process.env.MI_PHOTON_NOTIFY_PORT || '8788'}/notify`;
    const token = process.env.MI_PHOTON_NOTIFY_TOKEN || '';
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ title: safeNotificationText(title).slice(0, 120), message: safeNotificationText(message) }),
    });
    return { ok: res.ok, status: res.status, text: await res.text() };
}
function pushoverEnabled() {
    return /^(1|true|yes|on)$/i.test(process.env.MI_PUSHOVER_NOTIFY || process.env.MI_PUSHOVER_FALLBACK || '');
}
export async function notifyPushover(title, message) {
    if (!pushoverEnabled())
        return { skipped: true };
    const credentials = await pushoverCredentials();
    if (!credentials)
        return { skipped: true };
    const body = new URLSearchParams({ token: credentials.token, user: credentials.user, title: safeNotificationText(title).slice(0, 120), message: safeNotificationText(message) });
    const res = await fetch('https://api.pushover.net/1/messages.json', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
    });
    return { ok: res.ok, status: res.status, text: await res.text() };
}
export async function notify(title, message) {
    const results = {};
    const imessage = await notifyImessage(title, message).catch((error) => ({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    if (!imessage.skipped)
        results.imessage = imessage;
    const pushover = await notifyPushover(title, message).catch((error) => ({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    if (!pushover.skipped)
        results.pushover = pushover;
    return Object.keys(results).length ? results : { skipped: true };
}
