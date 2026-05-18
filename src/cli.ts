#!/usr/bin/env node
import 'dotenv/config';
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import { createInterface } from 'node:readline/promises';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { stdin as input, stdout as output } from 'node:process';
import { draftAssistant, proposeAssistantEdit } from './builder.js';
import { assistantPath } from './assistant.js';
import { checkAssistant, runAssistant } from './runner.js';
import { readRunRecords } from './primitives.js';
import { runFlueChat } from './flue.js';
import { readRecentEvents, logEvent } from './state.js';
import { createUploadLink } from './uploads.js';
import {
  appendThreadMessage,
  compactThread,
  createTempThread,
  getThread,
  listThreads,
  markThreadRead,
  readThreadMessages,
  threadContext,
} from './threads.js';

function usage() {
  return `Mi - tiny private assistant harness

Usage:
  mi                              Open the full-screen Mi terminal UI
  mi pi                           Open Mi main in pi
  mi raw                          Open the minimal fallback conversation
  mi --once <message>             Send one message to main and exit
  mi chat [thread]                Open main or an existing temporary conversation
  mi ask [--thread <id>] <message> Send one message to a Mi thread and exit
  mi inbox                        Show Mi main + temporary conversations
  mi threads                      List Mi conversations
  mi temp <title>                 Create/open a temporary conversation
  mi compact [thread]             Compact old read messages in a thread
  mi upload                       Create a temporary one-time image upload link
  mi detect-approval [next|approve <id>|reject <id>]  Review pending detect trends
  mi agents                       Open live background agent view
  mi task <name> [--cwd <path>] -- <task prompt>
  mi task reply <task-id-or-name> -- <follow-up prompt>
  mi task list                    List background agent tasks

  mi make <description> [--name <name>]
  mi run <assistant>
  mi edit <assistant> <change>
  mi check <assistant>
  mi logs <assistant> [limit]
`;
}

function argValue(args: string[], flag: string) {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  return args[index + 1];
}

function argsWithoutFlag(args: string[], flag: string) {
  const index = args.indexOf(flag);
  if (index === -1) return args;
  return args.filter((_, i) => i !== index && i !== index + 1);
}

async function writeAssistantFile(path: string, markdown: string) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, markdown);
}

async function makeCommand(args: string[]) {
  const name = argValue(args, '--name');
  const description = args.filter((arg, i) => arg !== '--name' && args[i - 1] !== '--name').join(' ').trim();
  if (!description) throw new Error('description required');
  const draft = draftAssistant({ description, name });
  await writeAssistantFile(draft.path, draft.markdown);
  await logEvent('mi.make', { name: draft.name, path: draft.path });
  console.log(`Created ${draft.path}`);
}

async function runCommand(args: string[]) {
  const name = args[0];
  if (!name) throw new Error('assistant name required');
  const result = await runAssistant({ name, trigger: 'manual' });
  await logEvent('mi.run', result);
  console.log(`${name}: ${result.status}`);
  console.log(result.summary);
  if (result.status === 'error') process.exitCode = 1;
}

async function editCommand(args: string[]) {
  const name = args[0];
  const change = args.slice(1).join(' ').trim();
  if (!name) throw new Error('assistant name required');
  if (!change) throw new Error('change required');
  const path = assistantPath(name);
  const currentMarkdown = await readFile(path, 'utf8');
  const draft = proposeAssistantEdit({ name, change, currentMarkdown });
  await writeAssistantFile(draft.path, draft.markdown);
  await logEvent('mi.edit', { name, path: draft.path, change });
  console.log(`Updated ${draft.path}`);
}

async function checkCommand(args: string[]) {
  const name = args[0];
  if (!name) throw new Error('assistant name required');
  const result = await checkAssistant(name);
  console.log(`${result.path}: ${result.ok ? 'ok' : 'needs work'}`);
  for (const issue of result.issues) console.log(`- ${issue}`);
  if (!result.ok) process.exitCode = 1;
}

async function logsCommand(args: string[]) {
  const name = args[0];
  if (!name) throw new Error('assistant name required');
  const limit = Number(args[1] || 20);
  const runs = await readRunRecords(Number.isFinite(limit) ? limit : 20);
  const matchingRuns = runs.filter((run) => run.assistant === name || JSON.stringify(run).includes(name));
  for (const run of matchingRuns) console.log(JSON.stringify(run));

  const events = await readRecentEvents(Number.isFinite(limit) ? limit : 20);
  const matchingEvents = events.filter((event: any) => JSON.stringify(event).includes(name));
  for (const event of matchingEvents) console.log(JSON.stringify(event));
}

function renderThreadLine(thread: { id: string; title: string; kind: string; unread: number; updatedAt: string }) {
  const unread = thread.unread > 0 ? `  ${thread.unread} unread` : '';
  const label = thread.kind === 'main' ? 'main' : `temp: ${thread.title}`;
  return `${label.padEnd(32)} ${thread.updatedAt}${unread}`;
}

async function inboxCommand() {
  const threads = await listThreads();
  console.log('Mi');
  for (const thread of threads) console.log(`  ${renderThreadLine(thread)}`);
}

async function showThread(threadId: string) {
  const thread = await getThread(threadId);
  if (!thread) throw new Error(`thread not found: ${threadId}`);
  const messages = await readThreadMessages(threadId, 30);
  const unread = messages.filter((message) => message.unread);

  console.log(`Mi / ${thread.title}`);
  if (unread.length > 0) {
    console.log(`\nUnread:`);
    for (const message of unread) console.log(`${message.role}> ${message.text}`);
  } else if (messages.length > 0) {
    console.log('\nRecent:');
    for (const message of messages.slice(-8)) console.log(`${message.role}> ${message.text}`);
  } else {
    console.log('\nNo messages yet.');
  }
  await markThreadRead(threadId);
}

async function askMi(threadId: string, message: string) {
  const thread = await getThread(threadId);
  if (!thread) throw new Error(`thread not found: ${threadId}`);
  await appendThreadMessage(threadId, 'user', message, { unread: false, source: 'cli' });
  await logEvent('mi.thread.user', { threadId, message });

  const context = await threadContext(threadId);
  const prompt = `You are Mi, Kyle's private persistent assistant. Reply as Mi in the current conversation. Be concise. Do not claim to have inspected files or services unless context explicitly says so. Risky actions require approval.\n\nThread: ${thread.title}\n\n${context}\n\nCurrent user message:\n${message}`;
  const result = await runFlueChat(prompt);
  const reply = result.reply || 'Got it.';
  await appendThreadMessage(threadId, 'assistant', reply, { unread: false, source: result.source });
  await logEvent('mi.thread.assistant', { threadId, source: result.source, ok: result.ok });
  return reply;
}

async function askCommand(args: string[]) {
  const threadId = argValue(args, '--thread') || 'main';
  const message = argsWithoutFlag(args, '--thread').join(' ').trim();
  if (!message) throw new Error('message required');
  console.log(await askMi(threadId, message));
}

async function onceCommand(args: string[]) {
  const message = args.join(' ').trim();
  if (!message) throw new Error('message required');
  console.log(await askMi('main', message));
}

async function tempCommand(args: string[]) {
  const title = args.join(' ').trim();
  if (!title) {
    const temps = (await listThreads()).filter((thread) => thread.kind === 'temporary');
    if (temps.length === 0) console.log('No temporary conversations.');
    else for (const thread of temps) console.log(renderThreadLine(thread));
    return;
  }
  const thread = await createTempThread(title);
  await chatCommand(thread.id);
}

async function uploadCommand() {
  const link = await createUploadLink();
  console.log(`Upload image: ${link.url}`);
  console.log(`Expires: ${link.expiresAt}`);
  console.log(`Max bytes: ${link.maxBytes}`);
}

type DetectApprovalItem = {
  id: number;
  trend: string;
  score: number;
  sources: number;
  detected_at?: string;
  route_reason?: string;
  verification?: unknown;
};

const DETECT_PIPELINE_CWD = process.env.DETECT_PIPELINE_CWD || join(homedir(), 'code', 'tacticsjournal', 'research', 'pipeline');

function runDetectApprovalPython(code: string, args: string[] = []) {
  const res = spawnSync('python3', ['-c', code, ...args], { cwd: DETECT_PIPELINE_CWD, encoding: 'utf8' });
  if (res.status !== 0) throw new Error((res.stderr || res.stdout || 'detect approval command failed').slice(-1000));
  return res.stdout || '';
}

function formatDetectApprovalItem(item: DetectApprovalItem) {
  return [
    `Detect trend #${item.id}: ${item.trend}`,
    `Score: ${item.score} | sources: ${item.sources}${item.detected_at ? ` | detected: ${item.detected_at}` : ''}`,
    item.route_reason ? `Route reason: ${item.route_reason}` : '',
    `Decide: mi detect-approval approve ${item.id}  OR  mi detect-approval reject ${item.id}`,
  ].filter(Boolean).join('\n');
}

