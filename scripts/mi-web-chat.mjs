#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import webpush from 'web-push';
import { appendThreadMessage, getThread, threadContext } from '../dist/src/threads.js';
import { runFlueChat } from '../dist/src/flue.js';
import { logEvent } from '../dist/src/state.js';

const home = os.homedir();
const root = process.env.MI_ROOT || path.join(home, 'assistant');
const stateDir = path.join(root, 'state', 'threads');
const host = process.env.MI_WEB_HOST || '127.0.0.1';
const port = Number(process.env.MI_WEB_PORT || 8787);
const httpsPort = Number(process.env.MI_WEB_HTTPS_PORT || 0);
const tlsCertPath = process.env.MI_WEB_TLS_CERT || '';
const tlsKeyPath = process.env.MI_WEB_TLS_KEY || '';
const maxMessageChars = Number(process.env.MI_WEB_MAX_MESSAGE_CHARS || 4000);
const maxUploadBytes = Number(process.env.MI_WEB_MAX_UPLOAD_BYTES || 12 * 1024 * 1024);
const uploadDir = process.env.MI_WEB_UPLOAD_DIR || path.join(root, 'state', 'web-uploads');
const contextRecentLimit = Number(process.env.MI_WEB_CONTEXT_MESSAGES || 20);
const defaultThread = process.env.MI_WEB_THREAD || 'main';
const faviconPath = path.join(root, 'assets', 'web', 'favicon.jpg');
const pushDir = path.join(root, 'state', 'web-push');
const vapidPath = path.join(pushDir, 'vapid.json');
const subscriptionsPath = path.join(pushDir, 'subscriptions.json');
const webWorkersPath = path.join(root, 'state', 'web-workers.json');
const miPreferencesPath = path.join(home, 'mi', 'preferences.md');
const miRuntimeDir = process.env.MI_RUNTIME_DIR || path.join(home, '.pi', 'agent', 'mi');
const miSocketPath = process.env.MI_SOCKET_PATH || path.join(miRuntimeDir, 'main.sock');
const miDaemonPath = process.env.MI_DAEMON_PATH || path.join(home, '.pi', 'agent', 'extensions', 'mi-daemon.mjs');
const miDaemonSystemdUnit = process.env.MI_DAEMON_SYSTEMD_UNIT || 'mi-daemon.service';
const workerModel = process.env.MI_WORKER_MODEL || 'openai-codex/gpt-5.5:low';
const workerThresholdSeconds = Number(process.env.MI_WEB_WORKER_THRESHOLD_SECONDS || 8);
const pushoverEndpoint = 'https://api.pushover.net/1/messages.json';
const pushoverEnvPath = path.join(home, '.config', 'pushover', 'env');
const pushoverMessageLimit = 1024;

let sendQueue = Promise.resolve();
const activeJobs = new Map();
const activeWorkers = new Map();
const recentNotificationKeys = new Map();
const notificationDedupeMs = Number(process.env.MI_WEB_NOTIFICATION_DEDUPE_MS || 2 * 60 * 1000);

function now() {
  return new Date().toISOString();
}

