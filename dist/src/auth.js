import crypto from 'node:crypto';
const sessions = new Map();
const ttlMs = 12 * 60 * 60 * 1000;
function secret() {
    return process.env.ASSISTANT_TOKEN || process.env.ASSISTANT_PASSWORD || '';
}
export function authConfigured() {
    return Boolean(secret());
}
export function createSession(res) {
    const sid = crypto.randomBytes(32).toString('base64url');
    const csrf = crypto.randomBytes(32).toString('base64url');
    sessions.set(sid, { csrf, expires: Date.now() + ttlMs });
    res.cookie('assistant_session', sid, {
        httpOnly: true,
        sameSite: 'strict',
        secure: process.env.COOKIE_SECURE !== 'false',
        maxAge: ttlMs,
        path: '/',
    });
    return { csrf };
}
export function clearSession(res, sid) {
    if (sid)
        sessions.delete(sid);
    res.clearCookie('assistant_session', { path: '/' });
}
export function requireAuth(req, res, next) {
    const configured = secret();
    if (!configured)
        return res.status(503).json({ error: 'auth not configured: set ASSISTANT_TOKEN or ASSISTANT_PASSWORD' });
    if (req.header('authorization') === `Bearer ${configured}`)
        return next();
    const sid = req.cookies?.assistant_session;
    const session = sid ? sessions.get(sid) : undefined;
    if (!session || session.expires < Date.now()) {
        if (sid)
            sessions.delete(sid);
        return res.status(401).json({ error: 'unauthorized' });
    }
    if (process.env.CSRF_DISABLED !== 'true' && req.method !== 'GET' && req.method !== 'HEAD') {
        if (req.header('x-csrf-token') !== session.csrf)
            return res.status(403).json({ error: 'bad csrf' });
    }
    next();
}
export function currentCsrf(req) {
    const sid = req.cookies?.assistant_session;
    const session = sid ? sessions.get(sid) : undefined;
    return session && session.expires >= Date.now() ? session.csrf : undefined;
}
export function validLoginPassword(value) {
    const configured = secret();
    if (!configured)
        return false;
    const input = Buffer.from(value);
    const expected = Buffer.from(configured);
    if (input.length !== expected.length)
        return false;
    return crypto.timingSafeEqual(input, expected);
}
