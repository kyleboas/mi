const secretPatterns = [
    /\b[A-Za-z0-9_]*(TOKEN|SECRET|PASSWORD|API_KEY)[A-Za-z0-9_]*\s*=\s*[^\s]+/gi,
    /sk-[A-Za-z0-9_-]{20,}/g,
    /[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{24,}/g,
];
function safeNotificationText(text) {
    let safe = text.replace(/https?:\/\/\S+/gi, '[link omitted]');
    for (const pattern of secretPatterns)
        safe = safe.replace(pattern, '[redacted]');
    return safe.slice(0, 900);
}
export async function notify(title, message) {
    const user = process.env.PUSHOVER_USER;
    const token = process.env.PUSHOVER_TOKEN;
    if (!user || !token)
        return { skipped: true };
    const body = new URLSearchParams({ token, user, title: safeNotificationText(title).slice(0, 120), message: safeNotificationText(message) });
    const res = await fetch('https://api.pushover.net/1/messages.json', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
    });
    return { ok: res.ok, status: res.status, text: await res.text() };
}