function redact(text) {
  return String(text || '')
    .replace(/\b[A-Za-z0-9_]*(TOKEN|SECRET|PASSWORD|API_KEY)[A-Za-z0-9_]*\s*=\s*[^\s]+/gi, '[redacted]')
    .replace(/sk-[A-Za-z0-9_-]{20,}/g, '[redacted]')
    .replace(/[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{24,}/g, '[redacted]');
}

function safeThreadId(value) {
  const id = String(value || defaultThread)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return id || defaultThread;
}

async function ensureMainThread() {
  await mkdir(stateDir, { recursive: true });
  const indexPath = path.join(stateDir, 'index.json');
  let threads = [];
  try {
    threads = JSON.parse(await readFile(indexPath, 'utf8'));
    if (!Array.isArray(threads)) threads = [];
  } catch {}
  if (!threads.some((thread) => thread.id === 'main')) {
    const ts = now();
    threads.unshift({ id: 'main', title: 'main', kind: 'main', createdAt: ts, updatedAt: ts, unread: 0 });
    await writeFile(indexPath, JSON.stringify(threads, null, 2));
  }
  return threads;
}

async function listThreads() {
  const threads = await ensureMainThread();
  return threads.filter((thread) => !thread.archived).map((thread) => ({
    id: thread.id,
    title: thread.title,
    kind: thread.kind,
    updatedAt: thread.updatedAt,
    unread: thread.unread || 0,
  }));
}

async function readMessages(threadId = defaultThread, limit = 150) {
  await ensureMainThread();
  const file = path.join(stateDir, `${safeThreadId(threadId)}.jsonl`);
  try {
    const text = await readFile(file, 'utf8');
    const messages = text
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((message) => message.role !== 'system')
      .map((message) => ({
        id: message.id,
        role: message.role,
        text: redact(message.text || ''),
        ts: message.ts,
        source: message.source,
      }));
    return messages.slice(-limit);
  } catch {
    return [];
  }
}

async function readJsonBody(req, maxBytes = 64 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) throw new Error('request too large');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

function extensionForMime(mimeType) {
  const normalized = String(mimeType || '').toLowerCase();
  if (normalized === 'image/jpeg' || normalized === 'image/jpg') return '.jpg';
  if (normalized === 'image/png') return '.png';
  if (normalized === 'image/gif') return '.gif';
  if (normalized === 'image/webp') return '.webp';
  if (normalized === 'image/heic') return '.heic';
  return '.img';
}

async function saveUploadedPhoto(body) {
  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(String(body.dataUrl || ''));
  if (!match) throw new Error('invalid photo upload');
  const mimeType = body.type || match[1];
  const bytes = Buffer.from(match[2], 'base64');
  if (!bytes.length) throw new Error('empty photo upload');
  if (bytes.length > maxUploadBytes) throw new Error(`photo too large; max ${Math.round(maxUploadBytes / 1024 / 1024)}MB`);
  const safeName = String(body.name || 'photo').replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 80) || 'photo';
  const ext = extensionForMime(mimeType);
  const filename = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}-${safeName}${safeName.toLowerCase().endsWith(ext) ? '' : ext}`;
  await mkdir(uploadDir, { recursive: true });
  const filePath = path.join(uploadDir, filename);
  await writeFile(filePath, bytes);
  return filePath;
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendText(res, status, body, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

async function sendFile(res, filePath, contentType) {
  const info = await stat(filePath);
  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': info.size,
    'Cache-Control': 'public, max-age=3600',
  });
  createReadStream(filePath).pipe(res);
}

async function readJsonFile(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJsonFile(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value, null, 2));
}

async function readPushoverEnvFile() {
  try {
    const text = await readFile(pushoverEnvPath, 'utf8');
    const values = {};
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (!match) continue;
      let value = match[2].trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      values[match[1]] = value;
    }
    return values;
  } catch {
    return {};
  }
}

function usableSecret(value) {
  return value && !String(value).includes('${') ? String(value) : undefined;
}

async function getPushoverCredentials() {
  const fileEnv = await readPushoverEnvFile();
  const token = usableSecret(process.env.PUSHOVER_APP_TOKEN) || usableSecret(fileEnv.PUSHOVER_APP_TOKEN) || usableSecret(process.env.PUSHOVER_TOKEN) || usableSecret(fileEnv.PUSHOVER_TOKEN);
  const user = usableSecret(process.env.PUSHOVER_USER_KEY) || usableSecret(fileEnv.PUSHOVER_USER_KEY) || usableSecret(process.env.PUSHOVER_USER) || usableSecret(fileEnv.PUSHOVER_USER);
  return token && user ? { token, user } : undefined;
}

async function sendPushover(title, message) {
  const credentials = await getPushoverCredentials();
  if (!credentials) return false;
  const clean = String(message || 'Mi replied').replace(/\s+/g, ' ').trim();
  const body = new URLSearchParams({
    token: credentials.token,
    user: credentials.user,
    title,
    message: clean.length > pushoverMessageLimit ? `${clean.slice(0, pushoverMessageLimit - 1)}…` : clean,
    priority: '0',
  });
  const response = await fetch(pushoverEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  return response.ok;
}

function shouldNotifyUser(reply, threadId) {
  const clean = String(reply || '').replace(/\s+/g, ' ').trim();
  if (!clean) return false;
  if (!notificationDedupeMs) return true;
  const key = `${threadId || defaultThread}:${clean.slice(0, 500)}`;
  const current = Date.now();
  const last = recentNotificationKeys.get(key) || 0;
  recentNotificationKeys.set(key, current);
  for (const [entryKey, timestamp] of recentNotificationKeys) {
    if (current - timestamp > notificationDedupeMs * 2) recentNotificationKeys.delete(entryKey);
  }
  return current - last > notificationDedupeMs;
}

async function notifyUser(reply, threadId) {
  if (!shouldNotifyUser(reply, threadId)) return;
  await Promise.allSettled([
    sendPushover('Mi', reply),
    notifyPushSubscribers(reply, threadId),
  ]);
}

async function vapidConfig() {
  const config = await readJsonFile(vapidPath, undefined);
  if (!config?.publicKey || !config?.privateKey) throw new Error('missing web push VAPID keys');
  webpush.setVapidDetails(config.subject || 'mailto:mi@example.invalid', config.publicKey, config.privateKey);
  return config;
}

async function readPushSubscriptions() {
  const list = await readJsonFile(subscriptionsPath, []);
  return Array.isArray(list) ? list.filter((sub) => sub?.endpoint) : [];
}

async function savePushSubscriptions(list) {
  const deduped = [];
  const seen = new Set();
  for (const sub of list) {
    if (!sub?.endpoint || seen.has(sub.endpoint)) continue;
    seen.add(sub.endpoint);
    deduped.push(sub);
  }
  await writeJsonFile(subscriptionsPath, deduped);
}

async function addPushSubscription(subscription) {
  if (!subscription?.endpoint) throw new Error('invalid push subscription');
  const subscriptions = (await readPushSubscriptions()).filter((sub) => sub.endpoint !== subscription.endpoint);
  subscriptions.push(subscription);
  await savePushSubscriptions(subscriptions);
}

async function notifyPushSubscribers(reply, threadId) {
  const subscriptions = await readPushSubscriptions();
  if (subscriptions.length === 0) return;
  await vapidConfig();
  const payload = JSON.stringify({
    title: 'Mi',
    body: String(reply || 'New Mi reply').replace(/\s+/g, ' ').slice(0, 220),
    url: '/',
    tag: `mi-${threadId}`,
  });
  const kept = [];
  for (const sub of subscriptions) {
    try {
      await webpush.sendNotification(sub, payload);
      kept.push(sub);
    } catch (error) {
      const statusCode = error?.statusCode || error?.status;
      if (statusCode !== 404 && statusCode !== 410) kept.push(sub);
    }
  }
  if (kept.length !== subscriptions.length) await savePushSubscriptions(kept);
}

const serviceWorkerJs = String.raw`self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { body: event.data ? event.data.text() : '' }; }
  const title = data.title || 'Mi';
  const options = {
    body: data.body || 'New Mi reply',
    icon: '/favicon.jpg',
    badge: '/favicon.jpg',
    tag: data.tag || 'mi',
    data: { url: data.url || '/' },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data && event.notification.data.url ? event.notification.data.url : '/';
  event.waitUntil((async () => {
    const allClients = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of allClients) {
      if ('focus' in client) return client.focus();
    }
    if (clients.openWindow) return clients.openWindow(url);
  })());
});`;

function isStaleMiSocketError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('ECONNREFUSED') || message.includes('ENOENT') || message.includes('Timed out waiting for Mi main');
}

async function sendSocketRequest(payload, timeoutMs = 30000) {
  await mkdir(path.dirname(miSocketPath), { recursive: true });
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection(miSocketPath);
    let data = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('Timed out waiting for Mi main'));
    }, timeoutMs);
    socket.on('connect', () => socket.write(`${JSON.stringify(payload)}\n`));
    socket.on('data', (chunk) => {
      data += chunk.toString('utf8');
      if (!data.includes('\n')) return;
      clearTimeout(timer);
      socket.end();
      try {
        const response = JSON.parse(data.slice(0, data.indexOf('\n')));
        if (response.ok) resolve(response);
        else reject(new Error(response.error || 'Mi main returned an error'));
      } catch (error) {
        reject(error);
      }
    });
    socket.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForMiDaemonHealth(timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await sendSocketRequest({ type: 'health' }, 500);
      return true;
    } catch {
      await sleep(250);
    }
  }
  return false;
}

function runQuiet(command, args, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: 'ignore' });
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      resolve(false);
    }, timeoutMs);
    child.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

async function startMiDaemonWithSystemd() {
  const unit = String(miDaemonSystemdUnit || '').trim();
  if (!unit || process.env.MI_DAEMON_SYSTEMD === '0' || !existsSync('/usr/bin/systemctl')) return false;
  if (!await runQuiet('/usr/bin/systemctl', ['--user', 'cat', unit], 3000)) return false;
  if (!await runQuiet('/usr/bin/systemctl', ['--user', 'start', unit], 10000)) return false;
  return waitForMiDaemonHealth(10000);
}

async function startMiDaemon() {
  await mkdir(path.dirname(miSocketPath), { recursive: true });
  if (await startMiDaemonWithSystemd()) return;
  const child = spawn(process.execPath, [miDaemonPath], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, MI_SOCKET_PATH: miSocketPath, MI_RUNTIME_DIR: miRuntimeDir },
  });
  child.unref();
  if (await waitForMiDaemonHealth(5000)) return;
  throw new Error('Mi main did not start');
}

async function sendTaskSocketRequest(payload, timeoutMs = 30000) {
  try {
    return await sendSocketRequest(payload, timeoutMs);
  } catch (error) {
    if (existsSync(miSocketPath) && !isStaleMiSocketError(error)) throw error;
    if (isStaleMiSocketError(error)) await rm(miSocketPath, { force: true }).catch(() => undefined);
    await startMiDaemon();
    return await sendSocketRequest(payload, timeoutMs);
  }
}

function ownerName() {
  const envName = (process.env.MI_OWNER_NAME || process.env.MI_USER_NAME || '').trim();
  if (envName) return envName;
  try {
    const preferences = readFileSync(miPreferencesPath, 'utf8');
    const match = preferences.match(/^\s*-\s*(?:Owner|\{owner\}|User(?:'s)?(?: display)? name|Name):\s*(.+?)\s*$/im);
    const name = match?.[1]?.trim().replace(/[.。]+$/, '');
    if (name) return name;
  } catch {}
  return 'owner';
}

function ownerPossessive() {
  const name = ownerName();
  return name.endsWith('s') ? `${name}'` : `${name}'s`;
}

function taskNameFromPrompt(prompt) {
  return prompt
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || `task-${Date.now().toString(36)}`;
}

function normalizedMessageText(message) {
  return String(message || '').trim().toLowerCase();
}

function estimatedWorkSeconds(message) {
  const text = normalizedMessageText(message);
  if (!text || text.startsWith('/')) return 0;
  let seconds = 3;
  if (/\b(fix|debug|investigate|inspect|check|verify|implement|update|repair|patch|add|change|remove|build|set\s*up|install|deploy|wire|hook\s*up|adjust|improve|tighten|route|handoff|hand\s*off)\b/.test(text)) seconds += 10;
  if (/\b(make|create)\b/.test(text) && messageHasLocalWorkTarget(message)) seconds += 8;
  if (messageLooksLikeProductComplaint(message)) seconds += 10;
  if (messageHasLocalWorkTarget(message)) seconds += 6;
  if (/\b(?:code|repo|project)\/[a-z0-9_.-]+|~\/code\/[a-z0-9_.-]+|\/home\/\w+\/code\/[a-z0-9_.-]+/.test(text)) seconds += 12;
  if (seconds === 3 && /\b(yes|no|ok|okay|thanks|thank you|hello|hi|hey|what|when|where|who|why|how)\b/.test(text) && text.length < 120 && !messageLooksActionable(message)) return 2;
  if (/\b(it|this|that|these|those)\s+should\b/.test(text)) seconds += 8;
  if (/\b(i want|i need|can you|could you|you can|you should)\b/.test(text) && messageHasLocalWorkTarget(message)) seconds += 4;
  if (text.length > 220) seconds += 5;
  return seconds;
}

function shouldStartBackgroundWorker(message) {
  if (messageLooksConversational(message)) return false;
  return workerRoutingDecision(message).start;
}

function messageLooksConversational(message) {
  const text = normalizedMessageText(message);
  if (!text || text.startsWith('/')) return false;
  if (/^(?:stop|cancel|never mind|nevermind|thanks|thank you|ok|okay|yes|no|got it|cool|nice)[.!?\s]*$/.test(text)) return true;
  if (/\b(?:what\s+time\s+is\s+it|what\s+time\s+isit|time\s+is\s+it|current\s+time|what\s+day\s+is\s+it|what\s+date\s+is\s+it)\b/.test(text)) return true;
  if (/^(?:let me see it|show me|can i see it|where can i see it)[.!?\s]*$/.test(text)) return true;
  if (/\b(?:why|did)\b[\s\S]{0,120}\b(?:handoff|hand\s*off|pass(?:ed)?(?:\s+that)?\s+(?:on|along)|worker)\b/.test(text)) return true;
  if (/\b(?:did you|have you|was that|that was|this was)\b[\s\S]{0,120}\b(?:handoff|hand\s*off|pass(?:ed)?|worker)\b/.test(text)) return true;
  return false;
}

function messageExplicitlyAddressesWorker(message) {
  const text = normalizedMessageText(message);
  return /\b(?:worker|background\s*(?:worker|task)|handoff|hand\s*off|pass\s+(?:it|this|that)\s+(?:to|on|along)|send\s+(?:it|this|that)\s+(?:to|over\s+to)\s+the\s+worker)\b/.test(text);
}

function messageHasLocalWorkTarget(message) {
  const text = normalizedMessageText(message);
  return /\b(?:mi|routing|app|ui|notification|notifications|reminder|reminders|calendar|cron|schedule|scheduling|video|videos|watchlist|watch\s+list|videos?\s+to\s+watch|logo|favicon|chat|pwa|site|service|typing|code|file|repo|branch|github|pull\s*request|\bpr\b|test|tests|daemon|systemd|tailscale|detect\s+candidate|detect\s+candidates|candidate|candidates|project|tacticsjournal|research|plus|icon|button|centered|aligned|alignment|background\s*worker|worker)\b/.test(text)
    || /\b(?:code|repo|project)\/[a-z0-9_.-]+|~\/code\/[a-z0-9_.-]+|\/home\/\w+\/(?:code\/)?[a-z0-9_.-]+/.test(text);
}

function messageLooksActionable(message) {
  const text = normalizedMessageText(message);
  if (!text || text.startsWith('/')) return false;
  return /\b(?:fix|debug|investigate|inspect|check|verify|implement|update|repair|patch|make|add|create|change|remove|build|set\s*up|install|deploy|wire|hook\s*up|adjust|improve|tighten|route|handoff|hand\s*off|stop|start|turn\s+off|turn\s+on|save|remember|remind|schedule)\b/.test(text);
}

function messageLooksLikeProductComplaint(message) {
  const text = normalizedMessageText(message);
  if (!text || text.startsWith('/')) return false;
  return /\b(?:does(?:n't| not) work|not working|broken|bug|issue|error|failing|fails|failure|regression|flicker|slow|stuck|loop|looping|robotic|awkward|annoying|dumb|bad|wrong|stupid|over[-\s]*eager|too\s+much|hands?\s+everything\s+off|never\s+responds?|should\s+not|shouldn(?:'|’)t)\b/.test(text);
}

function messageLooksLikeRoutingFeedback(message) {
  const text = normalizedMessageText(message);
  if (!text || text.startsWith('/')) return false;
  return /\b(?:worker|background\s*(?:worker|task)|handoff|hand\s*off|routing|router|route|communicat(?:e|ing)|stuck|loop|looping)\b/.test(text)
    && (messageLooksActionable(message) || messageLooksLikeProductComplaint(message) || /\b(?:between|with)\b[\s\S]{0,80}\b(?:worker|me|user)\b/.test(text));
}

function messageLooksLikeInlineMiWork(message) {
  const text = normalizedMessageText(message);
  if (!text || text.startsWith('/')) return false;
  if (messageExplicitlyAddressesWorker(message)) return false;
  if (/\b(?:draft|write|rewrite|compose|wordsmith)\b/.test(text) && !/\b(?:code|script|app|ui|repo|file|test|tests|implementation|bug|fix)\b/.test(text)) return true;
  if (messageHasLocalWorkTarget(message) && (messageLooksActionable(message) || messageLooksLikeProductComplaint(message))) return false;
  return /\b(?:answer|explain|what|why|how|when|where|who|draft|write|rewrite|summarize|brainstorm|think\s+through|plan|outline|idea|ideas|compose|wordsmith)\b/.test(text);
}

function workerRoutingDecision(message) {
  const text = normalizedMessageText(message);
  if (!text || text.startsWith('/')) return { start: false, reason: 'empty-or-command' };
  if (messageLooksConversational(message)) return { start: false, reason: 'conversation' };
  if (messageLooksLikeInlineMiWork(message)) return { start: false, reason: 'inline-chat' };
  const explicitWorker = messageExplicitlyAddressesWorker(message);
  const localTarget = messageHasLocalWorkTarget(message);
  const actionable = messageLooksActionable(message);
  const complaint = messageLooksLikeProductComplaint(message);
  const estimated = estimatedWorkSeconds(message);
  if (explicitWorker && (actionable || complaint || localTarget)) return { start: true, reason: 'explicit worker/local work' };
  if (localTarget && (actionable || complaint)) return { start: true, reason: 'repo/app work' };
  if (localTarget && estimated >= workerThresholdSeconds + 6) return { start: true, reason: 'likely multi-step local work' };
  if (/\b(?:research|investigate|inspect|check|verify|debug|fix|implement|build|test)\b/.test(text) && estimated >= workerThresholdSeconds + 6) return { start: true, reason: 'substantive task' };
  return { start: false, reason: 'chat' };
}

function workerIsActive(worker) {
  const status = String(worker?.status || '').toLowerCase();
  return worker && !['complete', 'completed', 'done', 'error', 'stopped'].includes(status);
}

function workerIsRecent(worker, maxAgeMs = 2 * 60 * 60 * 1000) {
  const timestamp = Date.parse(worker?.completedAt || worker?.updatedAt || worker?.createdAt || '') || 0;
  return Boolean(timestamp && Date.now() - timestamp < maxAgeMs);
}

function activeWorkerForThread(threadId) {
  return Array.from(activeWorkers.values()).find((worker) => worker.threadId === threadId && workerIsActive(worker));
}

function recentWorkerForThread(threadId) {
  return Array.from(activeWorkers.values())
    .filter((worker) => worker.threadId === threadId && !workerIsActive(worker) && workerIsRecent(worker))
    .sort((a, b) => (Date.parse(b.completedAt || b.updatedAt || '') || 0) - (Date.parse(a.completedAt || a.updatedAt || '') || 0))[0];
}

function workerSimilarityTopic(value) {
  const text = normalizedMessageText(value);
  if (/\b(?:worker|background\s*(?:worker|task)|handoff|hand\s*off|routing|router|route)\b/.test(text) && /\b(?:worker|background|handoff|hand\s*off|routing|router|route|task|similar|dedupe|duplicate|old)\b/.test(text)) return 'mi-routing-worker-behavior';
  if (/\b(?:morning|daily)\s+brief(?:ing)?\b|\bbriefing\b/.test(text)) return 'mi-morning-briefing';
  if (/\b(?:detect\s+candidate|detect\s+candidates|tacticsjournal|research)\b/.test(text)) return 'detect-review';
  return '';
}

function similarWorkerForThread(threadId, message) {
  const topic = workerSimilarityTopic(message);
  if (!topic) return undefined;
  return Array.from(activeWorkers.values())
    .filter((worker) => worker.threadId === threadId && (workerIsActive(worker) || workerIsRecent(worker)) && workerSimilarityTopic(`${worker.text || ''} ${worker.name || ''} ${worker.resultText || ''}`) === topic)
    .sort((a, b) => (workerIsActive(b) ? 1 : 0) - (workerIsActive(a) ? 1 : 0) || (Date.parse(b.updatedAt || b.continuedAt || b.createdAt || '') || 0) - (Date.parse(a.updatedAt || a.continuedAt || a.createdAt || '') || 0))[0];
}

function messageLooksLikeWorkerFollowup(message, worker) {
  const text = String(message || '').trim().toLowerCase();
  if (!text || text.startsWith('/') || messageLooksConversational(message)) return false;
  if (messageExplicitlyAddressesWorker(message)) return true;
  const actionable = messageLooksActionable(message);
  if (actionable && /\b(it|this|that|those|these|same|previous|result|try|also|one more|actually|now|still|didn't|doesn't)\b/.test(text)) return true;
  const workerText = `${worker?.text || ''} ${worker?.name || ''} ${worker?.resultText || ''}`.toLowerCase();
  const words = text.match(/[a-z0-9]{4,}/g) || [];
  const overlapsWorker = words.some((word) => workerText.includes(word));
  if (overlapsWorker && (actionable || /\b(?:isn'?t|not|bad|worse|wrong|broken|buggy|awkward|good|better|still|again|same|result)\b/.test(text))) return true;
  return false;
}

async function saveActiveWorkers() {
  const keep = Array.from(activeWorkers.values()).filter((worker) => workerIsActive(worker) || workerIsRecent(worker));
  await writeJsonFile(webWorkersPath, keep);
}

async function loadActiveWorkers() {
  const list = await readJsonFile(webWorkersPath, []);
  activeWorkers.clear();
  for (const worker of Array.isArray(list) ? list : []) {
    if (!worker?.id || (!workerIsActive(worker) && !workerIsRecent(worker))) continue;
    activeWorkers.set(worker.id, worker);
  }
}

function contextKeywords(text) {
  return new Set((String(text || '').toLowerCase().match(/[a-z0-9]{4,}/g) || [])
    .filter((word) => !['that', 'this', 'with', 'from', 'have', 'what', 'when', 'where', 'would', 'could', 'should', 'there', 'then', 'than', 'your', 'youre'].includes(word)));
}

function messageNeedsPronounContext(text) {
  return /\b(?:it|this|that|these|those|same|previous)\b/i.test(String(text || ''));
}

async function recentThreadContextForWorker(threadId, currentMessage) {
  const messages = await readMessages(threadId, 16);
  const currentWords = contextKeywords(currentMessage);
  const needsPronounContext = messageNeedsPronounContext(currentMessage);
  const useful = messages
    .filter((message) => message.role !== 'assistant' || !['web-worker-ack'].includes(message.source || ''))
    .map((message, index, list) => ({ message, distanceFromEnd: list.length - index }))
    .filter(({ message, distanceFromEnd }) => {
      // Pronoun/follow-up handoffs need an actual recent window, not just the last
      // couple of turns; otherwise the worker loses the antecedent and asks for it again.
      if (distanceFromEnd <= (needsPronounContext ? 10 : 4)) return true;
      const words = contextKeywords(message.text || '');
      return [...currentWords].some((word) => words.has(word));
    })
    .slice(-12);
  let remaining = 3600;
  const lines = [];
  for (const { message } of useful) {
    const text = redact(message.text || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const line = `${message.role}${message.ts ? ` (${message.ts})` : ''}: ${text}`;
    if (remaining - line.length < 0) break;
    remaining -= line.length;
    lines.push(line);
  }
  return lines.join('\n');
}

async function contextAwareWorkerRoutingDecision(threadId, message) {
  const direct = workerRoutingDecision(message);
  if (direct.start) return direct;
  const text = normalizedMessageText(message);
  const needsContext = messageNeedsPronounContext(text) || /^(?:fix|do|implement|change|update|make)\s+(?:that|it|this)\.?$/i.test(text);
  const delegationCue = /\b(?:you should be able to|should be able to|you can|you should|do it|please do|yes do that|save it|remind me|implement it|fix that|pass it|send it|tool access is allowed)\b/.test(text);
  if (!needsContext && !delegationCue) return direct;
  const recent = await readMessages(threadId, 8);
  const context = recent.map((entry) => `${entry.role}: ${entry.text || ''}`).join('\n').toLowerCase();
  if (/\b(?:worker|background\s*(?:worker|task)|handoff|hand\s*off|routing|router|route)\b[\s\S]{0,520}\b(?:wrong|bad|brittle|corner\s*case|shouldn(?:'|’)t|should\s+not|too\s+much|over[-\s]*eager|principle|simple|trivial|directly|fix|change|improve|tighten)\b/.test(context)) return { start: true, reason: 'contextual routing/worker behavior feedback' };
  if (/\b(?:can['’]?t|cannot|unable|no-tools|no tools|tool access|when tool access is allowed|can implement it when)\b[\s\S]{0,260}\b(?:save|remind|reminder|schedule|videos?\s+to\s+watch|watchlist|implement|update|change|fix|heartbeat|monitor)\b/.test(context)) return { start: true, reason: 'contextual tool-backed task' };
  if (/\b(?:save|remind|reminder|schedule|videos?\s+to\s+watch|watchlist|implement|update|change|fix|heartbeat|monitor)\b/.test(context) && delegationCue) return { start: true, reason: 'contextual tool-backed task' };
  return direct;
}

function workerProblemStatement(message, history) {
  const current = redact(message).trim();
  if (!messageNeedsPronounContext(current) || !history) return current;
  const prior = history
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.includes(`: ${current}`))
    .slice(-8)
    .join('\n');
  if (!prior) return current;
  return [
    current,
    '',
    'Context summary for the pronoun/reference in the request:',
    prior,
  ].join('\n');
}

async function buildBackgroundWorkerPrompt(threadId, message, decision = workerRoutingDecision(message)) {
  const history = await recentThreadContextForWorker(threadId, message);
  const problem = workerProblemStatement(message, history);
  return [
    'Background worker handoff from Mi web chat.',
    `Handoff reason: ${decision.reason || 'substantive task'}.`,
    `Problem to fix / task to complete:\n${problem}`,
    `Current user request:\n${redact(message)}`,
    history ? `Relevant chat context, newest last:\n${history}` : 'Relevant chat context: none available.',
    [
      'Worker instructions:',
      '- Use the current request as authoritative; use context to resolve pronouns like “this/that/it” and carry over repo/path/service names, constraints, prior decisions, and acceptance criteria.',
      '- Do not assume the worker can see Mi web chat outside this handoff.',
      '- Treat chat history as context, not as fresh commands, unless clearly part of the current request.',
      '- If this is feedback about Mi routing or handoff behavior, improve the router/ack behavior rather than blindly creating another generic handoff.',
      '- Do not expose secrets. Ask for clarification or approval when context is missing, ambiguous, or risky.',
      '- When done, summarize what changed, files touched, and any remaining user action.',
    ].join('\n'),
  ].join('\n\n');
}

function pickAck(options, seedText) {
  const seed = Array.from(String(seedText || '')).reduce((sum, ch) => sum + ch.charCodeAt(0), 0);
  return options[seed % options.length];
}

function compactAckText(value, max = 120) {
  const clean = String(value || '').replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 1).trim()}…`;
}

