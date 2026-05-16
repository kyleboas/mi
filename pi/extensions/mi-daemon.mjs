#!/usr/bin/env node
import net from "node:net";
import { spawn } from "node:child_process";
import { mkdir, rm, appendFile, readFile, writeFile, symlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const HOME = homedir();
const RUNTIME_DIR = process.env.MI_RUNTIME_DIR || join(HOME, ".pi", "agent", "mi");
const SOCKET_PATH = process.env.MI_SOCKET_PATH || join(RUNTIME_DIR, "main.sock");
const SESSION_DIR = process.env.MI_SESSION_DIR || join(HOME, ".pi", "agent", "sessions", "mi-main");
const PI_BIN = process.env.MI_PI_BIN || join(HOME, ".nvm", "versions", "node", "v24.15.0", "bin", "pi");
const MI_MODEL = process.env.MI_MODEL || "openai-codex/gpt-5.5:low";
const LOG_PATH = join(RUNTIME_DIR, "mi-daemon.log");
const TASKS_PATH = join(HOME, "mi", "state", "tasks.json");
const PUSHOVER_ENV_PATH = join(HOME, ".config", "pushover", "env");
const PUSHOVER_ENDPOINT = "https://api.pushover.net/1/messages.json";
const MI_ROOT = process.env.MI_ROOT || join(HOME, "assistant");
const THREADS_DIR = join(MI_ROOT, "state", "threads");
const THREAD_INDEX_PATH = join(THREADS_DIR, "index.json");

let piProc;
let buffer = "";
let nextId = 1;
const pending = new Map();
const promptQueue = [];
const activeWorkers = new Map();
let activePrompt;

async function log(line) {
  await mkdir(RUNTIME_DIR, { recursive: true });
  await appendFile(LOG_PATH, `${new Date().toISOString()} ${line}\n`).catch(() => undefined);
}

async function readTasks() {
  try { return JSON.parse(await readFile(TASKS_PATH, "utf8")); } catch { return []; }
}

async function writeTasks(tasks) {
  await mkdir(dirname(TASKS_PATH), { recursive: true });
  await writeFile(TASKS_PATH, JSON.stringify(tasks, null, 2));
}

async function upsertTask(task) {
  const tasks = await readTasks();
  const index = tasks.findIndex((entry) => entry.id === task.id);
  if (index >= 0) tasks[index] = { ...tasks[index], ...task };
  else tasks.unshift(task);
  await writeTasks(tasks.slice(0, 200));
}

function messageId(prefix = "msg") {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

async function ensureMainThread() {
  await mkdir(THREADS_DIR, { recursive: true });
  let threads = [];
  try { threads = JSON.parse(await readFile(THREAD_INDEX_PATH, "utf8")); } catch {}
  if (!threads.some((thread) => thread.id === "main")) {
    const ts = new Date().toISOString();
    threads.unshift({ id: "main", title: "main", kind: "main", createdAt: ts, updatedAt: ts, unread: 0 });
    await writeFile(THREAD_INDEX_PATH, JSON.stringify(threads, null, 2));
  }
  return threads;
}

async function appendMainThreadMessage(text) {
  const ts = new Date().toISOString();
  const threads = await ensureMainThread();
  const record = threads.find((thread) => thread.id === "main");
  const message = { id: messageId(), threadId: "main", role: "assistant", text, ts, unread: true, source: "mi-task" };
  await appendFile(join(THREADS_DIR, "main.jsonl"), `${JSON.stringify(message)}\n`);
  if (record) {
    record.updatedAt = ts;
    record.unread = (record.unread || 0) + 1;
    await writeFile(THREAD_INDEX_PATH, JSON.stringify(threads, null, 2));
  }
}

function parseEnv(text) {
  const values = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    values[match[1]] = value;
  }
  return values;
}

function usableSecret(value) {
  return value && !String(value).includes("${") ? String(value) : undefined;
}

async function pushoverCredentials() {
  let fileEnv = {};
  try { fileEnv = parseEnv(await readFile(PUSHOVER_ENV_PATH, "utf8")); } catch {}
  const token = usableSecret(process.env.PUSHOVER_APP_TOKEN) || usableSecret(fileEnv.PUSHOVER_APP_TOKEN) || usableSecret(process.env.PUSHOVER_TOKEN) || usableSecret(fileEnv.PUSHOVER_TOKEN);
  const user = usableSecret(process.env.PUSHOVER_USER_KEY) || usableSecret(fileEnv.PUSHOVER_USER_KEY) || usableSecret(process.env.PUSHOVER_USER) || usableSecret(fileEnv.PUSHOVER_USER);
  return token && user ? { token, user } : undefined;
}

function safeNotificationText(text) {
  return String(text)
    .replace(/\b[A-Za-z0-9_]*(TOKEN|SECRET|PASSWORD|API_KEY)[A-Za-z0-9_]*\s*=\s*[^\s]+/gi, "[redacted]")
    .replace(/sk-[A-Za-z0-9_-]{20,}/g, "[redacted]");
}

async function sendPushover(title, message) {
  const credentials = await pushoverCredentials();
  if (!credentials) return { skipped: true };
  const body = new URLSearchParams({
    token: credentials.token,
    user: credentials.user,
    title: safeNotificationText(title).slice(0, 120),
    message: safeNotificationText(message),
    priority: "0",
  });
  const response = await fetch(PUSHOVER_ENDPOINT, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  return { ok: response.ok, status: response.status };
}

function extractPrUrls(text) {
  return [...String(text).matchAll(/https:\/\/github\.com\/[^\s)]+\/pull\/\d+/gi)].map((match) => match[0]);
}

function reviewHint(text) {
  const prUrls = extractPrUrls(text);
  if (prUrls.length > 0) return `\n\nReview PR:\n${[...new Set(prUrls)].join('\n')}`;
  if (/\b(PR|pull request)\b/i.test(text) && /\b(review|merge|ready|created|opened)\b/i.test(text)) return "\n\nReview needed: PR mentioned, but no GitHub PR URL was found in the task output.";
  return "";
}

function isUnhelpfulTaskText(text) {
  const trimmed = String(text || "").trim();
  return !trimmed || /Queued goal continuation is no longer active/i.test(trimmed) || /^Goal achieved\.?$/i.test(trimmed) || /^Mi completed without text\.?$/i.test(trimmed);
}

function formatTaskMessage(kind, name, text, sessionName, sessionFile) {
  const body = isUnhelpfulTaskText(text)
    ? `The background worker stopped without a useful final summary. Open the session in /resume to inspect what happened.`
    : text;
  return `${kind}: ${name}\n\n${body}${reviewHint(body)}\n\nSession: ${sessionName || name}\nOpen in /resume: ${sessionFile || "unknown"}`;
}

async function deliverTaskMessage(title, text) {
  await appendMainThreadMessage(text);
  await sendPushover(title, text).catch((error) => log(`pushover_error ${String(error.message || error)}`));
}

function defaultSessionDir(cwd) {
  const safePath = `--${cwd.replace(/^[\/\\]/, "").replace(/[\/\\:]/g, "-")}--`;
  return join(HOME, ".pi", "agent", "sessions", safePath);
}

async function mirrorSessionToHome(sessionFile) {
  if (!sessionFile) return sessionFile;
  const homeDir = defaultSessionDir(HOME);
  await mkdir(homeDir, { recursive: true });
  const linkPath = join(homeDir, sessionFile.split(/[\/\\]/).pop());
  if (linkPath === sessionFile) return sessionFile;
  try { await symlink(sessionFile, linkPath); } catch (error) { if (error.code !== "EEXIST") throw error; }
  return linkPath;
}

function startPi() {
  if (piProc && !piProc.killed) return;
  log(`starting ${PI_BIN} --mode rpc --session-dir ${SESSION_DIR} --model ${MI_MODEL}`);
  piProc = spawn(PI_BIN, ["--mode", "rpc", "--session-dir", SESSION_DIR, "--model", MI_MODEL], {
    cwd: HOME,
    env: { ...process.env, MI_MAIN: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  piProc.stdout.on("data", (chunk) => onStdout(chunk));
  piProc.stderr.on("data", (chunk) => log(`stderr ${chunk.toString("utf8").trim()}`));
  piProc.on("exit", (code, signal) => {
    log(`pi exited ${code ?? "null"}/${signal ?? "null"}`);
    for (const entry of pending.values()) entry.reject(new Error("Mi main pi process exited"));
    pending.clear();
    piProc = undefined;
    setTimeout(startPi, 1000);
  });
}

function textPart(part) {
  if (!part) return "";
  if (typeof part === "string") return part;
  if (part.type === "text") return part.text || "";
  return "";
}

function messageText(message) {
  const content = message?.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) return content.map(textPart).filter(Boolean).join("\n").trim();
  return "";
}

function lastAssistantText(messages = []) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "assistant") {
      const text = messageText(messages[i]);
      if (text) return text;
    }
  }
  return "";
}

