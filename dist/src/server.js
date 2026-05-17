import 'dotenv/config';
import cookieParser from 'cookie-parser';
import express from 'express';
import { basename } from 'node:path';
import { authConfigured, clearSession, createSession, currentCsrf, requireAuth, validLoginPassword } from './auth.js';
import { runFlueChat } from './flue.js';
import { classify } from './policy.js';
import { runPiReadOnly, runPiReadOnlyStream } from './pi.js';
import { notify } from './notify.js';
import { createApproval, isKilled, isPaused, logEvent, readApprovals, readRecentEvents, writeApprovals } from './state.js';
import { appendThreadMessage, threadContext } from './threads.js';
import { requireTailnet, tailnetStatus } from './tailnet.js';
import { cleanupUploads, consumeUpload, createUploadLink, UPLOAD_DIR, UPLOAD_MAX_BYTES } from './uploads.js';
const app = express();
const SERVER_THREAD_ID = 'main';
async function buildMiChatPrompt(message, routeReason) {
    const context = await threadContext(SERVER_THREAD_ID, 40);
    return `You are Mi, Kyle's private persistent assistant. Reply in the current conversation with pi-chat-style momentum: be natural, concise, and useful; ask only when a missing detail blocks progress. Do not claim to have inspected files, services, or external state unless the context or a tool result proves it. Risky actions require approval. For substantive coding, repo inspection, testing, research, or multi-step work, recommend or start a background Mi task rather than pretending it is complete. If Kyle asks to monitor, periodically check, alert on, or schedule something, translate it into a Mi cron when details are sufficient.

Route hint: ${routeReason}
Thread: ${SERVER_THREAD_ID}

${context || 'No prior thread context.'}

New message to answer:
${message}`;
}
app.use(cookieParser());
app.use(express.json({ limit: '1mb' }));
app.use(requireTailnet);
app.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
});
app.use('/uploads', express.static(UPLOAD_DIR, { immutable: true, maxAge: '7d', index: false }));
app.use(express.static(new URL('./public', import.meta.url).pathname));
app.get('/health', (req, res) => res.json({ ok: true, authConfigured: authConfigured(), tailnet: tailnetStatus(req) }));
app.post('/api/upload-link', requireAuth, async (req, res) => {
    const base = `${req.protocol}://${req.get('host')}`;
    const link = await createUploadLink(process.env.MI_PUBLIC_BASE_URL || base);
    await logEvent('upload.link.created', { expiresAt: link.expiresAt, maxBytes: link.maxBytes });
    res.json(link);
});
app.get('/u/:token', (req, res) => {
    res.type('html').send(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Mi image upload</title><h1>Upload image</h1><p>This one-time link accepts JPEG, PNG, GIF, or WebP images up to ${Math.floor(UPLOAD_MAX_BYTES / 1024 / 1024)} MiB.</p><input id="file" type="file" accept="image/jpeg,image/png,image/gif,image/webp"><button id="send">Upload</button><pre id="out"></pre><script>send.onclick=async()=>{const f=file.files[0];if(!f){out.textContent='Choose an image first.';return}if(!/^image\\/(jpeg|png|gif|webp)$/.test(f.type)){out.textContent='Only image files are allowed.';return}out.textContent='Uploading...';const r=await fetch(location.pathname+'?filename='+encodeURIComponent(f.name),{method:'PUT',headers:{'content-type':f.type},body:f});const j=await r.json().catch(()=>({error:'Upload failed'}));out.textContent=j.url?'Uploaded image URL:\\n'+j.url:(j.error||'Upload failed')};</script>`);
});
app.put('/u/:token', express.raw({ type: '*/*', limit: UPLOAD_MAX_BYTES }), async (req, res) => {
    try {
        const result = await consumeUpload(String(req.params.token), Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0), String(req.get('content-type') || ''), basename(String(req.query.filename || 'image')));
        await logEvent('upload.completed', { filename: result.filename });
        res.json(result);
    }
    catch (error) {
        res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
});
setInterval(() => cleanupUploads().catch(() => undefined), 60 * 60 * 1000).unref();
app.post('/api/login', (req, res) => {
    const password = String(req.body?.password || '');
    if (!validLoginPassword(password))
        return res.status(401).json({ error: 'bad password' });
    res.json(createSession(res));
});
app.post('/api/logout', (req, res) => {
    clearSession(res, req.cookies?.assistant_session);
    res.json({ ok: true });
});
app.get('/api/session', requireAuth, (req, res) => {
    res.json({ ok: true, csrf: currentCsrf(req) });
});
app.post('/api/chat', requireAuth, async (req, res) => {
    if (await isKilled())
        return res.status(423).json({ error: 'Mi is killed: remove state/KILL to resume' });
    const message = String(req.body?.message || '').trim();
    if (!message)
        return res.status(400).json({ error: 'message required' });
    await logEvent('chat.request', { message });
    const decision = classify(message);
    if (await isPaused()) {
        await logEvent('chat.paused', { message });
        return res.json({ type: 'paused', reply: 'Mi is paused. Remove state/PAUSED to resume execution. Read-only chat execution is disabled while paused.' });
    }
    if (decision.mode === 'approval-required') {
        const approval = await createApproval(message, decision.reason);
        await notify('Mi approval needed', `Task ${approval.id} needs review.`);
        const reply = `This needs approval before I run it. Approval ID: ${approval.id}`;
        await appendThreadMessage(SERVER_THREAD_ID, 'user', message, { unread: false, source: 'server' });
        await appendThreadMessage(SERVER_THREAD_ID, 'assistant', reply, { unread: false, source: 'approval' });
        return res.json({ type: 'approval', reply, approval });
    }
    const prompt = await buildMiChatPrompt(message, decision.reason);
    await appendThreadMessage(SERVER_THREAD_ID, 'user', message, { unread: false, source: 'server' });
    if (decision.mode === 'pi-read-only') {
        const result = await runPiReadOnly(prompt);
        await appendThreadMessage(SERVER_THREAD_ID, 'assistant', result.text, { unread: false, source: 'pi-read-only' });
        await logEvent('chat.result', { message, route: decision, result });
        return res.json({ type: 'result', reply: result.text });
    }
    const result = await runFlueChat(prompt);
    await appendThreadMessage(SERVER_THREAD_ID, 'assistant', result.reply, { unread: false, source: result.source });
    await logEvent('chat.result', { message, route: decision, result });
    return res.json({ type: 'result', reply: result.reply });
});
app.post('/api/chat-stream', requireAuth, async (req, res) => {
    if (await isKilled())
        return res.status(423).json({ error: 'Mi is killed: remove state/KILL to resume' });
    const message = String(req.body?.message || '').trim();
    if (!message)
        return res.status(400).json({ error: 'message required' });
    await logEvent('chat.request', { message, stream: true });
    const decision = classify(message);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    if (await isPaused()) {
        send('done', { reply: 'Mi is paused. Remove state/PAUSED to resume execution.' });
        return res.end();
    }
    if (decision.mode === 'approval-required') {
        const approval = await createApproval(message, decision.reason);
        await notify('Mi approval needed', `Task ${approval.id} needs review.`);
        const reply = `This needs approval before I run it. Approval ID: ${approval.id}`;
        await appendThreadMessage(SERVER_THREAD_ID, 'user', message, { unread: false, source: 'server-stream' });
        await appendThreadMessage(SERVER_THREAD_ID, 'assistant', reply, { unread: false, source: 'approval' });
        send('done', { reply, approval });
        return res.end();
    }
    const prompt = await buildMiChatPrompt(message, decision.reason);
    await appendThreadMessage(SERVER_THREAD_ID, 'user', message, { unread: false, source: 'server-stream' });
    if (decision.mode === 'pi-read-only') {
        const result = await runPiReadOnlyStream(prompt, (e) => send(e.type, e));
        await appendThreadMessage(SERVER_THREAD_ID, 'assistant', result.text, { unread: false, source: 'pi-read-only' });
        await logEvent('chat.result', { message, route: decision, result });
        return res.end();
    }
    const result = await runFlueChat(prompt);
    await appendThreadMessage(SERVER_THREAD_ID, 'assistant', result.reply, { unread: false, source: result.source });
    send('text', { text: result.reply });
    send('done', { text: result.reply, trace: [] });
    await logEvent('chat.result', { message, route: decision, result });
    res.end();
});
app.get('/api/approvals', requireAuth, async (_req, res) => {
    res.json(await readApprovals());
});
app.get('/api/events', requireAuth, async (_req, res) => {
    res.json(await readRecentEvents());
});
app.post('/api/approvals/:id/:action', requireAuth, async (req, res) => {
    const id = String(req.params.id);
    const action = String(req.params.action);
    if (!['approve', 'reject'].includes(action))
        return res.status(400).json({ error: 'bad action' });
    const items = await readApprovals();
    const item = items.find((a) => a.id === id);
    if (!item)
        return res.status(404).json({ error: 'not found' });
    item.status = action === 'approve' ? 'approved' : 'rejected';
    await writeApprovals(items);
    await logEvent(`approval.${action}`, item);
    res.json(item);
});
app.post('/api/notify-test', requireAuth, async (_req, res) => {
    res.json(await notify('Mi test', 'Push notifications are wired.'));
});
const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 8787);
app.listen(port, host, () => {
    console.log(`Mi listening on http://${host}:${port}`);
});