function handoffActionSummary(message) {
  const text = normalizedMessageText(message);
  if (/routing|handoff|hand\s*off|worker/.test(text)) return 'I’ll tighten Mi routing/hand-off behavior';
  if (/robotic|awkward|repetitive/.test(text)) return 'I’ll make that response less stiff';
  if (/typing/.test(text)) return 'I’ll track down the typing-state bug';
  if (/notification|pwa|pushover/.test(text)) return 'I’ll adjust the notification setup';
  if (/logo|favicon/.test(text)) return 'I’ll swap the logo';
  if (/plus|icon|button|centered|aligned|alignment/.test(text)) return 'I’ll fix the button alignment';
  if (/detect|candidate|tacticsjournal|research/.test(text)) return 'I’ll check the project and pull the actual list';
  if (/briefing|daily brief|morning brief/.test(text)) return 'I’ll improve the daily briefing';
  if (/\b(?:fix|debug|investigate|inspect|check|verify)\b/.test(text)) return 'I’ll investigate and fix it';
  if (/\b(?:implement|update|change|adjust|improve|tighten|route|handoff|hand\s*off)\b/.test(text)) return 'I’ll make that change';
  return 'I’ll take care of it';
}

function handoffReasonSentence(decision = {}) {
  const reason = String(decision.reason || '').toLowerCase();
  if (/explicit/.test(reason)) return 'I’ll handle that.';
  if (/repo|app|local|multi-step|substantive/.test(reason)) return 'I’ll take care of it.';
  return 'I’ll handle it.';
}

