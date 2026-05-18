#!/usr/bin/env node
import net from "node:net";
import { spawn } from "node:child_process";
import { appendFile, mkdir, open, readFile, readdir, readlink, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";

const HOME = homedir();
const RUNTIME_DIR = process.env.MI_RUNTIME_DIR || join(HOME, ".pi", "agent", "mi");
const SOCKET_PATH = process.env.MI_SOCKET_PATH || join(RUNTIME_DIR, "main.sock");
const SESSION_DIR = process.env.MI_SESSION_DIR || join(HOME, ".pi", "agent", "sessions", "mi-main");
const PI_BIN = process.env.MI_PI_BIN || join(HOME, ".nvm", "versions", "node", "v24.15.0", "bin", "pi");
const MI_MODEL = process.env.MI_MODEL || "openai-codex/gpt-5.5:low";
const LOG_PATH = join(RUNTIME_DIR, "mi-daemon.log");
const TASKS_PATH = join(HOME, "mi", "state", "tasks.json");
const DISMISSED_TASKS_PATH = join(HOME, "mi", "state", "dismissed-tasks.json");
const PI_SESSIONS_DIR = join(HOME, ".pi", "agent", "sessions");
const ACTIVE_SESSION_WINDOW_MS = Number(process.env.MI_ACTIVE_PI_SESSION_WINDOW_MS || 7 * 24 * 60 * 60_000);
const PI_SESSION_SCAN_CACHE_MS = Number(process.env.MI_PI_SESSION_SCAN_CACHE_MS || 5000);
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
let piSessionTaskCache = { at: 0, tasks: [] };

async function log(line) {
  await mkdir(RUNTIME_DIR, { recursive: true });
  await appendFile(LOG_PATH, `${new Date().toISOString()} ${line}\n`).catch(() => undefined);
}

async function readTasks() {
  try { return JSON.parse(await readFile(TASKS_PATH, "utf8")); } catch { return []; }
}

async function readDismissedTaskKeys() {
  try {
    const text = await readFile(DISMISSED_TASKS_PATH, "utf8");
    try { return new Set(JSON.parse(text)); } catch {}
    const end = text.indexOf("\n]");
    if (end >= 0) return new Set(JSON.parse(text.slice(0, end + 2)));
    return new Set();
  } catch { return new Set(); }
}

async function writeDismissedTaskKeys(keys) {
  await mkdir(dirname(DISMISSED_TASKS_PATH), { recursive: true });
  const tmp = `${DISMISSED_TASKS_PATH}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify([...keys].filter(Boolean).sort(), null, 2));
  await rename(tmp, DISMISSED_TASKS_PATH);
}

function taskDismissKeys(task) {
  return [task?.id, task?.sessionFile, task?.actualSessionFile, task?.sessionId, task?.sessionName, task?.name].filter(Boolean).map(String);
}

function isTaskDismissed(task, dismissed) {
  return taskDismissKeys(task).some((key) => dismissed.has(key));
}

async function walkSessionFiles(dir = PI_SESSIONS_DIR, files = []) {
  let entries = [];
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return files; }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await walkSessionFiles(full, files);
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(full);
  }
  return files;
}

function textFromMessage(message) {
  const content = message?.content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => typeof part === "string" ? part : part?.type === "text" ? part.text || "" : part?.type === "toolCall" ? `tool: ${part.name || "unknown"}` : "")
    .filter(Boolean)
    .join(" ")
    .trim();
}

function parseProcStat(text) {
  const end = text.lastIndexOf(")");
  if (end < 0) return {};
  const fields = text.slice(end + 2).trim().split(/\s+/);
  return { ppid: Number(fields[1] || 0), startTicks: Number(fields[19] || 0) };
}

async function processStartedAtMs(startTicks) {
  try {
    const uptimeSeconds = Number((await readFile("/proc/uptime", "utf8")).split(/\s+/)[0] || 0);
    const ticksPerSecond = Number(process.env.CLK_TCK || 100);
    return Date.now() - (uptimeSeconds * 1000) + (startTicks / ticksPerSecond * 1000);
  } catch {
    return Date.now();
  }
}

function procLooksLikeInteractivePi(comm, cmdline) {
  if (comm === "pi") return true;
  return /(^|\u0000|\s)(pi|.*\/pi)(\u0000|\s|$)/.test(cmdline) || cmdline.includes("pi-coding-agent");
}

function sessionFileFromCmdline(cmdline) {
  const args = cmdline.split("\u0000").filter(Boolean);
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === "--session" || args[i] === "--resume") && args[i + 1]) return args[i + 1];
    if (args[i]?.startsWith("--session=")) return args[i].slice("--session=".length);
    if (args[i]?.startsWith("--resume=")) return args[i].slice("--resume=".length);
  }
  return "";
}

async function listActivePiProcesses() {
  let entries = [];
  try { entries = await readdir("/proc", { withFileTypes: true }); } catch { return []; }
  const processes = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    const pid = Number(entry.name);
    try {
      const dir = join("/proc", entry.name);
      const comm = (await readFile(join(dir, "comm"), "utf8")).trim();
      const cmdline = await readFile(join(dir, "cmdline"), "utf8").catch(() => "");
      if (!procLooksLikeInteractivePi(comm, cmdline)) continue;
      const environ = await readFile(join(dir, "environ"), "utf8").catch(() => "");
      if (environ.includes("MI_WORKER=1")) continue;
      const procStats = parseProcStat(await readFile(join(dir, "stat"), "utf8"));
      if (procStats.ppid === process.pid) continue;
      const input = await readlink(join(dir, "fd", "0")).catch(() => "");
      if (!input.startsWith("/dev/pts/") && !input.startsWith("/dev/tty")) continue;
      const cwd = await readlink(join(dir, "cwd"));
      const startedAtMs = await processStartedAtMs(procStats.startTicks || 0);
      const sessionFile = sessionFileFromCmdline(cmdline);
      processes.push({ pid, cwd, startedAtMs, sessionFile });
    } catch {}
  }
  return processes;
}

async function readSessionSample(file, stats) {
  const firstBytes = 16 * 1024;
  const tailBytes = 64 * 1024;
  let handle;
  try {
    handle = await open(file, "r");
    const first = Buffer.alloc(Math.min(firstBytes, stats.size));
    await handle.read(first, 0, first.length, 0);
    if (stats.size <= firstBytes) return first.toString("utf8");
    const tailLength = Math.min(tailBytes, stats.size - firstBytes);
    const tail = Buffer.alloc(tailLength);
    await handle.read(tail, 0, tail.length, Math.max(firstBytes, stats.size - tailLength));
    return `${first.toString("utf8")}\n${tail.toString("utf8")}`;
  } catch {
    return "";
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function readPiSessionTask(file, stats) {
  if (file.startsWith(SESSION_DIR)) return undefined;
  if (Date.now() - stats.mtimeMs > ACTIVE_SESSION_WINDOW_MS) return undefined;
  let sessionId = "";
  let cwd = HOME;
  let startedAt = "";
  let sessionName = "";
  let activeGoal;
  let lastAssistant = "";
  let lastTimestamp = stats.mtime.toISOString();
  const raw = await readSessionSample(file, stats);
  if (!raw) return undefined;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    if (record.timestamp) lastTimestamp = record.timestamp;
    if (record.type === "session") {
      sessionId = record.id || sessionId;
      cwd = record.cwd || cwd;
      startedAt = record.timestamp || startedAt;
    } else if (record.type === "session_info") {
      sessionName = record.name || sessionName;
    } else if (record.type === "custom" && record.customType === "pi-goal" && record.data?.goal) {
      activeGoal = record.data.goal;
    } else if (record.type === "message" && record.message?.role === "assistant") {
      const text = textFromMessage(record.message);
      if (text) lastAssistant = text.slice(0, 500);
    }
  }
  const status = String(activeGoal?.status || "").toLowerCase();
  const name = sessionName || activeGoal?.objective?.split("\n")[0]?.slice(0, 80) || basename(cwd) || "pi session";
  const progress = activeGoal?.objective ? activeGoal.objective.split("\n")[0].slice(0, 500) : lastAssistant || "Recent pi session";
  return enrichTask({
    id: `pi-session:${sessionId || file}`,
    name,
    cwd,
    status: "inactive",
    startedAt: startedAt || stats.birthtime.toISOString(),
    updatedAt: lastTimestamp || stats.mtime.toISOString(),
    lastEventAt: stats.mtime.toISOString(),
    finishedAt: stats.mtime.toISOString(),
    progress,
    sessionFile: file,
    actualSessionFile: file,
    sessionId,
    sessionName: name,
    source: "pi-session",
  });
}

async function listPiSessionTasks() {
  const now = Date.now();
  if (now - piSessionTaskCache.at < PI_SESSION_SCAN_CACHE_MS) return piSessionTaskCache.tasks;
  const activeProcesses = await listActivePiProcesses();
  const activeByCwd = new Map();
  for (const proc of activeProcesses) {
    const list = activeByCwd.get(proc.cwd) || [];
    list.push(proc);
    activeByCwd.set(proc.cwd, list);
  }
  const files = await walkSessionFiles();
  const withStats = [];
  for (const file of files) {
    try { withStats.push({ file, stats: await stat(file) }); } catch {}
  }
  withStats.sort((a, b) => b.stats.mtimeMs - a.stats.mtimeMs);
  const tasks = [];
  for (const { file, stats } of withStats.slice(0, 40)) {
    const task = await readPiSessionTask(file, stats);
    if (task) tasks.push(task);
  }
  const activeTaskIds = new Set();
  const matchedTaskIds = new Set();
  for (const proc of activeProcesses) {
    if (!proc.sessionFile) continue;
    const match = tasks.find((task) => !matchedTaskIds.has(task.id) && (task.sessionFile === proc.sessionFile || task.actualSessionFile === proc.sessionFile));
    if (match) {
      matchedTaskIds.add(match.id);
      activeTaskIds.add(match.id);
    }
  }
  const closeStartWindowMs = 10 * 60_000;
  for (const [cwd, procs] of activeByCwd) {
    for (const proc of procs) {
      const candidates = tasks
        .filter((task) => task.cwd === cwd && !matchedTaskIds.has(task.id))
        .map((task) => ({ task, delta: Math.abs(proc.startedAtMs - (Date.parse(task.startedAt || "") || 0)) }))
        .filter((entry) => entry.delta <= closeStartWindowMs)
        .sort((a, b) => a.delta - b.delta || Date.parse(b.task.updatedAt || b.task.lastEventAt || "") - Date.parse(a.task.updatedAt || a.task.lastEventAt || ""));
      const match = candidates[0]?.task;
      if (match) {
        matchedTaskIds.add(match.id);
        activeTaskIds.add(match.id);
      }
    }
  }
  const marked = tasks.map((task) => activeTaskIds.has(task.id)
    ? { ...task, status: "active", finishedAt: undefined }
    : { ...task, status: "inactive", finishedAt: task.finishedAt || task.lastEventAt || task.updatedAt });
  piSessionTaskCache = { at: now, tasks: marked };
  return marked;
}

function taskHasActiveWorker(task) {
  return taskDismissKeys(task).some((key) => activeWorkers.has(key));
}

function reconcileStoredTask(task) {
  const status = String(task.status || "").toLowerCase();
  if (["running", "queued", "thinking", "thinkingqueued"].includes(status) && !taskHasActiveWorker(task)) {
    const lastActiveAt = Date.parse(task.continuedAt || task.lastEventAt || task.updatedAt || task.startedAt || 0) || 0;
    if (Date.now() - lastActiveAt < 120000) return task;
    const finishedAt = task.finishedAt || task.lastEventAt || task.updatedAt || new Date().toISOString();
    return { ...task, status: "inactive", finishedAt, progress: task.progress || "worker is no longer running" };
  }
  return task;
}

async function listAllTasks() {
  const dismissed = await readDismissedTaskKeys();
  const rawTasks = await readTasks();
  const reconciledRawTasks = rawTasks.map(reconcileStoredTask);
  if (JSON.stringify(rawTasks) !== JSON.stringify(reconciledRawTasks)) await writeTasks(reconciledRawTasks);
  const tasks = reconciledRawTasks.filter((task) => !isTaskDismissed(task, dismissed));
  const taskKeys = new Set(tasks.flatMap((task) => [task.sessionFile, task.actualSessionFile]).filter(Boolean));
  const sessions = (await listPiSessionTasks()).filter((task) => !taskKeys.has(task.sessionFile) && !taskKeys.has(task.actualSessionFile) && !isTaskDismissed(task, dismissed));
  return [...tasks, ...sessions];
}

async function stopTask(request) {
  const requested = [request.taskId, request.id, request.sessionFile, request.actualSessionFile, request.sessionId, request.sessionName, request.name].filter(Boolean).map(String);
  if (requested.length === 0) throw new Error("taskId required");
  const tasks = await readTasks();
  const task = tasks.find((entry) => taskDismissKeys(entry).some((key) => requested.includes(key)));
  const name = task?.sessionName || task?.name || requested[0];
  const activeWorker = task ? (activeWorkers.get(task.id) || activeWorkers.get(task.name) || activeWorkers.get(task.sessionName)) : undefined;
  if (activeWorker && !activeWorker.proc.killed) activeWorker.proc.kill();
  if (task) {
    await upsertTask({ ...task, status: "stopped", finishedAt: new Date().toISOString(), progress: "stopped" });
    untrackActiveWorker(task, name);
  }
  return { text: `Stopped ${name}` };
}

async function dismissTask(request) {
  const requested = [request.taskId, request.id, request.sessionFile, request.actualSessionFile, request.sessionId, request.sessionName, request.name].filter(Boolean).map(String);
  if (requested.length === 0) throw new Error("taskId required");
  const tasks = await readTasks();
  const sessions = await listPiSessionTasks();
  const match = [...tasks, ...sessions].find((task) => taskDismissKeys(task).some((key) => requested.includes(key)));
  const keys = new Set([...(await readDismissedTaskKeys()), ...requested, ...taskDismissKeys(match || {})]);
  await writeDismissedTaskKeys(keys);
  const remaining = tasks.filter((task) => !isTaskDismissed(task, keys));
  if (remaining.length !== tasks.length) await writeTasks(remaining);
  piSessionTaskCache = { at: 0, tasks: [] };
  return { text: `Removed ${match?.sessionName || match?.name || requested[0]} from task list` };
}

async function resumePiSessions() {
  await writeDismissedTaskKeys(new Set());
  piSessionTaskCache = { at: 0, tasks: [] };
  const sessions = await listPiSessionTasks();
  return { text: `Added ${sessions.length} pi session${sessions.length === 1 ? "" : "s"} to task list`, count: sessions.length };
}

async function writeTasks(tasks) {
  await mkdir(dirname(TASKS_PATH), { recursive: true });
  await writeFile(TASKS_PATH, JSON.stringify(tasks, null, 2));
}

function extractPrUrls(text) {
  return [...String(text || "").matchAll(/https:\/\/github\.com\/[^\s)]+\/pull\/\d+/gi)].map((match) => match[0]);
}

function detectNeedsKyle(task) {
  const text = `${task.error || ""}\n${task.text || ""}\n${task.progress || ""}`;
  const patterns = [
    /approval required/i,
    /needs? (?:kyle|user|your) (?:input|review|approval|decision|confirmation)/i,
    /waiting (?:on|for) (?:kyle|user|you|approval|review|input|decision)/i,
    /blocked (?:by|on|until)/i,
    /please (?:review|approve|confirm|decide|provide)/i,
    /requires? (?:manual|human|user) (?:review|approval|input|decision)/i,
  ];
  const hit = patterns.find((pattern) => pattern.test(text));
  if (hit) return { needsKyle: true, needsKyleReason: hit.source };
  if (task.status === "error") return { needsKyle: true, needsKyleReason: "error" };
  return { needsKyle: false, needsKyleReason: undefined };
}

function enrichTask(task) {
  const prUrls = [...new Set([...(task.prUrls || []), ...extractPrUrls(`${task.text || ""}\n${task.progress || ""}\n${task.error || ""}`)])];
  return { ...task, ...detectNeedsKyle(task), prUrls };
}

async function upsertTask(task) {
  const tasks = await readTasks();
  const index = tasks.findIndex((entry) => entry.id === task.id);
  const previous = index >= 0 ? tasks[index] : undefined;
  const next = enrichTask({ ...task, updatedAt: new Date().toISOString() });
  const merged = index >= 0 ? enrichTask({ ...previous, ...next }) : next;
  if (merged.needsKyle && !previous?.notifiedNeedsKyleAt) {
    merged.notifiedNeedsKyleAt = new Date().toISOString();
    await appendMainThreadMessage(`Task needs Kyle: ${merged.sessionName || merged.name || merged.id}\n\n${merged.needsKyleReason || "Needs attention"}\n\n${merged.error || merged.progress || merged.text || "Open the background task for details."}`).catch(() => undefined);
  }
  if (merged.status === "paused" && previous?.status !== "paused" && !previous?.notifiedPausedAt) {
    merged.notifiedPausedAt = new Date().toISOString();
    await appendMainThreadMessage(`Task paused: ${merged.sessionName || merged.name || merged.id}\n\n${merged.progress || merged.text || "Open the background task for details."}`).catch(() => undefined);
  }
  if (index >= 0) tasks[index] = merged;
  else tasks.unshift(merged);
  const statusRank = (task) => {
    const status = String(task.status || "").toLowerCase();
    if (["running", "waiting", "active", "queued", "paused"].includes(status)) return 0;
    if (status === "error") return 1;
    return 2;
  };
  tasks.sort((a, b) => statusRank(a) - statusRank(b) || Date.parse(b.updatedAt || b.lastEventAt || b.finishedAt || b.startedAt || 0) - Date.parse(a.updatedAt || a.lastEventAt || a.finishedAt || a.startedAt || 0));
  await writeTasks(tasks.slice(0, 200));
  return merged;
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

async function appendMainThreadMessage(text, source = "mi-agent-view") {
  const ts = new Date().toISOString();
  const threads = await ensureMainThread();
  const record = threads.find((thread) => thread.id === "main");
  const message = { id: messageId(), threadId: "main", role: "assistant", text, ts, unread: true, source };
  await appendFile(join(THREADS_DIR, "main.jsonl"), `${JSON.stringify(message)}\n`);
  if (record) {
    record.updatedAt = ts;
    record.unread = (record.unread || 0) + 1;
    await writeFile(THREAD_INDEX_PATH, JSON.stringify(threads, null, 2));
  }
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
  command({ type: "set_session_name", name: "mi-main" }).catch((error) => log(`set_main_session_name_error ${String(error.message || error)}`));
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

function workerKeys(task, fallbackName) {
  return [...new Set([task.id, task.name, task.sessionName, fallbackName].filter(Boolean))];
}
function trackActiveWorker(task, fallbackName, worker) {
  for (const key of workerKeys(task, fallbackName)) activeWorkers.set(key, worker);
}
function untrackActiveWorker(task, fallbackName) {
  for (const key of workerKeys(task, fallbackName)) activeWorkers.delete(key);
}

function compactToolValue(value, max = 120) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function summarizeBashCommand(command) {
  const text = compactToolValue(command || "bash");
  const first = text.match(/^\s*(?:\w+=\S+\s+)*(?:sudo\s+)?([^\s;&|]+)/)?.[1]?.split("/").pop() || "command";
  if (["rg", "grep", "ag"].includes(first)) return "searching files";
  if (first === "find") return "finding files";
  if (["ls", "tree"].includes(first)) return "listing files";
  if (first === "git") return "checking git";
  if (["npm", "pnpm", "yarn", "bun"].includes(first)) return "running package script";
  if (["make", "just"].includes(first)) return "running project task";
  return `running ${first}`;
}

function summarizeToolStart(toolName, args = {}) {
  const name = String(toolName || "tool");
  if (name === "bash") return summarizeBashCommand(args.command);
  if (name === "read") return `reading ${compactToolValue(args.path || "file")}`;
  if (name === "edit") return `editing ${compactToolValue(args.path || "file")}`;
  if (name === "write") return `writing ${compactToolValue(args.path || "file")}`;
  if (name.includes("fetch") || name.includes("browser")) return `checking ${compactToolValue(args.url || args.path || name)}`;
  return `using ${name}`;
}

function summarizeWorkerEvent(event) {
  if (event.type === "agent_start") return "agent started";
  if (event.type === "turn_start") return "thinking";
  if (event.type === "tool_execution_start") return summarizeToolStart(event.toolName, event.args || {});
  if (event.type === "tool_execution_end") return event.isError ? `tool failed: ${event.toolName || "unknown"}` : undefined;
  if (event.type === "auto_retry_start") return `retrying: ${event.errorMessage || ""}`.trim();
  if (event.type === "compaction_start") return "compacting context";
  if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") return String(event.assistantMessageEvent.delta || "");
  return undefined;
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
  const eventListeners = [];

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
      for (const listener of eventListeners) listener(payload);
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

  function waitAgentEnd() {
    return new Promise((resolve, reject) => {
      agentEndWaiters.push({ resolve, reject });
    });
  }

  function onEvent(listener) {
    eventListeners.push(listener);
  }

  return { proc, rpc, waitAgentEnd, onEvent };
}

function isSlashCommand(message) {
  return /^\/[A-Za-z][\w:-]*(?:\s|$)/.test(String(message || "").trim());
}

function workerInputMessage(message, useGoal = "1") {
  return isSlashCommand(message) ? String(message || "").trim() : wrapWorkerMessage(message, useGoal);
}

function wrapWorkerMessage(message, useGoal = "1") {
  return String(useGoal) === "0" || message.trim().startsWith("/goal")
    ? message
    : `/goal ${message}\n\nWhen done, provide a concise final summary with concrete outcome, files changed, tests/checks run, PR URL if any, and what Kyle should do next.`;
}

function installTaskHeartbeat(worker, task) {
  let progress = "";
  let assistantText = "";
  let lastWrite = 0;
  worker.onEvent((event) => {
    const summary = summarizeWorkerEvent(event);
    if (!summary) return;
    if (event.type === "message_update") {
      assistantText = `${assistantText}${summary}`.replace(/\s+/g, " ").trim().slice(-500);
      progress = assistantText;
    } else if (!assistantText) {
      progress = summary;
    }
    const now = Date.now();
    if (now - lastWrite < 1000 && event.type === "message_update") return;
    lastWrite = now;
    const status = String(event.type || "").toLowerCase().includes("pause") ? "paused" : "running";
    void upsertTask({ ...task, status, progress, lastEventAt: new Date().toISOString() }).catch((error) => log(`task_heartbeat_error ${String(error.message || error)}`));
  });
}

async function finishTask({ task, worker, before, sessionFile, name, done, kind }) {
  try {
    const end = await done;
    const after = await worker.rpc({ type: "get_state" }).catch(() => before);
    const text = lastAssistantText(end.messages) || "Worker completed without text.";
    const visibleSessionFile = await mirrorSessionToHome(after.sessionFile || sessionFile || before.sessionFile);
    await upsertTask({ ...task, status: "complete", finishedAt: new Date().toISOString(), text, actualSessionFile: after.sessionFile || sessionFile || before.sessionFile, sessionFile: visibleSessionFile, sessionId: after.sessionId || task.sessionId, sessionName: after.sessionName || name, model: after.model || before.model });
    await appendMainThreadMessage(`${kind}: ${name}\n\n${text}\n\nOpen in /resume: ${visibleSessionFile || "unknown"}`).catch(() => undefined);
  } catch (error) {
    const errorText = String(error.message || error);
    await upsertTask({ ...task, status: "error", finishedAt: new Date().toISOString(), error: errorText });
    await appendMainThreadMessage(`${kind} failed: ${name}\n\n${errorText}`).catch(() => undefined);
  } finally {
    untrackActiveWorker(task, name);
    worker.proc.kill();
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
    const task = await upsertTask({
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
    });
    installTaskHeartbeat(worker, task);
    const done = worker.waitAgentEnd();
    await worker.rpc({ type: "prompt", message: workerInputMessage(message, request.useGoal) });
    if (request.background) {
      trackActiveWorker(task, name, worker);
      await appendMainThreadMessage(`Task started: ${name}\n\nStatus: running\nOpen in /resume: ${visibleSessionFile || "unknown"}`, "mi-task-status").catch(() => undefined);
      void finishTask({ task, worker, before, name, done, kind: "Task complete" });
      return { text: `Started background task: ${name}`, taskId: task.id, sessionFile: visibleSessionFile, sessionId: before.sessionId, sessionName: before.sessionName || name, model: before.model };
    }
    const end = await done;
    const after = await worker.rpc({ type: "get_state" }).catch(() => before);
    const text = lastAssistantText(end.messages) || "Worker completed without text.";
    await upsertTask({ ...task, status: "complete", finishedAt: new Date().toISOString(), text });
    return { text, sessionFile: await mirrorSessionToHome(after.sessionFile || before.sessionFile), sessionId: after.sessionId || before.sessionId, sessionName: after.sessionName || name, model: after.model || before.model };
  } finally {
    if (!request.background) worker.proc.kill();
  }
}

async function continueWorker(request) {
  const taskId = String(request.taskId || request.id || "").trim();
  const message = String(request.message || "").trim();
  if (!taskId) throw new Error("taskId required");
  if (!message) throw new Error("Message is empty");
  const tasks = await listAllTasks();
  let task = tasks.find((entry) => entry.id === taskId || entry.name === taskId || entry.sessionName === taskId || entry.sessionFile === taskId || entry.actualSessionFile === taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);
  if (task.source === "pi-session") task = await upsertTask({ ...task, id: task.id || `pi-session:${task.sessionId || task.sessionFile}`, status: task.status === "active" ? "active" : "inactive" });
  const name = task.sessionName || task.name || task.id;
  const activeWorker = activeWorkers.get(task.id) || activeWorkers.get(task.name) || activeWorkers.get(name) || activeWorkers.get(taskId);
  if (activeWorker && !activeWorker.proc.killed) {
    await activeWorker.rpc({ type: "prompt", message: workerInputMessage(message, request.useGoal), streamingBehavior: isSlashCommand(message) ? undefined : "steer" });
    await upsertTask({ ...task, status: "running", finishedAt: undefined, text: undefined, error: undefined, continuedAt: new Date().toISOString(), progress: "follow-up queued" });
    await appendMainThreadMessage(`Task updated: ${name}\n\nStatus: running\nFollow-up queued.`, "mi-task-status").catch(() => undefined);
    return { text: `Queued message for background task: ${name}`, taskId: task.id, sessionFile: task.sessionFile, sessionId: task.sessionId, sessionName: name };
  }
  const sessionFile = task.actualSessionFile || task.sessionFile;
  if (!sessionFile) throw new Error(`Task has no session file: ${taskId}`);
  const cwd = task.cwd || HOME;
  const model = String(request.model || MI_MODEL).trim();
  const worker = createRpcProcess({ cwd, sessionFile, model, env: { MI_WORKER: "1" } });
  try {
    const before = await worker.rpc({ type: "get_state" });
    const updated = await upsertTask({ ...task, status: "running", finishedAt: undefined, text: undefined, error: undefined, continuedAt: new Date().toISOString(), progress: "follow-up queued" });
    installTaskHeartbeat(worker, updated);
    const done = worker.waitAgentEnd();
    await worker.rpc({ type: "prompt", message: workerInputMessage(message, request.useGoal) });
    if (request.background) {
      trackActiveWorker(updated, name, worker);
      await appendMainThreadMessage(`Task updated: ${name}\n\nStatus: running\nOpen in /resume: ${task.sessionFile || sessionFile || "unknown"}`, "mi-task-status").catch(() => undefined);
      void finishTask({ task: updated, worker, before, sessionFile, name, done, kind: "Task updated" });
      return { text: `Sent follow-up to background task: ${name}`, taskId: task.id, sessionFile: task.sessionFile, sessionId: task.sessionId, sessionName: name };
    }
    const end = await done;
    const after = await worker.rpc({ type: "get_state" }).catch(() => before);
    const text = lastAssistantText(end.messages) || "Worker completed without text.";
    const visibleSessionFile = await mirrorSessionToHome(after.sessionFile || sessionFile);
    await upsertTask({ ...updated, status: "complete", finishedAt: new Date().toISOString(), text, actualSessionFile: after.sessionFile || sessionFile, sessionFile: visibleSessionFile });
    return { text, sessionFile: visibleSessionFile, sessionId: after.sessionId || task.sessionId, sessionName: after.sessionName || name };
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
    socket.end(JSON.stringify({ ok: true, tasks: await listAllTasks() }) + "\n");
    return;
  }
  if (request.type === "stop_task") {
    const result = await stopTask(request);
    socket.end(JSON.stringify({ ok: true, ...result }) + "\n");
    return;
  }
  if (request.type === "dismiss_task") {
    const result = await dismissTask(request);
    socket.end(JSON.stringify({ ok: true, ...result }) + "\n");
    return;
  }
  if (request.type === "resume_sessions") {
    const result = await resumePiSessions();
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
  for (const worker of activeWorkers.values()) worker.proc?.kill();
  await rm(SOCKET_PATH, { force: true }).catch(() => undefined);
  process.exit(0);
});
