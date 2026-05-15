import 'dotenv/config';
import cookieParser from 'cookie-parser';
import express from 'express';
import { authConfigured, clearSession, createSession, currentCsrf, requireAuth, validLoginPassword } from './auth.js';
import { runFlueChat } from './flue.js';
import { classify } from './policy.js';
import { runPiReadOnly, runPiReadOnlyStream } from './pi.js';
import { notify } from './notify.js';
import { createApproval, isKilled, isPaused, logEvent, readApprovals, readRecentEvents, writeApprovals } from './state.js';
import { requireTailnet, tailnetStatus } from './tailnet.js';

const app = express();
app.use(cookieParser());
app.use(express.json({ limit: '1mb' }));
app.use(requireTailnet);
app.use((_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});
app.use(express.static(new URL('./public', import.meta.url).pathname));

app.get('/health', (req, res) => res.json({ ok: true, authConfigured: authConfigured(), tailnet: tailnetStatus(req) }));

app.post('/api/login', (req, res) => {
  const password = String(req.body?.password || '');
  if (!validLoginPassword(password)) return res.status(401).json({ error: 'bad password' });
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

app.post('/api/chat-stream', requireAuth, async (req, res) => {
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

app.get('/api/approvals', requireAuth, async (_req, res) => {
  res.json(await readApprovals());
});

app.get('/api/events', requireAuth, async (_req, res) => {
  res.json(await readRecentEvents());
});

app.post('/api/approvals/:id/:action', requireAuth, async (req, res) => {
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

app.post('/api/notify-test', requireAuth, async (_req, res) => {
  res.json(await notify('Mi test', 'Push notifications are wired.'));
});

const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 8787);
app.listen(port, host, () => {
  console.log(`Mi listening on http://${host}:${port}`);
});
