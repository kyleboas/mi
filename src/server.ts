import 'dotenv/config';
import express from 'express';
import { basename } from 'node:path';
import { runFlueChat } from './flue.js';
import { classify } from './policy.js';
import { runPiReadOnly, runPiReadOnlyStream } from './pi.js';
import { notify } from './notify.js';
import { createApproval, isKilled, isPaused, logEvent, readApprovals, readRecentEvents, writeApprovals } from './state.js';
import { cleanupUploads, consumeUpload, createUploadLink, UPLOAD_DIR, UPLOAD_MAX_BYTES } from './uploads.js';

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use((_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});
app.use('/uploads', express.static(UPLOAD_DIR, { immutable: true, maxAge: '7d', index: false }));
app.use(express.static(new URL('./public', import.meta.url).pathname));

app.get('/health', (_req, res) => res.json({ ok: true, authConfigured: false, access: 'loopback-only' }));

app.post('/api/upload-link', async (req, res) => {
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
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

setInterval(() => cleanupUploads().catch(() => undefined), 60 * 60 * 1000).unref();

app.get('/api/session', (_req, res) => {
  res.json({ ok: true });
});

app.post('/api/chat', async (req, res) => {
  if (await isKilled()) return res.status(423).json({ error: 'Mi is killed: remove state/KILL to resume' });
  const message = String(req.body?.message || '').trim();
  if (!message) return res.status(400).json({ error: 'message required' });

  await logEvent('chat.request', { message });
  const decision = classify(message);

  if (await isPaused()) {
    await logEvent('chat.paused', { message });
    return res.json({ type: 'paused', reply: 'Mi is paused. Remove state/PAUSED to resume execution. Read-only chat execution is disabled while paused.' });
  }

  if (decision.mode === 'approval-required') {
    const approval = await createApproval(message, decision.reason);
    await notify('Mi approval needed', `Task ${approval.id} needs review.`);
    return res.json({
      type: 'approval',
      reply: `This needs approval before I run it. Approval ID: ${approval.id}`,
      approval,
    });
  }

  if (decision.mode === 'flue-chat') {
    const result = await runFlueChat(message);
    await logEvent('chat.result', { message, route: decision, result });
    return res.json({ type: 'result', reply: result.reply });
  }

  if (decision.mode === 'pi-read-only') {
    const result = await runPiReadOnly(message);
    await logEvent('chat.result', { message, route: decision, result });
    return res.json({ type: 'result', reply: result.text });
  }

  return res.status(500).json({ error: `unhandled route: ${decision.mode}` });
});

app.post('/api/chat-stream', async (req, res) => {
  if (await isKilled()) return res.status(423).json({ error: 'Mi is killed: remove state/KILL to resume' });
  const message = String(req.body?.message || '').trim();
  if (!message) return res.status(400).json({ error: 'message required' });

  await logEvent('chat.request', { message, stream: true });
  const decision = classify(message);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  if (await isPaused()) {
    send('done', { reply: 'Mi is paused. Remove state/PAUSED to resume execution.' });
    return res.end();
  }

  if (/^(hi|hello|hey|yo)\.?$/i.test(message)) {
    send('text', { text: 'Hello.' });
    send('done', { text: 'Hello.', trace: [] });
    await logEvent('chat.result', { message, result: { text: 'Hello.', trace: [] } });
    return res.end();
  }

  if (decision.mode === 'approval-required') {
    const approval = await createApproval(message, decision.reason);
    await notify('Mi approval needed', `Task ${approval.id} needs review.`);
    send('done', { reply: `This needs approval before I run it. Approval ID: ${approval.id}`, approval });
    return res.end();
  }

  const result = await runPiReadOnlyStream(message, (e) => send(e.type, e));
  await logEvent('chat.result', { message, result });
  res.end();
});

app.get('/api/approvals', async (_req, res) => {
  res.json(await readApprovals());
});

app.get('/api/events', async (_req, res) => {
  res.json(await readRecentEvents());
});

app.post('/api/approvals/:id/:action', async (req, res) => {
  const id = String(req.params.id);
  const action = String(req.params.action);
  if (!['approve', 'reject'].includes(action)) return res.status(400).json({ error: 'bad action' });
  const items = await readApprovals();
  const item = items.find((a) => a.id === id);
  if (!item) return res.status(404).json({ error: 'not found' });
  item.status = action === 'approve' ? 'approved' : 'rejected';
  await writeApprovals(items);
  await logEvent(`approval.${action}`, item);
  res.json(item);
});

app.post('/api/notify-test', async (_req, res) => {
  res.json(await notify('Mi test', 'Push notifications are wired.'));
});

const host = process.env.HOST || '127.0.0.1';
if (!['127.0.0.1', '::1', 'localhost'].includes(host) && process.env.MI_ALLOW_NON_LOOPBACK !== 'true') {
  throw new Error('Mi is unauthenticated and must bind to loopback. Set HOST=127.0.0.1 or MI_ALLOW_NON_LOOPBACK=true to override intentionally.');
}
const port = Number(process.env.PORT || 8787);
app.listen(port, host, () => {
  console.log(`Mi listening on http://${host}:${port}`);
});