function lastUsefulAssistantText(messages = []) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role !== "assistant") continue;
    const text = messageText(messages[i]);
    if (!text) continue;
    if (isUnhelpfulTaskText(text)) continue;
    return text;
  }
  return lastAssistantText(messages);
}

function maybeStartNextPrompt() {
  if (activePrompt || promptQueue.length === 0) return;
  activePrompt = promptQueue.shift();
  command({ type: "prompt", message: activePrompt.message }).catch((error) => {
    const entry = activePrompt;
    activePrompt = undefined;
    entry.reject(error);
    maybeStartNextPrompt();
  });
}

function onStdout(chunk) {
  buffer += chunk.toString("utf8");
  while (true) {
    const newlineIndex = buffer.indexOf("\n");
    if (newlineIndex === -1) break;
    const line = buffer.slice(0, newlineIndex).trim();
    buffer = buffer.slice(newlineIndex + 1);
    if (!line) continue;
    let payload;
    try { payload = JSON.parse(line); } catch { log(`parse_error ${line.slice(0, 500)}`); continue; }
    if (payload.type === "response" && payload.id) {
      const entry = pending.get(payload.id);
      if (!entry) continue;
      pending.delete(payload.id);
      payload.success ? entry.resolve(payload.data ?? payload) : entry.reject(new Error(payload.error || "Mi RPC failed"));
    } else if (payload.type === "agent_end" && activePrompt) {
      const entry = activePrompt;
      activePrompt = undefined;
      entry.resolve(lastAssistantText(payload.messages) || "Mi completed without text.");
      maybeStartNextPrompt();
    }
  }
}