async function detectApprovalCommand(args: string[]) {
  const action = args[0] || 'next';
  if (action === 'next' || action === 'list') {
    const py = String.raw`
import json
import psycopg
from db_conn import resolve_database_conninfo
from detect_policy import load_policy as load_detect_policy, passes_report_gate
conninfo, reason = resolve_database_conninfo()
if not conninfo:
    raise SystemExit(f"missing database connection: {reason}")
policy = load_detect_policy()
min_score = int(policy["report_min_score"])
min_sources = int(policy["report_min_sources"])
with psycopg.connect(conninfo) as conn, conn.cursor() as cur:
    cur.execute("""
        SELECT id, trend, COALESCE(final_score, score, 0), COALESCE(source_diversity, 0), detected_at, detect_route_reason, detect_verification
        FROM trend_candidates
        WHERE status = 'pending' AND COALESCE(report_decision, 'pending') = 'pending'
        ORDER BY COALESCE(final_score, score, 0) DESC, detected_at DESC, id DESC
        LIMIT 25
    """)
    rows = cur.fetchall() or []
items = []
for id_, trend, score, sources, detected_at, route_reason, verification in rows:
    if passes_report_gate(final_score=int(score or 0), source_diversity=int(sources or 0), min_score=min_score, min_sources=min_sources, policy=policy):
        items.append({"id": id_, "trend": trend, "score": int(score or 0), "sources": int(sources or 0), "detected_at": detected_at.isoformat() if detected_at else None, "route_reason": route_reason, "verification": verification})
print(json.dumps(items[:10], default=str))
`;
    const items = JSON.parse(runDetectApprovalPython(py)) as DetectApprovalItem[];
    if (items.length === 0) {
      console.log('No pending detect trends passing the report gate.');
      return;
    }
    const shown = action === 'next' ? items.slice(0, 1) : items;
    for (const item of shown) console.log(formatDetectApprovalItem(item));
    if (action === 'next' && items.length > 1) console.log(`\n${items.length - 1} more pending. Run again after approve/reject.`);
    return;
  }

  if (action === 'approve' || action === 'reject') {
    const id = Number(args[1]);
    if (!Number.isInteger(id) || id <= 0) throw new Error(`usage: mi detect-approval ${action} <candidate-id>`);
    const decision = action === 'approve' ? 'approved' : 'rejected';
    const py = String.raw`
import json, sys
import psycopg
from db_conn import resolve_database_conninfo
candidate_id = int(sys.argv[1])
decision = sys.argv[2]
conninfo, reason = resolve_database_conninfo()
if not conninfo:
    raise SystemExit(f"missing database connection: {reason}")
with psycopg.connect(conninfo) as conn, conn.cursor() as cur:
    cur.execute("""
        UPDATE trend_candidates
        SET report_decision = %s, report_decided_at = NOW(), report_decision_source = 'mi_detect_approval_command'
        WHERE id = %s AND status = 'pending' AND COALESCE(report_decision, 'pending') = 'pending'
        RETURNING id, trend, COALESCE(final_score, score, 0), COALESCE(source_diversity, 0)
    """, (decision, candidate_id))
    row = cur.fetchone()
    if not row:
        raise SystemExit("candidate not found or already decided")
    conn.commit()
print(json.dumps({"id": row[0], "trend": row[1], "score": int(row[2] or 0), "sources": int(row[3] or 0), "decision": decision}))
`;
    const result = JSON.parse(runDetectApprovalPython(py, [String(id), decision]));
    await appendThreadMessage('main', 'assistant', `Detect trend ${result.decision}: #${result.id} ${result.trend}`, { unread: false, source: 'detect-approval-command' });
    console.log(`${result.decision}: #${result.id} ${result.trend}`);
    return;
  }

  throw new Error('usage: mi detect-approval [next|list|approve <candidate-id>|reject <candidate-id>]');
}

function taskName(task: MiTask) {
  return (task.name || task.sessionName || task.id || 'task').replace(/^Mi task:\s*/i, '').trim() || 'task';
}

function taskNameFromPrompt(prompt: string) {
  return prompt
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || `task-${Date.now().toString(36)}`;
}

function taskStatus(task: MiTask) {
  if (task.finishedAt && !task.status) return 'complete';
  return task.status || 'unknown';
}

function isTaskNeedsInput(task: MiTask) {
  const status = taskStatus(task).toLowerCase();
  return !task.finishedAt && (task.needsKyle || ['waiting', 'paused'].includes(status));
}

function isTaskActive(task: MiTask) {
  const status = taskStatus(task).toLowerCase();
  return !task.finishedAt && ['running', 'waiting', 'active', 'queued', 'thinkingqueued'].includes(status);
}

function isTaskWorking(task: MiTask) {
  const status = taskStatus(task).toLowerCase();
  return !task.finishedAt && ['running', 'queued', 'thinking', 'thinkingqueued'].includes(status);
}

function taskSection(task: MiTask): 'needs input' | 'working' | 'completed' {
  if (isTaskNeedsInput(task)) return 'needs input';
  if (isTaskActive(task)) return 'working';
  return 'completed';
}

function taskSectionRank(task: MiTask) {
  const section = taskSection(task);
  return section === 'needs input' ? 0 : section === 'working' ? 1 : 2;
}

function taskActivitySymbol(task: MiTask, animated = true) {
  if (!isTaskActive(task)) return '○';
  if (!animated || !isTaskWorking(task)) return '●';
  return PI_SPINNER_FRAMES[Math.floor(Date.now() / 80) % PI_SPINNER_FRAMES.length];
}

function taskUpdatedMs(task: MiTask) {
  return Date.parse(task.updatedAt || task.lastEventAt || task.finishedAt || task.continuedAt || task.startedAt || '') || 0;
}

function taskSortRank(task: MiTask) {
  return 0;
}

function taskStartedMs(task: MiTask) {
  return Date.parse(task.startedAt || task.continuedAt || task.updatedAt || '') || 0;
}

function compactDuration(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function taskAge(task: MiTask) {
  const started = taskStartedMs(task);
  if (!started) return '';
  const end = Date.parse(task.finishedAt || '') || Date.now();
  return compactDuration(end - started);
}

function extractPrUrlsFromTask(task: MiTask) {
  const found = [...(task.prUrls || []), ...[task.text, task.progress, task.error].flatMap((value) => [...String(value || '').matchAll(/https:\/\/github\.com\/[^\s)]+\/pull\/(\d+)/gi)].map((match) => match[0]))];
  return [...new Set(found)];
}

function prColumn(task: MiTask) {
  const urls = extractPrUrlsFromTask(task);
  if (urls.length === 0) return ''.padEnd(8);
  const first = urls[0].match(/\/pull\/(\d+)/i)?.[1] || 'PR';
  return (`PR#${first}${urls.length > 1 ? `+${urls.length - 1}` : ''}`).padEnd(8).slice(0, 8);
}

function needsKyleColumn(task: MiTask) {
  if (task.needsKyle) return 'NEEDS'.padEnd(7);
  if (taskStatus(task) === 'error') return 'ERROR'.padEnd(7);
  return ''.padEnd(7);
}

function taskRepo(task: MiTask) {
  const cwd = task.cwd || '';
  if (!cwd) return '';
  const parts = cwd.split('/').filter(Boolean);
  return parts.at(-1) || cwd;
}

function taskDetail(task: MiTask) {
  const detail = task.error || (isTaskActive(task) ? (task.progress || task.text) : (task.text || task.progress)) || task.sessionName || '';
  return detail.replace(/\s+/g, ' ');
}

function shortTaskDetail(task: MiTask, width: number) {
  const detail = taskDetail(task);
  return truncateText(detail, Math.max(0, width));
}

function formatTaskRow(task: MiTask, width = 120) {
  const age = taskAge(task);
  const name = truncateText(taskName(task), Math.min(28, Math.max(10, Math.floor(width * 0.35))));
  const gapBeforeAge = 2;
  const detailBudget = Math.min(48, Math.max(0, width - name.length - age.length - gapBeforeAge - 3));
  const detail = shortTaskDetail(task, detailBudget);
  const left = `${name}${detail ? `   ${detail}` : ''}`;
  const gap = Math.max(gapBeforeAge, width - widthOf(left) - age.length);
  return truncateText(`${left}${' '.repeat(gap)}${age}`, width);
}

function stableTaskKey(task: MiTask) {
  return task.id || task.sessionFile || task.sessionName || task.name || '';
}

async function stopTaskInList(task: MiTask) {
  const taskId = task.id || task.sessionFile || task.sessionName || task.name;
  if (!taskId) return;
  await sendTaskSocketRequest({
    type: 'stop_task',
    taskId,
    id: task.id,
    sessionFile: task.sessionFile,
    sessionId: task.sessionId,
    sessionName: task.sessionName,
    name: task.name,
  }, 10000);
}

async function dismissTaskFromList(task: MiTask) {
  const taskId = task.id || task.sessionFile || task.sessionName || task.name;
  if (!taskId) return;
  await sendTaskSocketRequest({
    type: 'dismiss_task',
    taskId,
    id: task.id,
    sessionFile: task.sessionFile,
    sessionId: task.sessionId,
    sessionName: task.sessionName,
    name: task.name,
  }, 10000);
}

async function listTasks() {
  const result = await sendTaskSocketRequest({ type: 'list_tasks' }, 10000);
  return (result.tasks || []).sort((a, b) => taskStartedMs(b) - taskStartedMs(a) || taskUpdatedMs(b) - taskUpdatedMs(a));
}

async function taskCommand(args: string[]) {
  const name = args[0];
  if (name === 'list') {
    const tasks = await listTasks();
    if (tasks.length === 0) {
      console.log('No Mi background agents.');
      return;
    }
    for (const task of tasks) console.log(formatTaskRow(task));
    return;
  }
  if (name === 'reply') {
    const taskId = args[1];
    const sep = args.indexOf('--');
    const message = sep >= 0 ? args.slice(sep + 1).join(' ').trim() : args.slice(2).join(' ').trim();
    if (!taskId || !message) throw new Error('usage: mi task reply <task-id-or-name> -- <follow-up prompt>');
    const result = await sendTaskSocketRequest({ type: 'continue_worker', taskId, message, background: true }, 30000);
    console.log(result.text || 'Sent follow-up.');
    if (result.taskId) console.log(`Task: ${result.taskId}`);
    if (result.sessionFile) console.log(`Visible in /resume: ${result.sessionFile}`);
    return;
  }
  const cwd = argValue(args, '--cwd') || HOME;
  const sep = args.indexOf('--');
  const message = sep >= 0 ? args.slice(sep + 1).join(' ').trim() : args.slice(1).join(' ').trim();
  if (!name || !message) throw new Error('usage: mi task <name>|list [--cwd <path>] -- <task prompt>');
  const result = await sendTaskSocketRequest({ type: 'run_worker', name, cwd, message, background: true }, 30000);
  console.log(result.text || 'Started background task.');
  if (result.taskId) console.log(`Task: ${result.taskId}`);
  if (result.sessionFile) console.log(`Visible in /resume: ${result.sessionFile}`);
}

