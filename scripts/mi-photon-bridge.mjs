#!/usr/bin/env node
import http from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';

const projectId = process.env.PHOTON_PROJECT_ID;
const projectSecret = process.env.PHOTON_PROJECT_SECRET;
const allowedUsers = splitList(process.env.PHOTON_ALLOWED_USERS || '');
const allowAll = /^(1|true|yes|on)$/i.test(process.env.PHOTON_ALLOW_ALL_USERS || '');
const miBaseUrl = (process.env.MI_WEB_URL || 'http://127.0.0.1:8787').replace(/\/$/, '');
const miThread = process.env.MI_PHOTON_THREAD || 'main';
const pollMs = Number(process.env.MI_PHOTON_POLL_MS || 1500);
const maxWaitMs = Number(process.env.MI_PHOTON_MAX_WAIT_MS || 180000);
const bootTestSend = /^(1|true|yes|on)$/i.test(process.env.PHOTON_BOOT_TEST_SEND || '');
const maxReplyChars = Number(process.env.MI_PHOTON_MAX_REPLY_CHARS || 1200);
const notifyHost = process.env.MI_PHOTON_NOTIFY_HOST || '127.0.0.1';
const notifyPort = Number(process.env.MI_PHOTON_NOTIFY_PORT || 8788);
const notifyToken = process.env.MI_PHOTON_NOTIFY_TOKEN || '';
const shutdownGraceMs = Number(process.env.MI_PHOTON_SHUTDOWN_GRACE_MS || 10000);
const testMode = /^(1|true|yes|on)$/i.test(process.env.MI_PHOTON_TEST || '');
const testEventsPath = process.env.MI_PHOTON_TEST_EVENTS || '';
const testSendsPath = process.env.MI_PHOTON_TEST_SENDS || '';

let app;
let notifyServer;
let shuttingDown = false;
const inFlightHandlers = new Set();

function describeError(error) {
  return error?.stack || error?.message || String(error);
}

function fatalProcessError(kind, error) {
  console.error(`mi photon fatal ${kind}:`, describeError(error));
  setTimeout(() => process.exit(1), 100).unref?.();
}

process.on('unhandledRejection', (error) => fatalProcessError('unhandledRejection', error));
process.on('uncaughtException', (error) => fatalProcessError('uncaughtException', error));

if (!projectId || !projectSecret) {
  console.error('PHOTON_PROJECT_ID and PHOTON_PROJECT_SECRET are required.');
  process.exit(2);
}
if (!allowAll && allowedUsers.length === 0) {
  console.error('Set PHOTON_ALLOWED_USERS=+15551234567 or PHOTON_ALLOW_ALL_USERS=true.');
  process.exit(2);
}

async function appendTestSend(record) {
  if (!testSendsPath) return;
  const { appendFile, mkdir } = await import('node:fs/promises');
  const { dirname } = await import('node:path');
  await mkdir(dirname(testSendsPath), { recursive: true });
  await appendFile(testSendsPath, `${JSON.stringify({ ts: new Date().toISOString(), ...record })}\n`);
}

function createTestSpace(space = {}) {
  return {
    id: String(space.id || 'test-space'),
    phone: String(space.phone || '+15550000000'),
    async send(content) {
      await appendTestSend({ kind: 'message', spaceId: this.id, phone: this.phone, text: String(content?.text || content || '') });
    },
    async startTyping() {
      await appendTestSend({ kind: 'typing-start', spaceId: this.id, phone: this.phone });
    },
    async stopTyping() {
      await appendTestSend({ kind: 'typing-stop', spaceId: this.id, phone: this.phone });
    },
  };
}

async function createTestSpectrumApp() {
  const { readFile } = await import('node:fs/promises');
  const events = testEventsPath ? JSON.parse(await readFile(testEventsPath, 'utf8')) : [];
  return {
    messages: {
      async *[Symbol.asyncIterator]() {
        for (const event of events) {
          yield [createTestSpace(event.space), event.message || {}];
        }
      },
    },
    async stop() {
      await appendTestSend({ kind: 'stop' });
    },
  };
}

let Spectrum, imessage, spectrumText;
if (testMode) {
  spectrumText = (text) => ({ type: 'text', text: String(text || '') });
  Spectrum = createTestSpectrumApp;
  imessage = () => ({
    async user(id) { return { id }; },
    space: { async create(user) { return createTestSpace({ id: `notify:${user.id}`, phone: user.id }); } },
  });
  imessage.config = () => {};
} else {
  try {
    ({ Spectrum, text: spectrumText } = await import('spectrum-ts'));
    ({ imessage } = await import('spectrum-ts/providers/imessage'));
  } catch (error) {
    console.error('spectrum-ts is not installed. Run: npm install');
    console.error(error?.message || String(error));
    process.exit(3);
  }
}

app = await Spectrum({
  projectId,
  projectSecret,
  providers: [imessage.config()],
  options: { flattenGroups: true },
  telemetry: /^(1|true|yes|on)$/i.test(process.env.PHOTON_TELEMETRY || ''),
});

const knownSpaces = new Map();
const seen = new Set();