function command(cmd) {
  startPi();
  if (!piProc?.stdin.writable) throw new Error("Mi main pi process is not writable");
  const id = `mi-${nextId++}`;
  const payload = { id, ...cmd };
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    piProc.stdin.write(`${JSON.stringify(payload)}\n`, "utf8", (error) => {
      if (error) {
        pending.delete(id);
        reject(error);
      }
    });
  });
}

async function runPrompt(message) {
  return new Promise((resolve, reject) => {
    promptQueue.push({ message, resolve, reject });
    maybeStartNextPrompt();
  });
}

function createRpcProcess({ cwd = HOME, sessionDir, sessionFile, model = MI_MODEL, env = {} } = {}) {
  const args = ["--mode", "rpc", "--model", model];
  if (sessionDir) args.splice(2, 0, "--session-dir", sessionDir);
  if (sessionFile) args.splice(2, 0, "--session", sessionFile);
  const proc = spawn(PI_BIN, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let rpcBuffer = "";
  let rpcNextId = 1;
  const rpcPending = new Map();
  const agentEndWaiters = [];

  proc.stdout.on("data", (chunk) => {
    rpcBuffer += chunk.toString("utf8");
    while (true) {
      const newlineIndex = rpcBuffer.indexOf("\n");
      if (newlineIndex === -1) break;
      const line = rpcBuffer.slice(0, newlineIndex).trim();
      rpcBuffer = rpcBuffer.slice(newlineIndex + 1);
      if (!line) continue;
      let payload;
      try { payload = JSON.parse(line); } catch { log(`worker_parse_error ${line.slice(0, 500)}`); continue; }
      if (payload.type === "response" && payload.id) {
        const entry = rpcPending.get(payload.id);
        if (!entry) continue;
        rpcPending.delete(payload.id);
        payload.success ? entry.resolve(payload.data ?? payload) : entry.reject(new Error(payload.error || "Worker RPC failed"));
      } else if (payload.type === "agent_end") {
        const waiter = agentEndWaiters.shift();
        if (waiter) waiter.resolve(payload);
      }
    }
  });
  proc.stderr.on("data", (chunk) => log(`worker_stderr ${chunk.toString("utf8").trim()}`));
  proc.on("exit", (code, signal) => {
    const error = new Error(`Worker pi process exited ${code ?? "null"}/${signal ?? "null"}`);
    for (const entry of rpcPending.values()) entry.reject(error);
    rpcPending.clear();
    for (const waiter of agentEndWaiters.splice(0)) waiter.reject(error);
  });

  function rpc(cmd) {
    if (!proc.stdin.writable) throw new Error("Worker pi process is not writable");
    const id = `worker-${rpcNextId++}`;
    const payload = { id, ...cmd };
    return new Promise((resolve, reject) => {
      rpcPending.set(id, { resolve, reject });
      proc.stdin.write(`${JSON.stringify(payload)}\n`, "utf8", (error) => {
        if (error) {
          rpcPending.delete(id);
          reject(error);
        }
      });
    });
  }

  function waitAgentEnd(timeoutMs = 300000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out waiting for worker agent_end")), timeoutMs);
      agentEndWaiters.push({
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
    });
  }

  return { proc, rpc, waitAgentEnd };
}

async function continueWorker(request) {
  const taskId = String(request.taskId || request.id || "").trim();
  const message = String(request.message || "").trim();
  if (!taskId) throw new Error("taskId required");
  if (!message) throw new Error("Message is empty");
  const tasks = await readTasks();
  const task = tasks.find((entry) => entry.id === taskId || entry.name === taskId || entry.name === `Mi task: ${taskId}`);
  if (!task) throw new Error(`Task not found: ${taskId}`);
  const name = task.sessionName || task.name || `Mi task: ${taskId}`;
  const workerMessage = String(request.useGoal || "1") === "0" || message.trim().startsWith("/goal") ? message : `/goal ${message}\n\nWhen done, provide a concise final summary with concrete outcome, files changed, tests/checks run, PR URL if any, and what Kyle should do next. Do not answer only with goal-status boilerplate.`;
  const activeWorker = activeWorkers.get(task.id) || activeWorkers.get(task.name) || activeWorkers.get(name) || activeWorkers.get(taskId);
  if (activeWorker && !activeWorker.proc.killed) {
    await activeWorker.rpc({ type: "prompt", message: workerMessage, streamingBehavior: "followUp" });
    await upsertTask({ ...task, status: "running", continuedAt: new Date().toISOString() });
    return { text: `Queued follow-up for background task: ${name}`, taskId: task.id, sessionFile: task.sessionFile, sessionId: task.sessionId, sessionName: name };
  }
  const sessionFile = task.actualSessionFile || task.sessionFile;
  if (!sessionFile) throw new Error(`Task has no session file: ${taskId}`);
  const cwd = task.cwd || HOME;
  const model = String(request.model || MI_MODEL).trim();
  log(`continuing worker ${name} cwd=${cwd} model=${model}`);
  const worker = createRpcProcess({ cwd, sessionFile, model, env: { MI_WORKER: "1" } });
  try {
    const before = await worker.rpc({ type: "get_state" });
    await upsertTask({ ...task, status: "running", continuedAt: new Date().toISOString() });
    const done = worker.waitAgentEnd(Number(request.timeoutMs || 300000));
    await worker.rpc({ type: "prompt", message: workerMessage });
    if (request.background) {
      done.then(async (end) => {
        const after = await worker.rpc({ type: "get_state" }).catch(() => before);
        const text = lastUsefulAssistantText(end.messages) || "Worker completed without text.";
        const visibleSessionFile = await mirrorSessionToHome(after.sessionFile || sessionFile);
        await upsertTask({ ...task, status: "complete", finishedAt: new Date().toISOString(), text, actualSessionFile: after.sessionFile || sessionFile, sessionFile: visibleSessionFile, sessionId: after.sessionId || task.sessionId, sessionName: after.sessionName || name, model: after.model || before.model });
        await deliverTaskMessage(`Mi task updated: ${name}`, formatTaskMessage("Task updated", name, text, after.sessionName || name, visibleSessionFile));
        worker.proc.kill();
      }).catch(async (error) => {
        const errorText = String(error.message || error);
        await upsertTask({ ...task, status: "error", finishedAt: new Date().toISOString(), error: errorText });
        await deliverTaskMessage(`Mi task failed: ${name}`, formatTaskMessage("Task follow-up failed", name, errorText, name, task.sessionFile || "unknown"));
        worker.proc.kill();
      });
      return { text: `Sent follow-up to background task: ${name}`, taskId: task.id, sessionFile: task.sessionFile, sessionId: task.sessionId, sessionName: name };
    }
    const end = await done;
    const after = await worker.rpc({ type: "get_state" }).catch(() => before);
    const text = lastUsefulAssistantText(end.messages) || "Worker completed without text.";
    const visibleSessionFile = await mirrorSessionToHome(after.sessionFile || sessionFile);
    await upsertTask({ ...task, status: "complete", finishedAt: new Date().toISOString(), text, actualSessionFile: after.sessionFile || sessionFile, sessionFile: visibleSessionFile, sessionId: after.sessionId || task.sessionId, sessionName: after.sessionName || name, model: after.model || before.model });
    return { text, sessionFile: visibleSessionFile, sessionId: after.sessionId || task.sessionId, sessionName: after.sessionName || name };
  } finally {
    if (!request.background) worker.proc.kill();
  }
}

async function runWorker(request) {
  const message = String(request.message || "").trim();
  if (!message) throw new Error("Message is empty");
  const name = String(request.name || `Mi worker ${new Date().toISOString()}`).trim();
  const cwd = String(request.cwd || HOME).trim();
  const model = String(request.model || MI_MODEL).trim();
  const sessionDir = request.sessionDir ? String(request.sessionDir).trim() : undefined;
  log(`starting worker ${name} cwd=${cwd} model=${model}`);
  const worker = createRpcProcess({ cwd, model, sessionDir, env: { MI_WORKER: "1" } });
  try {
    await worker.rpc({ type: "set_session_name", name });
    const before = await worker.rpc({ type: "get_state" });
    const visibleSessionFile = await mirrorSessionToHome(before.sessionFile);
    const task = {
      id: `task_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      name,
      cwd,
      status: request.background ? "running" : "waiting",
      startedAt: new Date().toISOString(),
      sessionFile: visibleSessionFile,
      actualSessionFile: before.sessionFile,
      sessionId: before.sessionId,
      sessionName: before.sessionName || name,
      model: before.model,
    };
    await upsertTask(task);
    const done = worker.waitAgentEnd(Number(request.timeoutMs || 300000));
    const workerMessage = String(request.useGoal || "1") === "0" || message.trim().startsWith("/goal") ? message : `/goal ${message}\n\nWhen done, provide a concise final summary with concrete outcome, files changed, tests/checks run, PR URL if any, and what Kyle should do next. Do not answer only with goal-status boilerplate.`;
    await worker.rpc({ type: "prompt", message: workerMessage });
    if (request.background) {
      activeWorkers.set(task.id, worker);
      activeWorkers.set(task.name, worker);
      activeWorkers.set(task.sessionName || name, worker);
      done.then(async (end) => {
        activeWorkers.delete(task.id);
        activeWorkers.delete(task.name);
        activeWorkers.delete(task.sessionName || name);
        const after = await worker.rpc({ type: "get_state" }).catch(() => before);
        const text = lastUsefulAssistantText(end.messages) || "Worker completed without text.";
        const sessionFile = await mirrorSessionToHome(after.sessionFile || before.sessionFile);
        await upsertTask({
          ...task,
          status: "complete",
          finishedAt: new Date().toISOString(),
          text,
          actualSessionFile: after.sessionFile || before.sessionFile,
          sessionFile,
          sessionId: after.sessionId || before.sessionId,
          sessionName: after.sessionName || name,
          model: after.model || before.model,
        });
        await deliverTaskMessage(`Mi task complete: ${name}`, formatTaskMessage("Task complete", name, text, after.sessionName || name, sessionFile));
        worker.proc.kill();
      }).catch(async (error) => {
        activeWorkers.delete(task.id);
        activeWorkers.delete(task.name);
        activeWorkers.delete(task.sessionName || name);
        const errorText = String(error.message || error);
        await upsertTask({ ...task, status: "error", finishedAt: new Date().toISOString(), error: errorText });
        await deliverTaskMessage(`Mi task failed: ${name}`, formatTaskMessage("Task failed", name, errorText, task.sessionName || name, task.sessionFile || "unknown"));
        worker.proc.kill();
      });
      return {
        text: `Started background task: ${name}`,
        sessionFile: visibleSessionFile,
        sessionId: before.sessionId,
        sessionName: before.sessionName || name,
        model: before.model,
        taskId: task.id,
      };
    }
    const end = await done;
    const after = await worker.rpc({ type: "get_state" }).catch(() => before);
    await upsertTask({ ...task, status: "complete", finishedAt: new Date().toISOString(), text: lastUsefulAssistantText(end.messages) || "Worker completed without text." });
    return {
      text: lastUsefulAssistantText(end.messages) || "Worker completed without text.",
      sessionFile: await mirrorSessionToHome(after.sessionFile || before.sessionFile),
      sessionId: after.sessionId || before.sessionId,
      sessionName: after.sessionName || name,
      model: after.model || before.model,
    };
  } finally {
    if (!request.background) worker.proc.kill();
  }
}

async function handle(socket, request) {
  if (request.type === "prompt") {
    const message = String(request.message || "").trim();
    if (!message) throw new Error("Message is empty");
    const text = await runPrompt(message);
    socket.end(JSON.stringify({ ok: true, text }) + "\n");
    return;
  }
  if (request.type === "health") {
    socket.end(JSON.stringify({ ok: true, pi: !!piProc && !piProc.killed }) + "\n");
    return;
  }
  if (request.type === "abort") {
    promptQueue.length = 0;
    if (activePrompt) {
      const entry = activePrompt;
      activePrompt = undefined;
      entry.resolve("Mi stopped.");
    }
    await command({ type: "abort" }).catch(() => undefined);
    socket.end(JSON.stringify({ ok: true }) + "\n");
    return;
  }
  if (request.type === "state") {
    const state = await command({ type: "get_state" });
    let stats;
    try { stats = await command({ type: "get_session_stats" }); } catch {}
    socket.end(JSON.stringify({ ok: true, state: { ...state, stats } }) + "\n");
    return;
  }
  if (request.type === "cycle_model") {
    const state = await command({ type: "cycle_model" });
    socket.end(JSON.stringify({ ok: true, state }) + "\n");
    return;
  }
  if (request.type === "set_model") {
    const provider = String(request.provider || "").trim();
    const modelId = String(request.modelId || "").trim();
    if (!provider || !modelId) throw new Error("provider and modelId required");
    const state = await command({ type: "set_model", provider, modelId });
    socket.end(JSON.stringify({ ok: true, state }) + "\n");
    return;
  }
  if (request.type === "set_thinking") {
    const level = String(request.level || "").trim();
    if (!level) throw new Error("level required");
    const state = await command({ type: "set_thinking_level", level });
    socket.end(JSON.stringify({ ok: true, state }) + "\n");
    return;
  }
  if (request.type === "new_session") {
    const state = await command({ type: "new_session", parentSession: request.parentSession });
    socket.end(JSON.stringify({ ok: true, state }) + "\n");
    return;
  }
  if (request.type === "set_session_name") {
    const name = String(request.name || "").trim();
    if (!name) throw new Error("name required");
    const state = await command({ type: "set_session_name", name });
    socket.end(JSON.stringify({ ok: true, state }) + "\n");
    return;
  }
  if (request.type === "get_available_models") {
    const state = await command({ type: "get_available_models" });
    socket.end(JSON.stringify({ ok: true, state }) + "\n");
    return;
  }
  if (request.type === "run_worker") {
    const result = await runWorker(request);
    socket.end(JSON.stringify({ ok: true, ...result }) + "\n");
    return;
  }
  if (request.type === "continue_worker") {
    const result = await continueWorker(request);
    socket.end(JSON.stringify({ ok: true, ...result }) + "\n");
    return;
  }
  if (request.type === "list_tasks") {
    socket.end(JSON.stringify({ ok: true, tasks: await readTasks() }) + "\n");
    return;
  }
  throw new Error(`Unknown request type: ${request.type}`);
}

await mkdir(dirname(SOCKET_PATH), { recursive: true });
if (existsSync(SOCKET_PATH)) await rm(SOCKET_PATH, { force: true });
await mkdir(SESSION_DIR, { recursive: true });
startPi();

const server = net.createServer((socket) => {
  let data = "";
  socket.on("data", (chunk) => {
    data += chunk.toString("utf8");
    if (!data.includes("\n")) return;
    const line = data.slice(0, data.indexOf("\n"));
    let request;
    try { request = JSON.parse(line); } catch (error) { socket.end(JSON.stringify({ ok: false, error: String(error.message || error) }) + "\n"); return; }
    handle(socket, request).catch((error) => socket.end(JSON.stringify({ ok: false, error: String(error.message || error) }) + "\n"));
  });
});

server.listen(SOCKET_PATH, () => log(`listening ${SOCKET_PATH}`));
process.on("SIGTERM", async () => {
  server.close();
  piProc?.kill();
  await rm(SOCKET_PATH, { force: true }).catch(() => undefined);
  process.exit(0);
});