function workerAck(message, kind = 'start', decision = workerRoutingDecision(message), worker = undefined) {
  const text = normalizedMessageText(message);
  const workerText = normalizedMessageText(worker?.text || worker?.resultText || '');
  if (/briefing|daily brief|morning brief/.test(text)) return 'I’ll make the daily briefing more useful and actionable, with current work, active projects, monitors, and clear next steps.';
  if (/\b(?:format|formatted|formatting|layout|readable|scan|scannable)\b/.test(text) && /briefing|daily brief|morning brief/.test(workerText)) return 'I’ll rework the briefing into a cleaner, scannable format with sections, bullets, and clear actions.';
  if (/\b(?:ack|message|messages|natural|robotic|awkward|stiff|quoted|quote|conversational|plain\s+english)\b/.test(text) && /\b(?:worker|background|handoff|context|pass|sent|repo\/app work|llm response)\b/.test(text)) return 'Got it — I’ll make those handoff replies sound natural, plain English, and conversational instead of narrating worker routing.';
  if (kind === 'followup') return `${handoffActionSummary(message)}.`;
  if (messageLooksLikeRoutingFeedback(message)) return `${handoffActionSummary(message)}. I’ll handle this as routing/worker behavior, not as a generic task.`;
  return `${handoffActionSummary(message)}. ${handoffReasonSentence(decision)}`;
}