function splitList(value) {
  return String(value || '').split(',').map((s) => s.trim()).filter(Boolean);
}

function senderFor(space, message) {
  return String(message?.sender?.id || space?.phone || message?.space?.phone || '').trim();
}

function contentTextFor(content) {
  if (!content || typeof content !== 'object') return '';
  if (content.type === 'text') return String(content.text || '').trim();
  if (content.type === 'richlink') return String(content.url || '').trim();
  if (content.type === 'reaction') return String(content.emoji ? `reaction: ${content.emoji}` : 'reaction').trim();
  if (content.type === 'group') {
    return (Array.isArray(content.items) ? content.items : [])
      .map((item) => contentTextFor(item?.content || item))
      .filter(Boolean)
      .join('\n')
      .trim();
  }
  if (content.type === 'attachment') return `[the user sent an attachment]`;
  if (content.type === 'voice') return `[the user sent a voice message]`;
  return `[the user sent something I can't read here]`;
}

function textFor(message) {
  return contentTextFor(message?.content);
}

function mask(value) {
  const s = String(value || '');
  if (s.length <= 4) return s || '(unknown)';
  return `${s.slice(0, 3)}…${s.slice(-4)}`;
}

function authorized(sender) {
  if (allowAll) return true;
  return allowedUsers.includes(sender);
}