async function agentsCommand() {
  let tasks: MiTask[] = [];
  let optimisticTasks: MiTask[] = [];
  let selected = 0;
  let closed = false;
  const defaultAgentStatus = 'm multi-select • Esc clear task';
  let status = defaultAgentStatus;
  let inputMode: 'normal' | 'new-name' | 'new-prompt' | 'reply' = 'normal';
  let inputBuffer = '';
  let pendingName = '';
  let replyTarget: MiTask | undefined;
  let btwAnswer = '';
  let agentSubmitting = false;
  let multiSelectMode = false;
  const selectedTaskKeys = new Set<string>();
  let pasteBuffer = '';
  let pasteMode = false;
  let slashSelected = 0;
  const slashCommands = ['/settings', '/model', '/scoped-models', '/export', '/import', '/share', '/copy', '/name', '/session', '/changelog', '/hotkeys', '/fork', '/clone', '/tree', '/login', '/logout', '/new', '/compact', '/resume', '/reload', '/quit', '/mi', '/upload'];
  const slashCommandDescriptions: Record<string, string> = {
    '/settings': 'Open settings menu',
    '/model': 'Select model (opens selector UI)',
    '/scoped-models': 'Enable/disable models for Ctrl+P cycling',
    '/export': 'Export session (HTML default, or specify path: .html/.jsonl)',
    '/import': 'Import and resume a session from a JSONL file',
    '/share': 'Share session as a secret GitHub gist',
    '/copy': 'Copy last agent message to clipboard',
    '/name': 'Set session display name',
    '/session': 'Show session info and stats',
    '/changelog': 'Show changelog entries',
    '/hotkeys': 'Show all keyboard shortcuts',
    '/fork': 'Create a new fork from a previous user message',
    '/clone': 'Duplicate the current session at the current position',
    '/tree': 'Navigate session tree (switch branches)',
    '/login': 'Configure provider authentication',
    '/logout': 'Remove provider authentication',
    '/new': 'Start a new session',
    '/compact': 'Manually compact the session context',
    '/resume': 'Resume a different session',
    '/reload': 'Reload keybindings, extensions, skills, prompts, and themes',
    '/quit': 'Quit pi',
    '/mi': 'Ask Mi about the selected task',
    '/upload': 'Create an image upload link',
  };
  let renderTimer: NodeJS.Timeout | undefined;
  let pollTimer: NodeJS.Timeout | undefined;
  let animationTimer: NodeJS.Timeout | undefined;
  let piCycleConfig = await loadPiCycleConfig();
  const piCycleNextIndex: Record<string, number> = { '1': 0, '2': 0, '3': 0 };
  let agentModelSpec = MI_MODEL;
  let agentThinkingLevel: ThinkingLevel | undefined = String(MI_MODEL).match(/:(off|minimal|low|medium|high|xhigh)$/)?.[1] as ThinkingLevel | undefined;
  const dismissedTaskKeys = new Set<string>();

  const rows = () => process.stdout.rows || 24;
  const cols = () => process.stdout.columns || 100;

  async function refresh() {
    try {
      const selectedKey = selectedTask() ? stableTaskKey(selectedTask()!) : '';
      const listedTasks = (await listTasks()).filter((task) => !dismissedTaskKeys.has(stableTaskKey(task)));
      optimisticTasks = optimisticTasks.filter((optimistic) => !listedTasks.some((task) => taskName(task) === taskName(optimistic)));
      tasks = [...optimisticTasks, ...listedTasks];
      if (selectedKey) selected = tasks.findIndex((task) => stableTaskKey(task) === selectedKey);
      if (selected >= tasks.length) selected = tasks.length - 1;
      status = inputMode === 'normal' && !agentSubmitting ? (multiSelectMode ? multiSelectStatus() : defaultAgentStatus) : status;
    } catch (error) {
      status = error instanceof Error ? error.message : String(error);
    }
    requestRender();
  }

  function requestRender() {
    if (renderTimer) return;
    renderTimer = setTimeout(() => {
      renderTimer = undefined;
      render();
    }, 16);
  }

  function selectedTask() {
    return selected >= 0 ? tasks[selected] : undefined;
  }

  function agentModelBase(modelSpec = agentModelSpec) {
    return modelSpec.replace(/:(off|minimal|low|medium|high|xhigh)$/i, '');
  }

  function agentModelWithThinking(modelSpec = agentModelSpec, level = agentThinkingLevel) {
    const base = agentModelBase(modelSpec);
    return level ? `${base}:${level}` : modelSpec;
  }

  function inputLabel() {
    return inputMode === 'new-name' ? 'new name' : inputMode === 'new-prompt' ? `prompt for ${pendingName}` : `reply to ${taskName(replyTarget || selectedTask() || {})}`;
  }

  function agentInputVisibleLines(width: number, maxLines: number) {
    const wrapped = wrapPlain(inputBuffer, Math.max(1, width));
    return (wrapped.length > 0 ? wrapped : ['']).slice(-Math.max(1, maxLines));
  }

  function agentInputCursorColumn(inputLines: string[], width: number) {
    const lastLine = inputLines[inputLines.length - 1] || '';
    return Math.min(width, widthOf(lastLine) + 1);
  }

  function slashFuzzyScore(query: string, text: string) {
    const q = query.toLowerCase();
    const t = text.toLowerCase();
    if (!q) return 0;
    let qi = 0;
    let score = 0;
    let last = -1;
    let consecutive = 0;
    for (let i = 0; i < t.length && qi < q.length; i++) {
      if (t[i] !== q[qi]) continue;
      const boundary = i === 0 || /[\s\-_./:]/.test(t[i - 1] || '');
      if (last === i - 1) { consecutive++; score -= consecutive * 5; }
      else { consecutive = 0; if (last >= 0) score += (i - last - 1) * 2; }
      if (boundary) score -= 10;
      score += i * 0.1;
      last = i;
      qi++;
    }
    if (qi < q.length) return undefined;
    if (q === t) score -= 100;
    return score;
  }

  function slashCommandMatches() {
    if (!inputBuffer.startsWith('/')) return [];
    const token = inputBuffer.split(/\s+/, 1)[0].slice(1);
    return slashCommands
      .map((command, index) => ({ command, index, score: slashFuzzyScore(token, command.slice(1)) }))
      .filter((item): item is { command: string; index: number; score: number } => item.score !== undefined)
      .sort((a, b) => a.score - b.score || a.index - b.index)
      .map((item) => item.command);
  }

  function slashCommandSuggestionLines(width: number) {
    const matches = slashCommandMatches();
    slashSelected = Math.max(0, Math.min(slashSelected, Math.max(0, matches.length - 1)));
    const maxVisible = 5;
    const start = Math.max(0, Math.min(slashSelected - Math.floor(maxVisible / 2), Math.max(0, matches.length - maxVisible)));
    const visible = matches.slice(start, start + maxVisible);
    const primaryWidth = Math.max(1, Math.min(32, Math.max(...matches.map((command) => command.length - 1 + 2), 1)));
    const lines = visible.map((command, offset) => {
      const index = start + offset;
      const selectedSuggestion = index === slashSelected;
      const label = command.slice(1);
      const description = slashCommandDescriptions[command] || 'Forward to selected pi session';
      const prefix = selectedSuggestion ? '→ ' : '  ';
      const truncatedLabel = truncateText(label, Math.max(1, primaryWidth - 2));
      const spacing = ' '.repeat(Math.max(1, primaryWidth - widthOf(truncatedLabel)));
      const line = truncateText(`${prefix}${truncatedLabel}${spacing}${description}`, width);
      return selectedSuggestion ? fgAccent(line) : `${prefix}${truncatedLabel}${fgDim(spacing + truncateText(description, Math.max(0, width - widthOf(prefix + truncatedLabel + spacing))))}`;
    });
    if (start > 0 || start + visible.length < matches.length) lines.push(fgDim(truncateText(`  (${slashSelected + 1}/${matches.length})`, Math.max(0, width - 2))));
    return lines;
  }

  function moveSlashSelection(delta: number) {
    const matches = slashCommandMatches();
    if (matches.length === 0) return false;
    slashSelected = (slashSelected + delta + matches.length) % matches.length;
    requestRender();
    return true;
  }

  function autocompleteSlashCommand() {
    const matches = slashCommandMatches();
    if (matches.length === 0) return false;
    const token = inputBuffer.split(/\s+/, 1)[0];
    const command = matches[Math.max(0, Math.min(slashSelected, matches.length - 1))] || matches[0];
    inputBuffer = `${command}${inputBuffer.slice(token.length)}${inputBuffer === token ? ' ' : ''}`;
    slashSelected = 0;
    requestRender();
    return true;
  }

  function piCycleThinkingLevel(tier: string, modelSpec: string): ThinkingLevel | undefined {
    return piCycleConfig.thinkingLevels?.[`${tier}:${modelSpec}`] || piCycleConfig.thinkingLevels?.[modelSpec];
  }

  async function applyAgentPiCycle(text: string): Promise<{ body: string; model: string }> {
    piCycleConfig = await loadPiCycleConfig();
    const shortcut = piCycleConfig.shortcut || 'z';
    const escaped = shortcut.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = text.match(new RegExp(`^((?:${escaped}){1,3})(?:\\s+([\\s\\S]*)|$)`));
    if (!match || match[1].length % shortcut.length !== 0) return { body: text, model: agentModelWithThinking() };
    const tier = String(match[1].length / shortcut.length);
    const models = piCycleConfig.tiers[tier] || [];
    if (models.length === 0) throw new Error(`pi-cycle tier ${tier} has no models`);
    const index = piCycleNextIndex[tier] % models.length;
    const modelSpec = models[index];
    piCycleNextIndex[tier] = (index + 1) % models.length;
    agentThinkingLevel = piCycleThinkingLevel(tier, modelSpec) || agentThinkingLevel;
    agentModelSpec = agentModelWithThinking(modelSpec, agentThinkingLevel);
    requestRender();
    return { body: (match[2] || '').trim(), model: agentModelSpec };
  }

  function clearAgentInputModeIfEmpty() {
    if (inputMode === 'reply' && inputBuffer.length === 0) {
      inputMode = 'normal';
      replyTarget = undefined;
      status = defaultAgentStatus;
      return true;
    }
    return false;
  }

  function multiSelectStatus() {
    return `${selectedTaskKeys.size} selected • Enter toggle • Esc clear selected • m exit multi-select`;
  }

  function toggleSelectedTaskForBulkClear() {
    const task = selectedTask();
    const key = task ? stableTaskKey(task) : '';
    if (!key) return;
    if (selectedTaskKeys.has(key)) selectedTaskKeys.delete(key);
    else selectedTaskKeys.add(key);
    status = multiSelectStatus();
    requestRender();
  }

  function clearSelectedTasksFromList() {
    const selectedKeys = new Set(selectedTaskKeys);
    const toDismiss = tasks.filter((task) => selectedKeys.has(stableTaskKey(task)));
    for (const task of toDismiss) void dismissTaskFromList(task).catch((error) => { status = error instanceof Error ? error.message : String(error); requestRender(); });
    for (const key of selectedKeys) dismissedTaskKeys.add(key);
    tasks = tasks.filter((task) => !selectedKeys.has(stableTaskKey(task)));
    optimisticTasks = optimisticTasks.filter((task) => !selectedKeys.has(stableTaskKey(task)));
    selectedTaskKeys.clear();
    multiSelectMode = false;
    selected = Math.min(selected, Math.max(0, tasks.length - 1));
    status = `Removed ${toDismiss.length} task${toDismiss.length === 1 ? '' : 's'} from list`;
    requestRender();
  }

  function cycleAgentThinking() {
    const current = agentThinkingLevel === 'high' || agentThinkingLevel === 'medium' || agentThinkingLevel === 'low' ? agentThinkingLevel : 'low';
    agentThinkingLevel = current === 'low' ? 'medium' : current === 'medium' ? 'high' : 'low';
    agentModelSpec = agentModelWithThinking(agentModelSpec, agentThinkingLevel);
    requestRender();
  }

  async function runAgentSlashCommand(value: string) {
    if (!value.startsWith('/')) return false;
    if (value === '/quit') { close(); return true; }
    if (value.startsWith('/mi')) {
      const question = value.slice('/mi'.length).trim();
      const task = selectedTask();
      if (!question) { status = 'Usage: /mi <question about selected task>'; requestRender(); return true; }
      if (!task) { status = 'Select a task before using /mi'; requestRender(); return true; }
      status = 'Asking Mi about selected task...';
      requestRender();
      void (async () => {
        const taskContext = [
          `Task: ${taskName(task)}`,
          `Status: ${taskStatus(task)}`,
          task.cwd ? `cwd: ${task.cwd}` : '',
          task.sessionFile ? `session: ${task.sessionFile}` : '',
          task.needsKyle ? `needs Kyle: ${task.needsKyleReason || 'attention'}` : '',
          task.progress ? `progress: ${task.progress}` : '',
          task.text ? `latest result: ${task.text.slice(0, 1200)}` : '',
          task.error ? `error: ${task.error}` : '',
        ].filter(Boolean).join('\n');
        const reply = normalizeMiResponse(await sendToMiMain([
          "You are Mi, Kyle's private persistent assistant. Answer only about the selected background task below. If the question is unrelated, say you can only answer about the selected task here.",
          `Selected task context:\n${taskContext}`,
          `Kyle's question about this task:\n${question}`,
        ].join('\n\n')));
        btwAnswer = reply;
        status = 'mi answer';
        requestRender();
      })()
        .catch((error) => { status = error instanceof Error ? error.message : String(error); requestRender(); });
      return true;
    }
    if (value.startsWith('/new')) {
      const prompt = value.slice('/new'.length).trim();
      inputMode = 'new-prompt';
      pendingName = '';
      inputBuffer = prompt;
      status = 'New task';
      requestRender();
      if (prompt) void submitAgentInput();
      return true;
    }
    if (value === '/upload') {
      const link = await createUploadLink();
      status = `Upload image: ${link.url} expires ${link.expiresAt}`;
      requestRender();
      return true;
    }
    if (value === '/resume') {
      const result = await sendTaskSocketRequest({ type: 'resume_sessions' }, 10000);
      status = result.text || 'Resumed pi sessions';
      await refresh();
      return true;
    }
    const task = replyTarget || selectedTask();
    if (!task) {
      status = `Select a task to run ${value.split(/\s+/, 1)[0]}, or use /mi <question>`;
      requestRender();
      return true;
    }
    const taskId = task.id || task.sessionFile || task.sessionName || task.name;
    task.status = 'running';
    task.finishedAt = undefined;
    task.progress = value;
    requestRender();
    void sendTaskSocketRequest({ type: 'continue_worker', taskId, message: value, model: agentModelWithThinking(), background: true, useGoal: '0' }, 30000)
      .then(() => refresh())
      .catch((error) => { task.status = 'error'; task.finishedAt = new Date().toISOString(); task.error = error instanceof Error ? error.message : String(error); status = task.error; requestRender(); });
    return true;
  }

  function sectionTaskItems(label: 'needs input' | 'working' | 'completed') {
    return tasks
      .map((task, index) => ({ task, index }))
      .filter((item) => taskSection(item.task) === label)
      .sort((a, b) => label === 'completed'
        ? (Date.parse(b.task.finishedAt || b.task.updatedAt || b.task.lastEventAt || '') || 0) - (Date.parse(a.task.finishedAt || a.task.updatedAt || a.task.lastEventAt || '') || 0)
        : taskStartedMs(b.task) - taskStartedMs(a.task));
  }

  function navigationTaskIndexes() {
    return (['needs input', 'working', 'completed'] as const).flatMap((label) => sectionTaskItems(label).map((item) => item.index));
  }

  function moveAgentListSelection(delta: number) {
    const indexes = navigationTaskIndexes();
    if (indexes.length === 0) return;
    const current = selected >= 0 ? indexes.indexOf(selected) : -1;
    const next = current < 0
      ? (delta > 0 ? 0 : indexes.length - 1)
      : Math.max(0, Math.min(indexes.length - 1, current + delta));
    selected = indexes[next];
    requestRender();
  }

  function render() {
    if (closed) return;
    const width = cols();
    const height = rows();
    const maxInputLines = Math.max(1, Math.min(5, Math.floor(height / 3)));
    const inputLines = agentInputVisibleLines(width, maxInputLines);
    const slashSuggestionLines = slashCommandSuggestionLines(width);
    const footerLines = [
      fgDim(truncateText(status, width)),
      fgThinking(agentThinkingLevel, '─'.repeat(width)),
      ...inputLines.map((line) => truncateText(line, width)),
      fgThinking(agentThinkingLevel, '─'.repeat(width)),
      ...slashSuggestionLines,
      fgDim(truncateText(agentModelWithThinking(), width).padStart(width)),
    ];
    const contentHeight = Math.max(1, height - footerLines.length);
    const listHeight = Math.max(3, Math.floor(contentHeight * 0.55));
    const lines: string[] = [];
    lines.push(fgAccent(truncateText('Mi agents', width)));
    lines.push(fgThinking(undefined, '─'.repeat(width)));
    if (tasks.length === 0) {
      lines.push(fgDim('No background agents. Press n to start one.'));
    } else {
      const selectedSection = selectedTask() ? taskSection(selectedTask()!) : undefined;
      const groupedRows: Array<{ kind: 'header'; label: string } | { kind: 'task'; task: MiTask; index: number }> = [];
      for (const label of ['needs input', 'working', 'completed'] as const) {
        const sectionTasks = sectionTaskItems(label);
        if (sectionTasks.length === 0) continue;
        const visibleSectionTasks = label === 'completed' && selectedSection !== 'completed'
          ? sectionTasks.slice(0, 3)
          : sectionTasks;
        groupedRows.push({ kind: 'header', label: label === 'completed' && visibleSectionTasks.length < sectionTasks.length ? `completed (${visibleSectionTasks.length} shown of ${sectionTasks.length})` : label });
        groupedRows.push(...visibleSectionTasks.map((item) => ({ kind: 'task' as const, ...item })));
      }
      const selectedRow = Math.max(0, groupedRows.findIndex((row) => row.kind === 'task' && row.index === selected));
      const start = Math.max(0, Math.min(selectedRow - Math.floor(listHeight / 2), Math.max(0, groupedRows.length - listHeight)));
      for (const row of groupedRows.slice(start, start + listHeight)) {
        if (row.kind === 'header') {
          lines.push(fgDim(truncateText(row.label, width)));
        } else {
          const key = stableTaskKey(row.task);
          const symbol = multiSelectMode ? (selectedTaskKeys.has(key) ? '✓' : ' ') : taskActivitySymbol(row.task);
          const prefix = row.index === selected ? '→ ' : '  ';
          const text = truncateText(`${prefix}${symbol} ${formatTaskRow(row.task, width - 4)}`, width);
          lines.push(row.index === selected ? fgAccent(text) : text);
        }
      }
    }
    lines.push(fgThinking(undefined, '─'.repeat(width)));
    const task = selectedTask();
    if (btwAnswer) {
      lines.push(fgAccent(truncateText('mi', width)));
      lines.push(...wrapPlain(btwAnswer, Math.max(20, width - 2)).slice(0, Math.max(1, contentHeight - lines.length - 1)));
    } else if (task) {
      lines.push(truncateText(`${taskActivitySymbol(task)} ${taskName(task)}  ${taskStatus(task)}`, width));
      if (task.cwd) lines.push(fgDim(truncateText(`cwd: ${task.cwd}`, width)));
      if (task.needsKyle) lines.push(fgDim(truncateText(`needs Kyle: ${task.needsKyleReason || 'attention'}`, width)));
      const prUrls = extractPrUrlsFromTask(task);
      if (prUrls.length > 0) lines.push(fgDim(truncateText(`PR: ${prUrls.join(' ')}`, width)));
      if (task.sessionName || task.sessionFile) lines.push(fgDim(truncateText(`session: ${task.sessionName || ''} ${task.sessionFile || ''}`, width)));
      const body = task.error || (isTaskActive(task) ? (task.progress || task.text) : (task.text || task.progress)) || 'No result yet.';
      lines.push(...wrapPlain(body, Math.max(20, width - 2)).slice(0, Math.max(1, contentHeight - lines.length - 1)));
    }
    while (lines.length < contentHeight) lines.push('');
    const inputStartRow = contentHeight + 3;
    lines.push(...footerLines);
    while (lines.length < height) lines.push('');
    const out = ['\x1b[?2026h', '\x1b[H'];
    lines.slice(0, height).forEach((line, index) => {
      const padding = Math.max(0, width - widthOf(line));
      out.push('\x1b[2K', line, ' '.repeat(padding));
      if (index < height - 1) out.push('\r\n');
    });
    if (inputMode !== 'normal') out.push(`\x1b[${inputStartRow + inputLines.length - 1};${agentInputCursorColumn(inputLines, width)}H`, '\x1b[?25h');
    else out.push('\x1b[?25l');
    out.push('\x1b[?2026l');
    process.stdout.write(out.join(''));
  }

  async function openSelectedInPi() {
    const task = selectedTask();
    if (!task?.sessionFile) {
      status = 'Selected agent has no session file yet.';
      requestRender();
      return;
    }
    const sessionFile = task.sessionFile;
    const cwd = task.cwd || HOME;
    close();
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.env.PI_CMD || 'pi', ['--session', sessionFile], { cwd, env: process.env, stdio: 'inherit' });
      child.on('error', reject);
      child.on('close', () => resolve());
    });
  }

  async function submitAgentInput() {
    const value = inputBuffer.trim();
    inputBuffer = '';
    if (await runAgentSlashCommand(value)) {
      inputMode = 'normal';
      pendingName = '';
      replyTarget = undefined;
      return;
    }
    if (inputMode === 'new-name') {
      if (!value) { inputMode = 'normal'; requestRender(); return; }
      pendingName = value;
      inputMode = 'new-prompt';
      status = `Describe task for ${pendingName}`;
      requestRender();
      return;
    }
    if (inputMode === 'new-prompt') {
      const explicitName = pendingName;
      pendingName = '';
      inputMode = 'normal';
      if (!value) return;
      const turn = await applyAgentPiCycle(value);
      if (!turn.body) return;
      const name = explicitName || taskNameFromPrompt(turn.body);
      const optimisticTask: MiTask = {
        id: `pending_${Date.now().toString(36)}`,
        name,
        cwd: HOME,
        status: 'queued',
        startedAt: new Date().toISOString(),
        progress: turn.body,
      };
      optimisticTasks = [optimisticTask, ...optimisticTasks];
      tasks = [optimisticTask, ...tasks];
      selected = 0;
      status = `Starting ${name} with ${turn.model}...`;
      agentSubmitting = true;
      requestRender();
      void sendTaskSocketRequest({ type: 'run_worker', name, cwd: HOME, message: turn.body, model: turn.model, background: true }, 30000)
        .then(async (result) => {
          optimisticTask.id = result.taskId || optimisticTask.id;
          optimisticTask.sessionFile = result.sessionFile || optimisticTask.sessionFile;
          optimisticTask.sessionId = result.sessionId || optimisticTask.sessionId;
          optimisticTask.sessionName = result.sessionName || optimisticTask.sessionName;
          optimisticTask.status = 'running';
          optimisticTask.progress = result.text || optimisticTask.progress;
          await refresh();
          status = result.text || `Started ${name}.`;
        })
        .catch((error) => {
          optimisticTask.status = 'error';
          optimisticTask.finishedAt = new Date().toISOString();
          optimisticTask.error = error instanceof Error ? error.message : String(error);
          status = optimisticTask.error;
        })
        .finally(() => {
          agentSubmitting = false;
          requestRender();
        });
      return;
    }
    if (inputMode === 'reply') {
      const task = replyTarget || selectedTask();
      replyTarget = undefined;
      inputMode = 'normal';
      if (!task || !value) return;
      const taskId = task.id || task.sessionFile || task.sessionName || task.name;
      const turn = await applyAgentPiCycle(value);
      if (!turn.body) return;
      task.status = 'running';
      task.finishedAt = undefined;
      task.progress = turn.body;
      status = defaultAgentStatus;
      agentSubmitting = true;
      requestRender();
      void sendTaskSocketRequest({ type: 'continue_worker', taskId, message: turn.body, model: turn.model, background: true }, 30000)
        .then(() => refresh())
        .catch((error) => {
          task.status = 'error';
          task.finishedAt = new Date().toISOString();
          task.error = error instanceof Error ? error.message : String(error);
          status = task.error;
        })
        .finally(() => {
          agentSubmitting = false;
          requestRender();
        });
    }
  }

  function close() {
    closed = true;
    if (renderTimer) clearTimeout(renderTimer);
    if (pollTimer) clearInterval(pollTimer);
    if (animationTimer) clearInterval(animationTimer);
    process.stdin.off('data', onData);
    process.stdout.off('resize', requestRender);
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdout.write(`${RESET_CURSOR}\x1b[?25h\x1b[?2004l\x1b[?1049l`);
  }

  function onData(buffer: Buffer) {
    let data = buffer.toString('utf8');
    if (pasteMode || data.includes('\x1b[200~')) {
      pasteMode = true;
      data = `${pasteBuffer}${data.replace(/\x1b\[200~/g, '')}`;
      if (!data.includes('\x1b[201~')) {
        pasteBuffer = data;
        return;
      }
      const endIndex = data.indexOf('\x1b[201~');
      pasteBuffer = '';
      pasteMode = false;
      const pasted = data.slice(0, endIndex).replace(/\r?\n/g, '\n');
      const rest = data.slice(endIndex + '\x1b[201~'.length);
      if (inputMode === 'normal') {
        replyTarget = selectedTask();
        inputMode = replyTarget ? 'reply' : 'new-prompt';
        status = replyTarget ? `Reply to ${taskName(replyTarget)}` : 'New task';
      }
      inputBuffer += pasted;
      requestRender();
      if (!rest) return;
      data = rest;
    }
    if (data === '\x1b[Z' || data === '\x1b[1;2Z' || data === '\x1b\t' || data.includes('\x1b[Z') || data.includes('\x1b[1;2Z')) {
      cycleAgentThinking();
      return;
    }
    if (inputBuffer.startsWith('/') && /\x1b\[5(?:;\d+)?~/.test(data) && moveSlashSelection(-5)) return;
    if (inputBuffer.startsWith('/') && /\x1b\[6(?:;\d+)?~/.test(data) && moveSlashSelection(5)) return;
    if ((data === '\t' || data === '\x1b[1;5I') && inputBuffer.startsWith('/') && autocompleteSlashCommand()) return;
    if (inputMode !== 'normal') {
      if (data === '\x1b' || data === '\x03') {
        inputMode = 'normal';
        inputBuffer = '';
        pendingName = '';
        replyTarget = undefined;
        status = data === '\x03' ? 'Use /quit to exit' : defaultAgentStatus;
        requestRender();
        return;
      }
      if (data.includes('\r') || data.includes('\n')) {
        const parts = data.split(/[\r\n]+/);
        const beforeEnter = parts.shift() || '';
        const textBeforeEnter = beforeEnter.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
        if (textBeforeEnter) inputBuffer += textBeforeEnter;
        void submitAgentInput().then(() => {
          const afterEnter = parts.join('').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
          if (afterEnter && inputMode !== 'normal') inputBuffer += afterEnter;
          requestRender();
        }).catch((error) => { status = error instanceof Error ? error.message : String(error); inputMode = 'normal'; agentSubmitting = false; requestRender(); });
        return;
      }
      if (data === '\x7f' || data === '\b') {
        inputBuffer = inputBuffer.slice(0, -1);
        slashSelected = 0;
        clearAgentInputModeIfEmpty();
      } else {
        inputBuffer += data.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
        slashSelected = 0;
      }
      requestRender();
      return;
    }
    if (data === '\x03') { inputBuffer = ''; inputMode = 'normal'; status = 'Use /quit to exit'; requestRender(); return; }
    if (btwAnswer && data !== '\x1b') { btwAnswer = ''; }
    if (data === '\x1b') {
      if (btwAnswer) {
        btwAnswer = '';
        status = defaultAgentStatus;
        requestRender();
        return;
      }
      if (multiSelectMode) {
        clearSelectedTasksFromList();
        return;
      }
      const task = selectedTask();
      if (task) {
        const key = stableTaskKey(task);
        if (key) dismissedTaskKeys.add(key);
        tasks = tasks.filter((entry) => stableTaskKey(entry) !== key);
        status = `Removed ${taskName(task)} from list`;
        void dismissTaskFromList(task).catch((error) => { status = error instanceof Error ? error.message : String(error); requestRender(); });
      } else {
        status = defaultAgentStatus;
      }
      selected = -1;
      replyTarget = undefined;
      requestRender();
      return;
    }
    if (data === 'o') void openSelectedInPi().catch((error) => { status = error instanceof Error ? error.message : String(error); requestRender(); });
    else if (data === 'm') { multiSelectMode = !multiSelectMode; if (!multiSelectMode) selectedTaskKeys.clear(); status = multiSelectMode ? multiSelectStatus() : defaultAgentStatus; requestRender(); }
    else if (multiSelectMode && (data === ' ' || data.includes('\r') || data.includes('\n'))) toggleSelectedTaskForBulkClear();
    else if (data.includes('\r') || data.includes('\n')) { const task = selectedTask(); if (task) { replyTarget = task; inputMode = 'reply'; inputBuffer = ''; status = `Reply to ${taskName(task)}`; requestRender(); } }
    else if (/\x1b\[5(?:;\d+)?~/.test(data)) moveAgentListSelection(-3);
    else if (/\x1b\[6(?:;\d+)?~/.test(data)) moveAgentListSelection(3);
    else if (data === '\x1b[A' || data === '\x1bOA') moveAgentListSelection(-1);
    else if (data === '\x1b[B' || data === '\x1bOB') moveAgentListSelection(1);
    else {
      const text = data.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
      if (text) {
        replyTarget = selectedTask();
        inputMode = 'reply';
        status = `Reply to ${taskName(replyTarget || {})}`;
        inputBuffer = text;
        slashSelected = 0;
        requestRender();
      }
    }
  }

  process.stdout.write('\x1b[?1049h\x1b[?2004h\x1b[2J\x1b[H');
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', onData);
  process.stdout.on('resize', requestRender);
  await refresh();
  pollTimer = setInterval(() => void refresh(), 1000);
  animationTimer = setInterval(() => { if (tasks.some(isTaskWorking)) requestRender(); }, 180);
  await new Promise<void>((resolve) => {
    const interval = setInterval(() => {
      if (closed) {
        clearInterval(interval);
        resolve();
      }
    }, 50);
  });
}

async function compactCommand(args: string[]) {
  const threadId = args[0] || 'main';
  const result = await compactThread(threadId);
  await logEvent('mi.thread.compact', result);
  console.log(`Compacted ${result.compacted} message(s), kept ${result.kept}.`);
  console.log(`Summary: ${result.summaryPath}`);
  if (result.archivePath) console.log(`Archive: ${result.archivePath}`);
}

async function chatCommand(threadId = 'main') {
  await showThread(threadId);
  console.log('\nType a message. Commands: /inbox, /compact, /upload, /exit');
  const rl = createInterface({ input, output });
  try {
    while (true) {
      const line = (await rl.question('you> ')).trim();
      if (!line) continue;
      if (line === '/exit' || line === '/quit') break;
      if (line === '/help') {
        console.log('Commands: /inbox, /compact, /upload, /exit');
        continue;
      }
      if (line === '/inbox') {
        await inboxCommand();
        continue;
      }
      if (line === '/compact') {
        await compactCommand([threadId]);
        continue;
      }
      if (line === '/upload') {
        await uploadCommand();
        continue;
      }
      const reply = await askMi(threadId, line);
      console.log(`mi> ${reply}`);
    }
  } finally {
    rl.close();
  }
}

const HOME = homedir();
const PUSHOVER_ENDPOINT = 'https://api.pushover.net/1/messages.json';
const PUSHOVER_ENV_FILE = join(HOME, '.config', 'pushover', 'env');
const PUSHOVER_MESSAGE_LIMIT = 1024;
const MI_TASKS_DIR = join(HOME, 'mi');
const MI_RUNTIME_DIR = process.env.MI_RUNTIME_DIR || join(HOME, '.pi', 'agent', 'mi');
const MI_SOCKET_PATH = process.env.MI_SOCKET_PATH || join(MI_RUNTIME_DIR, 'main.sock');
const MI_DAEMON_PATH = process.env.MI_DAEMON_PATH || join(HOME, '.pi', 'agent', 'extensions', 'mi-daemon.mjs');
const MI_MODEL = process.env.MI_MODEL || 'openai-codex/gpt-5.5:low';
const PI_CYCLE_PATH = join(HOME, '.pi', 'agent', 'pi-cycle.json');

type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
type PiCycleConfig = {
  shortcut: string;
  tiers: Record<string, string[]>;
  thinkingLevels?: Record<string, ThinkingLevel>;
};

type MiTask = {
  id?: string;
  name?: string;
  cwd?: string;
  status?: string;
  startedAt?: string;
  updatedAt?: string;
  continuedAt?: string;
  finishedAt?: string;
  text?: string;
  error?: string;
  progress?: string;
  lastEventAt?: string;
  needsKyle?: boolean;
  needsKyleReason?: string;
  prUrls?: string[];
  sessionFile?: string;
  sessionName?: string;
  sessionId?: string;
};

function readPushoverEnvFile(): Record<string, string> {
  try {
    const text = readFileSync(PUSHOVER_ENV_FILE, 'utf8');
    const values: Record<string, string> = {};
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

function usableSecret(value: string | undefined) {
  return value && !value.includes('${') ? value : undefined;
}

function getPushoverCredentials() {
  const fileEnv = readPushoverEnvFile();
  const token = usableSecret(process.env.PUSHOVER_APP_TOKEN) || usableSecret(fileEnv.PUSHOVER_APP_TOKEN) || usableSecret(process.env.PUSHOVER_TOKEN) || usableSecret(fileEnv.PUSHOVER_TOKEN);
  const user = usableSecret(process.env.PUSHOVER_USER_KEY) || usableSecret(fileEnv.PUSHOVER_USER_KEY) || usableSecret(process.env.PUSHOVER_USER) || usableSecret(fileEnv.PUSHOVER_USER);
  return token && user ? { token, user } : undefined;
}

async function sendPushover(title: string, message: string) {
  const credentials = getPushoverCredentials();
  if (!credentials) return false;
  const body = new URLSearchParams({
    token: credentials.token,
    user: credentials.user,
    title,
    message: message.length > PUSHOVER_MESSAGE_LIMIT ? `${message.slice(0, PUSHOVER_MESSAGE_LIMIT - 1)}…` : message,
    priority: '0',
    monospace: '1',
  });
  const response = await fetch(PUSHOVER_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  return response.ok;
}

function stripAnsi(text: string) {
  return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
}

function widthOf(text: string) {
  return stripAnsi(text).length;
}

function truncateText(text: string, width: number) {
  const plain = stripAnsi(text);
  return plain.length <= width ? text : plain.slice(0, Math.max(0, width));
}

function wrapPlain(text: string, width: number) {
  const normalized = text.replace(/\r/g, '').split('\n');
  const out: string[] = [];
  for (const paragraph of normalized) {
    if (!paragraph) {
      out.push('');
      continue;
    }
    let line = '';
    for (const word of paragraph.split(/\s+/)) {
      if (!word) continue;
      if (!line) {
        while (word.length > width) {
          out.push(word.slice(0, width));
          line = word.slice(width);
          break;
        }
        if (!line) line = word;
      } else if (line.length + 1 + word.length <= width) {
        line += ` ${word}`;
      } else {
        out.push(line);
        line = word;
      }
      while (line.length > width) {
        out.push(line.slice(0, width));
        line = line.slice(width);
      }
    }
    out.push(line);
  }
  return out;
}

const PI_ACCENT = '\x1b[38;2;138;190;183m';
const PI_DIM = '\x1b[38;2;170;170;170m';
const PI_USER_BG = '\x1b[48;2;52;53;65m';
const THINKING_COLORS: Record<string, string> = {
  off: '\x1b[38;2;80;80;80m',
  minimal: '\x1b[38;2;110;110;110m',
  low: '\x1b[38;2;95;135;175m',
  medium: '\x1b[38;2;129;162;190m',
  high: '\x1b[38;2;178;148;187m',
  xhigh: '\x1b[38;2;209;131;232m',
};
const RESET_FG = '\x1b[39m';
const RESET_BG = '\x1b[49m';
const WHITE_CURSOR = '\x1b]12;white\x07';
const RESET_CURSOR = '\x1b]112\x07';
const PI_SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

function fgAccent(text: string) {
  return `${PI_ACCENT}${text}${RESET_FG}`;
}

function fgDim(text: string) {
  return `${PI_DIM}${text}${RESET_FG}`;
}

function fgThinking(level: string | undefined, text: string) {
  return `${THINKING_COLORS[level || 'low'] || THINKING_COLORS.low}${text}${RESET_FG}`;
}

function userBgLine(text: string, width: number) {
  const content = truncateText(text, width);
  return `${PI_USER_BG}${content}${' '.repeat(Math.max(0, width - widthOf(content)))}${RESET_BG}`;
}

function workingLine() {
  const frame = PI_SPINNER_FRAMES[Math.floor(Date.now() / 80) % PI_SPINNER_FRAMES.length];
  return `${fgAccent(frame)} ${fgDim('Working...')}`;
}

function sendSocketRequest(payload: unknown, timeoutMs = 120000): Promise<{ ok?: boolean; error?: string; text?: string; state?: any; tasks?: MiTask[]; taskId?: string; sessionFile?: string; sessionId?: string; sessionName?: string; model?: unknown }> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(MI_SOCKET_PATH);
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
        const response = JSON.parse(data.slice(0, data.indexOf('\n'))) as { ok?: boolean; error?: string; text?: string; state?: any; tasks?: MiTask[]; taskId?: string; sessionFile?: string; sessionId?: string; sessionName?: string; model?: unknown };
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

async function startMiDaemon() {
  await mkdir(dirname(MI_SOCKET_PATH), { recursive: true });
  const child = spawn(process.execPath, [MI_DAEMON_PATH], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, MI_SOCKET_PATH, MI_RUNTIME_DIR },
  });
  child.unref();
  for (let i = 0; i < 20; i++) {
    try {
      await sendSocketRequest({ type: 'health' }, 500);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error('Mi main did not start');
}

async function sendTaskSocketRequest(payload: unknown, timeoutMs = 30000) {
  try {
    return await sendSocketRequest(payload, timeoutMs);
  } catch (error) {
    if (existsSync(MI_SOCKET_PATH)) throw error;
    await startMiDaemon();
    return await sendSocketRequest(payload, timeoutMs);
  }
}

function normalizeMiResponse(text: string) {
  return text.trim() || 'Mi completed without text.';
}

function miPrompt(message: string) {
  return message;
}

async function requestMi(message: string) {
  const response = await sendSocketRequest({ type: 'prompt', message });
  return normalizeMiResponse(response.text || '');
}

async function abortMiMain() {
  return sendSocketRequest({ type: 'abort' }, 10000).catch(() => undefined);
}

async function getMiState() {
  try {
    return (await sendSocketRequest({ type: 'state' }, 10000)).state;
  } catch (error) {
    if (existsSync(MI_SOCKET_PATH)) throw error;
    await startMiDaemon();
    return (await sendSocketRequest({ type: 'state' }, 10000)).state;
  }
}

async function setMiModelThinking(modelSpec: string, level?: ThinkingLevel) {
  const [provider, ...idParts] = modelSpec.split('/');
  const modelId = idParts.join('/');
  if (!provider || !modelId) throw new Error(`Invalid model spec: ${modelSpec}`);
  try {
    await sendSocketRequest({ type: 'set_model', provider, modelId }, 30000);
    return level ? (await sendSocketRequest({ type: 'set_thinking', level }, 30000)).state : await getMiState();
  } catch (error) {
    if (existsSync(MI_SOCKET_PATH)) throw error;
    await startMiDaemon();
    await sendSocketRequest({ type: 'set_model', provider, modelId }, 30000);
    return level ? (await sendSocketRequest({ type: 'set_thinking', level }, 30000)).state : await getMiState();
  }
}

async function setMiThinking(level: 'low' | 'medium' | 'high') {
  return setMiModelThinking('openai-codex/gpt-5.5', level);
}

async function loadPiCycleConfig(): Promise<PiCycleConfig> {
  try {
    const raw = JSON.parse(await readFile(PI_CYCLE_PATH, 'utf8')) as Partial<PiCycleConfig>;
    return {
      shortcut: typeof raw.shortcut === 'string' && raw.shortcut.trim() ? raw.shortcut.trim() : 'z',
      tiers: {
        '1': Array.isArray(raw.tiers?.['1']) ? raw.tiers!['1'] : ['openai-codex/gpt-5.5'],
        '2': Array.isArray(raw.tiers?.['2']) ? raw.tiers!['2'] : ['openai-codex/gpt-5.5'],
        '3': Array.isArray(raw.tiers?.['3']) ? raw.tiers!['3'] : ['openai-codex/gpt-5.5'],
      },
      thinkingLevels: raw.thinkingLevels || {},
    };
  } catch {
    return { shortcut: 'z', tiers: { '1': ['openai-codex/gpt-5.5'], '2': ['openai-codex/gpt-5.5'], '3': ['openai-codex/gpt-5.5'] }, thinkingLevels: {} };
  }
}

async function sendToMiMain(message: string): Promise<string> {
  try {
    return await requestMi(miPrompt(message));
  } catch (error) {
    if (existsSync(MI_SOCKET_PATH)) throw error;
  }
  await startMiDaemon();
  return await requestMi(miPrompt(message));
}

async function miTuiCommand(initial = '') {
  await mkdir(MI_TASKS_DIR, { recursive: true });
  let transcript = (await readThreadMessages('main'))
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .map((message) => ({ role: message.role as 'user' | 'assistant', text: message.text }));
  await markThreadRead('main');

  let miState: any;
  let piCycleConfig = await loadPiCycleConfig();
  const piCycleNextIndex: Record<string, number> = { '1': 0, '2': 0, '3': 0 };
  let statusMessage = `Shift+Tab thinking • ${piCycleConfig.shortcut}/${piCycleConfig.shortcut.repeat(2)}/${piCycleConfig.shortcut.repeat(3)} pi-cycle`;
  let inputLine = '';
  let pending = false;
  const messageQueue: string[] = [];
  let scrollOffset = 0;
  let closed = false;
  let renderTimer: NodeJS.Timeout | undefined;
  let workingTimer: NodeJS.Timeout | undefined;
  let taskPollTimer: NodeJS.Timeout | undefined;
  let agentAnimationTimer: NodeJS.Timeout | undefined;
  let pendingEscapeTimer: NodeJS.Timeout | undefined;
  let pendingEscapeData = '';
  let compactAgents: MiTask[] = [];
  let selectedAgentIndex = -1;
  let agentListFocused = false;
  const dismissedCompactAgentKeys = new Set<string>();

  const rows = () => process.stdout.rows || 24;
  const cols = () => process.stdout.columns || 80;

  getMiState()
    .then((state) => {
      miState = state;
      requestRender();
    })
    .catch((error) => {
      statusMessage = error instanceof Error ? error.message : String(error);
      requestRender();
    });

  function refreshCompactAgents() {
    listTasks()
      .then((tasks) => {
        const selectedKey = selectedAgent() ? stableTaskKey(selectedAgent()!) : '';
        compactAgents = tasks.filter((task) => !dismissedCompactAgentKeys.has(stableTaskKey(task)));
        if (selectedKey) selectedAgentIndex = compactAgents.findIndex((task) => stableTaskKey(task) === selectedKey);
        if (selectedAgentIndex >= compactAgents.length) selectedAgentIndex = compactAgents.length - 1;
        requestRender();
      })
      .catch(() => undefined);
  }

  refreshCompactAgents();
  taskPollTimer = setInterval(refreshCompactAgents, 1000);
  agentAnimationTimer = setInterval(() => { if (compactAgents.some(isTaskWorking)) requestRender(); }, 180);

  function requestRender() {
    if (renderTimer) return;
    renderTimer = setTimeout(() => {
      renderTimer = undefined;
      render();
    }, 16);
  }

  function setPending(next: boolean) {
    if (pending === next) return;
    pending = next;
    if (pending) {
      workingTimer = setInterval(requestRender, 80);
    } else if (workingTimer) {
      clearInterval(workingTimer);
      workingTimer = undefined;
    }
  }

  function inputText() {
    return inputLine;
  }

  function inputDisplayText() {
    return inputText();
  }

  function inputVisibleLines(width: number, maxLines: number) {
    const wrapped = wrapPlain(inputDisplayText(), Math.max(1, width));
    const lines = wrapped.length > 0 ? wrapped : [''];
    return lines.slice(-Math.max(1, maxLines));
  }

  function inputCursorColumn(inputLines: string[], width: number) {
    const lastLine = inputLines[inputLines.length - 1] || '';
    return Math.min(width, widthOf(lastLine) + 1);
  }

  function formatTokens(value: number | undefined) {
    if (!Number.isFinite(value)) return '—';
    const n = Number(value);
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${Math.round(n / 100) / 10}k`;
    return String(n);
  }

  function selectedAgent() {
    return selectedAgentIndex >= 0 ? compactAgents[selectedAgentIndex] : undefined;
  }

  function compactAgentWindow() {
    if (compactAgents.length === 0) return { start: 0, items: [] as Array<{ task: MiTask; index: number }> };
    const anchor = selectedAgentIndex >= 0 ? selectedAgentIndex : 0;
    const start = Math.max(0, Math.min(anchor - 1, Math.max(0, compactAgents.length - 3)));
    return { start, items: compactAgents.slice(start, start + 3).map((task, offset) => ({ task, index: start + offset })) };
  }

  function statusLine(width: number) {
    const model = miState?.model;
    const modelName = model ? `${model.provider}/${model.id}` : MI_MODEL;
    const thinking = miState?.thinkingLevel ? ` ${miState.thinkingLevel}` : '';
    const selected = selectedAgent() ? ` agent:${selectedAgentIndex + 1}` : '';
    const left = [messageQueue.length > 0 ? `q${messageQueue.length}` : '', selected].filter(Boolean).join(' ');
    const right = `${modelName}${thinking}`;
    const available = Math.max(1, width - widthOf(left) - widthOf(right));
    if (left && available > 1) return fgDim(`${left}${' '.repeat(available)}${right}`);
    return fgDim(right.padStart(Math.max(widthOf(right), width)));
  }

  function compactAgentLines(width: number) {
    if (compactAgents.length === 0) return [];
    const window = compactAgentWindow();
    const lines: string[] = [];
    for (const { task, index } of window.items) {
      const marker = agentListFocused && index === selectedAgentIndex ? '▸' : index === selectedAgentIndex ? '→' : ' ';
      const row = truncateText(`${marker}${taskActivitySymbol(task)} ${formatTaskRow(task, width - 4)}`, width);
      lines.push(index === selectedAgentIndex ? fgAccent(row) : fgDim(row));
    }
    return lines.slice(0, 4);
  }

  function selectedAgentVisibleNumber() {
    if (selectedAgentIndex < 0) return undefined;
    const window = compactAgentWindow();
    const found = window.items.find((item) => item.index === selectedAgentIndex);
    return found ? String(found.index - window.start + 1) : String(selectedAgentIndex + 1);
  }

  function selectedAgentContext() {
    const task = selectedAgent();
    if (!task) return '';
    return [
      `Selected Mi background agent #${selectedAgentIndex + 1}: ${taskName(task)}`,
      `Status: ${taskStatus(task)}`,
      task.cwd ? `cwd: ${task.cwd}` : '',
      task.sessionFile ? `session: ${task.sessionFile}` : '',
      task.needsKyle ? `needs Kyle: ${task.needsKyleReason || 'attention'}` : '',
      extractPrUrlsFromTask(task).length ? `PRs: ${extractPrUrlsFromTask(task).join(' ')}` : '',
      task.text ? `latest result: ${task.text.slice(0, 800)}` : '',
      task.progress ? `progress: ${task.progress}` : '',
      task.error ? `error: ${task.error}` : '',
    ].filter(Boolean).join('\n');
  }

  async function buildMiTurnPrompt(text: string) {
    const recent = (await readThreadMessages('main', 15)).filter((message) => message.role === 'user' || message.role === 'assistant');
    const history = recent.map((message) => `${message.role}: ${message.text}`).join('\n');
    const agentContext = selectedAgentContext();
    return [
      "You are Mi, Kyle's private persistent assistant. Reply naturally and use recent conversation context. Do not mention hidden context unless it is useful.",
      history ? `Recent conversation history for context only:\n${history}` : '',
      agentContext ? `Selected agent context:\n${agentContext}` : '',
      `New message to answer:\n${text}`,
    ].filter(Boolean).join('\n\n');
  }

  function renderInputLine() {
    if (closed) return;
    requestRender();
  }

  function render() {
    if (closed) return;
    const width = cols();
    const height = rows();
    const innerWidth = Math.max(20, width - 4);
    const agentLines = compactAgentLines(width);
    const maxInputLines = Math.max(1, Math.min(5, height - agentLines.length - 5));
    const inputLines = inputVisibleLines(width, maxInputLines);
    const bodyViewport = Math.max(1, height - 4 - agentLines.length - inputLines.length);
    const body: string[] = [];

    for (const item of transcript) {
      if (item.role === 'user') {
        body.push(userBgLine('', width));
        for (const line of wrapPlain(item.text, Math.max(20, width - 4))) {
          body.push(userBgLine(`  ${line}`, width));
        }
        body.push(userBgLine('', width));
        body.push('');
      } else {
        body.push(...wrapPlain(item.text, innerWidth));
        body.push('');
      }
    }
    if (pending) {
      body.push(workingLine());
      body.push('');
    }

    const maxOffset = Math.max(0, body.length - bodyViewport);
    const offset = Math.min(scrollOffset, maxOffset);
    const end = body.length - offset;
    const start = Math.max(0, end - bodyViewport);
    const visibleBody = body.slice(start, end);
    while (visibleBody.length < bodyViewport) visibleBody.unshift('');

    const lines = [
      ...visibleBody.map((line) => truncateText(line, width)),
      fgThinking(miState?.thinkingLevel, '─'.repeat(width)),
      ...inputLines.map((line) => truncateText(line, width)),
      fgThinking(miState?.thinkingLevel, '─'.repeat(width)),
      statusLine(width),
      ...agentLines,
      '',
    ].slice(0, height);

    while (lines.length < height) lines.push('');
    const out = ['\x1b[?2026h', '\x1b[H'];
    lines.forEach((line, index) => {
      const padding = Math.max(0, width - widthOf(line));
      out.push('\x1b[2K', line, ' '.repeat(padding));
      if (index < lines.length - 1) out.push('\r\n');
    });
    out.push(WHITE_CURSOR, `\x1b[${bodyViewport + 1 + inputLines.length};${inputCursorColumn(inputLines, width)}H`, '\x1b[?25h', '\x1b[?2026l');
    process.stdout.write(out.join(''));
  }

  async function askOne(text: string) {
    setPending(true);
    transcript.push({ role: 'user', text });
    scrollOffset = 0;
    await appendThreadMessage('main', 'user', text, { unread: false, source: 'mi-cli' });
    requestRender();
    try {
      const response = await sendToMiMain(await buildMiTurnPrompt(text));
      getMiState().then((state) => {
        miState = state;
        requestRender();
      }).catch(() => undefined);
      await appendThreadMessage('main', 'assistant', response, { unread: false, source: 'mi-main' });
      transcript.push({ role: 'assistant', text: response });
      await sendPushover('Mi', response).catch(() => undefined);
    } catch (error) {
      transcript.push({ role: 'assistant', text: error instanceof Error ? error.message : String(error) });
    } finally {
      scrollOffset = 0;
      requestRender();
    }
  }

  async function processQueue() {
    if (pending) return;
    while (messageQueue.length > 0) {
      const next = messageQueue.shift()!;
      if (closed) break;
      await askOne(next);
    }
    setPending(false);
    requestRender();
  }

  function enqueueMessage(text: string) {
    messageQueue.push(text);
    void processQueue();
    requestRender();
  }

  function cleanup() {
    if (closed) return;
    closed = true;
    if (renderTimer) clearTimeout(renderTimer);
    if (workingTimer) clearInterval(workingTimer);
    if (taskPollTimer) clearInterval(taskPollTimer);
    if (agentAnimationTimer) clearInterval(agentAnimationTimer);
    if (pendingEscapeTimer) clearTimeout(pendingEscapeTimer);
    process.stdin.off('data', onData);
    process.stdout.off('resize', requestRender);
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdout.write(`${RESET_CURSOR}\x1b[?25h\x1b[?1049l`);
  }

  function scrollBy(delta: number) {
    scrollOffset = Math.max(0, scrollOffset + delta);
    requestRender();
  }

  function piCycleThinkingLevel(tier: string, modelSpec: string): ThinkingLevel | undefined {
    return piCycleConfig.thinkingLevels?.[`${tier}:${modelSpec}`] || piCycleConfig.thinkingLevels?.[modelSpec];
  }

  async function applyPiCycle(text: string): Promise<{ handled: boolean; body: string }> {
    piCycleConfig = await loadPiCycleConfig();
    const shortcut = piCycleConfig.shortcut || 'z';
    const escaped = shortcut.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = text.match(new RegExp(`^((?:${escaped}){1,3})(?:\\s+([\\s\\S]*)|$)`));
    if (!match || match[1].length % shortcut.length !== 0) return { handled: false, body: text };
    const tier = String(match[1].length / shortcut.length);
    const models = piCycleConfig.tiers[tier] || [];
    if (models.length === 0) throw new Error(`pi-cycle tier ${tier} has no models`);
    const index = piCycleNextIndex[tier] % models.length;
    const modelSpec = models[index];
    piCycleNextIndex[tier] = (index + 1) % models.length;
    const level = piCycleThinkingLevel(tier, modelSpec);
    statusMessage = `Tier ${tier}: ${modelSpec}${level ? ` ${level}` : ''}`;
    requestRender();
    await setMiModelThinking(modelSpec, level);
    miState = await getMiState();
    statusMessage = `Shift+Tab thinking • ${shortcut}/${shortcut.repeat(2)}/${shortcut.repeat(3)} pi-cycle`;
    requestRender();
    return { handled: true, body: (match[2] || '').trim() };
  }

  async function cycleThinking() {
    if (pending) {
      statusMessage = 'Wait for current response before switching thinking';
      requestRender();
      return;
    }
    const current = miState?.thinkingLevel === 'high' || miState?.thinkingLevel === 'medium' || miState?.thinkingLevel === 'low' ? miState.thinkingLevel : 'low';
    const next = current === 'low' ? 'medium' : current === 'medium' ? 'high' : 'low';
    statusMessage = `Switching to gpt-5.5 ${next}...`;
    requestRender();
    try {
      const result = await setMiThinking(next);
      miState = await getMiState();
      if (result?.thinkingLevel) miState.thinkingLevel = result.thinkingLevel;
      statusMessage = `Shift+Tab thinking • ${piCycleConfig.shortcut}/${piCycleConfig.shortcut.repeat(2)}/${piCycleConfig.shortcut.repeat(3)} pi-cycle`;
    } catch (error) {
      statusMessage = error instanceof Error ? error.message : String(error);
    }
    requestRender();
  }

  function submitInput() {
    const text = inputLine.trim();
    if (!text) return;
    inputLine = '';
    renderInputLine();
    if (text === '/quit') {
      cleanup();
      return;
    }
    if (text === '/upload') {
      void uploadCommand()
        .then(() => requestRender())
        .catch((error) => {
          statusMessage = error instanceof Error ? error.message : String(error);
          requestRender();
        });
      return;
    }
    void applyPiCycle(text)
      .then(({ body }) => {
        if (body) enqueueMessage(body);
        else requestRender();
      })
      .catch((error) => {
        statusMessage = error instanceof Error ? error.message : String(error);
        requestRender();
      });
  }

  function selectVisibleAgent(numberKey: string) {
    const numeric = Number(numberKey);
    if (numeric === 0) {
      selectedAgentIndex = -1;
      requestRender();
      return true;
    }
    if (!Number.isInteger(numeric) || numeric < 1 || numeric > 3) return false;
    const { items } = compactAgentWindow();
    const item = items[numeric - 1];
    if (!item) return false;
    selectedAgentIndex = item.index;
    requestRender();
    return true;
  }

  function moveAgentSelection(delta: number) {
    if (compactAgents.length === 0) return false;
    agentListFocused = true;
    if (selectedAgentIndex < 0) selectedAgentIndex = delta > 0 ? Math.min(delta, compactAgents.length - 1) : compactAgents.length - 1;
    else selectedAgentIndex = Math.max(0, Math.min(compactAgents.length - 1, selectedAgentIndex + delta));
    requestRender();
    return true;
  }

  function handleEscapeKey() {
    if (pending || messageQueue.length > 0) {
      messageQueue.length = 0;
      statusMessage = 'Stopping...';
      setPending(false);
      void abortMiMain().then(() => {
        statusMessage = `Shift+Tab thinking • ${piCycleConfig.shortcut}/${piCycleConfig.shortcut.repeat(2)}/${piCycleConfig.shortcut.repeat(3)} pi-cycle`;
        requestRender();
      });
    } else if (selectedAgentIndex >= 0 || agentListFocused) {
      const task = selectedAgent();
      if (task) {
        const key = stableTaskKey(task);
        if (key) dismissedCompactAgentKeys.add(key);
        compactAgents = compactAgents.filter((entry) => stableTaskKey(entry) !== key);
        statusMessage = `Removed ${taskName(task)} from list`;
        void dismissTaskFromList(task).catch((error) => { statusMessage = error instanceof Error ? error.message : String(error); requestRender(); });
      }
      selectedAgentIndex = -1;
      agentListFocused = false;
    } else {
      inputLine = '';
    }
    requestRender();
  }

  function handleCtrlC() {
    if (pending || messageQueue.length > 0) {
      messageQueue.length = 0;
      statusMessage = 'Stopping...';
      setPending(false);
      void abortMiMain().then(() => {
        statusMessage = `Shift+Tab thinking • ${piCycleConfig.shortcut}/${piCycleConfig.shortcut.repeat(2)}/${piCycleConfig.shortcut.repeat(3)} pi-cycle`;
        requestRender();
      });
      requestRender();
    } else {
      inputLine = '';
      requestRender();
    }
  }

  function isCompleteEscapeSequence(data: string) {
    return data === '\x1b[Z' || data === '\x1b[1;2Z' || data === '\x1b\t'
      || /\x1b\[5(?:;\d+)?~/.test(data)
      || /\x1b\[6(?:;\d+)?~/.test(data)
      || data.includes('\x1b[A') || data.includes('\x1bOA') || data.includes('\x1b[1;2A')
      || data.includes('\x1b[B') || data.includes('\x1bOB') || data.includes('\x1b[1;2B');
  }

  function flushPendingEscape() {
    const data = pendingEscapeData;
    pendingEscapeData = '';
    pendingEscapeTimer = undefined;
    if (data === '\x1b') handleEscapeKey();
    else handleInputData(data);
  }

  function handleInputData(data: string) {
    if (inputLine.length === 0 && /^[0-5]$/.test(data) && selectVisibleAgent(data)) return;
    if (data === '\x1b') {
      handleEscapeKey();
      return;
    }
    if (data === '\x03') {
      handleCtrlC();
      return;
    }
    if (data === '\x1b[Z' || data === '\x1b[1;2Z' || data === '\x1b\t' || data.includes('\x1b[Z') || data.includes('\x1b[1;2Z')) {
      void cycleThinking();
    } else if (data === '\x0c') {
      agentListFocused = true;
      if (selectedAgentIndex < 0 && compactAgents.length > 0) selectedAgentIndex = 0;
      requestRender();
    } else if (/\x1b\[5(?:;\d+)?~/.test(data)) {
      moveAgentSelection(-3);
    } else if (/\x1b\[6(?:;\d+)?~/.test(data)) {
      moveAgentSelection(3);
    } else if (data.includes('\x1b[A') || data.includes('\x1bOA') || data.includes('\x1b[1;2A')) {
      scrollBy(Math.max(3, Math.floor(rows() / 2)));
    } else if (data.includes('\x1b[B') || data.includes('\x1bOB') || data.includes('\x1b[1;2B')) {
      scrollBy(-Math.max(3, Math.floor(rows() / 2)));
    } else if (data.includes('\r') || data.includes('\n')) {
      const parts = data.split(/[\r\n]+/);
      const beforeEnter = parts.shift() || '';
      const textBeforeEnter = beforeEnter.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
      if (textBeforeEnter) inputLine += textBeforeEnter;
      if (!inputLine.trim() && selectedAgentIndex >= 0) {
        inputLine = `${selectedAgentVisibleNumber() || selectedAgentIndex + 1} `;
        renderInputLine();
        return;
      }
      submitInput();
      const afterEnter = parts.join('');
      const textAfterEnter = afterEnter.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
      if (textAfterEnter) inputLine += textAfterEnter;
      renderInputLine();
    } else if (data === '\x7f' || data === '\b') {
      inputLine = inputLine.slice(0, -1);
      renderInputLine();
    } else if (data === '\x15') {
      inputLine = '';
      renderInputLine();
    } else {
      const text = data.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
      if (text) {
        inputLine += text;
        renderInputLine();
      }
    }
  }

  function onData(buffer: Buffer) {
    const data = buffer.toString('utf8');
    if (pendingEscapeTimer) {
      clearTimeout(pendingEscapeTimer);
      pendingEscapeTimer = undefined;
    }
    if (pendingEscapeData) {
      pendingEscapeData += data;
      if (isCompleteEscapeSequence(pendingEscapeData) || pendingEscapeData.length >= 8) flushPendingEscape();
      else pendingEscapeTimer = setTimeout(flushPendingEscape, 40);
      return;
    }
    if (data.startsWith('\x1b') && !isCompleteEscapeSequence(data) && data.length < 8) {
      pendingEscapeData = data;
      pendingEscapeTimer = setTimeout(flushPendingEscape, 40);
      return;
    }
    handleInputData(data);
  }

  process.stdout.write(`${WHITE_CURSOR}\x1b[?1049h\x1b[?25h\x1b[2J\x1b[H`);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', onData);
  process.stdout.on('resize', requestRender);
  render();
  if (initial.trim()) enqueueMessage(initial.trim());

  await new Promise<void>((resolve) => {
    const interval = setInterval(() => {
      if (closed) {
        clearInterval(interval);
        resolve();
      }
    }, 50);
  });
}

async function launchPiMain(args: string[]) {
  const prompt = [
    'You are Mi, Kyle private persistent assistant.',
    'Be concise and minimal.',
    'Do not use emoji.',
    'Risky actions require explicit approval.',
    'All Mi tasks, goals, objectives, todos, plans, and work queues must be stored and maintained as Markdown files under /home/kyle/mi/.',
    'Do not deploy, merge, push, publish, edit secrets, or change production settings unless explicitly approved.',
    'Use the /mi command for side-channel notes, /mi read for unread Mi messages, and /mi bring-in only when Kyle asks to bring Mi thread context into this pi conversation.',
  ].join(' ');

  const piArgs = [
    '--append-system-prompt',
    prompt,
    '--tools',
    '',
    '--model',
    MI_MODEL,
    ...args,
  ];

  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.env.PI_CMD || 'pi', piArgs, {
      cwd: process.env.MI_ROOT || process.cwd(),
      env: { ...process.env, MI_MAIN: '1', MI_ROOT: process.env.MI_ROOT || process.cwd() },
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('close', (code) => {
      process.exitCode = code ?? 0;
      resolve();
    });
  });
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command) return miTuiCommand('');
  if (command === 'help' || command === '--help' || command === '-h') {
    console.log(usage());
    return;
  }
  if (command === '--once') return onceCommand(args);
  if (command === 'raw') return chatCommand(args[0] || 'main');
  if (command === 'pi') return launchPiMain(args);
  if (command === 'ui') return miTuiCommand(args.join(' '));
  if (command === 'chat' || command === 'open') return chatCommand(args[0] || 'main');
  if (command === 'ask') return askCommand(args);
  if (command === 'inbox' || command === 'threads') return inboxCommand();
  if (command === 'temp') return tempCommand(args);
  if (command === 'compact') return compactCommand(args);
  if (command === 'upload') return uploadCommand();
  if (command === 'detect-approval') return detectApprovalCommand(args);
  if (command === 'agents') return agentsCommand();
  if (command === 'task') return taskCommand(args);
  if (command === 'make') return makeCommand(args);
  if (command === 'run') return runCommand(args);
  if (command === 'edit') return editCommand(args);
  if (command === 'check') return checkCommand(args);
  if (command === 'logs') return logsCommand(args);
  throw new Error(`unknown command: ${command}`);
}

try {
  await main();
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
}