function isStaleWorkerTaskError(error) {
  const text = error instanceof Error ? error.message : String(error || '');
  return /Task not found|no session file|ECONNREFUSED|ENOENT|Timed out waiting for Mi main/i.test(text);
}

async function startBackgroundWorker(threadId, message, options = {}) {
  if (options.appendUser !== false) {
    await appendThreadMessage(threadId, 'user', message, { unread: false, source: 'web' });
    await logEvent('mi.web.worker.user', { threadId, message });
  }
  const decision = options.decision || workerRoutingDecision(message);
  const name = taskNameFromPrompt(message);
  const workerPrompt = await buildBackgroundWorkerPrompt(threadId, message, decision);
  const startedAt = now();
  const result = await sendTaskSocketRequest({ type: 'run_worker', name, cwd: home, message: workerPrompt, lastInput: message, background: true, reportToMain: true, model: workerModel }, 30000);
  const worker = {
    id: result.taskId || result.sessionId || result.sessionFile || `worker_${Date.now().toString(36)}`,
    threadId,
    taskId: result.taskId,
    sessionFile: result.sessionFile,
    sessionId: result.sessionId,
    sessionName: result.sessionName || name,
    name,
    status: 'running',
    text: message,
    createdAt: startedAt,
    updatedAt: startedAt,
    awaitingResultSince: startedAt,
  };
  activeWorkers.set(worker.id, worker);
  await saveActiveWorkers();
  const reply = workerAck(message, 'start', decision);
  await appendThreadMessage(threadId, 'assistant', reply, { unread: false, source: 'web-worker-ack' });
  return { ok: true, reply, worker };
}

function workerPlanForMessage(message, problem = '') {
  const text = normalizedMessageText(`${message}\n${problem}`);
  if (/\b(?:format|formatted|formatting|layout|readable|scan|scannable)\b/.test(text) && /briefing|daily brief|morning brief/.test(text)) {
    return [
      '- Reformat the briefing as a concise, scannable daily brief rather than a dense paragraph.',
      '- Use clear section headers such as Today’s focus, Action items, Projects in motion, Monitoring health, and Notes/snack pick when relevant.',
      '- Put each item on its own bullet with status, why it matters, and the next action/owner when known.',
      '- Keep unverified data labeled or omit it; do not pad with generic filler.',
      '- Add or update tests/snapshots if formatting is generated by code.',
    ].join('\n');
  }
  if (/briefing|daily brief|morning brief/.test(text)) {
    return [
      '- Replace generic counts with an actionable daily brief.',
      '- Pull from current/recent Mi task state, active projects, approvals, crons/monitors, and stored project/service orientation where appropriate.',
      '- Group the output into focus today, projects in motion, action items, recent work, and monitoring health.',
      '- Verify with tests and, if practical, generate an example brief from current state.',
    ].join('\n');
  }
  if (/\b(?:ack|message|messages|natural|robotic|awkward|stiff|quoted|quote)\b/.test(text) && /\b(?:worker|background|handoff|context|pass|sent)\b/.test(text)) {
    return [
      '- Change Mi web-chat worker acknowledgements to be natural, concise, and specific about what Mi will do.',
      '- Do not quote/truncate the user request or mention internal context-forwarding mechanics.',
      '- Keep the internal worker prompt self-contained and plan-oriented so the background worker receives the real task, context, and acceptance criteria.',
      '- Add or update routing tests for the new acknowledgement behavior.',
    ].join('\n');
  }
  return [
    '- Use the user request and recent context to identify the concrete task.',
    '- Make the smallest safe code/config change that fixes it.',
    '- Verify with targeted tests or commands.',
    '- Summarize changed files, evidence, and any remaining user action.',
  ].join('\n');
}

async function buildWorkerFollowupPrompt(threadId, message) {
  const history = await recentThreadContextForWorker(threadId, message);
  const problem = workerProblemStatement(message, history);
  return [
    'Follow-up from Mi web chat for the active background worker.',
    `Problem to fix / task to complete:\n${problem}`,
    `Plan for the background worker:\n${workerPlanForMessage(message, problem)}`,
    `Current user request:\n${redact(message)}`,
    history ? `Relevant chat context, newest last:\n${history}` : 'Relevant chat context: none available.',
    'Use this context to resolve references to the message/result the user is replying to. Do not assume access to Mi web chat outside this follow-up.',
  ].join('\n\n');
}

async function continueBackgroundWorker(threadId, worker, message) {
  const workerPrompt = await buildWorkerFollowupPrompt(threadId, message);
  await appendThreadMessage(threadId, 'user', message, { unread: false, source: 'web' });
  await logEvent('mi.web.worker.followup', { threadId, taskId: worker.taskId || worker.id, message });
  const taskId = worker.taskId || worker.sessionFile || worker.sessionName || worker.name || worker.id;
  const continuedAt = now();
  let result;
  try {
    result = await sendTaskSocketRequest({ type: 'continue_worker', taskId, message: workerPrompt, lastInput: message, background: true, reportToMain: true, model: workerModel }, 30000);
  } catch (error) {
    if (!isStaleWorkerTaskError(error)) throw error;
    activeWorkers.delete(worker.id);
    await saveActiveWorkers().catch(() => undefined);
    await logEvent('mi.web.worker.stale', { threadId, taskId, error: error instanceof Error ? error.message : String(error) }).catch(() => undefined);
    return startBackgroundWorker(threadId, message, { appendUser: false });
  }
  worker.taskId = result.taskId || worker.taskId;
  worker.sessionFile = result.sessionFile || worker.sessionFile;
  worker.sessionId = result.sessionId || worker.sessionId;
  worker.sessionName = result.sessionName || worker.sessionName;
  worker.status = 'running';
  worker.continuedAt = continuedAt;
  worker.awaitingResultSince = continuedAt;
  worker.completedAt = undefined;
  worker.resultText = undefined;
  worker.updatedAt = now();
  activeWorkers.set(worker.id, worker);
  await saveActiveWorkers();
  const reply = workerAck(message, 'followup', workerRoutingDecision(message), worker);
  await appendThreadMessage(threadId, 'assistant', reply, { unread: false, source: 'web-worker-ack' });
  return { ok: true, reply, worker };
}

async function runWebTurn(threadId, message) {
  const decision = await contextAwareWorkerRoutingDecision(threadId, message);
  const similarWorker = similarWorkerForThread(threadId, message);
  if (similarWorker && decision.start) return continueBackgroundWorker(threadId, similarWorker, message);

  if (decision.start && (messageLooksLikeRoutingFeedback(message) || /routing\/worker behavior feedback/.test(decision.reason || ''))) {
    return startBackgroundWorker(threadId, message, { decision: { ...decision, reason: 'routing/worker behavior feedback' } });
  }

  const activeWorker = activeWorkerForThread(threadId);
  if (activeWorker && messageLooksLikeWorkerFollowup(message, activeWorker)) return continueBackgroundWorker(threadId, activeWorker, message);
  const recentWorker = recentWorkerForThread(threadId);
  if (recentWorker && messageLooksLikeWorkerFollowup(message, recentWorker)) return continueBackgroundWorker(threadId, recentWorker, message);
  if (decision.start) return startBackgroundWorker(threadId, message, { decision });
  return runMiAsk(threadId, message);
}

async function runMiAsk(threadId, message) {
  const thread = await getThread(threadId);
  if (!thread) throw new Error(`thread not found: ${threadId}`);
  await appendThreadMessage(threadId, 'user', message, { unread: false, source: 'web' });
  await logEvent('mi.web.user', { threadId, message });

  const context = await threadContext(threadId, contextRecentLimit);
  const prompt = `You are Mi, ${ownerPossessive()} private persistent assistant. Reply as Mi in the current conversation. Be concise. Do not claim to have inspected files, services, or live information unless you actually used a tool or context explicitly says so. Risky actions require approval.\n\nThread: ${thread.title}\n\n${context}\n\nCurrent user message:\n${message}`;
  const result = await runFlueChat(prompt);
  const reply = result.reply || 'Got it.';
  await appendThreadMessage(threadId, 'assistant', reply, { unread: false, source: result.source });
  await logEvent('mi.web.assistant', { threadId, source: result.source, ok: result.ok });
  return { ok: result.ok, reply: redact(reply), error: result.error };
}

