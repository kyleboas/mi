#!/usr/bin/env node
import net from "node:net";
import { spawn } from "node:child_process";
import { mkdir, rm, appendFile } from "node:fs/promises";
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

let piProc;
let buffer = "";
let nextId = 1;
const pending = new Map();
const promptQueue = [];
let activePrompt;

async function log(line) {
  await mkdir(RUNTIME_DIR, { recursive: true });
  await appendFile(LOG_PATH, `${new Date().toISOString()} ${line}\n`).catch(() => undefined);
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
    if (messages[i]?.role === "assistant") return messageText(messages[i]);
  }
  return "";
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

function createRpcProcess({ cwd = HOME, sessionDir = join(HOME, ".pi", "agent", "sessions"), model = MI_MODEL, env = {} } = {}) {
  const proc = spawn(PI_BIN, ["--mode", "rpc", "--session-dir", sessionDir, "--model", model], {
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

async function runWorker(request) {
  const message = String(request.message || "").trim();
  if (!message) throw new Error("Message is empty");
  const name = String(request.name || `Mi worker ${new Date().toISOString()}`).trim();
  const cwd = String(request.cwd || HOME).trim();
  const model = String(request.model || MI_MODEL).trim();
  const sessionDir = String(request.sessionDir || join(HOME, ".pi", "agent", "sessions")).trim();
  log(`starting worker ${name} cwd=${cwd} model=${model}`);
  const worker = createRpcProcess({ cwd, model, sessionDir, env: { MI_WORKER: "1" } });
  try {
    await worker.rpc({ type: "set_session_name", name });
    const before = await worker.rpc({ type: "get_state" });
    const done = worker.waitAgentEnd(Number(request.timeoutMs || 300000));
    await worker.rpc({ type: "prompt", message });
    const end = await done;
    const after = await worker.rpc({ type: "get_state" }).catch(() => before);
    return {
      text: lastAssistantText(end.messages) || "Worker completed without text.",
      sessionFile: after.sessionFile || before.sessionFile,
      sessionId: after.sessionId || before.sessionId,
      sessionName: after.sessionName || name,
      model: after.model || before.model,
    };
  } finally {
    worker.proc.kill();
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
