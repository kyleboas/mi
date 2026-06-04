#!/usr/bin/env node
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { appendFile, mkdir, open, readFile, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const home = os.homedir();
const defaultConfigPath = path.join(home, '.config', 'mi-signal-bridge', 'config.json');
const configPath = process.env.MI_SIGNAL_CONFIG || defaultConfigPath;
const defaultStateDir = path.join(home, 'assistant', 'state', 'signal-bridge');

function expandHome(value) {
  if (!value || typeof value !== 'string') return value;
  return value === '~' ? home : value.startsWith('~/') ? path.join(home, value.slice(2)) : value;
}

function redact(text) {
  return String(text || '')
    .replace(/\+\d[\d\s().-]{6,}\d/g, '[number]')
    .replace(/\b[A-Za-z0-9_]*(TOKEN|SECRET|PASSWORD|API_KEY)[A-Za-z0-9_]*\s*=\s*[^\s]+/gi, '[secret]')
    .replace(/sk-[A-Za-z0-9_-]{20,}/g, '[secret]');
}

function sha(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function now() {
  return new Date().toISOString();
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function loadConfig() {
  const config = await readJson(configPath, undefined);
  if (!config) {
    throw new Error(`Missing config: ${configPath}\nCreate it from ~/.config/mi-signal-bridge/config.example.json.`);
  }

  const merged = {
    signalCli: path.join(home, '.local', 'bin', 'signal-cli'),
    miCli: path.join(home, '.local', 'bin', 'mi'),
    miRoot: path.join(home, 'assistant'),
    thread: 'main',
    pollIntervalMs: 5000,
    receiveTimeoutSeconds: 5,
    commandTimeoutMs: 120000,
    maxMessageChars: 4000,
    maxReplyChars: 3500,
    stateDir: defaultStateDir,
    allowGroups: false,
    noteToSelf: false,
    ...config,
  };

  merged.signalCli = expandHome(merged.signalCli);
  merged.miCli = expandHome(merged.miCli);
  merged.miRoot = expandHome(merged.miRoot);
  merged.stateDir = expandHome(merged.stateDir);
  if (merged.signalConfigDir) merged.signalConfigDir = expandHome(merged.signalConfigDir);

  if (!merged.account || typeof merged.account !== 'string') throw new Error('config.account is required, e.g. +15551234567');
  if (!Array.isArray(merged.allowedSenders) || merged.allowedSenders.length === 0) {
    throw new Error('config.allowedSenders must contain your personal Signal number/ACI/username. Refusing to run without an allowlist.');
  }
  merged.allowedSenders = merged.allowedSenders.map((value) => normalizeId(value)).filter(Boolean);
  return merged;
}

function normalizeId(value) {
  return String(value || '').trim().toLowerCase().replace(/[\s().-]+/g, '');
}

function signalGlobalArgs(config) {
  const args = [];
  if (config.signalConfigDir) args.push('--config', config.signalConfigDir);
  args.push('-a', config.account);
  return args;
}

async function runCommand(command, args, options = {}) {
  const timeoutMs = options.timeoutMs || 30000;
  return await new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd || process.cwd(),
      env: options.env || process.env,
      shell: false,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let killTimer;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      resolve(result);
    };

    const killTree = (signal) => {
      try {
        if (child.pid) process.kill(-child.pid, signal);
      } catch {}
    };

    const timer = setTimeout(() => {
      killTree('SIGTERM');
      killTimer = setTimeout(() => killTree('SIGKILL'), 2000);
      finish({ code: 124, stdout, stderr: `${stderr}\nTimed out after ${timeoutMs}ms`.trim() });
    }, timeoutMs);

    child.stdout.on('data', (chunk) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk) => (stderr += chunk.toString()));
    child.on('error', (error) => finish({ code: 127, stdout, stderr: error.message }));
    child.on('close', (code) => finish({ code: code ?? 0, stdout, stderr }));

    if (options.stdin) {
      child.stdin.end(options.stdin);
    } else {
      child.stdin.end();
    }
  });
}

function getEnvelope(event) {
  return event?.envelope || event?.params?.envelope || event?.params?.result?.envelope || event;
}

function eventAccount(event) {
  return event?.account || event?.params?.account || event?.params?.result?.account || getEnvelope(event)?.account;
}

function sourceIds(envelope, event) {
  return [
    envelope?.sourceNumber,
    envelope?.sourceUuid,
    envelope?.source,
    envelope?.sourceName,
    envelope?.sender,
    eventAccount(event),
  ].map(normalizeId).filter(Boolean);
}

function replyRecipient(config, envelope) {
  return config.noteToSelf ? config.account : envelope?.sourceNumber || envelope?.sourceUuid || envelope?.source;
}

function isAllowed(config, envelope, event) {
  const ids = sourceIds(envelope, event);
  return ids.some((id) => config.allowedSenders.includes(id));
}

function dataMessage(envelope) {
  return envelope?.dataMessage || envelope?.message?.dataMessage;
}