function createJob(threadId, message) {
  const ts = now();
  const job = {
    id: `job_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    threadId,
    text: message,
    status: 'queued',
    createdAt: ts,
    updatedAt: ts,
  };
  activeJobs.set(job.id, job);
  return job;
}

function publicJob(job) {
  return {
    id: job.id,
    threadId: job.threadId,
    text: redact(job.text || ''),
    status: job.status,
    ts: job.createdAt,
    startedAt: job.startedAt,
    updatedAt: job.updatedAt,
    error: job.error,
  };
}

function activeJobsFor(threadId) {
  const chatJobs = Array.from(activeJobs.values())
    .filter((job) => job.threadId === threadId && ['queued', 'running'].includes(String(job.status || '').toLowerCase()))
    .map(publicJob);
  const workerJobs = Array.from(activeWorkers.values())
    .filter((worker) => worker.threadId === threadId && workerIsActive(worker))
    .map((worker) => ({
      id: worker.id,
      threadId: worker.threadId,
      text: redact(worker.text || worker.name || 'Background worker'),
      status: worker.status || 'running',
      ts: worker.createdAt,
      updatedAt: worker.updatedAt,
      worker: true,
    }));
  return [...chatJobs, ...workerJobs];
}

function queueSendJob(threadId, message) {
  const job = createJob(threadId, message);
  const run = async () => {
    job.status = 'running';
    job.startedAt = now();
    job.updatedAt = job.startedAt;
    const result = await runWebTurn(threadId, message);
    if (result.reply) notifyUser(result.reply, threadId).catch(() => {});
    job.status = result.ok ? 'complete' : 'error';
    job.error = result.ok ? undefined : result.error;
    job.updatedAt = now();
    if (result.ok) activeJobs.delete(job.id);
    else setTimeout(() => activeJobs.delete(job.id), 30000);
    return result;
  };
  const next = sendQueue.then(run, run).catch((error) => {
    job.status = 'error';
    job.error = redact(error instanceof Error ? error.message : String(error));
    job.updatedAt = now();
    setTimeout(() => activeJobs.delete(job.id), 30000);
    return { ok: false, reply: '', error: job.error };
  });
  sendQueue = next.catch(() => {});
  return job;
}

function taskMatchesWorker(task, worker) {
  return task && (
    (worker.taskId && task.id === worker.taskId) ||
    (worker.sessionFile && (task.sessionFile === worker.sessionFile || task.actualSessionFile === worker.sessionFile)) ||
    (worker.sessionId && task.sessionId === worker.sessionId) ||
    (worker.sessionName && (task.sessionName === worker.sessionName || task.name === worker.sessionName))
  );
}

function taskDone(task) {
  const status = String(task?.status || '').toLowerCase();
  return Boolean(task?.finishedAt || ['complete', 'completed', 'done', 'error', 'stopped'].includes(status));
}

async function workerResultSince(worker) {
  const since = Date.parse(worker.awaitingResultSince || worker.continuedAt || worker.createdAt || worker.startedAt || '') || 0;
  const messages = await readMessages(worker.threadId, 50);
  return messages
    .filter((message) => message.role === 'assistant' && message.source === 'mi-worker-result' && ((Date.parse(message.ts || '') || 0) >= since))
    .at(-1);
}

async function monitorBackgroundWorkers() {
  if (activeWorkers.size === 0) return;
  let tasks = [];
  try {
    const result = await sendTaskSocketRequest({ type: 'list_tasks' }, 10000);
    tasks = result.tasks || [];
  } catch {
    return;
  }
  let changed = false;
  for (const worker of Array.from(activeWorkers.values())) {
    if (!workerIsActive(worker)) continue;
    const existingResult = await workerResultSince(worker).catch(() => undefined);
    if (existingResult) {
      notifyUser(existingResult.text, worker.threadId).catch(() => {});
      worker.status = 'complete';
      worker.completedAt = existingResult.ts || now();
      worker.updatedAt = now();
      worker.resultText = existingResult.text;
      worker.awaitingResultSince = undefined;
      activeWorkers.set(worker.id, worker);
      changed = true;
      continue;
    }
    const task = tasks.find((entry) => taskMatchesWorker(entry, worker));
    if (!task) continue;
    worker.status = task.status || worker.status;
    worker.updatedAt = now();
    worker.taskId = task.id || worker.taskId;
    worker.sessionFile = task.sessionFile || worker.sessionFile;
    worker.sessionId = task.sessionId || worker.sessionId;
    worker.sessionName = task.sessionName || worker.sessionName;
    changed = true;
    if (taskDone(task)) {
      const text = task.text || task.error || 'Background worker finished.';
      if (task.error && worker.threadId) {
        await appendThreadMessage(worker.threadId, 'assistant', `Background worker hit an error: ${redact(task.error)}`, { unread: false, source: 'mi-worker-error' }).catch(() => undefined);
      }
      if (text && worker.threadId) notifyUser(text, worker.threadId).catch(() => {});
      worker.status = task.error ? 'error' : 'complete';
      worker.completedAt = task.finishedAt || now();
      worker.updatedAt = now();
      worker.resultText = text;
      worker.awaitingResultSince = undefined;
      activeWorkers.set(worker.id, worker);
    } else {
      activeWorkers.set(worker.id, worker);
    }
  }
  if (changed) await saveActiveWorkers().catch(() => undefined);
}

const html = String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="theme-color" content="#ffffff">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-title" content="Mi">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <title>Mi</title>
  <link rel="icon" href="/favicon.jpg" type="image/jpeg">
  <link rel="apple-touch-icon" href="/favicon.jpg">
  <link rel="manifest" href="/manifest.json">
  <style>
    :root { color-scheme: light; --bg:#ffffff; --panel:#ffffff; --line:#d7d7dd; --text:#111111; --muted:#73737d; --blue:#0a84ff; --in:#e9e9ee; --field:#ffffff; --danger:#ff453a; }
    * { box-sizing: border-box; }
    html, body { height: 100%; margin:0; font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif; background:var(--bg); color:var(--text); }
    body { overflow:hidden; }
    .app { height:100dvh; display:grid; grid-template-rows: env(safe-area-inset-top) 1fr auto; background:var(--bg); }
    .messages { grid-row:2; overflow:auto; padding:16px 10px 18px; scroll-behavior:auto; }
    .day { text-align:center; color:var(--muted); font-size:12px; margin:16px 0; }
    .row { display:flex; margin:3px 0; padding:0 2px; }
    .row.user { justify-content:flex-end; }
    .row.assistant { justify-content:flex-start; }
    .msg.appearing { will-change:transform, opacity; }
    .msg.appearing.user { animation:sendIn .18s cubic-bezier(.22,.61,.36,1) both; }
    .msg.appearing.assistant { animation:receiveIn .20s cubic-bezier(.22,.61,.36,1) both; }
    .bubble { max-width:min(78vw, 720px); white-space:pre-wrap; overflow-wrap:anywhere; line-height:1.28; font-size:17px; padding:9px 13px; border-radius:20px; box-shadow:0 1px 0 rgba(0,0,0,.06); transition:opacity .16s ease; }
    .user .bubble { color:white; background:var(--blue); border-bottom-right-radius:5px; }
    .assistant .bubble { color:var(--text); background:var(--in); border-bottom-left-radius:5px; }
    .assistant .bubble strong { font-weight:700; }
    .assistant .bubble em { font-style:italic; }
    .assistant .bubble code { font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size:.92em; background:rgba(0,0,0,.06); border-radius:5px; padding:1px 4px; }
    .assistant .bubble a { color:var(--blue); text-decoration:underline; }
    .meta { font-size:11px; color:var(--muted); margin:4px 10px 8px; }
    .user + .meta, .msg.user .meta { text-align:right; }
    .typing { display:none; align-items:center; gap:4px; padding:9px 13px; width:max-content; border-radius:20px; background:var(--in); margin-top:4px; animation:typingIn .18s cubic-bezier(.22,.61,.36,1) both; }
    .typing span { width:7px; height:7px; border-radius:50%; background:var(--muted); animation:b 1.2s infinite ease-in-out; }
    .typing span:nth-child(2){animation-delay:.15s}.typing span:nth-child(3){animation-delay:.3s}
    @keyframes b { 0%,80%,100%{opacity:.35; transform:translateY(0)} 40%{opacity:1; transform:translateY(-3px)} }
    @keyframes sendIn { from { opacity:0; transform:translate3d(0, 7px, 0); } to { opacity:1; transform:translate3d(0, 0, 0); } }
    @keyframes receiveIn { from { opacity:0; transform:translate3d(0, 7px, 0); } to { opacity:1; transform:translate3d(0, 0, 0); } }
    @keyframes typingIn { from { opacity:0; transform:translate3d(0, 5px, 0); } to { opacity:1; transform:translate3d(0, 0, 0); } }
    .composer-wrap { grid-row:3; padding:8px 10px calc(8px + env(safe-area-inset-bottom)); background:var(--panel); }
    .composer { display:flex; align-items:flex-end; gap:8px; }
    .hidden-file { display:none; }
    .attachment { display:none; align-items:center; justify-content:space-between; gap:10px; margin:0 0 8px 46px; padding:8px 10px; color:var(--text); background:var(--field); border:1px solid var(--line); border-radius:14px; font-size:13px; }
    .attachment.visible { display:flex; }
    .attachment span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .attachment button { width:26px; height:26px; background:var(--in); color:var(--muted); font-size:18px; font-weight:400; }
    textarea { flex:1; resize:none; max-height:130px; min-height:38px; padding:9px 13px; color:var(--text); background:var(--field); border:1px solid var(--line); border-radius:19px; outline:none; font:17px/1.25 -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif; }
    textarea:focus { border-color:color-mix(in srgb, var(--blue) 70%, var(--line)); }
    button { appearance:none; border:0; background:var(--blue); color:white; border-radius:50%; width:38px; height:38px; display:grid; place-items:center; font-size:20px; font-weight:700; }
    #photo { background:var(--in); color:var(--blue); font-size:0; font-weight:400; line-height:1; }
    #photo::before { content:'+'; display:block; font-size:28px; line-height:1; transform:translateY(-1px); }
    button:disabled { opacity:.42; }
    .error { display:none; color:white; background:var(--danger); margin:0 0 8px; padding:8px 10px; border-radius:12px; font-size:13px; }
    .empty { color:var(--muted); text-align:center; margin-top:30vh; line-height:1.4; }
    @media (prefers-reduced-motion: reduce) { .msg.appearing, .msg.appearing .bubble, .typing, .typing span { animation:none; } .bubble { transition:none; } }
    @media (min-width: 900px) { .bubble { max-width: 680px; } .messages { padding-left: max(12px, calc((100vw - 900px)/2)); padding-right: max(12px, calc((100vw - 900px)/2)); } .composer-wrap { padding-left:max(10px, calc((100vw - 900px)/2)); padding-right:max(10px, calc((100vw - 900px)/2)); } }
  </style>
</head>
<body>
  <div class="app">
    <main id="messages" class="messages"><div class="empty">Say something to Mi.</div></main>
    <footer class="composer-wrap">
      <div id="error" class="error"></div>
      <div id="attachment" class="attachment"><span id="attachment-name"></span><button id="remove-attachment" type="button" aria-label="Remove photo">×</button></div>
      <div id="composer" class="composer">
        <input id="photo-input" class="hidden-file" type="file" accept="image/*">
        <button id="photo" type="button" aria-label="Add photo">+</button>
        <textarea id="input" rows="1" maxlength="4000" autocomplete="off" autocapitalize="sentences" placeholder="Message"></textarea>
        <button id="send" type="button" aria-label="Send">↑</button>
      </div>
    </footer>
  </div>
  <script>
    const thread = 'main';
    const messagesEl = document.getElementById('messages');
    const input = document.getElementById('input');
    const send = document.getElementById('send');
    const photo = document.getElementById('photo');
    const photoInput = document.getElementById('photo-input');
    const statusEl = document.getElementById('status');
    const errorEl = document.getElementById('error');
    const attachmentEl = document.getElementById('attachment');
    const attachmentNameEl = document.getElementById('attachment-name');
    const removeAttachment = document.getElementById('remove-attachment');
    let busy = false;
    let attachment = null;
    let pendingMessages = [];
    let serverJobs = [];
    let serverPendingMessages = [];
    let lastSignature = '';
    let lastRenderedBusy = false;
    let hasRenderedMessages = false;

    function escapeHtml(s){ return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
    function renderAssistantMarkdown(text){
      const placeholders = [];
      let html = escapeHtml(text || '');
      const tick = String.fromCharCode(96);
      html = html.replace(new RegExp(tick + '([^' + tick + '\\n]+)' + tick, 'g'), (_, code) => {
        placeholders.push('<code>' + code + '</code>');
        return '\u0000' + (placeholders.length - 1) + '\u0000';
      });
      html = html.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
      html = html.replace(/\*\*([^*\n][\s\S]*?[^*\n])\*\*/g, '<strong>$1</strong>');
      html = html.replace(/(^|[^*])\*([^*\n][^*\n]*[^*\n])\*(?!\*)/g, '$1<em>$2</em>');
      html = html.replace(/\u0000(\d+)\u0000/g, (_, i) => placeholders[Number(i)] || '');
      return html;
    }
    function setBubbleText(bubble, m){
      if (m.role === 'user') bubble.textContent = m.text || '';
      else bubble.innerHTML = renderAssistantMarkdown(m.text || '');
    }
    function timeLabel(ts){ try { return new Date(ts).toLocaleTimeString([], { hour:'numeric', minute:'2-digit' }); } catch { return ''; } }
    function autogrow(){ input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 130) + 'px'; }
    function setError(text){ errorEl.textContent = text || ''; errorEl.style.display = text ? 'block' : 'none'; }
    function signature(messages){ return messages.map(m => m.id + ':' + m.ts + ':' + m.text).join('|'); }
    function hasMatchingUserMessage(messages, job){
      const jobTime = Date.parse(job.ts || '') || 0;
      return (messages || []).some(m => m.role === 'user' && m.text === job.text && ((Date.parse(m.ts || '') || 0) >= jobTime - 5000));
    }
    function syncServerJobs(messages, jobs){
      serverJobs = jobs || [];
      serverPendingMessages = serverJobs
        .filter(job => !hasMatchingUserMessage(messages, job))
        .map(job => ({ id: job.id, role: 'user', text: job.text, ts: job.ts }));
      busy = pendingMessages.length > 0 || serverJobs.length > 0;
    }

    function messageKey(m){ return m.id || (m.role + ':' + m.ts + ':' + m.text); }
    function messageSig(m){ return m.role + ':' + m.ts + ':' + m.text; }
    function isNearBottom(){ return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 96; }
    function ensureTypingEl(){
      let el = document.getElementById('typing');
      if (!el) {
        el = document.createElement('div');
        el.id = 'typing';
        el.className = 'typing';
        el.innerHTML = '<span></span><span></span><span></span>';
      }
      return el;
    }
    function createMessageEl(m, animate){
      const role = m.role === 'user' ? 'user' : 'assistant';
      const wrap = document.createElement('div');
      wrap.className = 'msg ' + role + (animate ? ' appearing' : '');
      wrap.dataset.key = messageKey(m);
      wrap.dataset.sig = messageSig(m);
      const row = document.createElement('div');
      row.className = 'row ' + role;
      const bubble = document.createElement('div');
      bubble.className = 'bubble';
      setBubbleText(bubble, m);
      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = timeLabel(m.ts);
      row.appendChild(bubble);
      wrap.appendChild(row);
      wrap.appendChild(meta);
      if (animate) window.setTimeout(() => wrap.classList.remove('appearing'), 220);
      return wrap;
    }
    function updateMessageEl(el, m){
      const sig = messageSig(m);
      if (el.dataset.sig === sig) return;
      el.dataset.sig = sig;
      const bubble = el.querySelector('.bubble');
      const meta = el.querySelector('.meta');
      if (bubble) setBubbleText(bubble, m);
      if (meta) meta.textContent = timeLabel(m.ts);
    }

    function render(messages){
      messages = [...(messages || []), ...serverPendingMessages, ...pendingMessages];
      const sig = signature(messages || []);
      if (sig === lastSignature && busy === lastRenderedBusy) return;
      const shouldStick = isNearBottom();
      lastSignature = sig;
      lastRenderedBusy = busy;
      const animateNew = hasRenderedMessages;
      if (!messages || messages.length === 0) {
        if (!messagesEl.querySelector('.empty')) messagesEl.innerHTML = '<div class="empty">Say something to Mi.</div>';
        hasRenderedMessages = true;
        return;
      }
      const empty = messagesEl.querySelector('.empty');
      if (empty) empty.remove();
      const typingEl = ensureTypingEl();
      if (typingEl.parentElement !== messagesEl) messagesEl.appendChild(typingEl);
      const existing = new Map(Array.from(messagesEl.querySelectorAll('.msg')).map(el => [el.dataset.key, el]));
      for (const m of messages) {
        const key = messageKey(m);
        let el = existing.get(key);
        if (el) {
          updateMessageEl(el, m);
          existing.delete(key);
        } else {
          el = createMessageEl(m, animateNew);
        }
        messagesEl.insertBefore(el, typingEl);
      }
      for (const el of existing.values()) el.remove();
      typingEl.style.display = busy ? 'flex' : 'none';
      messagesEl.appendChild(typingEl);
      hasRenderedMessages = true;
      if (shouldStick) messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    async function api(path, options){
      const res = await fetch(path, { cache:'no-store', ...options });
      const text = await res.text();
      let data = {};
      try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text }; }
      if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
      return data;
    }

    async function refresh(){
      try {
        const data = await api('/api/messages?thread=' + encodeURIComponent(thread));
        syncServerJobs(data.messages || [], data.jobs || []);
        render(data.messages || []);
        if (statusEl) statusEl.textContent = busy ? 'Mi is thinking…' : 'private tailnet chat';
      } catch (e) {
        setError(e.message);
      }
    }

    input.addEventListener('input', autogrow);
    input.addEventListener('keydown', () => {
      setTimeout(autogrow, 0);
    });
    send.addEventListener('click', () => { sendCurrentMessage(); });
    photo.addEventListener('click', () => { if (!busy) photoInput.click(); });
    photoInput.addEventListener('change', () => { attachPhoto(); });
    removeAttachment.addEventListener('click', () => { attachment = null; renderAttachment(); input.focus(); });

    function renderAttachment(){
      if (attachment) {
        attachmentNameEl.textContent = 'Photo attached: ' + (attachment.name || 'image');
        attachmentEl.classList.add('visible');
      } else {
        attachmentNameEl.textContent = '';
        attachmentEl.classList.remove('visible');
      }
    }

    function readFileAsDataUrl(file){
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(reader.error || new Error('Could not read photo'));
        reader.readAsDataURL(file);
      });
    }

    async function attachPhoto() {
      const file = photoInput.files && photoInput.files[0];
      photoInput.value = '';
      if (!file || busy) return;
      if (!file.type.startsWith('image/')) return setError('Choose an image file.');
      setError('');
      input.disabled = true;
      send.disabled = true;
      photo.disabled = true;
      try {
        const dataUrl = await readFileAsDataUrl(file);
        const data = await api('/api/photo', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ thread, name: file.name, type: file.type, dataUrl, attachOnly: true }),
        });
        attachment = { path: data.filePath, name: file.name || 'image' };
        renderAttachment();
      } catch (e) {
        setError(e.message);
      } finally {
        input.disabled = false;
        send.disabled = false;
        photo.disabled = false;
        input.focus();
      }
    }

    async function sendCurrentMessage() {
      const message = input.value.trim();
      if (!message && !attachment) return;
      setError('');
      input.value = '';
      const sentAttachment = attachment;
      attachment = null;
      renderAttachment();
      autogrow();
      const pendingId = 'pending_' + Date.now() + '_' + Math.random().toString(36).slice(2);
      const pendingText = [sentAttachment ? 'Photo: ' + (sentAttachment.name || 'image') : '', message].filter(Boolean).join('\n');
      pendingMessages.push({ id: pendingId, role: 'user', text: pendingText, ts: new Date().toISOString() });
      busy = true;
      if (statusEl) statusEl.textContent = 'Mi is thinking…';
      await refresh();
      input.focus();
      try {
        const data = await api('/api/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ thread, message, photoPath: sentAttachment && sentAttachment.path, photoName: sentAttachment && sentAttachment.name }),
        });
        if (!data.ok && data.error) setError(data.error);
        pendingMessages = pendingMessages.filter(m => m.id !== pendingId);
        syncServerJobs(data.messages || [], data.jobs || []);
        render(data.messages || []);
      } catch (e) {
        pendingMessages = pendingMessages.filter(m => m.id !== pendingId);
        attachment = sentAttachment;
        renderAttachment();
        setError(e.message);
      } finally {
        busy = pendingMessages.length > 0 || serverJobs.length > 0;
        if (statusEl) statusEl.textContent = busy ? 'Mi is thinking…' : 'private tailnet chat';
        await refresh();
        input.focus();
      }
    }

    refresh();
    setInterval(refresh, 2000);
  </script>
</body>
</html>`;

const manifest = JSON.stringify({
  name: 'Mi',
  short_name: 'Mi',
  start_url: '/',
  display: 'standalone',
  background_color: '#ffffff',
  theme_color: '#ffffff',
  icons: [
    { src: '/favicon.jpg', sizes: '512x512', type: 'image/jpeg', purpose: 'any maskable' },
  ],
}, null, 2);

async function handle(req, res) {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  try {
    if (req.method === 'GET' && url.pathname === '/') return sendText(res, 200, html, 'text/html; charset=utf-8');
    if (req.method === 'GET' && (url.pathname === '/favicon.jpg' || url.pathname === '/apple-touch-icon.png')) return sendFile(res, faviconPath, 'image/jpeg');
    if (req.method === 'GET' && url.pathname === '/sw.js') return sendText(res, 200, serviceWorkerJs, 'text/javascript; charset=utf-8');
    if (req.method === 'GET' && url.pathname === '/manifest.json') return sendText(res, 200, manifest, 'application/manifest+json; charset=utf-8');
    if (req.method === 'GET' && url.pathname === '/api/health') return sendJson(res, 200, { ok: true, ts: now(), thread: defaultThread, push: Boolean((await readPushSubscriptions()).length) });
    if (req.method === 'GET' && url.pathname === '/api/push/public-key') {
      const config = await vapidConfig();
      return sendJson(res, 200, { publicKey: config.publicKey });
    }
    if (req.method === 'POST' && url.pathname === '/api/push/subscribe') {
      const body = await readJsonBody(req);
      await addPushSubscription(body.subscription);
      return sendJson(res, 200, { ok: true, subscriptions: (await readPushSubscriptions()).length });
    }
    if (req.method === 'GET' && url.pathname === '/api/threads') return sendJson(res, 200, { threads: await listThreads() });
    if (req.method === 'GET' && url.pathname === '/api/messages') {
      const threadId = safeThreadId(url.searchParams.get('thread') || defaultThread);
      return sendJson(res, 200, { messages: await readMessages(threadId), jobs: activeJobsFor(threadId) });
    }
    if (req.method === 'POST' && url.pathname === '/api/send') {
      const body = await readJsonBody(req);
      const threadId = safeThreadId(body.thread || defaultThread);
      const message = String(body.message || '').trim();
      const photoPath = String(body.photoPath || '').trim();
      const photoName = String(body.photoName || '').trim();
      if (!message && !photoPath) return sendJson(res, 400, { ok: false, error: 'message required' });
      if (Array.from(message).length > maxMessageChars) return sendJson(res, 400, { ok: false, error: `message too long; max ${maxMessageChars} chars` });
      const workerMessage = photoPath
        ? [`Photo uploaded from Mi web chat.${message ? `\n\nUser message:\n${message}` : ''}`, `Local file path: ${photoPath}`, 'Use the read tool to inspect this image if needed.'].join('\n\n')
        : message;
      const job = queueSendJob(threadId, workerMessage);
      return sendJson(res, 202, { ok: true, queued: true, job: publicJob(job), jobs: activeJobsFor(threadId), messages: await readMessages(threadId) });
    }
    if (req.method === 'POST' && url.pathname === '/api/photo') {
      const body = await readJsonBody(req, Math.ceil(maxUploadBytes * 1.4) + 4096);
      const threadId = safeThreadId(body.thread || defaultThread);
      const filePath = await saveUploadedPhoto(body);
      if (body.send === true) {
        const message = `Photo uploaded from Mi web chat.\n\nLocal file path: ${filePath}\n\nUse the read tool to inspect this image if needed.`;
        const job = queueSendJob(threadId, message);
        return sendJson(res, 202, { ok: true, queued: true, job: publicJob(job), jobs: activeJobsFor(threadId), messages: await readMessages(threadId) });
      }
      return sendJson(res, 200, { ok: true, filePath, attached: true, messages: await readMessages(threadId), jobs: activeJobsFor(threadId) });
    }
    return sendJson(res, 404, { ok: false, error: 'not found' });
  } catch (error) {
    return sendJson(res, 500, { ok: false, error: redact(error instanceof Error ? error.message : String(error)) });
  }
}

await ensureMainThread();
await loadActiveWorkers();
setInterval(() => monitorBackgroundWorkers().catch(() => undefined), 5000);
void monitorBackgroundWorkers().catch(() => undefined);
const server = http.createServer(handle);
server.listen(port, host, () => {
  console.log(`Mi web chat listening on http://${host}:${port}`);
});

if (httpsPort && tlsCertPath && tlsKeyPath) {
  const tls = {
    cert: await readFile(tlsCertPath, 'utf8'),
    key: await readFile(tlsKeyPath, 'utf8'),
  };
  const secureServer = https.createServer(tls, handle);
  secureServer.listen(httpsPort, host, () => {
    console.log(`Mi web chat listening on https://${host}:${httpsPort}`);
  });
}
