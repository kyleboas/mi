#!/usr/bin/env node
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmod, copyFile, lstat, mkdir, open, readdir, readFile, rename, rm } from 'node:fs/promises';
import { constants as fsConstants, realpathSync, statSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { classifyConfirmationReply, clearPendingConfirmation, createPendingConfirmation, readPendingConfirmation } from '../dist/src/pending-confirmations.js';
import { coordinatorDelegatedTasks, miCoordinatorLaunch, miCoordinatorPrompt, runMiCoordinatorRpc, safeCoordinatorFailureClass } from './mi-imessage-coordinator.mjs';
import { diverNotesPreflight } from './mi-diver-notes-intent.mjs';
import { authorizedForDivernote } from './mi-imessage-sender-access.mjs';
import { reviewedMiExtensionPaths } from '../pi/extensions/mi-reviewed-paths.mjs';
import { redactV2Text, sanitizeImessageCompletion } from './mi-imessage-v2.mjs';
import { directAdvisorSelections, v2ConfirmationCommand, v2RouteDecision } from './mi-web-chat-v2-route.mjs';
import { emitTurnEvent } from './mi-turn-observability.mjs';

const root = process.env.MI_ROOT || path.join(os.homedir(), 'assistant');
const maxReplyChars = boundedInteger(process.env.MI_IMESSAGE_MAX_REPLY_CHARS, 1200, 120, 6000);
const maxMessageChars = boundedInteger(process.env.MI_WEB_MAX_MESSAGE_CHARS, 4000, 1, 16000);
const maxCompletionChars = boundedInteger(process.env.MI_IMESSAGE_COMPLETION_MAX_CHARS, maxReplyChars, 120, 6000);
const coordinatorTimeoutMs = boundedInteger(process.env.MI_IMESSAGE_COORDINATOR_TIMEOUT_MS, 90_000, 1000, 10 * 60_000);
const taskPollMs = boundedInteger(process.env.MI_IMESSAGE_TASK_POLL_MS, 250, 25, 5000);
const maxConversations = boundedInteger(process.env.MI_IMESSAGE_CONCURRENCY, 4, 1, 16);
const deliveryLockStaleMs = boundedInteger(process.env.MI_IMESSAGE_DELIVERY_LOCK_STALE_MS, 60_000, 1000, 10 * 60_000);
const staleDeliveryReason = 'recovered-incomplete-delivery';
const confirmationObjectiveMaxChars = 240;
const coordinatorObjectiveMaxChars = boundedInteger(process.env.MI_COORDINATOR_OBJECTIVE_MAX_CHARS, 4000, 240, 16 * 1024);
const deliverySchemaVersion = 1;
const terminalTaskStatuses = new Set(['complete', 'completed', 'done', 'error', 'stopped', 'inactive']);

export const IMESSAGE_REPLIES = Object.freeze({
  retryIdentity: 'Please retry that message. I need its upstream ID and timestamp before I can process it.',
  startFailure: 'I could not start that request. Please try again.',
  sessionFailure: 'I could not reopen this conversation safely. Please try again.',
  timeout: 'That request took too long to finish. Please try again.',
  interruption: 'That request was interrupted before it finished. Please try again.',
  missingEvidence: 'I could not verify the completed result. Please try again.',
  sendFailure: 'I finished the request, but I could not send the reply. Please try again.',
  prohibited: 'I cannot handle secret, destructive, financial, or authentication actions from iMessage.',
  confirmationMissing: 'I cannot find a pending action for that confirmation.',
  confirmationCancelled: 'Okay, I will not proceed with that action.',
  workspace: 'I need an existing approved workspace before I can start that work.',
  objectiveTooLong: 'Please send a shorter request. I cannot safely store this exact action.',
  clarify: 'What exactly should I act on?',
});

function boundedInteger(value, fallback, minimum, maximum) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= minimum && number <= maximum ? number : fallback;
}

function isoNow() {
  return new Date().toISOString();
}

function safeId(value) {
  const id = String(value || '').trim();
  return /^[A-Za-z0-9._:-]{1,200}$/.test(id) ? id : '';
}

export function diverNotesReplyEnvironment(value) {
  const sessionId = String(value || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(sessionId)) return {};
  return { MI_DIVER_NOTES_ONLY_OPERATION: 'pi.message', MI_DIVER_NOTES_PI_SESSION_ID: sessionId };
}