function sentMessage(envelope) {
  return envelope?.syncMessage?.sentMessage || envelope?.message?.syncMessage?.sentMessage;
}

function isSyncSentMessage(event) {
  return Boolean(sentMessage(getEnvelope(event)));
}

function eventText(event) {
  const envelope = getEnvelope(event);
  const data = dataMessage(envelope);
  const sent = sentMessage(envelope);
  if (typeof data?.message === 'string') return data.message;
  if (typeof sent?.message === 'string') return sent.message;
  return '';
}

function isGroupMessage(event) {
  const envelope = getEnvelope(event);
  const message = dataMessage(envelope) || sentMessage(envelope);
  return Boolean(message?.groupInfo || message?.groupV2 || message?.groupId);
}

function eventTimestamp(event) {
  const envelope = getEnvelope(event);
  const message = dataMessage(envelope) || sentMessage(envelope);
  return message?.timestamp || envelope?.timestamp || Date.now();
}

function eventKey(event) {
  const envelope = getEnvelope(event);
  return sha(`${eventTimestamp(event)}:${sourceIds(envelope, event).join(',')}:${eventText(event)}`).slice(0, 32);
}

function messageHash(text) {
  return sha(text).slice(0, 64);
}

function pruneOwnReplyHashes(state) {
  const cutoff = Date.now() - 10 * 60 * 1000;
  state.ownReplyHashes = Array.isArray(state.ownReplyHashes)
    ? state.ownReplyHashes.filter((entry) => Number(entry?.ts || 0) > cutoff).slice(-200)
    : [];
}

function rememberOwnReplyChunks(config, state, chunks) {
  if (!config.noteToSelf) return;
  pruneOwnReplyHashes(state);
  const ts = Date.now();
  state.ownReplyHashes.push(...chunks.map((chunk) => ({ hash: messageHash(chunk.trim()), ts })));
  state.ownReplyHashes = state.ownReplyHashes.slice(-200);
}

function isOwnReplyEcho(config, event, state) {
  if (!config.noteToSelf || !isSyncSentMessage(event)) return false;
  pruneOwnReplyHashes(state);
  const text = eventText(event).trim();
  if (!text) return false;
  const hash = messageHash(text);
  return state.ownReplyHashes.some((entry) => entry.hash === hash);
}

function chunkText(text, maxChars) {
  const chars = Array.from(text || '');
  const chunks = [];
  for (let i = 0; i < chars.length; i += maxChars) chunks.push(chars.slice(i, i + maxChars).join(''));
  return chunks.length ? chunks : [''];
}

async function appendEvent(config, type, payload = {}) {
  await mkdir(config.stateDir, { recursive: true });
  const event = { ts: now(), type, ...payload };
  await appendFile(path.join(config.stateDir, 'events.jsonl'), `${JSON.stringify(event)}\n`);
}

async function loadState(config) {
  await mkdir(config.stateDir, { recursive: true });
  const statePath = path.join(config.stateDir, 'state.json');
  const state = await readJson(statePath, { seen: [] });
  state.seen = Array.isArray(state.seen) ? state.seen.slice(-1000) : [];
  pruneOwnReplyHashes(state);
  return { statePath, state, seen: new Set(state.seen) };
}

async function saveState(statePath, state, seen) {
  state.seen = Array.from(seen).slice(-1000);
  pruneOwnReplyHashes(state);
  state.updatedAt = now();
  await writeFile(statePath, JSON.stringify(state, null, 2));
}

async function sendSignal(config, recipient, message, chunks = chunkText(message, config.maxReplyChars)) {
  if (!config.noteToSelf && !recipient) throw new Error('missing Signal recipient');
  for (const chunk of chunks) {
    const args = config.noteToSelf
      ? [...signalGlobalArgs(config), 'send', '--message-from-stdin', '--note-to-self']
      : [...signalGlobalArgs(config), 'send', '--message-from-stdin', recipient];
    const result = await runCommand(config.signalCli, args, {
      cwd: config.miRoot,
      timeoutMs: 30000,
      stdin: chunk,
      env: { ...process.env, PATH: `${path.join(home, '.local', 'bin')}:${process.env.PATH || ''}` },
    });
    if (result.code !== 0) throw new Error(redact(result.stderr || result.stdout || `signal-cli send exited ${result.code}`));
  }
}

async function sendBridgeReply(config, recipient, message, state, statePath, seen) {
  const clean = redact(message || 'Mi did not return a reply.');
  const chunks = chunkText(clean, config.maxReplyChars);
  rememberOwnReplyChunks(config, state, chunks);
  await saveState(statePath, state, seen);
  await sendSignal(config, recipient, clean, chunks);
}

async function askMi(config, message) {
  const env = {
    ...process.env,
    PATH: `${path.join(home, '.local', 'bin')}:${process.env.PATH || ''}`,
    MI_ROOT: config.miRoot,
  };
  const result = await runCommand(config.miCli, ['ask', '--thread', config.thread, message], {
    cwd: config.miRoot,
    env,
    timeoutMs: config.commandTimeoutMs,
  });
  const reply = (result.stdout || '').trim();
  if (result.code === 0 && reply) return reply;
  const error = redact(result.stderr || result.stdout || `mi exited ${result.code}`);
  return `Mi could not answer safely right now. ${error.slice(0, 500)}`.trim();
}

