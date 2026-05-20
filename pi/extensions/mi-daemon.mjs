#!/usr/bin/env node
import net from "node:net";
import { spawn } from "node:child_process";
import { appendFile, mkdir, open, readFile, readdir, readlink, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";

const HOME = homedir();
const RUNTIME_DIR = process.env.MI_RUNTIME_DIR || join(HOME, ".pi", "agent", "mi");
const SOCKET_PATH = process.env.MI_SOCKET_PATH || join(RUNTIME_DIR, "main.sock");
const SESSION_DIR = process.env.MI_SESSION_DIR || join(HOME, ".pi", "agent", "sessions", "mi-main");
const PI_BIN = process.env.MI_PI_BIN || "pi";
const MI_MODEL = process.env.MI_MODEL || "openai-codex/gpt-5.5:low";
const LOG_PATH = join(RUNTIME_DIR, "mi-daemon.log");
const LOCK_PATH = join(RUNTIME_DIR, "mi-daemon.lock");
const TASKS_PATH = join(HOME, "mi", "state", "tasks.json");
const DISMISSED_TASKS_PATH = join(HOME, "mi", "state", "dismissed-tasks.json");
const MI_PREFERENCES_PATH = join(HOME, "mi", "preferences.md");
const PI_SESSIONS_DIR = join(HOME, ".pi", "agent", "sessions");
const ACTIVE_SESSION_WINDOW_MS = Number(process.env.MI_ACTIVE_PI_SESSION_WINDOW_MS || 7 * 24 * 60 * 60_000);
const PI_SESSION_SCAN_CACHE_MS = Number(process.env.MI_PI_SESSION_SCAN_CACHE_MS || 5000);
const MI_MAIN_IDLE_MS = Number(process.env.MI_MAIN_IDLE_MS || 120000);
const MI_DAEMON_LOCK_START_GRACE_MS = Number(process.env.MI_DAEMON_LOCK_START_GRACE_MS || 5000);
const MI_ROOT = process.env.MI_ROOT || process.cwd();
const THREADS_DIR = join(MI_ROOT, "state", "threads");
const THREAD_INDEX_PATH = join(THREADS_DIR, "index.json");
const EXCLUDED_PI_SESSION_CWDS = (process.env.MI_EXCLUDED_PI_SESSION_CWDS || "").split(":").map((value) => value.trim().replace(/\/+$/, "")).filter(Boolean);

let piProc;
let daemonLockHandle;
let buffer = "";
let nextId = 1;
const pending = new Map();
const promptQueue = [];
const activeWorkers = new Map();
const startingWorkerKeys = new Set();
let activePrompt;
let piIdleTimer;
let piSessionTaskCache = { at: 0, tasks: [] };

function miUserName() {
  const envName = process.env.MI_USER_NAME?.trim();
  if (envName) return envName;
  try {
    const preferences = readFileSync(MI_PREFERENCES_PATH, "utf8");
    const match = preferences.match(/^\s*-\s*(?:User(?:'s)?(?: display)? name|Name):\s*(.+?)\s*$/im);
    const name = match?.[1]?.trim().replace(/[.。]+$/, "");
    if (name) return name;
  } catch {}
  return "the user";
}

function miSummaryInstruction() {
  return `When done, provide a concise final summary with concrete outcome, files changed, tests/checks run, PR URL if any, and what ${miUserName()} should do next.`;
}

async function log(line) {
  await mkdir(RUNTIME_DIR, { recursive: true });
  await appendFile(LOG_PATH, `${new Date().toISOString()} ${line}\n`).catch(() => undefined);
}

function socketHealth(timeoutMs = 500) {
  return new Promise((resolve) => {
    if (!existsSync(SOCKET_PATH)) return resolve(false);
    const socket = net.createConnection(SOCKET_PATH);
    let data = "";
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, timeoutMs);
    socket.on("connect", () => socket.write(`${JSON.stringify({ type: "health" })}\n`));
    socket.on("data", (chunk) => {
      data += chunk.toString("utf8");
      if (!data.includes("\n")) return;
      clearTimeout(timer);
      socket.end();
      try { resolve(JSON.parse(data.slice(0, data.indexOf("\n"))).ok === true); } catch { resolve(false); }
    });
    socket.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

async function acquireDaemonLock() {
  await mkdir(dirname(SOCKET_PATH), { recursive: true });
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      daemonLockHandle = await open(LOCK_PATH, "wx");
      await daemonLockHandle.writeFile(String(process.pid));
      return true;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const lockOwner = (await readFile(LOCK_PATH, "utf8").catch(() => "")).trim();
      if (await socketHealth(2000)) {
        await log(`singleton exit; daemon already healthy at ${SOCKET_PATH}`);
        return false;
      }
      const lockStats = await stat(LOCK_PATH).catch(() => undefined);
      const lockAgeMs = lockStats ? Date.now() - lockStats.mtimeMs : Number.POSITIVE_INFINITY;
      if (lockOwner && existsSync(`/proc/${lockOwner}`) && lockAgeMs < MI_DAEMON_LOCK_START_GRACE_MS) {
        await log(`waiting for daemon lock ${LOCK_PATH} owned by starting pid ${lockOwner}`);
        await new Promise((resolve) => setTimeout(resolve, 250));
        continue;
      }
      if (lockOwner && existsSync(`/proc/${lockOwner}`)) {
        await log(`removing unhealthy daemon lock ${LOCK_PATH} owned by pid ${lockOwner}`);
        try { process.kill(Number(lockOwner), "SIGTERM"); } catch {}
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      await rm(LOCK_PATH, { force: true }).catch(() => undefined);
    }
  }
  return false;
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

function sessionFingerprint(task) {
  const direct = task?.sessionId ? String(task.sessionId) : "";
  if (direct) return direct;
  const path = String(task?.sessionFile || task?.actualSessionFile || "");
  const match = path.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\.jsonl)?$/i);
  return match?.[1] || "";
}

function taskDismissKeys(task) {
  return [task?.id, task?.sessionFile, task?.actualSessionFile, task?.sessionId, sessionFingerprint(task), task?.sessionName, task?.name].filter(Boolean).map(String);
}

function taskPersistentDismissKeys(task) {
  const isPiSession = task?.source === "pi-session" || String(task?.id || "").startsWith("pi-session:");
  if (isPiSession) return [task?.id, task?.sessionFile, task?.actualSessionFile, task?.sessionId].filter(Boolean).map(String);
  return taskDismissKeys(task);
}

function isTaskDismissed(task, dismissed) {
  return taskPersistentDismissKeys(task).some((key) => dismissed.has(key));
}

function isExcludedPiSessionTask(task) {
  const cwd = String(task?.cwd || "").replace(/\/+$/, "");
  return task?.source === "pi-session" && EXCLUDED_PI_SESSION_CWDS.includes(cwd);
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
    .map((part) => typeof part === "string" ? part : part?.type === "text" ? part.text || "" : "")
    .filter(Boolean)
    .join(" ")
    .trim();
}

function assistantMessageHasText(message) {
  return Boolean(textFromMessage(message));
}

function assistantMessageIsBusy(message) {
  const content = message?.content;
  if (!Array.isArray(content)) return false;
  if (content.some((part) => part?.type === "toolCall")) return true;
  if (assistantMessageHasText(message)) return false;
  return content.some((part) => part?.type === "thinking");
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
  if (file.startsWith(SESSION_DIR) || file.includes("/sessions/mi-main/")) return undefined;
  if (Date.now() - stats.mtimeMs > ACTIVE_SESSION_WINDOW_MS) return undefined;
  let sessionId = "";
  let cwd = HOME;
  let startedAt = "";
  let sessionName = "";
  let activeGoal;
  let lastAssistant = "";
  let lastInput = "";
  let lastTimestamp = stats.mtime.toISOString();
  let busy = false;
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
    } else if (record.type === "message" && record.message?.role === "user") {
      busy = true;
      const text = normalizeLastInputText(textFromMessage(record.message));
      if (text) lastInput = text.slice(0, 500);
    } else if (record.type === "message" && record.message?.role === "toolResult") {
      busy = true;
    } else if (record.type === "message" && record.message?.role === "assistant") {
      const text = textFromMessage(record.message);
      busy = assistantMessageIsBusy(record.message) || !text;
      if (text) lastAssistant = text.slice(0, 500);
    }
  }
  const sessionTitle = sessionName && !isGenericTaskName(normalizedNameText(sessionName)) ? sessionName : "";
  const goalTitle = activeGoal?.objective?.split("\n")[0]?.slice(0, 80) || "";
  const inputTitle = taskNameFromText(lastInput);
  const name = sessionTitle || goalTitle || inputTitle || basename(cwd) || "Mi session";
  const progress = activeGoal?.objective
    ? activeGoal.objective.split("\n")[0].slice(0, 500)
    : lastAssistant || (busy ? "Pi session is still running" : "Pi session finished without captured final output");
  return enrichTask({
    id: `pi-session:${sessionId || file}`,
    name,
    cwd,
    status: busy ? "running" : "complete",
    startedAt: startedAt || stats.birthtime.toISOString(),
    updatedAt: lastTimestamp || stats.mtime.toISOString(),
    lastEventAt: stats.mtime.toISOString(),
    finishedAt: busy ? undefined : (lastTimestamp || stats.mtime.toISOString()),
    text: busy ? undefined : lastAssistant,
    progress,
    sessionFile: file,
    actualSessionFile: file,
    sessionId,
    sessionName: name,
    lastInput,
    source: "pi-session",
  });
}

function inferOpenPiSessionFiles(tasks, activeProcesses) {
  const explicit = new Set(activeProcesses.map((proc) => proc.sessionFile).filter(Boolean));
  const inferred = new Set(explicit);
  const assigned = new Set(explicit);
  const interactiveProcesses = activeProcesses
    .filter((proc) => !proc.sessionFile)
    .sort((a, b) => b.startedAtMs - a.startedAtMs);
  const candidates = tasks
    .filter((task) => task.sessionFile && task.cwd)
    .sort((a, b) => (Date.parse(b.lastEventAt || b.updatedAt || b.startedAt || 0) || 0) - (Date.parse(a.lastEventAt || a.updatedAt || a.startedAt || 0) || 0));
  for (const proc of interactiveProcesses) {
    const match = candidates.find((task) => {
      if (assigned.has(task.sessionFile)) return false;
      if (task.cwd !== proc.cwd) return false;
      const startedAt = Date.parse(task.startedAt || "") || 0;
      const lastEventAt = Date.parse(task.lastEventAt || task.updatedAt || "") || 0;
      return startedAt >= proc.startedAtMs - 60_000 || lastEventAt >= proc.startedAtMs - 60_000;
    });
    if (!match) continue;
    inferred.add(match.sessionFile);
    assigned.add(match.sessionFile);
  }
  return inferred;
}

async function listPiSessionTasks() {
  const now = Date.now();
  if (now - piSessionTaskCache.at < PI_SESSION_SCAN_CACHE_MS) return piSessionTaskCache.tasks;
  const activeProcesses = await listActivePiProcesses();
  const files = await walkSessionFiles();
  const withStats = [];
  for (const file of files) {
    try { withStats.push({ file, stats: await stat(file) }); } catch {}
  }
  withStats.sort((a, b) => b.stats.mtimeMs - a.stats.mtimeMs);
  const explicitSessionFiles = new Set(activeProcesses.map((proc) => proc.sessionFile).filter(Boolean));
  const selected = [];
  const selectedFiles = new Set();
  for (const entry of withStats) {
    if (selected.length < 80 || explicitSessionFiles.has(entry.file)) {
      selected.push(entry);
      selectedFiles.add(entry.file);
    }
  }
  for (const file of explicitSessionFiles) {
    if (selectedFiles.has(file)) continue;
    try { selected.push({ file, stats: await stat(file) }); } catch {}
  }
  const parsedTasks = [];
  for (const { file, stats } of selected) {
    const task = await readPiSessionTask(file, stats);
    if (task) parsedTasks.push(task);
  }
  const openSessionFiles = inferOpenPiSessionFiles(parsedTasks, activeProcesses);
  const tasks = parsedTasks.map((task) => {
    const openPiSession = openSessionFiles.has(task.sessionFile);
    const status = String(task.status || "").toLowerCase();
    if (openPiSession && ["running", "active", "queued", "thinking", "thinkingqueued"].includes(status)) {
      return { ...task, status: "running", finishedAt: undefined, openPiSession: true };
    }
    if (["running", "active", "queued", "thinking", "thinkingqueued"].includes(status)) {
      return enrichTask({
        ...task,
        status: "paused",
        needsUser: true,
        needsUserReason: "interactive pi session stopped before replying",
        finishedAt: undefined,
        progress: task.progress || `stopped; needs ${miUserName()} input`,
      });
    }
    return task;
  });
  piSessionTaskCache = { at: now, tasks };
  return tasks;
}

function taskHasActiveWorker(task) {
  return taskDismissKeys(task).some((key) => activeWorkers.has(key));
}

function normalizedNameText(text) {
  return String(text || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function normalizedTaskName(task) {
  return normalizedNameText(task?.sessionName || task?.name || "");
}

function isGenericTaskName(name) {
  return !name || name === "user" || name === "mi session" || name === "recent mi session";
}

function normalizeLastInputText(text) {
  return String(text || "")
    .trim()
    .replace(/^\/goal\s+/i, "")
    .replace(/\n\nWhen done, provide a concise final summary with concrete outcome, files changed, tests\/checks run, PR URL if any, and what [^\n.]+ should do next\.$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function taskNameFromText(text) {
  return normalizeLastInputText(text)
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function normalizedLastInput(task) {
  return normalizeLastInputText(task?.lastInput).toLowerCase().slice(0, 500);
}

function logicalTaskStartKey({ name, cwd, message }) {
  return [String(cwd || ""), normalizedNameText(name), normalizeLastInputText(message).toLowerCase().slice(0, 500)].join("\u001f");
}

function sameLogicalTask(a, b) {
  if (samePiSessionTask(a, b)) return true;
  const sameCwd = String(a?.cwd || "") === String(b?.cwd || "");
  const aName = normalizedTaskName(a);
  const bName = normalizedTaskName(b);
  if (sameCwd && aName && aName === bName && !isGenericTaskName(aName)) return true;
  const aLastInput = normalizedLastInput(a);
  const bLastInput = normalizedLastInput(b);
  if (sameCwd && aLastInput && aLastInput === bLastInput) return true;
  return false;
}

function reconcileStoredTask(task) {
  const status = String(task.status || "").toLowerCase();
  if (["running", "active", "queued", "thinking", "thinkingqueued"].includes(status) && !taskHasActiveWorker(task)) {
    // A task that has entered Working must stay Working until an authoritative
    // terminal event updates it: finishTask() writes complete with final output,
    // worker failure writes error, and stop_task writes paused/needsUser.
    // Do not infer "inactive" from a missing in-memory worker: the daemon may
    // have restarted, or a session scan may lag behind the actual worker.
    return { ...task, status: task.status || "running", finishedAt: undefined };
  }
  return task;
}

function piSessionMatchKeys(task) {
  return [task?.sessionFile, task?.actualSessionFile, task?.sessionId, sessionFingerprint(task), task?.id].filter(Boolean).map(String);
}

function samePiSessionTask(a, b) {
  const aKeys = new Set(piSessionMatchKeys(a));
  return piSessionMatchKeys(b).some((key) => aKeys.has(key));
}

function dedupePiSessionTasks(tasks) {
  const merged = [];
  for (const task of tasks) {
    const index = merged.findIndex((entry) => sameLogicalTask(entry, task));
    if (index === -1) {
      merged.push(task);
      continue;
    }
    const previous = merged[index];
    const previousTime = Date.parse(previous.updatedAt || previous.lastEventAt || previous.finishedAt || previous.startedAt || 0) || 0;
    const nextTime = Date.parse(task.updatedAt || task.lastEventAt || task.finishedAt || task.startedAt || 0) || 0;
    const newer = nextTime >= previousTime ? task : previous;
    const older = newer === task ? previous : task;
    merged[index] = enrichTask({
      ...older,
      ...newer,
      lastInput: newer.lastInput || older.lastInput,
      text: newer.text || older.text,
      progress: newer.progress || older.progress,
      sessionFile: newer.sessionFile || older.sessionFile,
      actualSessionFile: newer.actualSessionFile || older.actualSessionFile,
      sessionId: newer.sessionId || older.sessionId,
    });
  }
  return merged;
}

function firstTimestampMs(...values) {
  for (const value of values) {
    const ms = Date.parse(String(value || ""));
    if (ms) return ms;
  }
  return 0;
}

function storedWorkingIsNewerThanScan(task, session) {
  const taskWorkAt = firstTimestampMs(task.continuedAt, task.updatedAt, task.lastEventAt, task.startedAt);
  const sessionAt = firstTimestampMs(session.finishedAt, session.updatedAt, session.lastEventAt, session.startedAt);
  return taskWorkAt > sessionAt;
}

function betterMergedName(task, activeSession, field) {
  const current = task?.[field];
  const next = activeSession?.[field];
  if ((!current || isGenericTaskName(normalizedNameText(current))) && next && !isGenericTaskName(normalizedNameText(next))) return next;
  return current || next;
}

async function mergeOpenPiSessions(tasks, dismissed) {
  const sessions = await listPiSessionTasks();
  const visibleSessions = sessions.filter((task) => !isTaskDismissed(task, dismissed) && !isExcludedPiSessionTask(task));
  const merged = tasks.map((task) => {
    const activeSession = visibleSessions.find((session) => sameLogicalTask(task, session));
    if (!activeSession) return task;
    const taskStatus = String(task.status || "").toLowerCase();
    const activeStatus = String(activeSession.status || "").toLowerCase();
    const terminalTask = task.finishedAt || ["complete", "completed", "done", "error", "stopped", "paused", "inactive"].includes(taskStatus);
    const liveTrackedWorker = taskHasActiveWorker(task);
    if (liveTrackedWorker) {
      return {
        ...task,
        lastEventAt: activeSession.lastEventAt || task.lastEventAt,
        sessionFile: task.sessionFile || activeSession.sessionFile,
        actualSessionFile: task.actualSessionFile || activeSession.actualSessionFile,
        sessionId: task.sessionId || activeSession.sessionId,
        sessionName: task.sessionName || activeSession.sessionName,
      };
    }
    const staleBusySession = ["running", "active", "queued", "thinking", "thinkingqueued"].includes(activeStatus);
    const storedWorking = ["running", "active", "queued", "thinking", "thinkingqueued"].includes(taskStatus) && !task.finishedAt;
    const scannedComplete = ["complete", "completed", "done", "inactive"].includes(activeStatus) || activeSession.finishedAt;
    const preserveStoredTerminal = terminalTask && (staleBusySession || taskStatus === "paused");
    const preserveStoredWorking = storedWorking && scannedComplete && storedWorkingIsNewerThanScan(task, activeSession);
    const preserveStoredState = preserveStoredTerminal || preserveStoredWorking;
    return {
      ...task,
      name: betterMergedName(task, activeSession, "name"),
      sessionName: betterMergedName(task, activeSession, "sessionName"),
      status: preserveStoredState ? task.status : (activeSession.status || task.status),
      needsUser: preserveStoredTerminal ? task.needsUser : (activeSession.needsUser ?? task.needsUser),
      needsUserReason: preserveStoredTerminal ? task.needsUserReason : (activeSession.needsUserReason || task.needsUserReason),
      finishedAt: preserveStoredState ? task.finishedAt : activeSession.finishedAt,
      text: preserveStoredState ? task.text : (activeSession.text || task.text),
      progress: preserveStoredState ? task.progress : (activeSession.progress || task.progress),
      lastInput: activeSession.lastInput || task.lastInput,
      lastEventAt: activeSession.lastEventAt || task.lastEventAt,
      updatedAt: preserveStoredState ? task.updatedAt : (activeSession.updatedAt || task.updatedAt),
      openPiSession: activeSession.openPiSession || undefined,
    };
  });
  for (const session of visibleSessions) {
    if (!merged.some((task) => sameLogicalTask(task, session))) merged.push(session);
  }
  return dedupePiSessionTasks(merged);
}

async function listAllTasks() {
  const dismissed = await readDismissedTaskKeys();
  const rawTasks = await readTasks();
  const reconciledRawTasks = rawTasks.map(reconcileStoredTask);
  if (JSON.stringify(rawTasks) !== JSON.stringify(reconciledRawTasks)) await writeTasks(reconciledRawTasks);
  const storedTasks = reconciledRawTasks.filter((task) => !isTaskDismissed(task, dismissed) && !isExcludedPiSessionTask(task));
  const mergedTasks = await mergeOpenPiSessions(storedTasks, dismissed);
  // Anything that appears in mi agents should stay there until the user clears it.
  // Discovered/open pi sessions used to disappear after the recent-session window;
  // persist the merged view so refreshes and daemon restarts keep the task row.
  if (JSON.stringify(reconciledRawTasks) !== JSON.stringify(mergedTasks)) await writeTasks(mergedTasks);
  return mergedTasks;
}

async function stopTask(request) {
  const requested = [request.taskId, request.id, request.sessionFile, request.actualSessionFile, request.sessionId, request.sessionName, request.name].filter(Boolean).map(String);
  if (requested.length === 0) throw new Error("taskId required");
  const tasks = await readTasks();
  const sessions = await listPiSessionTasks();
  const task = [...tasks, ...sessions].find((entry) => taskDismissKeys(entry).some((key) => requested.includes(key)));
  const name = task?.sessionName || task?.name || requested[0];
  const activeWorker = task ? workerKeys(task, name).map((key) => activeWorkers.get(key)).find(Boolean) : undefined;
  if (task) {
    await upsertTask({ ...task, status: "paused", needsUser: true, needsUserReason: "stopped by Escape", finishedAt: undefined, error: undefined, progress: `stopped by Escape; needs ${miUserName()} input`, updatedAt: new Date().toISOString() });
  }
  if (activeWorker && !activeWorker.proc.killed) {
    activeWorker.expectedStop = true;
    activeWorker.proc.kill();
  }
  if (task) {
    untrackActiveWorker(task, name);
  }
  return { text: `Stopped ${name}; moved to needs input` };
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

async function listPiSessionsForResume() {
  piSessionTaskCache = { at: 0, tasks: [] };
  return (await listPiSessionTasks()).filter((task) => !isExcludedPiSessionTask(task));
}

async function resumePiSession(request) {
  const requested = [request.taskId, request.id, request.sessionFile, request.actualSessionFile, request.sessionId, request.sessionName, request.name].filter(Boolean).map(String);
  if (requested.length === 0) throw new Error("session id required");
  const sessions = await listPiSessionsForResume();
  const session = sessions.find((task) => taskDismissKeys(task).some((key) => requested.includes(key)));
  if (!session) throw new Error(`Session not found: ${requested[0]}`);
  const dismissed = await readDismissedTaskKeys();
  for (const key of taskPersistentDismissKeys(session)) dismissed.delete(key);
  await writeDismissedTaskKeys(dismissed);
  piSessionTaskCache = { at: 0, tasks: [] };
  const task = await upsertTask(session);
  return { text: `Added ${task.sessionName || task.name || requested[0]} as task`, task };
}

async function resumePiSessions() {
  const sessions = await listPiSessionsForResume();
  const activeSessions = sessions.filter((task) => ["active", "running"].includes(String(task.status || "").toLowerCase()));
  const dismissed = await readDismissedTaskKeys();
  for (const task of activeSessions) {
    for (const key of taskPersistentDismissKeys(task)) dismissed.delete(key);
    await upsertTask(task);
  }
  await writeDismissedTaskKeys(dismissed);
  piSessionTaskCache = { at: 0, tasks: [] };
  return { text: `Restored ${activeSessions.length} active Mi session${activeSessions.length === 1 ? "" : "s"}; past dismissed sessions stay hidden`, count: activeSessions.length };
}

async function writeTasks(tasks) {
  await mkdir(dirname(TASKS_PATH), { recursive: true });
  await writeFile(TASKS_PATH, JSON.stringify(tasks, null, 2));
}

function extractPrUrls(text) {
  return [...String(text || "").matchAll(/https:\/\/github\.com\/[^\s)]+\/pull\/\d+/gi)].map((match) => match[0]);
}

function detectNeedsUser(task) {
  const status = String(task.status || "").toLowerCase();
  if (task.needsUser) return { needsUser: true, needsUserReason: task.needsUserReason || "requested" };
  if (status === "error") return { needsUser: true, needsUserReason: task.needsUserReason || "error" };
  return { needsUser: false, needsUserReason: undefined };
}

function enrichTask(task) {
  const prUrls = [...new Set([...(task.prUrls || []), ...extractPrUrls(`${task.text || ""}\n${task.progress || ""}\n${task.error || ""}`)])];
  return { ...task, ...detectNeedsUser(task), prUrls };
}

async function upsertTask(task) {
  const tasks = await readTasks();
  const taskIsPiSession = task?.source === "pi-session" || String(task?.id || "").startsWith("pi-session:");
  const index = tasks.findIndex((entry) => entry.id === task.id || sameLogicalTask(entry, task));
  const previous = index >= 0 ? tasks[index] : undefined;
  const next = enrichTask({ ...task, updatedAt: new Date().toISOString() });
  const merged = index >= 0 ? enrichTask({ ...previous, ...next }) : next;
  if (merged.needsUser && !previous?.notifiedNeedsUserAt) {
    merged.notifiedNeedsUserAt = new Date().toISOString();
    await appendMainThreadMessage(`Task needs ${miUserName()}: ${merged.sessionName || merged.name || merged.id}\n\n${merged.needsUserReason || "Needs attention"}\n\n${merged.error || merged.progress || merged.text || "Open the background task for details."}`).catch(() => undefined);
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

function scheduleStopPi() {
  if (piIdleTimer) clearTimeout(piIdleTimer);
  if (!piProc || piProc.killed || activePrompt || promptQueue.length > 0 || pending.size > 0) return;
  piIdleTimer = setTimeout(() => {
    piIdleTimer = undefined;
    if (!piProc || piProc.killed || activePrompt || promptQueue.length > 0 || pending.size > 0) return;
    log("stopping idle Mi main pi");
    piProc.kill();
  }, MI_MAIN_IDLE_MS);
}

function startPi() {
  if (piIdleTimer) { clearTimeout(piIdleTimer); piIdleTimer = undefined; }
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
    if (activePrompt || promptQueue.length > 0 || pending.size > 0) setTimeout(startPi, 1000);
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

function isNonFinalAssistantText(text) {
  const normalized = String(text || "").trim().toLowerCase();
  return normalized === "queued goal continuation is no longer active.";
}

function lastAssistantText(messages = []) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "assistant") {
      const text = messageText(messages[i]);
      if (text && !isNonFinalAssistantText(text)) return text;
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
      scheduleStopPi();
    } else if (payload.type === "agent_end" && activePrompt) {
      const entry = activePrompt;
      activePrompt = undefined;
      entry.resolve(lastAssistantText(payload.messages) || "Mi completed without text.");
      maybeStartNextPrompt();
      scheduleStopPi();
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
  return [...new Set([
    task.id,
    task.name,
    task.sessionName,
    task.sessionId,
    task.sessionFile,
    task.actualSessionFile,
    sessionFingerprint(task),
    fallbackName,
  ].filter(Boolean).map(String))];
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

function workerInputMessage(message, useGoal = "0") {
  return isSlashCommand(message) ? String(message || "").trim() : wrapWorkerMessage(message, useGoal);
}

function wrapWorkerMessage(message, useGoal = "0") {
  return String(useGoal) === "1" && !message.trim().startsWith("/goal")
    ? `/goal ${message}\n\n${miSummaryInstruction()}`
    : message;
}

function installTaskHeartbeat(worker, task) {
  let progress = "";
  let assistantText = "";
  let lastWrite = 0;
  worker.onEvent((event) => {
    if (worker.expectedStop) return;
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
  } catch (error) {
    if (worker.expectedStop) {
      await log(`worker_expected_stop ${name}`);
      return;
    }
    const errorText = String(error.message || error);
    await upsertTask({ ...task, status: "error", finishedAt: new Date().toISOString(), error: errorText });
    await appendMainThreadMessage(`${kind} failed: ${name}\n\n${errorText}`).catch(() => undefined);
  } finally {
    untrackActiveWorker(task, name);
    worker.proc.kill();
  }
}

function taskIsOpenIssue(task) {
  const status = String(task?.status || "").toLowerCase();
  if (task?.needsUser) return true;
  if (["running", "waiting", "active", "queued", "thinking", "thinkingqueued", "paused", "error"].includes(status)) return true;
  return !task?.finishedAt && !["complete", "completed", "done", "stopped"].includes(status);
}

function existingOpenIssueMessage(task, name) {
  const status = String(task?.status || "open");
  const reason = task?.needsUser ? `; needs ${miUserName()}: ${task.needsUserReason || "attention"}` : "";
  const session = task?.sessionFile ? `\nOpen in /resume: ${task.sessionFile}` : "";
  return `Not starting duplicate task: ${name}. Existing task is ${status}${reason}.${session}`;
}

async function findOpenDuplicateWorkerIssue({ name, cwd, message }) {
  const probe = { name, sessionName: name, cwd, lastInput: message };
  const tasks = await listAllTasks();
  return tasks.find((task) => sameLogicalTask(task, probe) && taskIsOpenIssue(task));
}

async function runWorker(request) {
  const message = String(request.message || "").trim();
  if (!message) throw new Error("Message is empty");
  const name = String(request.name || `Mi worker ${new Date().toISOString()}`).trim();
  const cwd = String(request.cwd || HOME).trim();
  const model = String(request.model || MI_MODEL).trim();
  const sessionDir = request.sessionDir ? String(request.sessionDir).trim() : undefined;
  const startKey = logicalTaskStartKey({ name, cwd, message });
  if (startingWorkerKeys.has(startKey)) {
    await log(`duplicate_worker_start_suppressed ${name}`);
    return { text: `Not starting duplicate task: ${name}. Existing task is already starting.`, sessionName: name };
  }
  startingWorkerKeys.add(startKey);
  let worker;
  let task;
  try {
    const duplicate = await findOpenDuplicateWorkerIssue({ name, cwd, message });
    if (duplicate) {
      const text = existingOpenIssueMessage(duplicate, name);
      await log(`duplicate_worker_suppressed ${name} existing=${duplicate.id || duplicate.sessionName || duplicate.sessionFile || "unknown"}`);
      return { text, taskId: duplicate.id, sessionFile: duplicate.sessionFile, sessionId: duplicate.sessionId, sessionName: duplicate.sessionName || duplicate.name || name };
    }
    log(`starting worker ${name} cwd=${cwd} model=${model}`);
    worker = createRpcProcess({ cwd, model, sessionDir, env: { MI_WORKER: "1" } });
    const taskId = `task_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    task = request.background
      ? await upsertTask({
        id: taskId,
        name,
        cwd,
        status: "running",
        progress: "starting worker",
        startedAt: new Date().toISOString(),
        sessionName: name,
        model,
        lastInput: message,
      })
      : undefined;
    if (task) trackActiveWorker(task, name, worker);
    await worker.rpc({ type: "set_session_name", name });
    const before = await worker.rpc({ type: "get_state" });
    const visibleSessionFile = await mirrorSessionToHome(before.sessionFile);
    task = await upsertTask({
      ...(task || {}),
      id: task?.id || taskId,
      name,
      cwd,
      status: request.background ? "running" : "waiting",
      progress: request.background ? (task?.progress || "starting worker") : undefined,
      startedAt: task?.startedAt || new Date().toISOString(),
      sessionFile: visibleSessionFile,
      actualSessionFile: before.sessionFile,
      sessionId: before.sessionId,
      sessionName: before.sessionName || name,
      model: before.model,
      lastInput: message,
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
  } catch (error) {
    if (request.background && task) {
      if (worker?.expectedStop) {
        await log(`worker_expected_stop ${name}`);
      } else {
        await upsertTask({ ...task, status: "error", finishedAt: new Date().toISOString(), error: String(error.message || error) });
      }
      untrackActiveWorker(task, name);
    }
    if (worker?.expectedStop) return { text: `Stopped ${name}; moved to needs input`, taskId: task?.id, sessionFile: task?.sessionFile, sessionId: task?.sessionId, sessionName: name };
    throw error;
  } finally {
    startingWorkerKeys.delete(startKey);
    if (!request.background) worker?.proc.kill();
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
  const activeWorker = workerKeys(task, name).map((key) => activeWorkers.get(key)).find(Boolean) || activeWorkers.get(taskId);
  if (activeWorker && !activeWorker.proc.killed) {
    await upsertTask({ ...task, status: "running", needsUser: false, needsUserReason: undefined, finishedAt: undefined, text: undefined, error: undefined, continuedAt: new Date().toISOString(), progress: "follow-up queued", lastInput: message });
    void activeWorker.rpc({ type: "prompt", message: workerInputMessage(message, request.useGoal), streamingBehavior: isSlashCommand(message) ? undefined : "steer" })
      .catch((error) => {
        if (activeWorker.expectedStop) return log(`worker_expected_stop ${name}`);
        return upsertTask({ ...task, status: "error", finishedAt: new Date().toISOString(), error: String(error.message || error), lastInput: message });
      });
    await appendMainThreadMessage(`Task updated: ${name}\n\nStatus: running\nFollow-up queued.`, "mi-task-status").catch(() => undefined);
    return { text: `Queued message for background task: ${name}`, taskId: task.id, sessionFile: task.sessionFile, sessionId: task.sessionId, sessionName: name };
  }
  const sessionFile = task.actualSessionFile || task.sessionFile;
  if (!sessionFile) throw new Error(`Task has no session file: ${taskId}`);
  const cwd = task.cwd || HOME;
  const model = String(request.model || MI_MODEL).trim();
  const worker = createRpcProcess({ cwd, sessionFile, model, env: { MI_WORKER: "1" } });
  const updated = await upsertTask({ ...task, status: "running", needsUser: false, needsUserReason: undefined, finishedAt: undefined, text: undefined, error: undefined, continuedAt: new Date().toISOString(), progress: "follow-up queued", lastInput: message });
  if (request.background) {
    trackActiveWorker(updated, name, worker);
    void (async () => {
      const before = await worker.rpc({ type: "get_state" });
      installTaskHeartbeat(worker, updated);
      const done = worker.waitAgentEnd();
      await worker.rpc({ type: "prompt", message: workerInputMessage(message, request.useGoal) });
      await appendMainThreadMessage(`Task updated: ${name}\n\nStatus: running\nOpen in /resume: ${task.sessionFile || sessionFile || "unknown"}`, "mi-task-status").catch(() => undefined);
      void finishTask({ task: updated, worker, before, sessionFile, name, done, kind: "Task updated" });
    })().catch(async (error) => {
      if (worker.expectedStop) {
        await log(`worker_expected_stop ${name}`);
        return;
      }
      await upsertTask({ ...updated, status: "error", finishedAt: new Date().toISOString(), error: String(error.message || error), lastInput: message });
      untrackActiveWorker(updated, name);
      worker.proc.kill();
    });
    return { text: `Sent follow-up to background task: ${name}`, taskId: task.id, sessionFile: task.sessionFile, sessionId: task.sessionId, sessionName: name };
  }
  try {
    const before = await worker.rpc({ type: "get_state" });
    installTaskHeartbeat(worker, updated);
    const done = worker.waitAgentEnd();
    await worker.rpc({ type: "prompt", message: workerInputMessage(message, request.useGoal) });
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
  if (request.type === "list_pi_sessions") {
    socket.end(JSON.stringify({ ok: true, sessions: await listPiSessionsForResume() }) + "\n");
    return;
  }

  if (request.type === "resume_session") {
    const result = await resumePiSession(request);
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

if (!(await acquireDaemonLock())) process.exit(0);
if (existsSync(SOCKET_PATH)) await rm(SOCKET_PATH, { force: true });
await mkdir(SESSION_DIR, { recursive: true });
// Keep the daemon lightweight: Mi main pi starts lazily on prompt/state/model requests.

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
  await rm(LOCK_PATH, { force: true }).catch(() => undefined);
  await daemonLockHandle?.close().catch(() => undefined);
  process.exit(0);
});