function normalizeIdentity(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function digest(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function stableConversationIdentity(space, message) {
  const spaceId = normalizeIdentity(space?.id || message?.space?.id);
  if (spaceId) return { kind: 'photon-space', value: spaceId };
  const sender = normalizeIdentity(message?.sender?.id || space?.phone || message?.space?.phone);
  if (sender) return { kind: 'imessage-sender', value: sender };
  return undefined;
}

export function conversationIdFor(space, message) {
  const identity = stableConversationIdentity(space, message);
  return identity ? `imessage-${digest(JSON.stringify(identity)).slice(0, 32)}` : undefined;
}

export function upstreamMessageId(message) {
  return [message?.id, message?.messageId, message?.eventId, message?.guid]
    .map((value) => String(value || '').trim()).find(Boolean) || '';
}

export function stableMessageTimestamp(message) {
  const value = message?.timestamp || message?.createdAt || message?.date;
  if (value === undefined || value === null || String(value).trim() === '') return '';
  const parsed = typeof value === 'number' && Number.isFinite(value) ? value : Date.parse(String(value));
  return Number.isFinite(parsed) && parsed > 0 ? new Date(parsed).toISOString() : '';
}

export function deliveryIdFor(conversationId, message) {
  const upstreamId = upstreamMessageId(message);
  if (!conversationId || !upstreamId) return undefined;
  return digest(JSON.stringify({ version: 1, conversationId, upstreamId }));
}

function contentTextFor(content) {
  if (!content || typeof content !== 'object') return '';
  if (content.type === 'text') return String(content.text || '').trim();
  if (content.type === 'richlink') return String(content.url || '').trim();
  if (content.type === 'reaction') return String(content.emoji ? `reaction: ${content.emoji}` : 'reaction').trim();
  if (content.type === 'group') return (Array.isArray(content.items) ? content.items : []).map((item) => contentTextFor(item?.content || item)).filter(Boolean).join('\n').trim();
  if (content.type === 'attachment') return '[the user sent an attachment]';
  if (content.type === 'voice') return '[the user sent a voice message]';
  return '[the user sent something I cannot read here]';
}

export function messageTextFor(message) {
  return contentTextFor(message?.content).slice(0, maxMessageChars);
}

export function requestDigestFor(conversationId, message, text, timestamp) {
  return digest(JSON.stringify({
    version: 1,
    conversationId,
    upstreamId: upstreamMessageId(message),
    timestamp,
    direction: String(message?.direction || ''),
    text: String(text || ''),
  }));
}

export function formatImessagePlainText(value) {
  return String(value || '')
    .replace(/\r\n?/g, '\n')
    .replace(/^\s{0,3}#{1,6}\s+(.+)$/gm, '$1')
    .replace(/^\s*[-*+]\s+/gm, '• ')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/__([^_\n]+)__/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/\[([^\]\n]+)\]\([^\s)]+\)/g, '$1')
    .replace(/^\s*(?:---+|___+)\s*$/gm, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function cleanReply(value, fallback = IMESSAGE_REPLIES.missingEvidence, strict = false) {
  const text = redactV2Text(formatImessagePlainText(value)).replace(/[—–]/g, '-').replace(/\0/g, '').trim();
  if (!text) return fallback;
  const controlReply = /^Action class: [a-z][a-z0-9_-]*\.\s+Exact objective: [\s\S]+?\s+This could make a real change or contact another service\. Reply "(?:confirm|deny) [a-f0-9]{32}"/i.test(text)
    || /^I still need confirmation for the pending action\.\s+Reply confirm [a-f0-9]{32} or deny [a-f0-9]{32}\.$/i.test(text);
  const safe = strict ? sanitizeImessageCompletion(text, '') : text;
  if (strict && !safe && !controlReply) return fallback;
  const candidate = safe || text;
  return candidate
    .replace(/(?:~|\/)(?:home|Users|tmp)\/[A-Za-z0-9_.@/:-]+/g, '[private path]')
    .replace(/\b(?:task|thread|session|correlation)[ _-]?(?:id)?\s*[:=]\s*[A-Za-z0-9._:-]{6,}\b/gi, '[private id]')
    .replace(/\b(?:system|hidden|internal)\s+prompt\b/gi, '[private instructions]')
    .replace(/\b(?:photon|pi|worker|daemon|gateway|routing|handoff)\b/gi, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim().slice(0, maxCompletionChars) || fallback;
}

function conversationDirectory(conversationId, stateRoot) {
  return path.join(stateRoot, 'imessage', 'conversations', conversationId);
}

async function ensurePrivateDirectory(directory) {
  const existing = await lstat(directory).catch((error) => error?.code === 'ENOENT' ? undefined : null);
  if (existing === null || (existing && (!existing.isDirectory() || existing.isSymbolicLink()))) throw new Error('private directory is not a real directory');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const verified = await lstat(directory);
  if (!verified.isDirectory() || verified.isSymbolicLink()) throw new Error('private directory is not a real directory');
  await chmod(directory, 0o700);
}

export async function prepareCoordinatorPiConfig(stateRoot, sourceAuthPath = path.join(os.homedir(), '.pi', 'agent', 'auth.json')) {
  const source = await lstat(sourceAuthPath).catch((error) => error?.code === 'ENOENT' ? undefined : Promise.reject(error));
  if (!source) return undefined;
  if (!source.isFile() || source.isSymbolicLink() || (source.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && source.uid !== process.getuid())) {
    throw new Error('Pi auth source is not a private owned file');
  }
  const configDirectory = path.join(stateRoot, 'imessage', 'runtime', 'pi-config');
  await ensurePrivateDirectory(configDirectory);
  const destination = path.join(configDirectory, 'auth.json');
  const current = await lstat(destination).catch((error) => error?.code === 'ENOENT' ? undefined : Promise.reject(error));
  if (current) {
    if (!current.isFile() || current.isSymbolicLink() || (typeof process.getuid === 'function' && current.uid !== process.getuid())) throw new Error('Pi auth copy is not a private owned file');
    await chmod(destination, 0o600);
    return configDirectory;
  }
  const temporary = path.join(configDirectory, `.auth-${process.pid}-${randomBytes(8).toString('hex')}.tmp`);
  try {
    await copyFile(sourceAuthPath, temporary, fsConstants.COPYFILE_EXCL);
    await chmod(temporary, 0o600);
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
  return configDirectory;
}

async function atomicJsonWrite(file, value) {
  const directory = path.dirname(file);
  await ensurePrivateDirectory(directory);
  const temporary = `${file}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  const content = JSON.stringify(value, null, 2);
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(content, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(temporary, 0o600);
    await rename(temporary, file);
    await chmod(file, 0o600);
    const directoryHandle = await open(directory, 'r');
    try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function readJson(file) {
  try {
    const info = await lstat(file);
    if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size > 256 * 1024) return undefined;
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return undefined;
  }
}

function deliveryFile(directory, deliveryId) {
  return path.join(directory, 'deliveries', `${deliveryId}.json`);
}

function boundedDelivery(record) {
  const next = { ...record };
  if (next.status === 'received' || next.status === 'running') next.rawMessage = String(next.rawMessage || '').slice(0, maxMessageChars);
  else delete next.rawMessage;
  if (next.completionReply) next.completionReply = cleanReply(next.completionReply);
  next.taskIds = Array.isArray(next.taskIds) ? next.taskIds.filter((id) => safeId(id)).slice(0, 32) : [];
  return next;
}

async function writeDelivery(file, record) {
  await atomicJsonWrite(file, boundedDelivery(record));
}

function deliveryLockFile(file) {
  return `${file}.lock`;
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function deliveryLockIsStale(lockPath) {
  const info = await lstat(lockPath).catch((error) => error?.code === 'ENOENT' ? undefined : null);
  if (!info) return false;
  const owner = await readJson(path.join(lockPath, 'owner'));
  const pid = Number(owner?.pid);
  if (Number.isSafeInteger(pid) && pid > 0) return !processIsAlive(pid);
  const createdAt = Date.parse(String(owner?.createdAt || '')) || info.mtimeMs;
  return Date.now() - createdAt > deliveryLockStaleMs;
}

async function acquireDeliveryLock(file) {
  const lockPath = deliveryLockFile(file);
  await ensurePrivateDirectory(path.dirname(file));
  while (true) {
    const nonce = randomBytes(16).toString('hex');
    let created = false;
    try {
      await mkdir(lockPath, { mode: 0o700 });
      created = true;
      await chmod(lockPath, 0o700);
      const owner = await open(path.join(lockPath, 'owner'), 'wx', 0o600);
      try {
        await owner.writeFile(JSON.stringify({ pid: process.pid, createdAt: isoNow(), nonce }), 'utf8');
        await owner.sync();
      } finally {
        await owner.close();
      }
      await chmod(path.join(lockPath, 'owner'), 0o600);
      return async () => {
        const current = await readJson(path.join(lockPath, 'owner'));
        if (current?.nonce === nonce) await rm(lockPath, { recursive: true, force: true });
      };
    } catch (error) {
      if (created) await rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
      if (error?.code !== 'EEXIST') throw error;
      if (await deliveryLockIsStale(lockPath)) {
        await rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

async function withDeliveryLock(file, work) {
  const release = await acquireDeliveryLock(file);
  try {
    return await work();
  } finally {
    await release().catch(() => undefined);
  }
}

async function listDeliveryFiles(directory) {
  let entries = [];
  try { entries = await readdir(path.join(directory, 'deliveries'), { withFileTypes: true }); } catch { return []; }
  return entries.filter((entry) => entry.isFile() && /^[a-f0-9]{64}\.json$/.test(entry.name)).map((entry) => path.join(directory, 'deliveries', entry.name));
}

export function isSameConversationResend(value) {
  const text = String(value || '').trim().toLowerCase().replace(/[.!?]+$/g, '').replace(/\s+/g, ' ');
  return /^(?:please )?(?:send|resend)(?: it| that| this)? again(?: please)?$/.test(text);
}

async function lastSentReply(directory) {
  const deliveries = [];
  for (const file of await listDeliveryFiles(directory)) {
    const value = await readJson(file).catch(() => undefined);
    if (!value || value.status !== 'sent' || typeof value.completionReply !== 'string' || !value.completionReply.trim()) continue;
    const timestamp = Date.parse(value.sentAt || value.completedAt || value.receivedAt || '');
    deliveries.push({ reply: value.completionReply, timestamp: Number.isFinite(timestamp) ? timestamp : 0 });
  }
  deliveries.sort((left, right) => right.timestamp - left.timestamp);
  return deliveries[0]?.reply || '';
}

async function validateSessionFile(file) {
  try {
    const info = await lstat(file);
    if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size > 16 * 1024 * 1024) return false;
    const text = await readFile(file, 'utf8');
    for (const line of text.split('\n').filter(Boolean)) JSON.parse(line);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return true;
    return false;
  }
}

async function ensurePrivateFile(file) {
  await ensurePrivateDirectory(path.dirname(file));
  const existing = await lstat(file).catch((error) => error?.code === 'ENOENT' ? undefined : null);
  if (existing === null || (existing && !existing.isFile())) throw new Error('private file is not a regular file');
  const handle = await open(file, 'a', 0o600);
  try { await handle.sync(); } finally { await handle.close(); }
  await chmod(file, 0o600);
}

async function interruptIncompleteDelivery(file, reason = staleDeliveryReason) {
  return withDeliveryLock(file, async () => {
    const record = await readJson(file);
    if (!record || !['received', 'running'].includes(record.status)) return false;
    record.status = 'interrupted';
    record.interruptedAt = isoNow();
    record.interruptionReason = reason;
    delete record.runningAt;
    delete record.rawMessage;
    await writeDelivery(file, record);
    return true;
  });
}

async function recoverStaleRunning(stateRoot) {
  const base = path.join(stateRoot, 'imessage', 'conversations');
  let conversations = [];
  try { conversations = await readdir(base, { withFileTypes: true }); } catch { return; }
  for (const entry of conversations) {
    if (!entry.isDirectory() || !/^imessage-[a-f0-9]{32}$/.test(entry.name)) continue;
    const directory = path.join(base, entry.name);
    for (const file of await listDeliveryFiles(directory)) {
      await interruptIncompleteDelivery(file).catch(() => undefined);
    }
  }
}

async function tacticsJournalContext(message) {
  if (!/\btactics\s+journal\b/i.test(String(message || ''))) return '';
  const monitorFile = path.join(root, 'state', 'tactics-journal-monitor-state.json');
  const briefFile = path.join(root, 'state', 'tactics-journal-brief-state.json');
  try {
    const monitor = JSON.parse(await readFile(monitorFile, 'utf8'));
    let brief;
    try {
      const candidate = JSON.parse(await readFile(briefFile, 'utf8'));
      if (candidate?.version === 1 && candidate?.context && Date.now() - Date.parse(candidate.checkedAt) <= 30 * 60 * 1000) brief = { checkedAt: candidate.checkedAt, context: candidate.context };
    } catch {}
    return JSON.stringify({ monitor: { checkedAt: monitor.checkedAt, availability: monitor.availability, checks: monitor.checks }, brief });
  } catch { return ''; }
}

function workspaceFromEnvironment() {
  const workspaceRootSetting = String(process.env.MI_IMESSAGE_WORKSPACE_ROOT || path.join(os.homedir(), 'workflows')).trim();
  const workspaceCwdSetting = String(process.env.MI_IMESSAGE_WORKSPACE_CWD || workspaceRootSetting).trim();
  try {
    const rootPath = realpathSync(workspaceRootSetting);
    const cwdPath = realpathSync(workspaceCwdSetting);
    const relative = path.relative(rootPath, cwdPath);
    if (rootPath === os.homedir() || rootPath !== path.resolve(workspaceRootSetting) || cwdPath !== path.resolve(workspaceCwdSetting)) return undefined;
    if (!statSync(rootPath).isDirectory() || !statSync(cwdPath).isDirectory()) return undefined;
    if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) return undefined;
    return { root: rootPath, cwd: cwdPath };
  } catch { return undefined; }
}

function reducedEnvironment(extra = {}) {
  const allowed = ['PATH', 'HOME', 'USER', 'LOGNAME', 'HOSTNAME', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TERM', 'TMPDIR', 'TMP', 'TEMP', 'PI_PROVIDER', 'PI_MODEL', 'PI_CONFIG_DIR', 'PI_GATEWAY_URL', 'AGENT_GATEWAY_URL'];
  const env = {};
  for (const key of allowed) if (process.env[key] !== undefined) env[key] = process.env[key];
  return { ...env, ...extra };
}

function coordinatorTaskIds(taskIds) {
  return [...new Set(taskIds.filter((id) => safeId(id)))];
}

function taskIsTerminal(task) {
  return Boolean(task?.finishedAt || terminalTaskStatuses.has(String(task?.status || '').toLowerCase()));
}

function daemonRequest(socketPath, payload, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = '';
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('daemon timeout')); }, timeoutMs);
    socket.on('connect', () => socket.write(`${JSON.stringify(payload)}\n`));
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      if (!buffer.includes('\n')) return;
      clearTimeout(timer);
      socket.destroy();
      try {
        const response = JSON.parse(buffer.slice(0, buffer.indexOf('\n')));
        if (response.ok !== true) reject(new Error('daemon rejected request'));
        else resolve(response);
      } catch { reject(new Error('daemon sent invalid response')); }
    });
    socket.on('error', () => { clearTimeout(timer); reject(new Error('daemon unavailable')); });
  });
}

async function ensureDaemon(socketPath, reviewedDaemonPath = '') {
  try { await daemonRequest(socketPath, { type: 'health' }, 800); return true; } catch {}
  const daemonPath = reviewedDaemonPath || process.env.MI_DAEMON_PATH || path.join(root, 'pi', 'extensions', 'mi-daemon.mjs');
  try {
    const child = spawn(process.execPath, [daemonPath], { cwd: root, env: reducedEnvironment({ MI_ROOT: root, MI_SOCKET_PATH: socketPath, MI_RUNTIME_DIR: process.env.MI_RUNTIME_DIR }), detached: true, stdio: 'ignore' });
    child.unref();
  } catch { return false; }
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try { await daemonRequest(socketPath, { type: 'health' }, 500); return true; } catch { await new Promise((resolve) => setTimeout(resolve, 100)); }
  }
  return false;
}

async function writeCapabilityGrant(directory, workspace, diverNotesAccess) {
  const grantsDirectory = path.join(directory, 'runtime');
  await ensurePrivateDirectory(grantsDirectory);
  const createdAt = isoNow();
  const grants = [{
    id: `imessage-${Date.now().toString(36)}`,
    resource: `file://${workspace.cwd}`,
    rights: ['read'],
    constraints: { recursive: true, profile: 'mi-main-orchestrator' },
    principal: { id: 'mi-imessage', type: 'imessage', displayName: 'Mi iMessage runtime' },
    createdAt,
    expiresAt: new Date(Date.now() + 6 * 60 * 60_000).toISOString(),
  }];
  if (diverNotesAccess === 'read' || diverNotesAccess === 'write') grants.push({
    id: `imessage-diver-notes-${Date.now().toString(36)}`,
    resource: 'diver-notes://vault',
    rights: diverNotesAccess === 'write' ? ['read', 'write'] : ['read'],
    constraints: { exact: true, profile: 'diver-notes' },
    principal: { id: 'mi-imessage', type: 'imessage', displayName: 'Mi iMessage runtime' },
    createdAt,
    expiresAt: new Date(Date.now() + 6 * 60 * 60_000).toISOString(),
  });
  const file = path.join(grantsDirectory, `capabilities-${Date.now().toString(36)}.json`);
  await atomicJsonWrite(file, { profile: 'mi-main-orchestrator', grants });
  return file;
}

async function writeCoordinatorPolicy(file, { correlationId, objective, workspace, allowWrite, advisorSelections, socketPath }) {
  await atomicJsonWrite(file, {
    version: 1, correlationId, objective, workspaceRoot: workspace.root, workspaceCwd: workspace.cwd,
    socketPath, allowWrite: allowWrite === true, advisorSelections, advisorTaskIds: [],
  });
}

async function readPolicyTaskIds(file) {
  const value = await readJson(file);
  return Array.isArray(value?.advisorTaskIds) ? coordinatorTaskIds(value.advisorTaskIds) : [];
}

async function waitForDaemonTasks(ids, request, timeoutMs, onTimeout) {
  const deadline = Date.now() + timeoutMs;
  let latest = [];
  while (Date.now() < deadline) {
    let listed;
    try { listed = await request({ type: 'list_tasks' }); } catch {
      return { ok: false, reason: 'missing-evidence' };
    }
    latest = ids.map((id) => (listed.tasks || []).find((task) => task?.id === id));
    if (latest.some((task) => !task)) return { ok: false, reason: 'missing-evidence' };
    if (latest.every(taskIsTerminal)) return { ok: true, tasks: latest };
    await new Promise((resolve) => setTimeout(resolve, Math.min(taskPollMs, Math.max(1, deadline - Date.now()))));
  }
  await onTimeout(ids);
  return { ok: false, reason: 'timeout' };
}

export class ImessageRuntime {
  constructor({ stateRoot = path.join(root, 'state'), sendReply, daemonRequest: request = daemonRequest, spawnRpc = runMiCoordinatorRpc } = {}) {
    this.stateRoot = stateRoot;
    this.sendReply = sendReply;
    this.daemonRequest = request;
    this.spawnRpc = spawnRpc;
    this.queues = new Map();
    this.deliveryLocks = new Map();
    this.children = new Set();
    this.active = 0;
    this.waiting = [];
  }

  async initialize() {
    await ensurePrivateDirectory(path.join(this.stateRoot, 'imessage'));
    await ensurePrivateDirectory(path.join(this.stateRoot, 'imessage', 'conversations'));
    await recoverStaleRunning(this.stateRoot);
  }

  async acquireConversationSlot() {
    if (this.active < maxConversations) { this.active += 1; return; }
    await new Promise((resolve) => this.waiting.push(resolve));
    this.active += 1;
  }

  releaseConversationSlot() {
    this.active = Math.max(0, this.active - 1);
    const next = this.waiting.shift();
    if (next) next();
  }

  async shutdown() {
    for (const child of this.children) {
      try { if (child.exitCode === null) child.kill('SIGTERM'); } catch {}
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    for (const child of this.children) {
      try { if (child.exitCode === null) child.kill('SIGKILL'); } catch {}
    }
  }

  enqueue(conversationId, work) {
    const previous = this.queues.get(conversationId) || Promise.resolve();
    const current = previous.then(() => work(), () => work());
    const tracked = current.catch(() => undefined);
    this.queues.set(conversationId, tracked);
    return current.finally(() => {
      if (this.queues.get(conversationId) === tracked) this.queues.delete(conversationId);
    });
  }

  async sendAndMark(record, file, reply, sendReply = this.sendReply) {
    const text = cleanReply(reply);
    if (!sendReply) return false;
    let accepted = false;
    try { accepted = await sendReply(text); } catch { accepted = false; }
    if (!accepted) return false;
    record.status = 'sent';
    record.sentAt = isoNow();
    record.completionReply = text;
    delete record.rawMessage;
    try {
      await writeDelivery(file, record);
    } catch {
      // Photon already accepted the reply. Keep the in-memory success and let
      // the retained completed record replay once if this durable write failed.
      console.error('Mi iMessage delivery state write failed after Photon success.');
    }
    return true;
  }

  async replayUnsent(directory, sendReply = this.sendReply, exclude = '') {
    const records = [];
    for (const file of await listDeliveryFiles(directory)) {
      const record = await readJson(file);
      if (!record || record.conversationId !== path.basename(directory) || record.status !== 'completed' || file.endsWith(`${exclude}.json`)) continue;
      records.push({ file, record });
    }
    records.sort((a, b) => String(a.record.receivedAt).localeCompare(String(b.record.receivedAt)));
    for (const entry of records) {
      if (!await this.sendAndMark(entry.record, entry.file, entry.record.completionReply, sendReply)) return false;
    }
    return true;
  }

  async handleEvent({ space, message, senderAuthorized = false, sendReply = this.sendReply }) {
    const preliminaryConversationId = conversationIdFor(space, message);
    if (!preliminaryConversationId) return this.handleEventInternal({ space, message, senderAuthorized, sendReply });
    const preliminaryDeliveryId = deliveryIdFor(preliminaryConversationId, message);
    const lockFile = preliminaryDeliveryId
      ? deliveryFile(conversationDirectory(preliminaryConversationId, this.stateRoot), preliminaryDeliveryId)
      : '';
    const active = lockFile ? this.deliveryLocks.get(lockFile) : undefined;
    if (active) return active;
    const work = this.enqueue(preliminaryConversationId, () => this.handleEventInternal({ space, message, senderAuthorized, sendReply }));
    if (!lockFile) return work;
    this.deliveryLocks.set(lockFile, work);
    try { return await work; } finally { if (this.deliveryLocks.get(lockFile) === work) this.deliveryLocks.delete(lockFile); }
  }

  async handleEventInternal({ space, message, senderAuthorized = false, sendReply = this.sendReply }) {
    const text = messageTextFor(message);
    if (!text) return { ok: true, ignored: true };
    const conversationId = conversationIdFor(space, message);
    const upstreamId = upstreamMessageId(message);
    const timestamp = stableMessageTimestamp(message);
    if (!conversationId || !upstreamId || !timestamp) {
      if (sendReply) {
        try { await sendReply(IMESSAGE_REPLIES.retryIdentity); } catch {}
      }
      return { ok: false, reason: 'missing-identity' };
    }
    const deliveryId = deliveryIdFor(conversationId, message);
    const requestDigest = requestDigestFor(conversationId, message, text, timestamp);
    const directory = conversationDirectory(conversationId, this.stateRoot);
    const file = deliveryFile(directory, deliveryId);
    try {
      await ensurePrivateDirectory(directory);
      await ensurePrivateDirectory(path.join(directory, 'deliveries'));
    } catch {
      try { if (sendReply) await sendReply(IMESSAGE_REPLIES.startFailure); } catch {}
      return { ok: false, reason: 'state-unavailable', deliveryId, conversationId };
    }
    return withDeliveryLock(file, async () => {
      const deliveryInfo = await lstat(file).catch((error) => error?.code === 'ENOENT' ? undefined : null);
      if (deliveryInfo === null || (deliveryInfo && !deliveryInfo.isFile())) {
      try { if (sendReply) await sendReply(IMESSAGE_REPLIES.startFailure); } catch {}
      return { ok: false, reason: 'invalid-delivery-state', deliveryId, conversationId };
    }
      let record = await readJson(file);
      let createdHere = false;
      if (deliveryInfo && !record) {
      try { if (sendReply) await sendReply(IMESSAGE_REPLIES.startFailure); } catch {}
      return { ok: false, reason: 'invalid-delivery-state', deliveryId, conversationId };
    }
    if (record) {
      if (record.requestDigest !== requestDigest) {
        try { if (sendReply) await sendReply(IMESSAGE_REPLIES.startFailure); } catch {}
        return { ok: false, reason: 'payload-conflict', deliveryId, conversationId };
      }
      if (record.status === 'sent') return { ok: true, duplicate: true, status: record.status, deliveryId, conversationId };
      if (record.status === 'running') {
        record.status = 'interrupted';
        record.interruptedAt = isoNow();
        record.interruptionReason = staleDeliveryReason;
        delete record.runningAt;
        delete record.rawMessage;
        await writeDelivery(file, record);
        const sent = Boolean(sendReply && await sendReply(IMESSAGE_REPLIES.interruption).catch(() => false));
        if (sent) {
          record.interruptionNotifiedAt = isoNow();
          await writeDelivery(file, record).catch(() => undefined);
        }
        return { ok: sent, status: 'interrupted', deliveryId, conversationId };
      }
      if (record.status === 'interrupted') {
        delete record.rawMessage;
        await writeDelivery(file, record).catch(() => undefined);
        if (!record.interruptionNotifiedAt) {
          let sent = false;
          try { sent = Boolean(sendReply && await sendReply(IMESSAGE_REPLIES.interruption)); } catch {}
          if (sent) {
            record.interruptionNotifiedAt = isoNow();
            await writeDelivery(file, record).catch(() => undefined);
          }
          return { ok: sent, status: 'interrupted', deliveryId, conversationId };
        }
        return { ok: false, duplicate: true, status: 'interrupted', deliveryId, conversationId };
      }
      if (record.status === 'completed') {
        const sent = await this.sendAndMark(record, file, record.completionReply, sendReply);
        return { ok: sent, replay: true, status: sent ? 'sent' : 'completed', deliveryId, conversationId };
      }
      if (record.status !== 'received') {
        try { if (sendReply) await sendReply(IMESSAGE_REPLIES.startFailure); } catch {}
        return { ok: false, reason: 'invalid-delivery-state', deliveryId, conversationId };
      }
      } else {
        record = {
          schemaVersion: deliverySchemaVersion,
          deliveryId,
          conversationId,
          requestDigest,
          status: 'received',
          receivedAt: isoNow(),
          rawMessage: text,
          taskIds: [],
        };
        createdHere = true;
        try { await writeDelivery(file, record); } catch {
          try { if (sendReply) await sendReply(IMESSAGE_REPLIES.startFailure); } catch {}
          return { ok: false, reason: 'state-unavailable', deliveryId, conversationId };
        }
      }
      if (!createdHere && record.status === 'received') {
        record.status = 'interrupted';
        record.interruptedAt = isoNow();
        record.interruptionReason = staleDeliveryReason;
        delete record.rawMessage;
        await writeDelivery(file, record);
        const sent = Boolean(sendReply && await sendReply(IMESSAGE_REPLIES.interruption).catch(() => false));
        if (sent) {
          record.interruptionNotifiedAt = isoNow();
          await writeDelivery(file, record).catch(() => undefined);
        }
        return { ok: sent, status: 'interrupted', deliveryId, conversationId };
      }
      if (createdHere) {
        try {
          await this.resolveEarlierIncomplete(directory, record);
        } catch {
          try { if (sendReply) await sendReply(IMESSAGE_REPLIES.startFailure); } catch {}
          return { ok: false, reason: 'state-unavailable', deliveryId, conversationId };
        }
      }
      await this.acquireConversationSlot();
    try {
      if (!await this.replayUnsent(directory, sendReply, deliveryId)) return { ok: false, reason: 'send-failure', deliveryId, conversationId };
      const current = await readJson(file);
      if (!current || current.status !== 'received') return { ok: true, duplicate: true, status: current?.status || 'unknown', deliveryId, conversationId };
      current.status = 'running';
      current.runningAt = isoNow();
      await writeDelivery(file, current);
      const result = await this.runTurn(current, directory, { space, message, senderAuthorized });
      current.taskIds = coordinatorTaskIds(result.taskIds || []);
      if (result.status === 'sent') return { ...result, deliveryId, conversationId };
      current.status = 'completed';
      current.completedAt = isoNow();
      current.completionReply = cleanReply(result.reply, IMESSAGE_REPLIES.missingEvidence);
      delete current.rawMessage;
      await writeDelivery(file, current);
      const sent = await this.sendAndMark(current, file, current.completionReply, sendReply);
      return { ok: sent, status: sent ? 'sent' : 'completed', deliveryId, conversationId, reply: current.completionReply, taskIds: current.taskIds };
    } catch (error) {
      console.error('Mi iMessage runtime turn failed.');
      const current = await readJson(file) || record;
      current.status = 'completed';
      current.completedAt = isoNow();
      current.completionReply = IMESSAGE_REPLIES.startFailure;
      delete current.rawMessage;
      await writeDelivery(file, current).catch(() => undefined);
      const sent = await this.sendAndMark(current, file, current.completionReply, sendReply).catch(() => false);
      return { ok: sent, status: sent ? 'sent' : 'completed', deliveryId, conversationId, reply: current.completionReply, error: 'runtime-failure' };
    } finally {
      this.releaseConversationSlot();
    }
    });
  }

  async resolveEarlierIncomplete(directory, current) {
    const earlier = [];
    for (const file of await listDeliveryFiles(directory)) {
      if (file.endsWith(`${current.deliveryId}.json`)) continue;
      const record = await readJson(file);
      if (!record || record.conversationId !== current.conversationId || !['received', 'running'].includes(record.status)) continue;
      const receivedAt = Date.parse(String(record.receivedAt || ''));
      const currentReceivedAt = Date.parse(String(current.receivedAt || ''));
      if (!Number.isFinite(receivedAt) || !Number.isFinite(currentReceivedAt)) continue;
      if (receivedAt < currentReceivedAt || (receivedAt === currentReceivedAt && record.deliveryId < current.deliveryId)) earlier.push({ file, receivedAt, deliveryId: record.deliveryId });
    }
    earlier.sort((a, b) => a.receivedAt - b.receivedAt || a.deliveryId.localeCompare(b.deliveryId));
    for (const entry of earlier) await interruptIncompleteDelivery(entry.file);
  }

  async runTurn(record, directory, sender = {}) {
    const message = record.rawMessage || '';
    const workspace = workspaceFromEnvironment();
    const confirmationOptions = { statePath: path.join(this.stateRoot, 'pending-confirmations.json') };
    if (v2ConfirmationCommand(message)) {
      const confirmation = await classifyConfirmationReply({ threadId: record.conversationId, reply: message }, confirmationOptions).catch(() => ({ kind: 'state_error' }));
      if (confirmation.kind === 'deny') return { reply: IMESSAGE_REPLIES.confirmationCancelled, taskIds: [] };
      if (confirmation.kind === 'confirm') {
        const confirmed = confirmation.record;
        if (!workspace) return { reply: IMESSAGE_REPLIES.workspace, taskIds: [] };
        return this.runCoordinator({ ...record, rawMessage: confirmed.objective || confirmed.summary }, directory, {
          objective: confirmed.objective || confirmed.summary,
          confirmedObjective: confirmed.objective || confirmed.summary,
          actionClass: confirmed.actionClass || 'confirmed-high-impact',
          allowWrite: false,
          advisorSelections: directAdvisorSelections(confirmed.objective || confirmed.summary),
          workspace,
        });
      }
      return { reply: confirmation.kind === 'state_error' ? IMESSAGE_REPLIES.startFailure : IMESSAGE_REPLIES.confirmationMissing, taskIds: [] };
    }
    if (isSameConversationResend(message)) {
      const pending = await readPendingConfirmation(record.conversationId, confirmationOptions).catch(() => null);
      if (pending && isSameConversationResend(pending.objective || pending.summary)) await clearPendingConfirmation(record.conversationId, confirmationOptions).catch(() => undefined);
      const reply = await lastSentReply(directory);
      return { reply: reply || 'I do not have an earlier reply in this conversation to resend.', taskIds: [] };
    }
    const route = v2RouteDecision({ message, workspace, coordinatorObjectiveMaxChars, confirmationObjectiveMaxChars });
    if (route.kind === 'cancel') {
      await clearPendingConfirmation(record.conversationId, confirmationOptions).catch(() => undefined);
      return { reply: IMESSAGE_REPLIES.confirmationCancelled, taskIds: [] };
    }
    const pending = await readPendingConfirmation(record.conversationId, confirmationOptions).catch(() => null);
    if (pending) return { reply: `I still need confirmation for the pending action. Reply confirm ${pending.id} or deny ${pending.id}.`, taskIds: [] };
    if (route.kind === 'confirmation-command') return { reply: IMESSAGE_REPLIES.confirmationMissing, taskIds: [] };
    if (route.kind === 'never-delegate') return { reply: IMESSAGE_REPLIES.prohibited, taskIds: [] };
    if (route.kind === 'confirm-too-long' || route.kind === 'objective-too-long') return { reply: IMESSAGE_REPLIES.objectiveTooLong, taskIds: [] };
    if (route.kind === 'clarify') return { reply: IMESSAGE_REPLIES.clarify, taskIds: [] };
    if (route.kind === 'workspace-refused') return { reply: IMESSAGE_REPLIES.workspace, taskIds: [] };
    if (route.kind === 'confirm') {
      const pendingAction = await createPendingConfirmation({
        threadId: record.conversationId,
        summary: route.objective,
        riskReason: 'High-impact iMessage action',
        objective: route.objective,
        actionClass: route.actionClass,
      }, confirmationOptions);
      return { reply: `Action class: ${route.actionClass}.\n\nExact objective: ${route.objective}\n\nThis could make a real change or contact another service. Reply "confirm ${pendingAction.id}" to approve or "deny ${pendingAction.id}" to cancel.`, taskIds: [] };
    }
    const plan = { ...(route.plan || {}), workspace, cwd: workspace.cwd, workspaceRoot: workspace.root };
    // A normal coordinator turn is available after transport authorization, but
    // the private vault needs both that verified bridge signal and a named
    // sender in PHOTON_ALLOWED_USERS. PHOTON_ALLOW_ALL_USERS never grants it.
    const diverNotes = authorizedForDivernote({ ...sender })
      ? diverNotesPreflight({ message, plan })
      : { access: 'none' };
    if (diverNotes.reply) return { reply: diverNotes.reply, taskIds: [] };
    const suppliedContext = await tacticsJournalContext(message);
    return this.runCoordinator(record, directory, { ...plan, diverNotesAccess: diverNotes.access, diverNotesPiSessionId: diverNotes.piSessionId, suppliedContext });
  }

  async runCoordinator(record, directory, plan) {
    const correlationId = randomUUID();
    const workspace = plan.workspace;
    if (!workspace) return { reply: IMESSAGE_REPLIES.workspace, taskIds: [] };
    const sessionPath = path.join(directory, 'session.jsonl');
    if (!await validateSessionFile(sessionPath)) return { reply: IMESSAGE_REPLIES.sessionFailure, taskIds: [] };
    try { await ensurePrivateFile(sessionPath); } catch { return { reply: IMESSAGE_REPLIES.sessionFailure, taskIds: [] }; }
    const reviewed = reviewedMiExtensionPaths({
      root,
      daemonPath: process.env.MI_DAEMON_PATH,
      capabilityGuardPath: process.env.MI_CAPABILITY_GUARD,
      capabilityAdapterPath: process.env.MI_CAPABILITY_ADAPTER,
      diverNotesPath: process.env.MI_DIVER_NOTES_EXTENSION,
      requireDaemon: true,
      requireGuard: true,
      requireAdapter: true,
      requireDiverNotes: true,
    });
    const grants = await writeCapabilityGrant(directory, workspace, plan.diverNotesAccess || 'none');
    const policy = path.join(directory, 'runtime', 'coordinator-policy.json');
    const socketPath = process.env.MI_SOCKET_PATH || path.join(process.env.MI_RUNTIME_DIR || path.join(os.homedir(), '.pi', 'agent', 'mi'), 'main.sock');
    await writeCoordinatorPolicy(policy, {
      correlationId, objective: plan.objective, workspace, allowWrite: plan.allowWrite,
      advisorSelections: [...new Set(plan.advisorSelections || [])].filter((name) => name === 'Seth' || name === 'Alex'), socketPath,
    });
    let piConfigDirectory;
    try {
      piConfigDirectory = process.env.PI_CODING_AGENT_DIR || await prepareCoordinatorPiConfig(this.stateRoot);
    } catch {
      console.error('Diver could not prepare its private Pi authentication directory.');
      return { reply: IMESSAGE_REPLIES.startFailure, taskIds: [] };
    }
    const launch = miCoordinatorLaunch({
      piCommand: process.env.PI_CMD || 'pi', cwd: workspace.cwd, sessionPath,
      model: process.env.DIVER_WORKER_MODEL || process.env.MI_WORKER_MODEL || 'openai-codex/gpt-5.6-luna:high',
      capabilityGuardPath: reviewed.capabilityGuardPath,
      capabilityAdapterPath: reviewed.capabilityAdapterPath,
      diverNotesPath: reviewed.diverNotesPath,
      env: reducedEnvironment({
        PATH: `/home/kyle/.local/bin:${process.env.PATH || '/usr/bin:/bin'}`,
        HOME: '/home/kyle', USER: 'kyle', LOGNAME: 'kyle',
        MI_ROOT: root, MI_CAPABILITY_PROFILE: 'mi-main-orchestrator', MI_CAPABILITY_GRANTS_FILE: grants,
        MI_CAPABILITY_AUDIT_FILE: path.join(directory, 'runtime', 'capability-audit.jsonl'),
        MI_COORDINATOR_POLICY_FILE: policy, MI_SOCKET_PATH: socketPath,
        ...diverNotesReplyEnvironment(plan.diverNotesPiSessionId),
        ...(piConfigDirectory ? { PI_CODING_AGENT_DIR: piConfigDirectory } : {}),
      }),
    });
    const taskIds = new Set();
    const startedAt = Date.now();
    const result = await this.spawnRpc({
      launch, requestId: correlationId,
      prompt: miCoordinatorPrompt({ message: record.rawMessage, tacticsContext: plan.suppliedContext, confirmedObjective: plan.confirmedObjective, actionClass: plan.actionClass, advisorSelections: plan.advisorSelections, diverNotesAccess: plan.diverNotesAccess }),
      timeoutMs: coordinatorTimeoutMs,
      onSpawn: (child) => {
        this.children.add(child);
        child.once?.('close', () => this.children.delete(child));
        child.once?.('exit', () => this.children.delete(child));
      },
      onEvent: (event) => { for (const id of coordinatorDelegatedTasks(event)) taskIds.add(id); },
    });
    await chmod(sessionPath, 0o600).catch(() => undefined);
    for (const id of await readPolicyTaskIds(policy)) taskIds.add(id);
    const ids = coordinatorTaskIds([...taskIds]);
    if (ids.length) {
      record.taskIds = ids;
      await writeDelivery(deliveryFile(directory, record.deliveryId), record).catch(() => undefined);
      const remaining = Math.max(1000, coordinatorTimeoutMs - (Date.now() - startedAt));
      let daemonReady = false;
      try { await this.daemonRequest(socketPath, { type: 'health' }, 800); daemonReady = true; } catch { daemonReady = await ensureDaemon(socketPath, reviewed.daemonPath); }
      if (!daemonReady) return { reply: IMESSAGE_REPLIES.missingEvidence, taskIds: ids };
      const waited = await waitForDaemonTasks(ids, (request) => this.daemonRequest(socketPath, request), remaining, async (known) => {
        await Promise.allSettled(known.map((taskId) => this.daemonRequest(socketPath, { type: 'stop_task', taskId }, 5000)));
      });
      if (!waited.ok) return { reply: waited.reason === 'timeout' ? IMESSAGE_REPLIES.timeout : IMESSAGE_REPLIES.missingEvidence, taskIds: ids };
      const failedTask = waited.tasks.some((task) => Boolean(task.error) || ['error', 'stopped', 'inactive'].includes(String(task.status || '').toLowerCase()));
      const findings = waited.tasks.map((task) => task.text || '').filter(Boolean).join('\n\n');
      const reply = failedTask ? IMESSAGE_REPLIES.interruption : cleanReply(result.ok ? (findings || result.text) : '', result.ok ? IMESSAGE_REPLIES.missingEvidence : result.reason === 'timeout' ? IMESSAGE_REPLIES.timeout : IMESSAGE_REPLIES.interruption, true);
      return { reply, taskIds: ids };
    }
    if (!result.ok) {
      console.error(`Diver iMessage coordinator failed: ${safeCoordinatorFailureClass(result.failureClass)}${result.diagnostic ? ` (${result.diagnostic})` : ''}`);
      const reply = result.reason === 'timeout' ? IMESSAGE_REPLIES.timeout
        : ['exited-SIGTERM', 'exited-SIGINT', 'exited-SIGKILL'].includes(result.reason) ? IMESSAGE_REPLIES.interruption
          : result.reason === 'spawn-error' ? IMESSAGE_REPLIES.startFailure : IMESSAGE_REPLIES.startFailure;
      return { reply, taskIds: [] };
    }
    const reply = cleanReply(result.text, IMESSAGE_REPLIES.missingEvidence);
    await emitTurnEvent(root, { stage: 'terminal', outcome: 'ok', route: 'imessage', modelProfile: 'none', turn: correlationId }).catch(() => undefined);
    return { reply, taskIds: [] };
  }
}

export async function createImessageRuntime(options = {}) {
  const runtime = new ImessageRuntime(options);
  await runtime.initialize();
  return runtime;
}

export function actionableIdentityStatus(space, message) {
  const text = messageTextFor(message);
  return { actionable: Boolean(text), conversationId: conversationIdFor(space, message), upstreamId: upstreamMessageId(message), timestamp: stableMessageTimestamp(message) };
}

export { cleanReply, recoverStaleRunning, validateSessionFile };