function localCommandReply(text) {
  const command = text.trim().toLowerCase();
  if (command === '/help' || command === 'help') {
    return 'Mi Signal bridge commands:\n/help - show this\n/status - check bridge\nAnything else goes to Mi main chat. Risky actions still require explicit approval. Do not send secrets.';
  }
  if (command === '/status' || command === 'status' || command === '/ping') {
    return 'Mi Signal bridge is online. Allowlist is enabled. No public webhook is exposed.';
  }
  return undefined;
}

async function handleEvent(config, event, seen, statePath, state) {
  const envelope = getEnvelope(event);
  const key = eventKey(event);
  if (seen.has(key)) return;
  seen.add(key);
  await saveState(statePath, state, seen);

  if (isOwnReplyEcho(config, event, state)) {
    await appendEvent(config, 'ignored_own_reply_echo', { eventHash: key });
    return;
  }

  if (!isAllowed(config, envelope, event)) {
    await appendEvent(config, 'rejected_sender', { sourceHash: sha(sourceIds(envelope, event).join(',')).slice(0, 16), eventHash: key });
    return;
  }

  if (!config.allowGroups && isGroupMessage(event)) {
    await appendEvent(config, 'ignored_group', { eventHash: key });
    return;
  }

  const recipient = replyRecipient(config, envelope);
  if (!recipient) {
    await appendEvent(config, 'missing_recipient', { eventHash: key });
    return;
  }

  const text = eventText(event).trim();
  if (!text) {
    await appendEvent(config, 'ignored_empty', { eventHash: key });
    return;
  }

  if (Array.from(text).length > config.maxMessageChars) {
    await appendEvent(config, 'too_long', { eventHash: key, chars: Array.from(text).length });
    await sendBridgeReply(config, recipient, `Message is too long for this bridge. Limit: ${config.maxMessageChars} characters.`, state, statePath, seen);
    return;
  }

  await appendEvent(config, 'received', { eventHash: key, messageHash: sha(text).slice(0, 16), noteToSelf: Boolean(config.noteToSelf) });
  const localReply = localCommandReply(text);
  const reply = localReply || await askMi(config, text);
  await sendBridgeReply(config, recipient, reply, state, statePath, seen);
  await appendEvent(config, 'replied', { eventHash: key, replyHash: sha(reply || '').slice(0, 16) });
}

async function receiveOnce(config) {
  const args = [
    ...signalGlobalArgs(config),
    '--output', 'json',
    'receive',
    '--ignore-attachments',
    '--ignore-stories',
    '--ignore-avatars',
    '--ignore-stickers',
    '--timeout', String(config.receiveTimeoutSeconds),
    '--max-messages', '20',
  ];
  return await runCommand(config.signalCli, args, {
    cwd: config.miRoot,
    timeoutMs: (Number(config.receiveTimeoutSeconds) + 10) * 1000,
    env: { ...process.env, PATH: `${path.join(home, '.local', 'bin')}:${process.env.PATH || ''}` },
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireLock(config) {
  await mkdir(config.stateDir, { recursive: true });
  const lockPath = path.join(config.stateDir, 'bridge.lock');
  const handle = await open(lockPath, 'wx').catch((error) => {
    if (error?.code === 'EEXIST') throw new Error(`Bridge lock exists: ${lockPath}. Is another bridge running?`);
    throw error;
  });
  await handle.writeFile(`${process.pid}\n${now()}\n`);
  const release = async () => {
    try { await handle.close(); } catch {}
    try { await unlink(lockPath); } catch {}
  };
  process.on('SIGINT', async () => { await release(); process.exit(0); });
  process.on('SIGTERM', async () => { await release(); process.exit(0); });
  return release;
}

async function main() {
  const config = await loadConfig();
  const release = await acquireLock(config);
  const { statePath, state, seen } = await loadState(config);
  await appendEvent(config, 'started', { thread: config.thread });

  while (true) {
    const result = await receiveOnce(config);
    if (result.code !== 0) {
      await appendEvent(config, 'receive_error', { error: redact(result.stderr || result.stdout).slice(0, 1000) });
      await sleep(config.pollIntervalMs);
      continue;
    }

    const lines = result.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
    for (const line of lines) {
      try {
        await handleEvent(config, JSON.parse(line), seen, statePath, state);
      } catch (error) {
        await appendEvent(config, 'handle_error', { error: redact(error instanceof Error ? error.message : String(error)).slice(0, 1000) });
      }
    }

    await saveState(statePath, state, seen);
    await sleep(config.pollIntervalMs);
  }

  // Unreachable, but kept for symmetry if the loop is later made finite.
  await release();
}

main().catch((error) => {
  console.error(redact(error instanceof Error ? error.message : String(error)));
  process.exit(1);
});
