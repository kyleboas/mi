#!/usr/bin/env node
import http from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { emitTurnEvent } from './mi-turn-observability.mjs';
import { createImessageRuntime } from './mi-imessage-runtime.mjs';

const root = process.env.MI_ROOT || '/home/kyle/assistant';
const projectId = process.env.PHOTON_PROJECT_ID;
const projectSecret = process.env.PHOTON_PROJECT_SECRET;
const allowedUsers = splitList(process.env.PHOTON_ALLOWED_USERS || '');
const allowAll = /^(1|true|yes|on)$/i.test(process.env.PHOTON_ALLOW_ALL_USERS || '');
const photonTypingDelayMs = boundedEnvironmentInteger('MI_PHOTON_TYPING_DELAY_MS', 100, 0, 5000);
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
let runtime;
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

function splitList(value) {
  return String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
}

function boundedEnvironmentInteger(name, fallback, minimum, maximum) {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === '') return fallback;
  const parsed = /^\d+$/.test(String(raw).trim()) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    console.warn(`Invalid ${name}; using safe default ${fallback}ms.`);
    return fallback;
  }
  return parsed;
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
      const delayMs = Number(space.typingStartDelayMs || 0);
      if (Number.isFinite(delayMs) && delayMs > 0) await sleep(delayMs);
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
        for (const event of events) yield [createTestSpace(event.space), event.message || {}];
      },
    },
    async stop() { await appendTestSend({ kind: 'stop' }); },
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
runtime = await createImessageRuntime();

function senderFor(space, message) {
  return String(message?.sender?.id || space?.phone || message?.space?.phone || '').trim();
}

function mask(value) {
  const text = String(value || '');
  if (text.length <= 4) return text || '(unknown)';
  return `${text.slice(0, 3)}…${text.slice(-4)}`;
}

function authorized(sender) {
  return allowAll || allowedUsers.includes(sender);
}

function cleanNotification(text) {
  return String(text || '').replace(/[—–]/g, '-').replace(/\n{3,}/g, '\n\n').trim().slice(0, maxReplyChars) || 'I am here.';
}

async function sendWithRetries(space, reply) {
  const text = cleanNotification(reply);
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

function startTypingBestEffort(space, delayMs = photonTypingDelayMs) {
  console.log(`photon typing scheduled delay=${delayMs}ms`);
  let done = false;
  let started = false;
  let startPromise;
  const timer = setTimeout(() => {
    if (done || typeof space?.startTyping !== 'function') return;
    startPromise = Promise.resolve(space.startTyping()).then(() => {
      started = true;
      console.log('photon typing start ok');
    }).catch((error) => console.warn('photon typing start failed:', error?.message || String(error)));
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
  const sender = senderFor(space, message);
  console.log(`photon inbound sender=${mask(sender)} space=${mask(space?.id || message?.space?.id)}`);
  if (!authorized(sender)) {
    console.log(`photon inbound blocked sender=${mask(sender)} allowed=${allowedUsers.map(mask).join(',') || '(none)'}`);
    return;
  }
  const stopTyping = startTypingBestEffort(space);
  try {
    const result = await runtime.handleEvent({ space, message, sendReply: (reply) => sendWithRetries(space, reply) });
    await emitTurnEvent(root, { stage: 'ack', outcome: result.ok ? 'ok' : 'skipped', route: 'photon', modelProfile: 'none', turn: result.deliveryId || result.conversationId || 'retry' }).catch(() => undefined);
  } catch (error) {
    console.error('mi photon handling failed:', error?.message || String(error));
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
  await space.send(spectrumText(cleanNotification(message)));
  console.log(`photon ${label} sent`);
}

async function sendBootTest() {
  if (!bootTestSend || !allowedUsers[0]) return;
  try { await sendToUser(allowedUsers[0], 'Mi Photon bridge started. Reply to this iMessage to talk to Mi.', 'boot test'); }
  catch (error) { console.error('photon boot test failed:', error?.message || String(error)); }
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
      try { resolve(body ? JSON.parse(body) : {}); } catch (error) { reject(error); }
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
      const message = String(payload.message || '').trim();
      const target = String(payload.to || allowedUsers[0] || '').trim();
      if (!message) return sendJson(res, 400, { ok: false, error: 'message required' });
      await sendToUser(target, message, 'notification');
      return sendJson(res, 200, { ok: true });
    } catch (error) {
      console.error('photon notify failed:', error?.message || String(error));
      return sendJson(res, 500, { ok: false, error: 'notification failed' });
    }
  });
  server.on('error', (error) => console.error('Mi Photon notify endpoint error:', error?.message || String(error)));
  server.listen(notifyPort, notifyHost, () => console.log(`Mi Photon notify endpoint listening on http://${notifyHost}:${notifyPort}/notify`));
  notifyServer = server;
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Mi Photon bridge shutting down from ${signal}`);
  if (notifyServer) await new Promise((resolve) => notifyServer.close(() => resolve())).catch(() => undefined);
  if (inFlightHandlers.size > 0) {
    await Promise.race([Promise.allSettled(Array.from(inFlightHandlers)), sleep(shutdownGraceMs)]);
  }
  await runtime?.shutdown?.().catch(() => undefined);
  await app?.stop?.().catch((error) => console.error('Mi Photon bridge stop failed:', error?.message || String(error)));
  process.exit(0);
}

process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));

function trackHandle(space, message) {
  const task = handle(space, message).catch((error) => console.error('mi photon handler task failed:', error?.message || String(error)));
  inFlightHandlers.add(task);
  task.finally(() => inFlightHandlers.delete(task));
}

console.log('Mi Photon bridge connecting directly to the Mi iMessage runtime');
startNotifyServer();
void sendBootTest();
for (;;) {
  try {
    for await (const [space, message] of app.messages) if (!shuttingDown) trackHandle(space, message);
    if (testMode) {
      while (inFlightHandlers.size > 0) await Promise.allSettled(Array.from(inFlightHandlers));
      await app?.stop?.().catch(() => undefined);
      process.exit(0);
    }
  } catch (error) {
    console.error('Photon stream error; reconnecting:', error?.message || String(error));
    if (testMode) process.exit(1);
    await sleep(3000);
  }
}