function sanitizeMiConversationText(text) {
  const input = String(text || '');
  const parts = input.split(/(```[\s\S]*?```|`[^`\n]*`)/g);
  return parts.map((part) => {
    if (!part || part.startsWith('```') || part.startsWith('`')) return part;
    return part.replace(/[—–]/g, '-');
  }).join('');
}

function cleanReply(text) {
  return sanitizeMiConversationText(String(text || ''))
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, maxReplyChars) || `I'm here.`;
}

async function miJson(path, init = {}) {
  const res = await fetch(`${miBaseUrl}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers || {}) },
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(`${path} ${res.status}: ${data.error || text}`);
  return data;
}

async function askImessage(message) {
  const start = Date.now();
  console.log(`imessage send chars=${String(message || '').length}`);
  const data = await miJson('/api/imessage', {
    method: 'POST',
    body: JSON.stringify({ thread: miThread, message }),
  });
  const reply = cleanReply(data.reply);
  if (!data.handoff) return { reply, followUp: null };

  console.log('imessage handoff - polling for worker result');
  while (Date.now() - start < maxWaitMs) {
    await sleep(pollMs);
    try {
      const poll = await miJson(`/api/messages?thread=${encodeURIComponent(miThread)}`);
      const workerReplies = (poll.messages || []).filter((m) => {
        const ts = Date.parse(m.ts || '') || 0;
        return m.role === 'assistant' && ts >= start && ['mi-worker-result', 'mi-worker-error'].includes(m.source);
      });
      if (workerReplies.length) {
        const latest = workerReplies.at(-1);
        console.log(latest.source === 'mi-worker-error' ? 'imessage worker error ready' : 'imessage worker result ready');
        const fallback = latest.source === 'mi-worker-error' ? 'I hit an issue finishing that. I’ll need another pass.' : 'Done.';
        return { reply, followUp: cleanReply(latest.text || fallback) };
      }
    } catch (error) {
      console.warn('imessage poll error:', error?.message || String(error));
    }
  }
  return { reply, followUp: null };
}

async function send(space, reply) {
  const text = String(reply || 'Done.');
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      console.log(`photon send reply chars=${text.length} attempt=${attempt}`);
      await space.send(spectrumText(text));
      console.log('photon send ok');
      return true;
    } catch (error) {
      lastError = error;
      console.warn(`photon send failed attempt=${attempt}:`, error?.message || String(error));
      if (attempt < 3) await sleep(1500 * attempt);
    }
  }
  console.error('photon send failed permanently:', lastError?.message || String(lastError));
  return false;
}

function startTypingBestEffort(space, delayMs = 700) {
  let done = false;
  let started = false;
  let startPromise = null;
  const start = async () => {
    if (done || typeof space?.startTyping !== 'function') return;
    try {
      await space.startTyping();
      started = true;
      console.log('photon typing start ok');
    } catch (error) {
      console.warn('photon typing start failed:', error?.message || String(error));
    }
  };
  const timer = setTimeout(() => {
    startPromise = start();
  }, delayMs);
  return async () => {
    done = true;
    clearTimeout(timer);
    if (startPromise) await startPromise.catch(() => undefined);
    if (!started || typeof space?.stopTyping !== 'function') return;
    try {
      await space.stopTyping();
      console.log('photon typing stop ok');
    } catch (error) {
      console.warn('photon typing stop failed:', error?.message || String(error));
    }
  };
}

async function handle(space, message) {
  if (message?.direction && message.direction !== 'inbound') return;
  const id = String(message?.id || `${space?.id}:${message?.timestamp || Date.now()}`);
  if (seen.has(id)) return;
  seen.add(id);
  if (seen.size > 5000) seen.clear();

  const sender = senderFor(space, message);
  const spaceId = String(space?.id || message?.space?.id || '');
  console.log(`photon inbound id=${mask(id)} sender=${mask(sender)} space=${mask(spaceId)}`);
  if (!authorized(sender)) {
    console.log(`photon inbound blocked sender=${mask(sender)} allowed=${allowedUsers.map(mask).join(',') || '(none)'}`);
    return;
  }
  const body = textFor(message);
  if (!body) {
    console.log('photon inbound ignored: empty/unsupported message');
    return;
  }
  if (space?.id) knownSpaces.set(space.id, space);
  const stopTyping = startTypingBestEffort(space);
  try {
    // Do not wrap the Mi call in space.responding(): Photon typing/read-state RPCs
    // can fail with upstream connection drops before Mi is even asked. Typing is
    // cosmetic and best-effort; replies must continue without it.
    const { reply, followUp } = await askImessage(body);
    await send(space, reply);
    if (followUp && followUp !== reply) await send(space, followUp);
  } catch (error) {
    console.error('mi photon handling failed:', error?.message || String(error));
    await send(space, 'I hit an issue on my side. Try that again?');
  } finally {
    await stopTyping();
  }
}

async function sendToUser(target, message, label = 'notification') {
  if (!target) throw new Error('no iMessage target configured');
  console.log(`photon ${label} sending to ${mask(target)} chars=${String(message || '').length}`);
  const im = imessage(app);
  const user = await im.user(target);
  const space = await im.space.create(user);
  await space.send(spectrumText(cleanReply(message)));
  console.log(`photon ${label} sent`);
}

async function sendBootTest() {
  if (!bootTestSend) return;
  const target = allowedUsers[0];
  if (!target) {
    console.log('photon boot test skipped: no PHOTON_ALLOWED_USERS target');
    return;
  }
  try {
    await sendToUser(target, 'Mi Photon bridge started, reply to this iMessage to talk to Mi.', 'boot test');
  } catch (error) {
    console.error('photon boot test failed:', error?.message || String(error));
  }
}

function localOnly(req) {
  const address = req.socket.remoteAddress || '';
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function readRequestJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString('utf8');
      if (body.length > 16_384) reject(new Error('request too large'));
    });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch (error) { reject(error); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(data));
}

function startNotifyServer() {
  if (!notifyPort) return;
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method !== 'POST' || req.url !== '/notify') return sendJson(res, 404, { ok: false, error: 'not found' });
      if (!localOnly(req)) return sendJson(res, 403, { ok: false, error: 'local only' });
      if (notifyToken && req.headers.authorization !== `Bearer ${notifyToken}`) return sendJson(res, 401, { ok: false, error: 'unauthorized' });
      const payload = await readRequestJson(req);
      const title = String(payload.title || 'Mi');
      const message = String(payload.message || '').trim();
      const target = String(payload.to || allowedUsers[0] || '').trim();
      if (!message) return sendJson(res, 400, { ok: false, error: 'message required' });
      await sendToUser(target, `${title}\n\n${message}`, 'notification');
      return sendJson(res, 200, { ok: true });
    } catch (error) {
      console.error('photon notify failed:', error?.message || String(error));
      return sendJson(res, 500, { ok: false, error: error?.message || String(error) });
    }
  });
  server.on('error', (error) => {
    console.error('Mi Photon notify endpoint error:', error?.message || String(error));
  });
  server.listen(notifyPort, notifyHost, () => {
    console.log(`Mi Photon notify endpoint listening on http://${notifyHost}:${notifyPort}/notify`);
  });
  notifyServer = server;
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Mi Photon bridge shutting down from ${signal}`);
  if (notifyServer) {
    await new Promise((resolve) => notifyServer.close(() => resolve())).catch(() => undefined);
  }
  if (inFlightHandlers.size > 0) {
    console.log(`Mi Photon bridge waiting for ${inFlightHandlers.size} in-flight message(s)`);
    await Promise.race([
      Promise.allSettled(Array.from(inFlightHandlers)),
      sleep(shutdownGraceMs),
    ]);
  }
  await app?.stop?.().catch((error) => {
    console.error('Mi Photon bridge stop failed:', error?.message || String(error));
  });
  process.exit(0);
}

process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));

function trackHandle(space, message) {
  const task = handle(space, message).catch((error) => {
    console.error('mi photon handler task failed:', error?.message || String(error));
  });
  inFlightHandlers.add(task);
  task.finally(() => inFlightHandlers.delete(task));
}

console.log(`Mi Photon bridge connecting to Mi at ${miBaseUrl}, thread=${miThread}`);
startNotifyServer();
void sendBootTest();
for (;;) {
  try {
    for await (const [space, message] of app.messages) {
      if (!shuttingDown) trackHandle(space, message);
    }
    if (testMode) {
      await Promise.allSettled(Array.from(inFlightHandlers));
      await app?.stop?.().catch((error) => {
        console.error('Mi Photon bridge stop failed:', error?.message || String(error));
      });
      process.exit(0);
    }
  } catch (error) {
    console.error('Photon stream error; reconnecting:', error?.message || String(error));
    if (testMode) process.exit(1);
    await sleep(3000);
  }
}
