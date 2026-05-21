#!/usr/bin/env node
import 'dotenv/config';
import { AssistantMessageComponent, getMarkdownTheme, getSelectListTheme, initTheme, UserMessageComponent } from '@mariozechner/pi-coding-agent';
import { AuthStorage, createAgentSessionFromServices, createAgentSessionServices, ModelRegistry, ModelSelectorComponent, SessionManager, SettingsManager } from '@mariozechner/pi-coding-agent';
import { CombinedAutocompleteProvider, CURSOR_MARKER, Editor, matchesKey, ProcessTerminal, TUI } from '@mariozechner/pi-tui';
import { fuzzyFilter, truncateToWidth, visibleWidth } from '@mariozechner/pi-tui';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { createInterface } from 'node:readline/promises';
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { stdin as input, stdout as output } from 'node:process';
import { draftAssistant, proposeAssistantEdit } from './builder.js';
import { assistantPath } from './assistant.js';
import { checkAssistant, runAssistant } from './runner.js';
import { readRunRecords } from './primitives.js';
import { runFlueChat } from './flue.js';
import { readRecentEvents, logEvent } from './state.js';
import { appendThreadMessage, compactThread, createTempThread, getThread, listThreads, markThreadRead, readThreadMessages, threadContext, } from './threads.js';
initTheme(process.env.PI_THEME, false);
const MI_TASK_POLL_MS = Number(process.env.MI_TASK_POLL_MS || 10000);
const MI_AGENT_CLOCK_MS = Number(process.env.MI_AGENT_CLOCK_MS || 1000);
const PI_LOADER_INTERVAL_MS = 80;
const DISABLE_MOUSE_TRACKING_SEQUENCE = '\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1015l';
// Match pi's loader animation cadence. Flicker is handled by pi-tui's
// differential renderer rather than by slowing Mi's animation down.
const MI_AGENT_ANIMATION_MS = Number(process.env.MI_AGENT_ANIMATION_MS || 250);
const MI_WORKING_RENDER_MS = Number(process.env.MI_WORKING_RENDER_MS || PI_LOADER_INTERVAL_MS);
const MI_SESSION_TAIL_BYTES = Number(process.env.MI_SESSION_TAIL_BYTES || 256 * 1024);
const MI_SESSION_ACTIVITY_REFRESH_MS = Number(process.env.MI_SESSION_ACTIVITY_REFRESH_MS || 1000);
let resolveModelScopeModule;
let scopedModelsSelectorModule;
async function resolvePiModelScope(patterns, modelRegistry) {
    if (patterns.length === 0)
        return [];
    resolveModelScopeModule ||= import(new URL('./core/model-resolver.js', await import.meta.resolve('@mariozechner/pi-coding-agent')).href);
    const { resolveModelScope } = await resolveModelScopeModule;
    return resolveModelScope(patterns, modelRegistry);
}
async function getScopedModelsSelectorComponent() {
    scopedModelsSelectorModule ||= import(new URL('./modes/interactive/components/scoped-models-selector.js', await import.meta.resolve('@mariozechner/pi-coding-agent')).href);
    const { ScopedModelsSelectorComponent } = await scopedModelsSelectorModule;
    return ScopedModelsSelectorComponent;
}
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
  mi agents                       Open mi agents live background agent view
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
function argValue(args, flag) {
    const index = args.indexOf(flag);
    if (index === -1)
        return undefined;
    return args[index + 1];
}
function argsWithoutFlag(args, flag) {
    const index = args.indexOf(flag);
    if (index === -1)
        return args;
    return args.filter((_, i) => i !== index && i !== index + 1);
}
async function writeAssistantFile(path, markdown) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, markdown);
}
async function makeCommand(args) {
    const name = argValue(args, '--name');
    const description = args.filter((arg, i) => arg !== '--name' && args[i - 1] !== '--name').join(' ').trim();
    if (!description)
        throw new Error('description required');
    const draft = draftAssistant({ description, name });
    await writeAssistantFile(draft.path, draft.markdown);
    await logEvent('mi.make', { name: draft.name, path: draft.path });
    console.log(`Created ${draft.path}`);
}
async function runCommand(args) {
    const name = args[0];
    if (!name)
        throw new Error('assistant name required');
    const result = await runAssistant({ name, trigger: 'manual' });
    await logEvent('mi.run', result);
    console.log(`${name}: ${result.status}`);
    console.log(result.summary);
    if (result.status === 'error')
        process.exitCode = 1;
}
async function editCommand(args) {
    const name = args[0];
    const change = args.slice(1).join(' ').trim();
    if (!name)
        throw new Error('assistant name required');
    if (!change)
        throw new Error('change required');
    const path = assistantPath(name);
    const currentMarkdown = await readFile(path, 'utf8');
    const draft = proposeAssistantEdit({ name, change, currentMarkdown });
    await writeAssistantFile(draft.path, draft.markdown);
    await logEvent('mi.edit', { name, path: draft.path, change });
    console.log(`Updated ${draft.path}`);
}
async function checkCommand(args) {
    const name = args[0];
    if (!name)
        throw new Error('assistant name required');
    const result = await checkAssistant(name);
    console.log(`${result.path}: ${result.ok ? 'ok' : 'needs work'}`);
    for (const issue of result.issues)
        console.log(`- ${issue}`);
    if (!result.ok)
        process.exitCode = 1;
}
async function logsCommand(args) {
    const name = args[0];
    if (!name)
        throw new Error('assistant name required');
    const limit = Number(args[1] || 20);
    const runs = await readRunRecords(Number.isFinite(limit) ? limit : 20);
    const matchingRuns = runs.filter((run) => run.assistant === name || JSON.stringify(run).includes(name));
    for (const run of matchingRuns)
        console.log(JSON.stringify(run));
    const events = await readRecentEvents(Number.isFinite(limit) ? limit : 20);
    const matchingEvents = events.filter((event) => JSON.stringify(event).includes(name));
    for (const event of matchingEvents)
        console.log(JSON.stringify(event));
}
function renderThreadLine(thread) {
    const unread = thread.unread > 0 ? `  ${thread.unread} unread` : '';
    const label = thread.kind === 'main' ? 'main' : `temp: ${thread.title}`;
    return `${label.padEnd(32)} ${thread.updatedAt}${unread}`;
}
async function inboxCommand() {
    const threads = await listThreads();
    console.log('Mi');
    for (const thread of threads)
        console.log(`  ${renderThreadLine(thread)}`);
}
async function showThread(threadId) {
    const thread = await getThread(threadId);
    if (!thread)
        throw new Error(`thread not found: ${threadId}`);
    const messages = await readThreadMessages(threadId, 30);
    const unread = messages.filter((message) => message.unread);
    console.log(`Mi / ${thread.title}`);
    if (unread.length > 0) {
        console.log(`\nUnread:`);
        for (const message of unread)
            console.log(`${message.role}> ${message.text}`);
    }
    else if (messages.length > 0) {
        console.log('\nRecent:');
        for (const message of messages.slice(-8))
            console.log(`${message.role}> ${message.text}`);
    }
    else {
        console.log('\nNo messages yet.');
    }
    await markThreadRead(threadId);
}
async function askMi(threadId, message) {
    const thread = await getThread(threadId);
    if (!thread)
        throw new Error(`thread not found: ${threadId}`);
    await appendThreadMessage(threadId, 'user', message, { unread: false, source: 'cli' });
    await logEvent('mi.thread.user', { threadId, message });
    const context = await threadContext(threadId);
    const prompt = `You are Mi, ${miUserPossessive()} private persistent assistant. Reply as Mi in the current conversation. Be concise. Do not claim to have inspected files or services unless context explicitly says so. Risky actions require approval.\n\nThread: ${thread.title}\n\n${context}\n\nCurrent user message:\n${message}`;
    const result = await runFlueChat(prompt);
    const reply = result.reply || 'Got it.';
    await appendThreadMessage(threadId, 'assistant', reply, { unread: false, source: result.source });
    await logEvent('mi.thread.assistant', { threadId, source: result.source, ok: result.ok });
    return reply;
}
async function askCommand(args) {
    const threadId = argValue(args, '--thread') || 'main';
    const message = argsWithoutFlag(args, '--thread').join(' ').trim();
    if (!message)
        throw new Error('message required');
    console.log(await askMi(threadId, message));
}
async function onceCommand(args) {
    const message = args.join(' ').trim();
    if (!message)
        throw new Error('message required');
    console.log(await askMi('main', message));
}
async function tempCommand(args) {
    const title = args.join(' ').trim();
    if (!title) {
        const temps = (await listThreads()).filter((thread) => thread.kind === 'temporary');
        if (temps.length === 0)
            console.log('No temporary conversations.');
        else
            for (const thread of temps)
                console.log(renderThreadLine(thread));
        return;
    }
    const thread = await createTempThread(title);
    await chatCommand(thread.id);
}
function taskName(task) {
    return (task.name || task.sessionName || task.id || 'task').replace(/^Mi task:\s*/i, '').trim() || 'task';
}
function taskNameFromPrompt(prompt) {
    return prompt
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 32) || `task-${Date.now().toString(36)}`;
}
function taskStatus(task) {
    const status = String(task.status || '').toLowerCase();
    if (task.needsUser && task.needsUserReason === 'stopped by Escape')
        return 'paused';
    if (task.finishedAt && !task.status)
        return 'complete';
    return task.status || 'unknown';
}
function isTaskNeedsInput(task) {
    const status = taskStatus(task).toLowerCase();
    return status === 'error' || (!task.finishedAt && task.needsUser && ['paused', 'error'].includes(status));
}
function isTaskActive(task) {
    const status = taskStatus(task).toLowerCase();
    return !task.finishedAt && ['running', 'waiting', 'active', 'queued', 'thinkingqueued'].includes(status);
}
function isTaskWorking(task) {
    const status = taskStatus(task).toLowerCase();
    return !task.finishedAt && ['running', 'queued', 'thinking', 'thinkingqueued'].includes(status);
}
function taskSection(task) {
    if (isTaskNeedsInput(task))
        return 'needs input';
    if (isTaskActive(task))
        return 'working';
    return 'completed';
}
function taskSectionRank(task) {
    const section = taskSection(task);
    return section === 'needs input' ? 0 : section === 'working' ? 1 : 2;
}
function taskActivitySymbol(task, animated = true, frameIndex = 0) {
    if (isTaskNeedsInput(task))
        return '●';
    if (!isTaskActive(task))
        return '○';
    return '●';
}
function taskUpdatedMs(task) {
    return Date.parse(task.updatedAt || task.lastEventAt || task.finishedAt || task.continuedAt || task.startedAt || '') || 0;
}
function taskSortRank(task) {
    return 0;
}
function taskStartedMs(task) {
    return Date.parse(task.startedAt || task.continuedAt || task.updatedAt || '') || 0;
}
function taskSectionMovedMs(task) {
    const section = taskSection(task);
    const timestamp = section === 'needs input'
        ? task.updatedAt || task.lastEventAt || task.continuedAt || task.startedAt
        : section === 'working'
            ? task.continuedAt || task.updatedAt || task.lastEventAt || task.startedAt
            : task.finishedAt || task.updatedAt || task.lastEventAt || task.continuedAt || task.startedAt;
    return Date.parse(timestamp || '') || 0;
}
function compactDuration(ms) {
    const seconds = Math.max(0, Math.floor(ms / 1000));
    if (seconds < 60)
        return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60)
        return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24)
        return `${hours}h`;
    return `${Math.floor(hours / 24)}d`;
}
function taskTimeLabel(task) {
    const section = taskSection(task);
    const now = Date.now();
    const timestamp = section === 'completed'
        ? Date.parse(task.finishedAt || task.updatedAt || task.lastEventAt || '')
        : section === 'needs input'
            ? Date.parse(task.updatedAt || task.lastEventAt || task.continuedAt || task.startedAt || '')
            : Date.parse(task.continuedAt || task.startedAt || task.updatedAt || task.lastEventAt || '');
    if (!timestamp)
        return '';
    return compactDuration(now - timestamp);
}
function extractPrUrlsFromTask(task) {
    const found = [...(task.prUrls || []), ...[task.text, task.progress, task.error].flatMap((value) => [...String(value || '').matchAll(/https:\/\/github\.com\/[^\s)]+\/pull\/(\d+)/gi)].map((match) => match[0]))];
    return [...new Set(found)];
}
function prColumn(task) {
    const urls = extractPrUrlsFromTask(task);
    if (urls.length === 0)
        return ''.padEnd(8);
    const first = urls[0].match(/\/pull\/(\d+)/i)?.[1] || 'PR';
    return (`PR#${first}${urls.length > 1 ? `+${urls.length - 1}` : ''}`).padEnd(8).slice(0, 8);
}
function needsUserColumn(task) {
    if (task.needsUser)
        return 'NEEDS'.padEnd(7);
    if (taskStatus(task) === 'error')
        return 'ERROR'.padEnd(7);
    return ''.padEnd(7);
}
function taskRepo(task) {
    const cwd = task.cwd || '';
    if (!cwd)
        return '';
    const parts = cwd.split('/').filter(Boolean);
    return parts.at(-1) || cwd;
}
function isNonFinalAssistantText(text) {
    return text.trim().toLowerCase() === 'queued goal continuation is no longer active.';
}
function taskDisplayText(task) {
    return task.text && !isNonFinalAssistantText(task.text) ? task.text : '';
}
function taskFinalOutput(task, options = {}) {
    const sessionText = task.sessionFile ? readSessionFinalOutput(task.sessionFile, options) : '';
    const text = taskDisplayText(task);
    return task.error || (options.full ? (sessionText || text) : (text || sessionText));
}
function taskDetail(task) {
    const taskText = taskDisplayText(task);
    const base = task.error || (isTaskActive(task) ? (task.progress || taskText) : (taskText || task.progress)) || task.sessionName || '';
    const reason = task.needsUser ? `needs input: ${task.needsUserReason || 'attention'}` : '';
    const detail = reason ? `${reason}${base ? ` — ${base}` : ''}` : base;
    return detail.replace(/\s+/g, ' ');
}
function textFromSessionMessage(message) {
    const content = message?.content;
    if (typeof content === 'string')
        return content.trim();
    if (!Array.isArray(content))
        return '';
    return content
        .map((part) => typeof part === 'string' ? part : part?.type === 'text' ? part.text || '' : part?.type === 'thinking' ? `thinking: ${part.thinking || ''}` : part?.type === 'toolCall' ? `tool: ${part.name || 'unknown'} ${JSON.stringify(part.arguments || {})}` : '')
        .filter(Boolean)
        .join('\n')
        .trim();
}
function summarizeSessionTool(name, args, elapsedLabel = '') {
    const elapsed = elapsedLabel ? ` (${elapsedLabel})` : '';
    if (name === 'bash')
        return `running${elapsed}: ${String(args?.command || '').slice(0, 140)}`;
    if (name === 'read')
        return `reading${elapsed}: ${args?.path || ''}${args?.offset ? `:${args.offset}` : ''}`;
    if (name === 'edit')
        return `editing${elapsed}: ${args?.path || ''}`;
    if (name === 'write')
        return `writing${elapsed}: ${args?.path || ''}`;
    if (name)
        return `using ${name}${elapsed}`;
    return `using tool${elapsed}`;
}
function recordTimestampMs(record) {
    return Date.parse(record?.timestamp || record?.createdAt || record?.at || '') || 0;
}
function formatSessionEvent(record, options = {}) {
    if (record.type !== 'message')
        return '';
    const role = record.message?.role || '';
    if (role === 'user')
        return `you: ${textFromSessionMessage(record.message).replace(/\s+/g, ' ').slice(0, 180)}`;
    if (role === 'assistant') {
        const content = record.message?.content;
        if (Array.isArray(content)) {
            const tool = content.find((part) => part?.type === 'toolCall');
            if (tool) {
                const startMs = recordTimestampMs(record);
                const endMs = options.toolResultTimes?.get(String(tool.id || '')) || options.nowMs || Date.now();
                const elapsed = startMs ? compactDuration(endMs - startMs) : '';
                return summarizeSessionTool(tool.name || '', tool.arguments || {}, elapsed);
            }
            const thinking = content.find((part) => part?.type === 'thinking')?.thinking;
            if (thinking)
                return 'thinking…';
        }
        const text = textFromSessionMessage(record.message).replace(/\s+/g, ' ').trim();
        return text ? `mi: ${text.slice(0, 500)}` : '';
    }
    if (role === 'toolResult')
        return `${record.message?.toolName || 'tool'} finished`;
    return '';
}
const sessionTailCache = new Map();
function readSessionTailSync(sessionFile, maxBytes = MI_SESSION_TAIL_BYTES) {
    const stats = statSync(sessionFile);
    const cached = sessionTailCache.get(sessionFile);
    if (cached && cached.size === stats.size && cached.mtimeMs === stats.mtimeMs && cached.maxBytes === maxBytes)
        return cached.raw;
    let raw;
    if (stats.size <= maxBytes) {
        raw = readFileSync(sessionFile, 'utf8');
    }
    else {
        const fd = openSync(sessionFile, 'r');
        try {
            const length = Math.min(maxBytes, stats.size);
            const buffer = Buffer.alloc(length);
            readSync(fd, buffer, 0, length, stats.size - length);
            raw = buffer.toString('utf8');
        }
        finally {
            closeSync(fd);
        }
    }
    sessionTailCache.set(sessionFile, { size: stats.size, mtimeMs: stats.mtimeMs, maxBytes, raw });
    return raw;
}
function readSessionOutputSync(sessionFile, full = false) {
    return full ? readFileSync(sessionFile, 'utf8') : readSessionTailSync(sessionFile);
}
function readSessionFinalOutput(sessionFile, options = {}) {
    try {
        const raw = readSessionOutputSync(sessionFile, options.full === true);
        const records = raw.trim().split(/\r?\n/).slice(options.full ? undefined : -160).reverse();
        for (const line of records) {
            let record;
            try {
                record = JSON.parse(line);
            }
            catch {
                continue;
            }
            if (record.type !== 'message' || record.message?.role !== 'assistant')
                continue;
            const content = record.message?.content;
            if (Array.isArray(content) && content.some((part) => part?.type === 'toolCall'))
                continue;
            const text = textFromSessionMessage(record.message).replace(/^thinking:.*$/gmi, '').trim();
            if (text && !isNonFinalAssistantText(text))
                return text;
        }
    }
    catch { }
    return '';
}
function normalizeLastInputText(text) {
    return text
        .replace(/^\/goal\s+/, '')
        .replace(/\n\nWhen done, provide a concise final summary with concrete outcome, files changed, tests\/checks run, PR URL if any, and what [^\n.]+ should do next\.$/, '')
        .replace(/\s+/g, ' ')
        .trim();
}
function readSessionLastUserInput(sessionFile) {
    try {
        const raw = readSessionTailSync(sessionFile);
        const records = raw.trim().split(/\r?\n/).slice(-160).reverse();
        for (const line of records) {
            let record;
            try {
                record = JSON.parse(line);
            }
            catch {
                continue;
            }
            if (record.type !== 'message' || record.message?.role !== 'user')
                continue;
            const text = normalizeLastInputText(textFromSessionMessage(record.message));
            if (text)
                return text;
        }
    }
    catch { }
    return '';
}
function taskLastInput(task) {
    return normalizeLastInputText(task.lastInput || '') || (task.sessionFile ? readSessionLastUserInput(task.sessionFile) : '');
}
function taskNeedsInputQuestion(task) {
    return task.progress || taskDisplayText(task) || task.error || task.needsUserReason || 'Needs input.';
}
const sessionActivityStepsCache = new Map();
function readSessionActivitySteps(sessionFile, task, maxRecords = 10) {
    const active = isTaskActive(task);
    const failed = taskStatus(task) === 'error';
    const cacheKey = [sessionFile, maxRecords, active ? 'active' : 'idle', failed ? 'failed' : 'ok'].join('\u001f');
    const cached = sessionActivityStepsCache.get(cacheKey);
    if (cached && Date.now() - cached.at < MI_SESSION_ACTIVITY_REFRESH_MS)
        return cached.value;
    try {
        const raw = readSessionTailSync(sessionFile);
        const records = raw
            .trim()
            .split(/\r?\n/)
            .slice(-120)
            .map((line) => { try {
            return JSON.parse(line);
        }
        catch {
            return undefined;
        } })
            .filter(Boolean);
        const toolResultTimes = new Map();
        for (const record of records) {
            if (record?.type !== 'message' || record?.message?.role !== 'toolResult')
                continue;
            const toolCallId = String(record.message.toolCallId || '');
            const timestamp = recordTimestampMs(record);
            if (toolCallId && timestamp)
                toolResultTimes.set(toolCallId, timestamp);
        }
        const nowMs = Date.now();
        const events = records
            .map((record) => formatSessionEvent(record, { toolResultTimes, nowMs }))
            .filter(Boolean)
            .filter((line, index, lines) => index === 0 || line !== lines[index - 1])
            .slice(-maxRecords);
        if (events.length === 0)
            return [];
        const value = events.map((line, index) => {
            const last = index === events.length - 1;
            const mark = failed && last ? '!' : active && last ? '→' : '✓';
            return `${mark} ${line}`;
        });
        sessionActivityStepsCache.set(cacheKey, { at: Date.now(), value });
        return value;
    }
    catch {
        return [];
    }
}
function shortTaskDetail(task, width) {
    const detail = taskDetail(task);
    return truncateText(detail, Math.max(0, width));
}
function formatTaskRow(task, width = 120) {
    const timeLabel = taskTimeLabel(task);
    const gap = 2;
    const nameWidth = Math.min(30, Math.max(12, Math.floor(width * 0.32)));
    const timeWidth = Math.max(4, Math.min(8, widthOf(timeLabel)));
    const detailWidth = Math.max(0, width - nameWidth - timeWidth - gap * 2);
    const name = padVisibleEnd(taskName(task), nameWidth);
    const detail = padVisibleEnd(shortTaskDetail(task, detailWidth), detailWidth);
    const time = truncateText(timeLabel, timeWidth).padStart(timeWidth);
    return truncateText(`${name}${' '.repeat(gap)}${detail}${' '.repeat(gap)}${time}`, width);
}
function sessionFingerprint(task) {
    const direct = task.sessionId ? String(task.sessionId) : '';
    if (direct)
        return direct;
    const path = String(task.sessionFile || task.actualSessionFile || '');
    const match = path.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\.jsonl)?$/i);
    return match?.[1] || '';
}
function taskIdentityKeys(task) {
    return [...new Set([task.id, task.sessionId, sessionFingerprint(task), task.sessionFile, task.actualSessionFile].filter(Boolean).map(String))];
}
function stableTaskKey(task) {
    const isPiSession = task.source === 'pi-session' || String(task.id || '').startsWith('pi-session:') || Boolean(task.sessionFile || task.actualSessionFile || task.sessionId);
    if (isPiSession)
        return task.sessionId || sessionFingerprint(task) || task.sessionFile || task.actualSessionFile || task.id || task.sessionName || task.name || '';
    return task.id || task.sessionFile || task.sessionName || task.name || '';
}
function normalizedTaskName(task) {
    return String(task.sessionName || task.name || '').trim().toLowerCase().replace(/\s+/g, ' ');
}
function isGenericTaskName(name) {
    return !name || name === 'user' || name === 'mi session' || name === 'recent mi session';
}
function taskCwdKey(task) {
    return String(task.cwd || '').replace(/\/+$/, '');
}
function normalizedTaskLastInput(task) {
    return normalizeLastInputText(task.lastInput || '').toLowerCase().slice(0, 500);
}
function tasksSameIdentity(a, b) {
    const aKeys = new Set(taskIdentityKeys(a));
    if (taskIdentityKeys(b).some((key) => aKeys.has(key)))
        return true;
    const sameCwd = taskCwdKey(a) === taskCwdKey(b);
    if (!sameCwd)
        return false;
    const aName = normalizedTaskName(a);
    const bName = normalizedTaskName(b);
    if (aName && aName === bName && !isGenericTaskName(aName))
        return true;
    const aLastInput = normalizedTaskLastInput(a);
    const bLastInput = normalizedTaskLastInput(b);
    return Boolean(aLastInput && aLastInput === bLastInput);
}
function mergeTaskIdentity(previous, next) {
    return {
        ...previous,
        ...next,
        sessionId: next.sessionId || previous.sessionId,
        sessionFile: next.sessionFile || previous.sessionFile,
        actualSessionFile: next.actualSessionFile || previous.actualSessionFile,
        sessionName: next.sessionName || previous.sessionName,
        lastInput: next.lastInput || previous.lastInput,
        text: next.text || previous.text,
        progress: next.progress || previous.progress,
    };
}
function dedupeTasksByStableKey(list) {
    const merged = [];
    for (const task of list) {
        const index = merged.findIndex((entry) => tasksSameIdentity(entry, task));
        if (index === -1)
            merged.push(task);
        else
            merged[index] = mergeTaskIdentity(merged[index], task);
    }
    return merged;
}
async function stopTaskInList(task) {
    const taskId = task.id || task.sessionFile || task.sessionName || task.name;
    if (!taskId)
        return;
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
async function dismissTaskFromList(task) {
    const taskId = task.id || task.sessionFile || task.sessionName || task.name;
    if (!taskId)
        return;
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
async function listResumeSessions() {
    const result = await sendTaskSocketRequest({ type: 'list_pi_sessions' }, 10000);
    return (result.sessions || []).sort((a, b) => taskUpdatedMs(b) - taskUpdatedMs(a) || taskStartedMs(b) - taskStartedMs(a));
}
async function taskCommand(args) {
    const name = args[0];
    if (name === 'list') {
        const tasks = await listTasks();
        if (tasks.length === 0) {
            console.log('No Mi background agents.');
            return;
        }
        for (const task of tasks)
            console.log(formatTaskRow(task));
        return;
    }
    if (name === 'reply') {
        const taskId = args[1];
        const sep = args.indexOf('--');
        const message = sep >= 0 ? args.slice(sep + 1).join(' ').trim() : args.slice(2).join(' ').trim();
        if (!taskId || !message)
            throw new Error('usage: mi task reply <task-id-or-name> -- <follow-up prompt>');
        const result = await sendTaskSocketRequest({ type: 'continue_worker', taskId, message, background: true }, 30000);
        console.log(result.text || 'Sent follow-up.');
        if (result.taskId)
            console.log(`Task: ${result.taskId}`);
        if (result.sessionFile)
            console.log(`Visible in /resume: ${result.sessionFile}`);
        return;
    }
    const cwd = argValue(args, '--cwd') || HOME;
    const sep = args.indexOf('--');
    const message = sep >= 0 ? args.slice(sep + 1).join(' ').trim() : args.slice(1).join(' ').trim();
    if (!name || !message)
        throw new Error('usage: mi task <name>|list [--cwd <path>] -- <task prompt>');
    const result = await sendTaskSocketRequest({ type: 'run_worker', name, cwd, message, background: true }, 30000);
    console.log(result.text || 'Started background task.');
    if (result.taskId)
        console.log(`Task: ${result.taskId}`);
    if (result.sessionFile)
        console.log(`Visible in /resume: ${result.sessionFile}`);
}
async function miAgentsCommand() {
    let tasks = [];
    let optimisticTasks = [];
    let selected = 0;
    let closed = false;
    const defaultAgentStatus = '^L full output • ^M multi-select • Esc clear task';
    let status = defaultAgentStatus;
    let inputMode = 'normal';
    let inputBuffer = '';
    let pendingName = '';
    let replyTarget;
    let miChatTask;
    let btwAnswer = '';
    let fullLastOutputMode = false;
    let fullLastOutputScroll = 0;
    let agentSubmitting = false;
    let multiSelectMode = false;
    const selectedTaskKeys = new Set();
    const pendingTaskUpdates = new Map();
    const pendingTaskUpdateStartedAt = new Map();
    let resumeMode = false;
    let resumeSessions = [];
    let resumeSelected = 0;
    let resumeLoading = false;
    let resumeEnterPending = false;
    let resumeMultiSelectMode = false;
    const selectedResumeKeys = new Set();
    let tui;
    let pollTimer;
    let clockTimer;
    const renderTestMode = process.env.MI_AGENT_RENDER_TEST === '1';
    let piCycleConfig = renderTestMode ? { shortcut: 'z', tiers: { '1': [MI_MODEL], '2': [MI_MODEL], '3': [MI_MODEL] }, thinkingLevels: {} } : await loadPiCycleConfig();
    const piCycleNextIndex = { '1': 0, '2': 0, '3': 0 };
    let agentModelSpec = MI_MODEL;
    let agentThinkingLevel = String(MI_MODEL).match(/:(off|minimal|low|medium|high|xhigh)$/)?.[1];
    let agentModelPicker;
    const dismissedTaskKeys = new Set();
    const renderTestRows = Number(process.env.MI_AGENT_RENDER_TEST_ROWS || '') || undefined;
    const renderTestCols = Number(process.env.MI_AGENT_RENDER_TEST_COLS || '') || undefined;
    const rows = () => renderTestRows || process.stdout.rows || 24;
    const cols = () => renderTestCols || process.stdout.columns || 100;
    const agentEditorTui = { terminal: { rows: process.stdout.rows || 24 }, requestRender() { requestRender(); } };
    const agentEditor = new Editor(agentEditorTui, piEditorTheme(agentThinkingLevel));
    if (!renderTestMode)
        agentEditor.setAutocompleteProvider(createPiSlashAutocompleteProvider());
    let syncingAgentEditor = false;
    agentEditor.focused = true;
    agentEditor.onChange = (text) => {
        inputBuffer = text;
        if (syncingAgentEditor)
            return;
        if (inputMode === 'normal' && text.length > 0 && !text.startsWith('/')) {
            replyTarget = selectedTask();
            inputMode = replyTarget ? 'reply' : 'normal';
            status = replyTarget ? `Reply to ${taskName(replyTarget)}` : 'Select a task or use /new';
        }
        if ((inputMode === 'reply' || inputMode === 'mi-chat') && text.length === 0)
            clearAgentInputModeIfEmpty();
        requestRender();
    };
    agentEditor.onSubmit = (value) => {
        inputBuffer = value;
        void submitAgentInput().then(() => requestRender()).catch((error) => {
            status = error instanceof Error ? error.message : String(error);
            inputMode = 'normal';
            agentSubmitting = false;
            requestRender();
        });
    };
    function setAgentInput(text) {
        inputBuffer = text;
        syncingAgentEditor = true;
        agentEditor.setText(text);
        syncingAgentEditor = false;
        requestRender();
    }
    function taskRenderSignature(task) {
        return [stableTaskKey(task), task.status, task.needsUser, task.needsUserReason, task.error, task.progress, task.text, task.finishedAt, task.updatedAt].map((value) => String(value ?? '')).join('\u001f');
    }
    async function refresh() {
        let forceFullRender = false;
        try {
            const beforeRenderSignature = tasks.map(taskRenderSignature).join('\u001e');
            const selectedKey = selectedTask() ? stableTaskKey(selectedTask()) : '';
            const listedTasks = dedupeTasksByStableKey((await listTasks()).filter((task) => !dismissedTaskKeys.has(stableTaskKey(task))));
            optimisticTasks = optimisticTasks.filter((optimistic) => !listedTasks.some((task) => tasksSameIdentity(task, optimistic)));
            tasks = dedupeTasksByStableKey([...optimisticTasks, ...listedTasks]).map((task) => {
                const key = stableTaskKey(task);
                const terminal = ['complete', 'error', 'stopped', 'paused'].includes(String(task.status || '').toLowerCase());
                if (terminal) {
                    const pendingStartedAt = pendingTaskUpdateStartedAt.get(key) || 0;
                    const terminalAt = Date.parse(task.finishedAt || task.updatedAt || task.continuedAt || '') || 0;
                    if (terminalAt > pendingStartedAt) {
                        pendingTaskUpdates.delete(key);
                        pendingTaskUpdateStartedAt.delete(key);
                    }
                }
                const update = pendingTaskUpdates.get(key);
                return update ? { ...task, ...update } : task;
            });
            if (selectedKey) {
                const nextSelected = tasks.findIndex((task) => stableTaskKey(task) === selectedKey);
                if (nextSelected >= 0)
                    selected = nextSelected;
            }
            clampTaskSelection();
            forceFullRender = beforeRenderSignature !== tasks.map(taskRenderSignature).join('\u001e');
            status = inputMode === 'normal' && !agentSubmitting ? (multiSelectMode ? multiSelectStatus() : defaultAgentStatus) : status;
        }
        catch (error) {
            status = error instanceof Error ? error.message : String(error);
        }
        requestRender(forceFullRender);
    }
    function requestRender(force = false) {
        // Use differential renders for spinner/input updates to avoid flicker.
        // Callers pass force=true for structural list changes or explicit refreshes
        // so stale rows cannot look like duplicate tasks.
        tui?.requestRender?.(force);
    }
    function reclickFullOutputIfActive() {
        if (!fullLastOutputMode)
            return;
        fullLastOutputScroll = 0;
        status = 'Full output • ↑/↓ scroll • ^L back';
        if (!renderTestMode)
            process.stdout.write('\x1b[2J\x1b[H');
        requestRender(true);
    }
    function selectedTask() {
        return selected >= 0 ? tasks[selected] : undefined;
    }
    function clampTaskSelection() {
        selected = tasks.length > 0 && selected >= 0 ? Math.min(selected, tasks.length - 1) : -1;
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
    function agentInputVisibleLines(width, maxLines) {
        const wrapped = wrapPlain(inputBuffer, Math.max(1, width));
        return (wrapped.length > 0 ? wrapped : ['']).slice(-Math.max(1, maxLines));
    }
    function agentInputCursorColumn(inputLines, width) {
        const lastLine = inputLines[inputLines.length - 1] || '';
        return Math.min(width, widthOf(lastLine) + 1);
    }
    function piCycleThinkingLevel(tier, modelSpec) {
        return piCycleConfig.thinkingLevels?.[`${tier}:${modelSpec}`] || piCycleConfig.thinkingLevels?.[modelSpec];
    }
    async function applyAgentPiCycle(text) {
        piCycleConfig = await loadPiCycleConfig();
        const shortcut = piCycleConfig.shortcut || 'z';
        const escaped = shortcut.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const match = text.match(new RegExp(`^((?:${escaped}){1,3})(?:\\s+([\\s\\S]*)|$)`));
        if (!match || match[1].length % shortcut.length !== 0)
            return { body: text, model: agentModelWithThinking() };
        const tier = String(match[1].length / shortcut.length);
        const models = piCycleConfig.tiers[tier] || [];
        if (models.length === 0)
            throw new Error(`pi-cycle tier ${tier} has no models`);
        const index = piCycleNextIndex[tier] % models.length;
        const modelSpec = models[index];
        piCycleNextIndex[tier] = (index + 1) % models.length;
        agentThinkingLevel = piCycleThinkingLevel(tier, modelSpec) || agentThinkingLevel;
        agentModelSpec = agentModelWithThinking(modelSpec, agentThinkingLevel);
        requestRender();
        return { body: (match[2] || '').trim(), model: agentModelSpec };
    }
    function clearAgentInputModeIfEmpty() {
        if ((inputMode === 'reply' || inputMode === 'mi-chat') && inputBuffer.length === 0) {
            if (inputMode === 'reply') {
                inputMode = 'normal';
                replyTarget = undefined;
                status = defaultAgentStatus;
            }
            return true;
        }
        return false;
    }
    async function askMiAboutTask(task, question) {
        const taskContext = [
            `Task: ${taskName(task)}`,
            `Status: ${taskStatus(task)}`,
            task.sessionFile ? `session: ${task.sessionFile}` : '',
            task.needsUser ? `needs input: ${task.needsUserReason || 'attention'}` : '',
            task.progress ? `progress: ${task.progress}` : '',
            task.text ? `latest result: ${task.text.slice(0, 1200)}` : '',
            task.error ? `error: ${task.error}` : '',
        ].filter(Boolean).join('\n');
        return normalizeMiResponse(await sendToMiMain([
            `You are Mi, ${miUserPossessive()} private persistent assistant. Answer only about the selected background task below. If the question is unrelated, say you can only answer about the selected task here.`,
            `Selected task context:\n${taskContext}`,
            `${miUserPossessive({ capitalize: true })} message in the ongoing /mi chat about this task:\n${question}`,
        ].join('\n\n')));
    }
    function multiSelectStatus() {
        return `${selectedTaskKeys.size} selected • Enter toggle • Esc clear selected • ^C exit multi-select`;
    }
    function toggleSelectedTaskForBulkClear() {
        const task = selectedTask();
        const key = task ? stableTaskKey(task) : '';
        if (!key)
            return;
        if (selectedTaskKeys.has(key))
            selectedTaskKeys.delete(key);
        else
            selectedTaskKeys.add(key);
        status = multiSelectStatus();
        requestRender();
    }
    function toggleMultiSelectMode() {
        multiSelectMode = !multiSelectMode;
        if (!multiSelectMode)
            selectedTaskKeys.clear();
        status = multiSelectMode ? multiSelectStatus() : defaultAgentStatus;
        requestRender();
    }
    function clearSelectedTasksFromList() {
        const selectedKeys = new Set(selectedTaskKeys);
        const toDismiss = tasks.filter((task) => selectedKeys.has(stableTaskKey(task)));
        if (!renderTestMode)
            for (const task of toDismiss)
                void dismissTaskFromList(task).catch((error) => { status = error instanceof Error ? error.message : String(error); requestRender(true); });
        for (const key of selectedKeys)
            dismissedTaskKeys.add(key);
        tasks = tasks.filter((task) => !selectedKeys.has(stableTaskKey(task)));
        optimisticTasks = optimisticTasks.filter((task) => !selectedKeys.has(stableTaskKey(task)));
        selectedTaskKeys.clear();
        multiSelectMode = false;
        clampTaskSelection();
        status = `Removed ${toDismiss.length} task${toDismiss.length === 1 ? '' : 's'} from list`;
        requestRender(true);
    }
    function updateAgentEditorBorderColor() {
        agentEditor.borderColor = thinkingBorderColor(agentThinkingLevel);
    }
    function cycleAgentThinking() {
        const currentIndex = THINKING_LEVELS.indexOf(agentThinkingLevel || 'low');
        agentThinkingLevel = THINKING_LEVELS[(currentIndex + 1) % THINKING_LEVELS.length];
        agentModelSpec = agentModelWithThinking(agentModelSpec, agentThinkingLevel);
        updateAgentEditorBorderColor();
        status = `Thinking level: ${agentThinkingLevel}`;
        requestRender();
    }
    async function runAgentSlashCommand(value) {
        if (!value.startsWith('/'))
            return false;
        if (value === '/goal' || value.startsWith('/goal '))
            return false;
        if (value === '/quit') {
            close();
            return true;
        }
        if (value.startsWith('/mi')) {
            const question = value.slice('/mi'.length).trim();
            const task = selectedTask();
            if (!question) {
                status = 'Usage: /mi <question about selected task>';
                requestRender();
                return true;
            }
            if (!task) {
                status = 'Select a task before using /mi';
                requestRender();
                return true;
            }
            miChatTask = task;
            status = 'Asking Mi about selected task...';
            requestRender();
            void (async () => {
                btwAnswer = await askMiAboutTask(task, question);
                inputMode = 'mi-chat';
                setAgentInput('');
                status = `Chatting with Mi about ${taskName(task)} • ^C end`;
                requestRender();
            })()
                .catch((error) => { inputMode = 'normal'; miChatTask = undefined; status = error instanceof Error ? error.message : String(error); requestRender(); });
            return true;
        }
        if (value.startsWith('/new')) {
            const prompt = value.slice('/new'.length).trim();
            inputMode = 'new-prompt';
            pendingName = '';
            replyTarget = undefined;
            selected = -1;
            setAgentInput(prompt);
            status = 'New task';
            requestRender();
            if (prompt)
                void submitAgentInput();
            return true;
        }
        if (value === '/scoped-models') {
            if (tui) {
                status = 'Loading scoped models...';
                requestRender();
                agentModelPicker = await createExactPiScopedModelsSelector(tui, () => {
                    agentModelPicker = undefined;
                    status = defaultAgentStatus;
                    requestRender();
                }, (message) => { status = message; });
                status = 'Configure scoped models';
            }
            requestRender();
            return true;
        }
        if (value === '/model' || value.startsWith('/model ')) {
            const modelQuery = value.replace(/^\/model\b/, '').trim();
            if (tui) {
                agentModelPicker = await createExactPiModelSelector(tui, modelFromSpec(agentModelBase()), (model) => {
                    agentModelSpec = agentModelWithThinking(modelRef(model), agentThinkingLevel);
                    agentModelPicker = undefined;
                    updateAgentEditorBorderColor();
                    status = `Model: ${agentModelSpec}`;
                    requestRender();
                }, () => {
                    agentModelPicker = undefined;
                    status = defaultAgentStatus;
                    requestRender();
                }, modelQuery || undefined);
                status = 'Select model';
            }
            requestRender();
            return true;
        }
        if (value === '/resume' || value.startsWith('/resume ')) {
            inputMode = 'normal';
            pendingName = '';
            replyTarget = undefined;
            await openResumeMenu();
            return true;
        }
        if (value === '/open') {
            inputMode = 'normal';
            pendingName = '';
            replyTarget = undefined;
            await openSelectedInPi();
            return true;
        }
        if (MI_BLOCKED_PI_SLASH_COMMANDS.has(slashCommandName(value))) {
            status = `${slashCommandName(value)} is a Pi app command; open Pi directly to use it.`;
            requestRender();
            return true;
        }
        await runSlashCommandInPi(value);
        return true;
    }
    function sectionTaskItems(label) {
        return tasks
            .map((task, index) => ({ task, index }))
            .filter((item) => taskSection(item.task) === label)
            .sort((a, b) => taskStartedMs(a.task) - taskStartedMs(b.task) || taskUpdatedMs(a.task) - taskUpdatedMs(b.task));
    }
    function navigationTaskIndexes() {
        return ['needs input', 'working', 'completed'].flatMap((label) => sectionTaskItems(label).map((item) => item.index));
    }
    function moveAgentListSelection(delta) {
        const indexes = navigationTaskIndexes();
        if (indexes.length === 0)
            return;
        const current = selected >= 0 ? indexes.indexOf(selected) : -1;
        const next = current < 0
            ? (delta > 0 ? 0 : indexes.length - 1)
            : Math.max(0, Math.min(indexes.length - 1, current + delta));
        selected = indexes[next];
        requestRender();
    }
    function moveResumeSelection(delta) {
        if (resumeSessions.length === 0)
            return;
        resumeSelected = Math.max(0, Math.min(resumeSessions.length - 1, resumeSelected + delta));
        requestRender();
    }
    async function openResumeMenu() {
        resumeMode = true;
        resumeLoading = true;
        resumeEnterPending = false;
        resumeMultiSelectMode = false;
        selectedResumeKeys.clear();
        resumeSessions = [];
        resumeSelected = 0;
        status = 'Loading pi sessions...';
        requestRender();
        resumeSessions = await listResumeSessions();
        resumeSelected = 0;
        resumeLoading = false;
        status = resumeSessions.length > 0 ? '^M multi-select • Enter add session as task • Esc cancel' : 'No pi sessions found';
        requestRender();
        if (resumeEnterPending && resumeSessions.length > 0) {
            resumeEnterPending = false;
            await addSelectedResumeSession();
        }
    }
    function resumeSessionRequest(session) {
        return {
            type: 'resume_session',
            taskId: session.id,
            id: session.id,
            sessionFile: session.sessionFile,
            actualSessionFile: session.actualSessionFile,
            sessionId: session.sessionId,
            sessionName: session.sessionName,
            name: session.name,
        };
    }
    async function addSelectedResumeSession() {
        const session = resumeSessions[resumeSelected];
        if (!session)
            return;
        const result = await sendTaskSocketRequest(resumeSessionRequest(session), 10000);
        status = result.text || `Added ${taskName(session)} as task`;
        resumeMode = false;
        await refresh();
    }
    function toggleSelectedResumeSession() {
        const session = resumeSessions[resumeSelected];
        const key = session ? stableTaskKey(session) : '';
        if (!key)
            return;
        if (selectedResumeKeys.has(key))
            selectedResumeKeys.delete(key);
        else
            selectedResumeKeys.add(key);
        status = `${selectedResumeKeys.size} selected • Enter add selected • Esc cancel • ^M exit multi-select`;
        requestRender();
    }
    async function addSelectedResumeSessions() {
        const selectedKeys = new Set(selectedResumeKeys);
        const selectedSessions = resumeSessions.filter((session) => selectedKeys.has(stableTaskKey(session)));
        for (const session of selectedSessions)
            await sendTaskSocketRequest(resumeSessionRequest(session), 10000);
        status = `Added ${selectedSessions.length} session${selectedSessions.length === 1 ? '' : 's'} as tasks`;
        resumeMode = false;
        resumeMultiSelectMode = false;
        selectedResumeKeys.clear();
        await refresh();
    }
    function normalizeVisibleTasks() {
        const selectedKey = selectedTask() ? stableTaskKey(selectedTask()) : '';
        const deduped = dedupeTasksByStableKey(tasks);
        if (deduped.length !== tasks.length) {
            tasks = deduped;
            if (selectedKey) {
                const nextSelected = tasks.findIndex((task) => stableTaskKey(task) === selectedKey);
                if (nextSelected >= 0)
                    selected = nextSelected;
            }
            clampTaskSelection();
        }
    }
    function renderAgentLines(width = cols()) {
        if (closed)
            return [];
        normalizeVisibleTasks();
        const height = rows();
        if (agentModelPicker) {
            const lines = agentModelPicker.render(width);
            while (lines.length < height)
                lines.push('');
            return lines.slice(0, height);
        }
        agentEditorTui.terminal.rows = height;
        const piEditor = renderTestMode
            ? { markedLines: [`> ${inputBuffer}`], lines: [`> ${inputBuffer}`], cursor: { row: 0, col: Math.min(width, inputBuffer.length + 3) } }
            : renderPiEditor(agentEditor, width);
        // Keep the prompt anchored at the bottom. When users paste/type a long
        // prompt, let it grow upward by shrinking the agent list/detail area rather
        // than overflowing below the terminal and confusing the differential
        // renderer. Keep the cursor-containing tail visible.
        const maxInputLines = Math.max(1, height - 4);
        const rawInputLines = piEditor.markedLines;
        const inputLines = rawInputLines.length > maxInputLines ? rawInputLines.slice(-maxInputLines) : rawInputLines;
        const footerLines = [
            '',
            ...inputLines.map((line) => truncateText(line, width)),
            fgDim(truncateText(agentModelWithThinking(), width).padStart(width)),
        ];
        const contentHeight = Math.max(0, height - footerLines.length);
        const listHeight = Math.max(1, Math.floor(contentHeight * 0.55));
        const lines = [];
        const task = selectedTask();
        const fullLastOutput = fullLastOutputMode && task
            ? (taskFinalOutput(task, { full: true }) || taskDisplayText(task) || task.progress || 'No result yet.')
            : '';
        if (fullLastOutput && task) {
            lines.push(fgAccent(truncateText('mi agents', width)) + fgLightGrey(truncateText(`  ${status}`, Math.max(0, width - widthOf('mi agents')))));
            lines.push(fgThinking(undefined, '─'.repeat(width)));
            const lastInput = taskLastInput(task);
            if (lastInput) {
                lines.push('');
                lines.push(...renderPiUserMessage(lastInput, width));
                lines.push('');
            }
            const outputLines = renderPiLastOutputMessage(fullLastOutput || 'No result yet.', width);
            // Like pi: render the last input, then the whole output above the normal
            // input footer instead of fitting it into an internal viewport. The
            // terminal/tmux scrollback owns scrolling; because the footer is last,
            // the visible screen lands at the latest output with input still usable.
            lines.push(...outputLines);
            lines.push(...footerLines);
            return lines.map((line) => padVisibleEnd(truncateText(line, width), width));
        }
        lines.push(fgAccent(truncateText('mi agents', width)) + fgLightGrey(truncateText(`  ${status}`, Math.max(0, width - widthOf('mi agents')))));
        lines.push(fgThinking(undefined, '─'.repeat(width)));
        if (resumeMode) {
            lines.push(fgDim(truncateText('resume pi sessions', width)));
            if (resumeSessions.length === 0) {
                lines.push(fgDim('No pi sessions found.'));
            }
            else {
                const start = Math.max(0, Math.min(resumeSelected - Math.floor(listHeight / 2), Math.max(0, resumeSessions.length - listHeight)));
                for (const { task, index } of resumeSessions.slice(start, start + listHeight).map((task, offset) => ({ task, index: start + offset }))) {
                    const key = stableTaskKey(task);
                    const symbol = resumeMultiSelectMode ? (selectedResumeKeys.has(key) ? '✓' : ' ') : taskActivitySymbol(task, false);
                    const prefix = index === resumeSelected ? '→ ' : '  ';
                    const text = truncateText(`${prefix}${symbol} ${formatTaskRow(task, width - 4)}`, width);
                    lines.push(index === resumeSelected ? fgAccent(text) : text);
                }
            }
        }
        else if (tasks.length === 0) {
            lines.push(fgDim('No background agents. Use /new to start one.'));
        }
        else {
            const selectedSection = selectedTask() ? taskSection(selectedTask()) : undefined;
            const groupedRows = [];
            for (const label of ['needs input', 'working', 'completed']) {
                const sectionTasks = sectionTaskItems(label);
                if (sectionTasks.length === 0)
                    continue;
                const visibleSectionTasks = label === 'completed' && selectedSection !== 'completed'
                    ? sectionTasks.slice(0, 3)
                    : sectionTasks;
                groupedRows.push({ kind: 'header', label: label === 'completed' && visibleSectionTasks.length < sectionTasks.length ? `completed (${visibleSectionTasks.length} shown of ${sectionTasks.length})` : label });
                groupedRows.push(...visibleSectionTasks.map((item) => ({ kind: 'task', ...item })));
            }
            const selectedRow = Math.max(0, groupedRows.findIndex((row) => row.kind === 'task' && row.index === selected));
            const start = Math.max(0, Math.min(selectedRow - Math.floor(listHeight / 2), Math.max(0, groupedRows.length - listHeight)));
            for (const row of groupedRows.slice(start, start + listHeight)) {
                if (row.kind === 'header') {
                    lines.push(fgDim(truncateText(row.label, width)));
                }
                else {
                    const key = stableTaskKey(row.task);
                    const symbol = multiSelectMode ? (selectedTaskKeys.has(key) ? '✓' : ' ') : taskActivitySymbol(row.task, false);
                    const prefix = row.index === selected ? '→ ' : '  ';
                    const text = truncateText(`${prefix}${symbol} ${formatTaskRow(row.task, width - 4)}`, width);
                    lines.push(row.index === selected ? fgAccent(text) : text);
                }
            }
        }
        if (!fullLastOutput)
            lines.push(fgThinking(undefined, '─'.repeat(width)));
        const maxCollapsedActivityLines = Math.max(1, Math.min(12, Math.floor(contentHeight * 0.5)));
        const remainingContentLines = () => Math.max(0, contentHeight - lines.length);
        const collapsedDetailBudget = () => Math.max(1, Math.min(maxCollapsedActivityLines, remainingContentLines()));
        const detailBudget = collapsedDetailBudget();
        if (!fullLastOutput && btwAnswer) {
            lines.push(fgAccent(truncateText('mi', width)));
            lines.push(...renderPiAssistantMessage(btwAnswer, width).slice(0, detailBudget));
        }
        else if (task) {
            // The selected task is already shown in the list above. Repeating its
            // title here looked like a duplicated task row in mi agents.
            if (task.sessionName || task.sessionFile)
                lines.push(fgDim(truncateText(`session: ${task.sessionName || ''} ${task.sessionFile || ''}`, width)));
            const prUrls = extractPrUrlsFromTask(task);
            if (prUrls.length > 0)
                lines.push(fgDim(truncateText(`PR: ${prUrls.join(' ')}`, width)));
            const lastInput = taskLastInput(task);
            if (lastInput) {
                lines.push('');
                lines.push(...renderPiUserMessage(lastInput, width).slice(-Math.max(1, Math.min(4, remainingContentLines()))));
            }
            if (isTaskNeedsInput(task)) {
                lines.push('');
                if (!task.error && task.needsUserReason === 'stopped by Escape' && task.sessionFile) {
                    const activity = readSessionActivitySteps(task.sessionFile, task, 12);
                    const body = activity.length > 0 ? activity.map((line) => truncateText(line, width)) : renderPiAssistantMessage(taskNeedsInputQuestion(task), width);
                    lines.push(...body.slice(-collapsedDetailBudget()));
                }
                else {
                    const errorText = task.error || taskNeedsInputQuestion(task);
                    lines.push(...renderPiAssistantMessage(errorText, width).slice(-collapsedDetailBudget()));
                }
            }
            else if (isTaskActive(task) && task.sessionFile) {
                const activity = readSessionActivitySteps(task.sessionFile, task, 12);
                lines.push('');
                if (activity.length > 0) {
                    lines.push(...activity.map((line) => truncateText(line, width)).slice(-collapsedDetailBudget()));
                }
                else {
                    const body = task.error || task.progress || taskDisplayText(task) || 'No activity yet.';
                    lines.push(...renderPiAssistantMessage(body, width).slice(-collapsedDetailBudget()));
                }
            }
            else {
                const finalOutput = taskFinalOutput(task);
                lines.push('');
                const outputBudget = Math.max(1, remainingContentLines());
                lines.push(...renderPiLastOutputMessage(finalOutput || 'No result yet.', width).slice(0, outputBudget));
            }
        }
        if (lines.length > contentHeight)
            lines.splice(contentHeight);
        while (lines.length < contentHeight)
            lines.push('');
        lines.push(...footerLines);
        while (lines.length < height)
            lines.push('');
        return lines.slice(0, height).map((line) => padVisibleEnd(truncateText(line, width), width));
    }
    async function openPi(args, cwd = HOME) {
        close();
        await new Promise((resolve, reject) => {
            const child = spawn(process.env.PI_CMD || 'pi', args, { cwd, env: process.env, stdio: 'inherit' });
            child.on('error', reject);
            child.on('close', () => resolve());
        });
    }
    async function openSelectedInPi() {
        const task = selectedTask();
        if (!task?.sessionFile) {
            status = 'Selected agent has no session file yet.';
            requestRender();
            return;
        }
        await openPi(['--session', task.sessionFile], task.cwd || HOME);
    }
    async function runSlashCommandInPi(value) {
        const task = replyTarget || selectedTask();
        if (task?.sessionFile)
            return openPi(['--session', task.sessionFile, value], task.cwd || HOME);
        return openPi([value], HOME);
    }
    async function submitAgentInput() {
        const value = inputBuffer.trim();
        setAgentInput('');
        if (await runAgentSlashCommand(value)) {
            if (inputMode === 'new-prompt')
                return;
            inputMode = 'normal';
            pendingName = '';
            replyTarget = undefined;
            return;
        }
        if (inputMode === 'new-name') {
            if (!value) {
                inputMode = 'normal';
                requestRender();
                return;
            }
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
            if (!value)
                return;
            const turn = await applyAgentPiCycle(value);
            if (!turn.body)
                return;
            const name = explicitName || taskNameFromPrompt(turn.body);
            const optimisticTask = {
                id: `pending_${Date.now().toString(36)}`,
                name,
                cwd: HOME,
                status: 'queued',
                startedAt: new Date().toISOString(),
                progress: turn.body,
                lastInput: turn.body,
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
        if (inputMode === 'normal' && value) {
            const task = selectedTask();
            if (!task) {
                status = 'Select a task or use /new';
                setAgentInput(value);
                requestRender();
                return;
            }
            replyTarget = task;
            inputMode = 'reply';
        }
        if (inputMode === 'mi-chat') {
            const task = miChatTask || selectedTask();
            if (!task || !value)
                return;
            status = 'Asking Mi...';
            requestRender();
            btwAnswer = await askMiAboutTask(task, value);
            inputMode = 'mi-chat';
            miChatTask = task;
            status = `Chatting with Mi about ${taskName(task)} • ^C end`;
            requestRender();
            return;
        }
        if (inputMode === 'reply') {
            const task = replyTarget || selectedTask();
            replyTarget = undefined;
            inputMode = 'normal';
            if (!task || !value)
                return;
            const taskId = task.id || task.sessionFile || task.sessionName || task.name;
            const taskKey = stableTaskKey(task);
            const startedAt = Date.now();
            const immediateRunningUpdate = { status: 'running', needsUser: false, needsUserReason: undefined, finishedAt: undefined, text: undefined, error: undefined, progress: value, lastInput: value, continuedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
            Object.assign(task, immediateRunningUpdate);
            if (taskKey) {
                pendingTaskUpdates.set(taskKey, immediateRunningUpdate);
                pendingTaskUpdateStartedAt.set(taskKey, startedAt);
            }
            status = `Sent follow-up to ${taskName(task)}`;
            agentSubmitting = true;
            reclickFullOutputIfActive();
            requestRender();
            const turn = await applyAgentPiCycle(value);
            if (!turn.body)
                return;
            const runningUpdate = { ...immediateRunningUpdate, progress: turn.body, lastInput: turn.body, updatedAt: new Date().toISOString() };
            Object.assign(task, runningUpdate);
            if (taskKey)
                pendingTaskUpdates.set(taskKey, runningUpdate);
            reclickFullOutputIfActive();
            requestRender();
            void sendTaskSocketRequest({ type: 'continue_worker', taskId, message: turn.body, model: turn.model, background: true }, 30000)
                .then(async () => {
                if (taskKey) {
                    pendingTaskUpdates.delete(taskKey);
                    pendingTaskUpdateStartedAt.delete(taskKey);
                }
                await refresh();
                setTimeout(() => void refresh(), 250);
            })
                .catch((error) => {
                if (taskKey) {
                    pendingTaskUpdates.delete(taskKey);
                    pendingTaskUpdateStartedAt.delete(taskKey);
                }
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
        if (closed)
            return;
        closed = true;
        if (pollTimer)
            clearInterval(pollTimer);
        if (clockTimer)
            clearInterval(clockTimer);
        tui?.stop();
        tui = undefined;
    }
    function handleAgentEditorInput(data) {
        agentEditor.handleInput(data);
        inputBuffer = agentEditor.getText();
        requestRender();
    }
    function isAgentTextPasteInput(data) {
        return data.includes('\x1b[200~') || (data.length > 1 && data.includes('\n') && /[^\r\n]/.test(data) && !data.includes('\x1b'));
    }
    function handleAgentTextPasteInput(data) {
        if (inputMode === 'normal' && !inputBuffer) {
            const task = selectedTask();
            if (task) {
                replyTarget = task;
                inputMode = 'reply';
                status = `Reply to ${taskName(task)}`;
            }
        }
        handleAgentEditorInput(data.includes('\x1b[200~') ? data : `\x1b[200~${data}\x1b[201~`);
    }
    function onData(data) {
        if (isAgentTextPasteInput(data)) {
            handleAgentTextPasteInput(data);
            return;
        }
        const keyParts = splitTerminalInput(data);
        if (keyParts.length > 1) {
            for (const keyPart of keyParts)
                onData(keyPart);
            return;
        }
        if (agentModelPicker) {
            agentModelPicker.handleInput(data);
            requestRender();
            return;
        }
        if (matchesKey(data, 'ctrl+c')) {
            if (multiSelectMode && !inputBuffer) {
                multiSelectMode = false;
                selectedTaskKeys.clear();
                status = defaultAgentStatus;
            }
            else if (inputBuffer) {
                setAgentInput('');
                inputMode = 'normal';
                pendingName = '';
                replyTarget = undefined;
                miChatTask = undefined;
                status = defaultAgentStatus;
            }
            else {
                status = 'Use /quit to exit';
            }
            requestRender();
            return;
        }
        if (data === '\x0c' || data.includes('\x0c')) {
            fullLastOutputMode = !fullLastOutputMode;
            fullLastOutputScroll = 0;
            status = fullLastOutputMode ? 'Full output • ↑/↓ scroll • ^L back' : defaultAgentStatus;
            if (!renderTestMode)
                process.stdout.write('\x1b[2J\x1b[H');
            tui?.requestRender?.(true) ?? requestRender();
            return;
        }
        if (matchesKey(data, 'shift+tab') || data === '\x1b[Z' || data === '\x1b[1;2Z' || data === '\x1b\t' || data.includes('\x1b[Z') || data.includes('\x1b[1;2Z')) {
            cycleAgentThinking();
            return;
        }
        if (inputMode !== 'normal') {
            if (data.includes('\r') || data.includes('\n')) {
                void submitAgentInput().then(() => requestRender()).catch((error) => {
                    status = error instanceof Error ? error.message : String(error);
                    inputMode = 'normal';
                    agentSubmitting = false;
                    requestRender();
                });
                return;
            }
            if (data === '\x1b' || data === '\x03') {
                if (inputMode === 'mi-chat' && data === '\x1b') {
                    status = miChatTask ? `Chatting with Mi about ${taskName(miChatTask)} • ^C end` : defaultAgentStatus;
                    requestRender();
                    return;
                }
                const wasMiChat = inputMode === 'mi-chat';
                inputMode = 'normal';
                setAgentInput('');
                pendingName = '';
                replyTarget = undefined;
                miChatTask = undefined;
                status = wasMiChat || data === '\x1b' ? defaultAgentStatus : 'Use /quit to exit';
                requestRender();
                return;
            }
            handleAgentEditorInput(data);
            return;
        }
        if (data === '\x03') {
            if (inputBuffer)
                setAgentInput('');
            status = 'Use /quit to exit';
            requestRender();
            return;
        }
        if (resumeMode && !inputBuffer) {
            const keys = data.match(/\x1b\[27;\d+;\d+~|\x1b\[\d+(?::\d*)?(?::\d+)?(?:;\d+)?(?::\d+)?u|\x1b\[5(?:;\d+)?~|\x1b\[6(?:;\d+)?~|\x1b\[[AB]|\x1bO[AB]|\r|\n|\x03|\x1b|./gs) || [];
            for (const key of keys) {
                if (!resumeMode)
                    break;
                if (key === '\x1b' || key === '\x03') {
                    if (resumeMultiSelectMode && selectedResumeKeys.size > 0)
                        selectedResumeKeys.clear();
                    else
                        resumeMode = false;
                    resumeMultiSelectMode = false;
                    status = resumeMode ? '^M multi-select • Enter add session as task • Esc cancel' : defaultAgentStatus;
                    requestRender();
                }
                else if (key === '\r' || key === '\n') {
                    if (resumeLoading) {
                        resumeEnterPending = true;
                        status = 'Loading pi sessions...';
                        requestRender();
                    }
                    else if (resumeMultiSelectMode)
                        void addSelectedResumeSessions().catch((error) => { status = error instanceof Error ? error.message : String(error); resumeMode = false; resumeMultiSelectMode = false; requestRender(); });
                    else
                        void addSelectedResumeSession().catch((error) => { status = error instanceof Error ? error.message : String(error); resumeMode = false; requestRender(); });
                    return;
                }
                else if (isCtrlMShortcut(key)) {
                    resumeMultiSelectMode = !resumeMultiSelectMode;
                    if (!resumeMultiSelectMode)
                        selectedResumeKeys.clear();
                    status = resumeMultiSelectMode ? `${selectedResumeKeys.size} selected • Enter add selected • Esc cancel • ^M exit multi-select` : '^M multi-select • Enter add session as task • Esc cancel';
                    requestRender();
                }
                else if (resumeMultiSelectMode && key === ' ') {
                    toggleSelectedResumeSession();
                }
                else if (/\x1b\[5(?:;\d+)?~/.test(key))
                    moveResumeSelection(-5);
                else if (/\x1b\[6(?:;\d+)?~/.test(key))
                    moveResumeSelection(5);
                else if (key === '\x1b[A' || key === '\x1bOA')
                    moveResumeSelection(-1);
                else if (key === '\x1b[B' || key === '\x1bOB')
                    moveResumeSelection(1);
            }
            return;
        }
        if (fullLastOutputMode && !inputBuffer && (isPageUpKey(data) || isPageDownKey(data))) {
            // Do not implement an internal full-output pager. Native terminal/tmux
            // scrollback handles long output like pi; PageUp/PageDown switch the
            // selected task whose full output is shown.
            if (tasks.length > 0)
                selected = Math.max(0, Math.min(tasks.length - 1, selected + (isPageUpKey(data) ? -1 : 1)));
            fullLastOutputScroll = 0;
            requestRender();
            return;
        }
        if (isPageUpKey(data) || isPageDownKey(data)) {
            if (!inputBuffer) {
                moveAgentListSelection(isPageUpKey(data) ? -5 : 5);
                return;
            }
            handleAgentEditorInput(data);
            return;
        }
        if (btwAnswer && data !== '\x1b') {
            btwAnswer = '';
        }
        if (data === '\x1b') {
            if (inputBuffer) {
                setAgentInput('');
                status = defaultAgentStatus;
                requestRender();
                return;
            }
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
                if (isTaskNeedsInput(task)) {
                    const key = stableTaskKey(task);
                    if (key) {
                        dismissedTaskKeys.add(key);
                        pendingTaskUpdates.delete(key);
                        pendingTaskUpdateStartedAt.delete(key);
                    }
                    tasks = tasks.filter((entry) => stableTaskKey(entry) !== key);
                    optimisticTasks = optimisticTasks.filter((entry) => stableTaskKey(entry) !== key);
                    clampTaskSelection();
                    status = `Removed ${taskName(task)} from list`;
                    if (!renderTestMode)
                        void dismissTaskFromList(task).catch((error) => { status = error instanceof Error ? error.message : String(error); requestRender(true); });
                }
                else if (isTaskActive(task)) {
                    task.status = 'paused';
                    task.needsUser = true;
                    task.needsUserReason = 'stopped by Escape';
                    task.finishedAt = undefined;
                    task.progress = 'stopped by Escape; needs input';
                    task.updatedAt = new Date().toISOString();
                    status = `Stopped ${taskName(task)}; moved to needs input`;
                    const taskKey = stableTaskKey(task);
                    if (taskKey) {
                        pendingTaskUpdates.set(taskKey, { status: 'paused', needsUser: true, needsUserReason: 'stopped by Escape', finishedAt: undefined, progress: 'stopped by Escape; needs input', updatedAt: task.updatedAt });
                        pendingTaskUpdateStartedAt.delete(taskKey);
                    }
                    clampTaskSelection();
                    if (!renderTestMode)
                        void stopTaskInList(task).then(() => refresh()).catch((error) => { status = error instanceof Error ? error.message : String(error); requestRender(true); });
                }
                else {
                    const key = stableTaskKey(task);
                    if (key)
                        dismissedTaskKeys.add(key);
                    tasks = tasks.filter((entry) => stableTaskKey(entry) !== key);
                    optimisticTasks = optimisticTasks.filter((entry) => stableTaskKey(entry) !== key);
                    clampTaskSelection();
                    status = `Removed ${taskName(task)} from list`;
                    if (!renderTestMode)
                        void dismissTaskFromList(task).catch((error) => { status = error instanceof Error ? error.message : String(error); requestRender(true); });
                }
            }
            else {
                status = defaultAgentStatus;
                clampTaskSelection();
            }
            replyTarget = undefined;
            miChatTask = undefined;
            requestRender(true);
            return;
        }
        if (multiSelectMode && !inputBuffer && (data === ' ' || data.includes('\r') || data.includes('\n')))
            toggleSelectedTaskForBulkClear();
        else if (isCtrlMShortcut(data) && !inputBuffer)
            toggleMultiSelectMode();
        else if (!inputBuffer && (data.includes('\r') || data.includes('\n'))) {
            const task = selectedTask();
            if (task) {
                replyTarget = task;
                inputMode = 'reply';
                setAgentInput('');
                status = `Reply to ${taskName(task)}`;
                requestRender();
            }
            else {
                handleAgentEditorInput(data);
            }
        }
        else if (!inputBuffer && (data === '\x1b[A' || data === '\x1bOA'))
            moveAgentListSelection(-1);
        else if (!inputBuffer && (data === '\x1b[B' || data === '\x1bOB'))
            moveAgentListSelection(1);
        else
            handleAgentEditorInput(data);
    }
    async function runAgentRenderTest() {
        const fixturePath = process.env.MI_AGENT_RENDER_TEST_TASKS;
        if (fixturePath)
            tasks = dedupeTasksByStableKey(JSON.parse(readFileSync(fixturePath, 'utf8')));
        clampTaskSelection();
        const width = cols();
        const frames = [];
        const snapshot = (event) => frames.push({
            event,
            selected,
            selectedTask: selectedTask() ? taskName(selectedTask()) : undefined,
            inputMode,
            status,
            lines: renderAgentLines(width),
        });
        const keyForEvent = (event) => {
            if (event === 'up')
                return '\x1b[A';
            if (event === 'down')
                return '\x1b[B';
            if (event === 'pageUp')
                return '\x1b[5~';
            if (event === 'pageDown')
                return '\x1b[6~';
            if (event === 'enter')
                return '\n';
            if (event === 'escape')
                return '\x1b';
            if (event === 'ctrlL')
                return '\x0c';
            if (event === 'ctrlC')
                return '\x03';
            if (event.startsWith('text:'))
                return event.slice('text:'.length);
            if (event.startsWith('paste:'))
                return event.slice('paste:'.length).replace(/\\n/g, '\n');
            return event;
        };
        snapshot('initial');
        for (const event of (process.env.MI_AGENT_RENDER_TEST_EVENTS || 'down,down,pageDown,pageUp,up,enter,escape').split(',').map((item) => item.trim()).filter(Boolean)) {
            if (event.startsWith('add:')) {
                const name = event.slice('add:'.length).trim() || `render-added-${Date.now().toString(36)}`;
                const ts = new Date().toISOString();
                const task = { id: `render-test-${name}`, name, cwd: HOME, status: 'running', progress: `test-added ${name}`, startedAt: ts, updatedAt: ts };
                tasks = dedupeTasksByStableKey([task, ...tasks]);
                selected = 0;
                clampTaskSelection();
            }
            else {
                onData(keyForEvent(event));
            }
            snapshot(event);
        }
        console.log(JSON.stringify({ width, height: rows(), frames }, null, 2));
        process.exit(0);
    }
    if (renderTestMode) {
        await runAgentRenderTest();
        return;
    }
    // Use the alternate screen so stale rows cannot remain in terminal scrollback
    // and look like duplicate tasks after section/status changes.
    tui = startPiTuiScreen(new FunctionScreen(renderAgentLines, onData), { alternateScreen: true });
    await refresh();
    pollTimer = setInterval(() => void refresh(), MI_TASK_POLL_MS);
    clockTimer = setInterval(() => {
        if (tasks.length === 0 && resumeSessions.length === 0)
            return;
        requestRender();
    }, MI_AGENT_CLOCK_MS);
    // Working background agents use a static filled dot; task state arrives via polling,
    // while elapsed time labels are computed locally from timestamps once per second.
    await new Promise((resolve) => {
        const interval = setInterval(() => {
            if (closed) {
                clearInterval(interval);
                resolve();
            }
        }, 50);
    });
}
async function compactCommand(args) {
    const threadId = args[0] || 'main';
    const result = await compactThread(threadId);
    await logEvent('mi.thread.compact', result);
    console.log(`Compacted ${result.compacted} message(s), kept ${result.kept}.`);
    console.log(`Summary: ${result.summaryPath}`);
    if (result.archivePath)
        console.log(`Archive: ${result.archivePath}`);
}
async function chatCommand(threadId = 'main') {
    await showThread(threadId);
    console.log('\nType a message. Commands: /inbox, /compact, /exit');
    const rl = createInterface({ input, output });
    try {
        while (true) {
            const line = (await rl.question('you> ')).trim();
            if (!line)
                continue;
            if (line === '/exit' || line === '/quit')
                break;
            if (line === '/help') {
                console.log('Commands: /inbox, /compact, /exit');
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
            const reply = await askMi(threadId, line);
            console.log(`mi> ${reply}`);
        }
    }
    finally {
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
const MI_PREFERENCES_PATH = join(MI_TASKS_DIR, 'preferences.md');
function miUserName() {
    const envName = process.env.MI_USER_NAME?.trim();
    if (envName)
        return envName;
    try {
        const preferences = readFileSync(MI_PREFERENCES_PATH, 'utf8');
        const match = preferences.match(/^\s*-\s*(?:User(?:'s)?(?: display)? name|Name):\s*(.+?)\s*$/im);
        const name = match?.[1]?.trim().replace(/[.。]+$/, '');
        if (name)
            return name;
    }
    catch { }
    return 'the user';
}
function miUserPossessive({ capitalize = false } = {}) {
    const name = miUserName();
    if (name.toLowerCase() === 'the user')
        return capitalize ? "The user's" : "the user's";
    return name.endsWith('s') ? `${name}'` : `${name}'s`;
}
const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'];
function readPushoverEnvFile() {
    try {
        const text = readFileSync(PUSHOVER_ENV_FILE, 'utf8');
        const values = {};
        for (const line of text.split(/\r?\n/)) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#'))
                continue;
            const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
            if (!match)
                continue;
            let value = match[2].trim();
            if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
                value = value.slice(1, -1);
            values[match[1]] = value;
        }
        return values;
    }
    catch {
        return {};
    }
}
function usableSecret(value) {
    return value && !value.includes('${') ? value : undefined;
}
function getPushoverCredentials() {
    const fileEnv = readPushoverEnvFile();
    const token = usableSecret(process.env.PUSHOVER_APP_TOKEN) || usableSecret(fileEnv.PUSHOVER_APP_TOKEN) || usableSecret(process.env.PUSHOVER_TOKEN) || usableSecret(fileEnv.PUSHOVER_TOKEN);
    const user = usableSecret(process.env.PUSHOVER_USER_KEY) || usableSecret(fileEnv.PUSHOVER_USER_KEY) || usableSecret(process.env.PUSHOVER_USER) || usableSecret(fileEnv.PUSHOVER_USER);
    return token && user ? { token, user } : undefined;
}
async function sendPushover(title, message) {
    const credentials = getPushoverCredentials();
    if (!credentials)
        return false;
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
function stripCursorMarkers(text) {
    return text.replaceAll(CURSOR_MARKER, '');
}
function stripEditorCursor(text) {
    return text.replaceAll(`${CURSOR_MARKER}\x1b[7m \x1b[0m`, '').replaceAll(CURSOR_MARKER, '');
}
function stripAnsi(text) {
    return stripCursorMarkers(text)
        .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
        .replace(/\x1b_[^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
        .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
}
function widthOf(text) {
    return visibleWidth(stripCursorMarkers(text));
}
function truncateText(text, width) {
    return truncateToWidth(stripCursorMarkers(text).replace(/[\r\n]+/g, ' '), Math.max(0, width), '');
}
function padVisibleEnd(text, width) {
    const truncated = truncateText(text, width);
    return `${truncated}${' '.repeat(Math.max(0, width - widthOf(truncated)))}`;
}
function wrapPlain(text, width) {
    const normalized = text.replace(/\r/g, '').split('\n');
    const out = [];
    for (const paragraph of normalized) {
        if (!paragraph) {
            out.push('');
            continue;
        }
        let line = '';
        for (const word of paragraph.split(/\s+/)) {
            if (!word)
                continue;
            if (!line) {
                while (word.length > width) {
                    out.push(word.slice(0, width));
                    line = word.slice(width);
                    break;
                }
                if (!line)
                    line = word;
            }
            else if (line.length + 1 + word.length <= width) {
                line += ` ${word}`;
            }
            else {
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
const PI_BORDER_MUTED = '\x1b[38;2;80;80;80m';
const PI_LIGHT_GREY = '\x1b[38;2;190;190;190m';
const PI_USER_BG = '\x1b[48;2;52;53;65m';
const THINKING_COLORS = {
    off: '\x1b[38;2;80;80;80m',
    minimal: '\x1b[38;2;110;110;110m',
    low: '\x1b[38;2;95;135;175m',
    medium: '\x1b[38;2;129;162;190m',
    high: '\x1b[38;2;178;148;187m',
    xhigh: '\x1b[38;2;209;131;232m',
};
const RESET_FG = '\x1b[39m';
const RESET_BG = '\x1b[49m';
const PI_SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
function fgAccent(text) {
    return getMarkdownTheme().code(text);
}
function fgDim(text) {
    return getMarkdownTheme().linkUrl(text);
}
function fgBorderMuted(text) {
    return `${PI_BORDER_MUTED}${text}${RESET_FG}`;
}
function fgLightGrey(text) {
    return `${PI_LIGHT_GREY}${text}${RESET_FG}`;
}
function thinkingBorderColor(level) {
    return (text) => fgThinking(level || 'low', text);
}
function piEditorTheme(level) {
    return { borderColor: level ? thinkingBorderColor(level) : fgBorderMuted, selectList: getSelectListTheme() };
}
function fgThinking(level, text) {
    return `${THINKING_COLORS[level || 'low'] || THINKING_COLORS.low}${text}${RESET_FG}`;
}
function modelRef(model) {
    return `${model.provider}/${model.id}`;
}
function createModelPicker(models, currentModel) {
    const allModels = [...models].sort((a, b) => {
        const ac = currentModel?.provider === a.provider && currentModel?.id === a.id;
        const bc = currentModel?.provider === b.provider && currentModel?.id === b.id;
        if (ac && !bc)
            return -1;
        if (!ac && bc)
            return 1;
        return String(a.provider).localeCompare(String(b.provider)) || String(a.id).localeCompare(String(b.id));
    });
    return { filter: '', allModels, filteredModels: allModels, selectedIndex: 0, currentModel };
}
function updateModelPickerFilter(picker, filter) {
    picker.filter = filter;
    picker.filteredModels = filter
        ? fuzzyFilter(picker.allModels, filter, ({ id, provider }) => `${id} ${provider} ${provider}/${id} ${provider} ${id}`)
        : picker.allModels;
    picker.selectedIndex = Math.min(picker.selectedIndex, Math.max(0, picker.filteredModels.length - 1));
}
function renderPiStyleModelPicker(picker, width, height) {
    const maxVisible = 10;
    const startIndex = Math.max(0, Math.min(picker.selectedIndex - Math.floor(maxVisible / 2), Math.max(0, picker.filteredModels.length - maxVisible)));
    const endIndex = Math.min(startIndex + maxVisible, picker.filteredModels.length);
    const lines = [
        fgBorderMuted('─'.repeat(Math.max(1, width))),
        '',
        fgDim(truncateText('Only showing models from configured providers. Use /login to add providers.', width)),
        '',
        truncateText(`Search: ${picker.filter}`, width),
        '',
    ];
    for (let i = startIndex; i < endIndex; i++) {
        const item = picker.filteredModels[i];
        const isSelected = i === picker.selectedIndex;
        const isCurrent = picker.currentModel?.provider === item.provider && picker.currentModel?.id === item.id;
        const prefix = isSelected ? fgAccent('→ ') : '  ';
        const modelText = isSelected ? fgAccent(String(item.id)) : String(item.id);
        const providerBadge = fgDim(`[${item.provider}]`);
        const checkmark = isCurrent ? `\x1b[32m ✓\x1b[39m` : '';
        lines.push(truncateText(`${prefix}${modelText} ${providerBadge}${checkmark}`, width));
    }
    if (startIndex > 0 || endIndex < picker.filteredModels.length)
        lines.push(fgDim(truncateText(`  (${picker.selectedIndex + 1}/${picker.filteredModels.length})`, width)));
    if (picker.filteredModels.length === 0)
        lines.push(fgDim('  No matching models'));
    else {
        const selected = picker.filteredModels[picker.selectedIndex];
        lines.push('', fgDim(truncateText(`  Model Name: ${selected?.name || selected?.id || ''}`, width)));
    }
    lines.push('', fgBorderMuted('─'.repeat(Math.max(1, width))));
    return lines.slice(0, height);
}
function handlePiStyleModelPickerInput(picker, data) {
    if (data === '\x1b' || data === '\x03')
        return { action: 'cancel' };
    if (isUpKey(data))
        picker.selectedIndex = picker.filteredModels.length ? (picker.selectedIndex === 0 ? picker.filteredModels.length - 1 : picker.selectedIndex - 1) : 0;
    else if (isDownKey(data))
        picker.selectedIndex = picker.filteredModels.length ? (picker.selectedIndex === picker.filteredModels.length - 1 ? 0 : picker.selectedIndex + 1) : 0;
    else if (data.includes('\r') || data.includes('\n'))
        return { model: picker.filteredModels[picker.selectedIndex] };
    else if (data === '\x7f' || data === '\b')
        updateModelPickerFilter(picker, picker.filter.slice(0, -1));
    else if (/^[\x20-\x7e]+$/.test(data))
        updateModelPickerFilter(picker, picker.filter + data);
    return {};
}
function addPiSelectorPageKeys(selector, tui, stateKey = 'filteredModels') {
    const originalHandleInput = selector.handleInput.bind(selector);
    selector.handleInput = (data) => {
        if (isPageUpKey(data) || isPageDownKey(data)) {
            const state = selector;
            const items = state[stateKey] || [];
            if (items.length > 0) {
                const page = 10;
                const delta = isPageUpKey(data) ? -page : page;
                state.selectedIndex = Math.max(0, Math.min(items.length - 1, (state.selectedIndex || 0) + delta));
                state.updateList?.();
                tui.requestRender();
            }
            return;
        }
        originalHandleInput(data);
    };
    return selector;
}
async function createExactPiModelSelector(tui, currentModel, onSelect, onCancel, initialSearchInput) {
    const settingsManager = SettingsManager.create(process.cwd());
    const modelRegistry = ModelRegistry.create(AuthStorage.create());
    modelRegistry.refresh();
    const scopedModels = await getPiScopedModels(settingsManager, modelRegistry);
    const selector = new ModelSelectorComponent(tui, currentModel, settingsManager, modelRegistry, scopedModels, onSelect, onCancel, initialSearchInput);
    addPiSelectorPageKeys(selector, tui, 'filteredModels');
    selector.focused = true;
    return selector;
}
async function createExactPiScopedModelsSelector(tui, onCancel, onStatus) {
    const settingsManager = SettingsManager.create(process.cwd());
    const modelRegistry = ModelRegistry.create(AuthStorage.create());
    modelRegistry.refresh();
    const allModels = await modelRegistry.getAvailable();
    const scopedModels = await getPiScopedModels(settingsManager, modelRegistry);
    const enabledModelIds = scopedModels.length > 0 ? scopedModels.map((scoped) => modelRef(scoped.model)) : undefined;
    const ScopedModelsSelectorComponent = await getScopedModelsSelectorComponent();
    const selector = new ScopedModelsSelectorComponent({ allModels, enabledModelIds }, {
        onChange: () => { modelAutocompleteCache = undefined; },
        onPersist: (enabledIds) => {
            settingsManager.setEnabledModels(enabledIds === null ? undefined : enabledIds);
            modelAutocompleteCache = undefined;
            onStatus('Scoped models saved');
            tui.requestRender();
        },
        onCancel,
    });
    addPiSelectorPageKeys(selector, tui, 'filteredItems');
    selector.focused = true;
    return selector;
}
function modelFromSpec(spec) {
    const [provider, ...idParts] = spec.split('/');
    return { provider, id: idParts.join('/') };
}
function renderPiUserMessage(text, width) {
    return new UserMessageComponent(text, getMarkdownTheme()).render(width);
}
function renderPiAssistantMessage(text, width) {
    const trimmed = text.trim();
    if (!trimmed)
        return [];
    const lines = new AssistantMessageComponent({ content: [{ type: 'text', text: trimmed }] }, false, getMarkdownTheme()).render(width);
    while (lines.length > 0 && stripAnsi(lines[0] || '').trim() === '')
        lines.shift();
    while (lines.length > 0 && stripAnsi(lines[lines.length - 1] || '').trim() === '')
        lines.pop();
    return lines;
}
function stripLeadingVisibleWhitespace(line) {
    let index = 0;
    let output = '';
    while (index < line.length) {
        const rest = line.slice(index);
        const osc = rest.match(/^\x1b\][^\x07]*(?:\x07|\x1b\\)/);
        if (osc) {
            output += osc[0];
            index += osc[0].length;
            continue;
        }
        const csi = rest.match(/^\x1b\[[0-?]*[ -/]*[@-~]/);
        if (csi) {
            output += csi[0];
            index += csi[0].length;
            continue;
        }
        const apc = rest.match(/^\x1b_[^\x07\x1b]*(?:\x07|\x1b\\)/);
        if (apc) {
            output += apc[0];
            index += apc[0].length;
            continue;
        }
        if (/\s/.test(line[index] || '')) {
            index += 1;
            continue;
        }
        break;
    }
    return output + line.slice(index);
}
function renderPiLastOutputMessage(text, width) {
    // AssistantMessageComponent wraps final assistant lines in ANSI/OSC markers.
    // Strip Markdown's visible left padding even when those markers are
    // interleaved with the padding on the final line.
    return renderPiAssistantMessage(text, width).map(stripLeadingVisibleWhitespace);
}
function renderMiTranscriptItem(item, width) {
    return item.role === 'user' ? renderPiUserMessage(item.text, width) : renderPiAssistantMessage(item.text, width);
}
const PI_SLASH_COMMANDS = ['/model', '/scoped-models', '/export', '/import', '/share', '/copy', '/name', '/session', '/fork', '/clone', '/tree', '/new', '/compact', '/resume', '/open', '/quit', '/mi'];
const PI_SLASH_COMMAND_DESCRIPTIONS = {
    '/settings': 'Open settings menu',
    '/model': 'Select Mi model',
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
    '/new': 'Start a new Mi background agent',
    '/compact': 'Manually compact the session context',
    '/resume': 'Add an existing pi session as a task',
    '/open': 'Open the selected agent in Pi',
    '/reload': 'Reload keybindings, extensions, skills, prompts, and themes',
    '/quit': 'Quit',
    '/mi': 'Chat with Mi about the selected task',
};
let modelAutocompleteCache;
let piResourceCommandCache;
function prefixPiResourceDescription(description, sourceInfo) {
    const scope = sourceInfo?.scope;
    const source = sourceInfo?.source;
    if (!scope || !source)
        return description || '';
    const tag = source.startsWith('npm:') ? `${scope}:${source}` : source.startsWith('git:') ? `${scope}:${source}` : scope;
    return description ? `[${tag}] ${description}` : `[${tag}]`;
}
async function getPiResourceSlashCommands(cwd = process.cwd()) {
    const now = Date.now();
    if (piResourceCommandCache && piResourceCommandCache.cwd === cwd && now - piResourceCommandCache.loadedAt < 30_000)
        return piResourceCommandCache.commands;
    const services = await createAgentSessionServices({ cwd, authStorage: AuthStorage.create() });
    const { session } = await createAgentSessionFromServices({ services, sessionManager: SessionManager.inMemory() });
    const builtinNames = new Set(PI_SLASH_COMMANDS.map((command) => command.replace(/^\//, '')));
    const extensionCommands = session.extensionRunner.getRegisteredCommands()
        .filter((cmd) => !builtinNames.has(cmd.name) && !MI_BLOCKED_PI_SLASH_COMMANDS.has(`/${cmd.invocationName}`))
        .map((cmd) => ({
        name: cmd.invocationName,
        description: prefixPiResourceDescription(cmd.description, cmd.sourceInfo),
        getArgumentCompletions: cmd.getArgumentCompletions,
    }));
    const templateCommands = session.promptTemplates.map((template) => ({
        name: template.name,
        description: prefixPiResourceDescription(template.description, template.sourceInfo),
        ...(template.argumentHint ? { argumentHint: template.argumentHint } : {}),
    }));
    const skillCommands = services.settingsManager.getEnableSkillCommands?.()
        ? services.resourceLoader.getSkills().skills.map((skill) => ({
            name: `skill:${skill.name}`,
            description: prefixPiResourceDescription(skill.description, skill.sourceInfo),
        }))
        : [];
    piResourceCommandCache = { loadedAt: now, cwd, commands: [...templateCommands, ...extensionCommands, ...skillCommands] };
    return piResourceCommandCache.commands;
}
async function getPiScopedModels(settingsManager = SettingsManager.create(process.cwd()), modelRegistry = ModelRegistry.create(AuthStorage.create())) {
    const patterns = settingsManager.getEnabledModels?.() || [];
    return resolvePiModelScope(patterns, modelRegistry);
}
async function getModelAutocompleteItems(argumentPrefix) {
    const now = Date.now();
    if (!modelAutocompleteCache || now - modelAutocompleteCache.loadedAt > 30_000) {
        const settingsManager = SettingsManager.create(process.cwd());
        const registry = ModelRegistry.create(AuthStorage.create());
        registry.refresh();
        const scopedModels = await getPiScopedModels(settingsManager, registry);
        const scoped = scopedModels.map((scopedModel) => scopedModel.model);
        modelAutocompleteCache = { loadedAt: now, models: scoped.length > 0 ? scoped : await registry.getAvailable() };
    }
    const models = modelAutocompleteCache.models.map((model) => ({
        ...model,
        ref: modelRef(model),
    }));
    return fuzzyFilter(models, argumentPrefix, ({ id, provider, ref, name }) => `${id} ${provider} ${ref} ${name || ''}`)
        .slice(0, 20)
        .map((model) => ({
        value: model.ref,
        label: model.id,
        description: model.provider,
    }));
}
const MI_LOCAL_SLASH_COMMANDS = new Set(['/new', '/mi', '/quit', '/resume', '/open', '/model', '/scoped-models']);
const MI_BLOCKED_PI_SLASH_COMMANDS = new Set(['/settings', '/login', '/logout', '/reload', '/hotkeys', '/changelog']);
function slashCommandName(value) {
    return value.match(/^\/\S+/)?.[0] || '';
}
function isMiLocalSlashCommand(value) {
    return MI_LOCAL_SLASH_COMMANDS.has(slashCommandName(value));
}
function createPiSlashAutocompleteProvider(commands = PI_SLASH_COMMANDS) {
    const slashCommands = commands.map((command) => ({
        name: command.replace(/^\//, ''),
        description: PI_SLASH_COMMAND_DESCRIPTIONS[command],
        ...(command === '/model' ? { argumentHint: '<model>', getArgumentCompletions: getModelAutocompleteItems } : {}),
    }));
    const baseProvider = new CombinedAutocompleteProvider(slashCommands, process.cwd());
    return {
        async getSuggestions(lines, cursorLine, cursorCol, options) {
            const resourceCommands = await getPiResourceSlashCommands(process.cwd()).catch(() => []);
            if (resourceCommands.length === 0)
                return baseProvider.getSuggestions(lines, cursorLine, cursorCol, options);
            return new CombinedAutocompleteProvider([...slashCommands, ...resourceCommands], process.cwd()).getSuggestions(lines, cursorLine, cursorCol, options);
        },
        applyCompletion: baseProvider.applyCompletion.bind(baseProvider),
        shouldTriggerFileCompletion: baseProvider.shouldTriggerFileCompletion?.bind(baseProvider),
    };
}
const miTranscriptItemRenderCache = new WeakMap();
const miTranscriptRenderCache = new WeakMap();
function renderCachedMiTranscriptItem(item, width) {
    const cached = miTranscriptItemRenderCache.get(item);
    if (cached && cached.width === width && cached.role === item.role && cached.text === item.text)
        return cached.lines;
    const lines = renderMiTranscriptItem(item, width);
    miTranscriptItemRenderCache.set(item, { width, role: item.role, text: item.text, lines });
    return lines;
}
function renderMiTranscript(transcript, width) {
    const last = transcript.at(-1);
    const cached = miTranscriptRenderCache.get(transcript);
    if (cached && cached.width === width && cached.length === transcript.length && cached.lastRole === (last?.role || '') && cached.lastText === (last?.text || ''))
        return cached.lines;
    const body = [];
    for (const item of transcript) {
        const lines = renderCachedMiTranscriptItem(item, width);
        if (lines.length === 0)
            continue;
        if (body.length > 0)
            body.push('');
        body.push(...lines);
    }
    miTranscriptRenderCache.set(transcript, { width, length: transcript.length, lastRole: last?.role || '', lastText: last?.text || '', lines: body });
    return body;
}
function isPageUpKey(data) {
    return matchesKey(data, 'pageUp') || /\x1b\[5(?:;\d+)?~/.test(data);
}
function isPageDownKey(data) {
    return matchesKey(data, 'pageDown') || /\x1b\[6(?:;\d+)?~/.test(data);
}
function isUpKey(data) {
    return matchesKey(data, 'up') || data.includes('\x1b[A') || data.includes('\x1bOA') || data.includes('\x1b[1;2A');
}
function isDownKey(data) {
    return matchesKey(data, 'down') || data.includes('\x1b[B') || data.includes('\x1bOB') || data.includes('\x1b[1;2B');
}
function isCtrlMShortcut(data) {
    // iOS Termius sends Ctrl-M as raw CR. That is indistinguishable from a
    // legacy Enter byte, so mi agents reserves raw CR for the documented ^M
    // shortcut in normal list/resume modes. LF keeps Enter semantics when a
    // terminal can send it distinctly.
    return data === '\r' || (data !== '\n' && (matchesKey(data, 'ctrl+m') || /^(?:\x1b\[109;5(?::1)?u|\x1b\[27;5;109~)$/.test(data)));
}
function splitTerminalInput(data) {
    if (data.includes('\x1b[200~') || data.includes('\x1b[201~'))
        return [data];
    return data.match(/\x1b\[27;\d+;\d+~|\x1b\[\d+(?::\d*)?(?::\d+)?(?:;\d+)?(?::\d+)?u|\x1b\[5(?:;\d+)?~|\x1b\[6(?:;\d+)?~|\x1b\[1;2Z|\x1b\[Z|\x1b\t|\x1b\[[ABCD]|\x1bO[ABCD]|\r|\n|\x03|\x0c|\x1b|[^\x1b\r\n\x03\x0c]+/gs) || [];
}
function renderPiEditor(editor, width) {
    const rawLines = editor.render(width);
    const marker = rawLines.findIndex((line) => line.includes(CURSOR_MARKER));
    const cursor = marker >= 0
        ? { row: marker, col: Math.min(width, widthOf(rawLines[marker].slice(0, rawLines[marker].indexOf(CURSOR_MARKER))) + 1) }
        : { row: Math.max(0, rawLines.length - 2), col: Math.min(width, widthOf(editor.getText().split('\n').at(-1) || '') + 1) };
    return { lines: rawLines.map(stripEditorCursor), markedLines: rawLines, cursor };
}
function renderPiEditorText(text, width, terminalRows) {
    const tui = { terminal: { rows: terminalRows }, requestRender() { } };
    const editor = new Editor(tui, piEditorTheme());
    editor.focused = true;
    editor.setText(text);
    return renderPiEditor(editor, width);
}
class FunctionScreen {
    renderLines;
    onInput;
    focused = true;
    constructor(renderLines, onInput) {
        this.renderLines = renderLines;
        this.onInput = onInput;
    }
    render(width) {
        return this.renderLines(width).map((line) => truncateText(line, width));
    }
    handleInput(data) {
        this.onInput(data);
    }
    invalidate() { }
}
function startPiTuiScreen(component, options = {}) {
    const terminal = new ProcessTerminal();
    const tui = new TUI(terminal);
    let stopped = false;
    const originalStop = tui.stop.bind(tui);
    tui.stop = () => {
        if (stopped)
            return;
        stopped = true;
        originalStop();
        // Mi does not handle mouse input; keep it disabled so tmux mouse-wheel scrollback works.
        process.stdout.write(DISABLE_MOUSE_TRACKING_SEQUENCE);
        if (options.alternateScreen)
            process.stdout.write('\x1b[?1049l');
    };
    tui.addChild(component);
    tui.setFocus(component);
    if (options.alternateScreen)
        process.stdout.write('\x1b[?1049h\x1b[2J\x1b[3J\x1b[H');
    if (options.clearScreen !== false)
        terminal.clearScreen();
    else
        process.stdout.write('\x1b[3J');
    // Reset stale mouse tracking from prior full-screen apps before pi-tui starts.
    process.stdout.write(DISABLE_MOUSE_TRACKING_SEQUENCE);
    tui.start();
    // pi-tui may enable mouse tracking during start; disable it afterwards so
    // wheel/trackpad gestures go to terminal/tmux scrollback like pi.
    process.stdout.write(DISABLE_MOUSE_TRACKING_SEQUENCE);
    return tui;
}
function workingLine(frameIndex = 0) {
    const frame = PI_SPINNER_FRAMES[frameIndex % PI_SPINNER_FRAMES.length] || '⠋';
    return `${fgAccent(frame)} ${fgDim('Working...')}`;
}
function sendSocketRequest(payload, timeoutMs = 120000) {
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
            if (!data.includes('\n'))
                return;
            clearTimeout(timer);
            socket.end();
            try {
                const response = JSON.parse(data.slice(0, data.indexOf('\n')));
                if (response.ok)
                    resolve(response);
                else
                    reject(new Error(response.error || 'Mi main returned an error'));
            }
            catch (error) {
                reject(error);
            }
        });
        socket.on('error', (error) => {
            clearTimeout(timer);
            reject(error);
        });
    });
}
function isStaleMiSocketError(error) {
    const message = error instanceof Error ? error.message : String(error);
    return message.includes('ECONNREFUSED') || message.includes('ENOENT') || message.includes('Timed out waiting for Mi main');
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
        }
        catch {
            await new Promise((resolve) => setTimeout(resolve, 250));
        }
    }
    throw new Error('Mi main did not start');
}
async function sendTaskSocketRequest(payload, timeoutMs = 30000) {
    try {
        return await sendSocketRequest(payload, timeoutMs);
    }
    catch (error) {
        if (existsSync(MI_SOCKET_PATH) && !isStaleMiSocketError(error))
            throw error;
        if (isStaleMiSocketError(error))
            await rm(MI_SOCKET_PATH, { force: true }).catch(() => undefined);
        await startMiDaemon();
        return await sendSocketRequest(payload, timeoutMs);
    }
}
function normalizeMiResponse(text) {
    return text.trim() || 'Mi completed without text.';
}
function miPrompt(message) {
    return message;
}
async function requestMi(message) {
    const response = await sendSocketRequest({ type: 'prompt', message });
    return normalizeMiResponse(response.text || '');
}
async function abortMiMain() {
    return sendSocketRequest({ type: 'abort' }, 10000).catch(() => undefined);
}
async function getMiState() {
    try {
        return (await sendSocketRequest({ type: 'state' }, 10000)).state;
    }
    catch (error) {
        if (existsSync(MI_SOCKET_PATH) && !isStaleMiSocketError(error))
            throw error;
        await rm(MI_SOCKET_PATH, { force: true }).catch(() => undefined);
        await startMiDaemon();
        return (await sendSocketRequest({ type: 'state' }, 10000)).state;
    }
}
async function setMiModelThinking(modelSpec, level) {
    const [provider, ...idParts] = modelSpec.split('/');
    const modelId = idParts.join('/');
    if (!provider || !modelId)
        throw new Error(`Invalid model spec: ${modelSpec}`);
    try {
        await sendSocketRequest({ type: 'set_model', provider, modelId }, 30000);
        return level ? (await sendSocketRequest({ type: 'set_thinking', level }, 30000)).state : await getMiState();
    }
    catch (error) {
        if (existsSync(MI_SOCKET_PATH) && !isStaleMiSocketError(error))
            throw error;
        await rm(MI_SOCKET_PATH, { force: true }).catch(() => undefined);
        await startMiDaemon();
        await sendSocketRequest({ type: 'set_model', provider, modelId }, 30000);
        return level ? (await sendSocketRequest({ type: 'set_thinking', level }, 30000)).state : await getMiState();
    }
}
async function setMiThinking(level) {
    return setMiModelThinking('openai-codex/gpt-5.5', level);
}
async function getAvailableMiModels() {
    try {
        return (await sendSocketRequest({ type: 'get_available_models' }, 30000)).state?.models || [];
    }
    catch (error) {
        if (existsSync(MI_SOCKET_PATH) && !isStaleMiSocketError(error))
            throw error;
        await rm(MI_SOCKET_PATH, { force: true }).catch(() => undefined);
        await startMiDaemon();
        return (await sendSocketRequest({ type: 'get_available_models' }, 30000)).state?.models || [];
    }
}
async function loadPiCycleConfig() {
    try {
        const raw = JSON.parse(await readFile(PI_CYCLE_PATH, 'utf8'));
        return {
            shortcut: typeof raw.shortcut === 'string' && raw.shortcut.trim() ? raw.shortcut.trim() : 'z',
            tiers: {
                '1': Array.isArray(raw.tiers?.['1']) ? raw.tiers['1'] : ['openai-codex/gpt-5.5'],
                '2': Array.isArray(raw.tiers?.['2']) ? raw.tiers['2'] : ['openai-codex/gpt-5.5'],
                '3': Array.isArray(raw.tiers?.['3']) ? raw.tiers['3'] : ['openai-codex/gpt-5.5'],
            },
            thinkingLevels: raw.thinkingLevels || {},
        };
    }
    catch {
        return { shortcut: 'z', tiers: { '1': ['openai-codex/gpt-5.5'], '2': ['openai-codex/gpt-5.5'], '3': ['openai-codex/gpt-5.5'] }, thinkingLevels: {} };
    }
}
async function sendToMiMain(message) {
    try {
        return await requestMi(miPrompt(message));
    }
    catch (error) {
        if (existsSync(MI_SOCKET_PATH) && !isStaleMiSocketError(error))
            throw error;
        await rm(MI_SOCKET_PATH, { force: true }).catch(() => undefined);
    }
    await startMiDaemon();
    return await requestMi(miPrompt(message));
}
async function miTuiCommand(initial = '') {
    await mkdir(MI_TASKS_DIR, { recursive: true });
    const MI_TUI_TRANSCRIPT_LIMIT = Number(process.env.MI_TUI_TRANSCRIPT_LIMIT || 100);
    let transcript = (await readThreadMessages('main', Math.max(MI_TUI_TRANSCRIPT_LIMIT * 3, MI_TUI_TRANSCRIPT_LIMIT)))
        .filter((message) => message.role === 'user' || message.role === 'assistant')
        .slice(-MI_TUI_TRANSCRIPT_LIMIT)
        .map((message) => ({ role: message.role, text: message.text }));
    await markThreadRead('main');
    let miState;
    let miThinkingLevel = String(MI_MODEL).match(/:(off|minimal|low|medium|high|xhigh)$/)?.[1];
    let piCycleConfig = await loadPiCycleConfig();
    const piCycleNextIndex = { '1': 0, '2': 0, '3': 0 };
    let statusMessage = `tmux scrollback for history • Shift+Tab thinking • ${piCycleConfig.shortcut}/${piCycleConfig.shortcut.repeat(2)}/${piCycleConfig.shortcut.repeat(3)} pi-cycle`;
    const rows = () => process.stdout.rows || 24;
    const cols = () => process.stdout.columns || 80;
    let inputLine = '';
    const editorTui = { terminal: { rows: process.stdout.rows || 24 }, requestRender() { requestRender(); } };
    const inputEditor = new Editor(editorTui, piEditorTheme(miThinkingLevel));
    inputEditor.setAutocompleteProvider(createPiSlashAutocompleteProvider(['/model', '/scoped-models', '/export', '/import', '/share', '/copy', '/name', '/session', '/fork', '/clone', '/tree', '/compact', '/quit']));
    inputEditor.focused = true;
    inputEditor.onChange = (text) => { inputLine = text; };
    let pending = false;
    const messageQueue = [];
    let scrollOffset = 0;
    let closed = false;
    let tui;
    let workingTimer;
    let workingFrame = 0;
    let pendingEscapeTimer;
    let pendingEscapeData = '';
    let modelPicker;
    // Do not fetch model state on startup: that spins up the Mi main pi RPC process.
    // The footer can show MI_MODEL until the first prompt/model action needs real state.
    // Main Mi behaves like pi: it renders only the active conversation.
    // Background workers live in the dedicated `mi agents` view.
    function requestRender() {
        tui?.requestRender();
    }
    function setPending(next) {
        if (pending === next)
            return;
        pending = next;
        if (workingTimer) {
            clearInterval(workingTimer);
            workingTimer = undefined;
        }
        if (pending) {
            workingFrame = 0;
            workingTimer = setInterval(() => {
                workingFrame = (workingFrame + 1) % PI_SPINNER_FRAMES.length;
                requestRender();
            }, MI_WORKING_RENDER_MS);
        }
        requestRender();
    }
    function inputText() {
        return inputLine;
    }
    function inputDisplayText() {
        return inputText();
    }
    function inputVisibleLines(width, maxLines) {
        const wrapped = wrapPlain(inputDisplayText(), Math.max(1, width));
        const lines = wrapped.length > 0 ? wrapped : [''];
        return lines.slice(-Math.max(1, maxLines));
    }
    function inputCursorColumn(inputLines, width) {
        const lastLine = inputLines[inputLines.length - 1] || '';
        return Math.min(width, widthOf(lastLine) + 1);
    }
    function formatTokens(value) {
        if (!Number.isFinite(value))
            return '—';
        const n = Number(value);
        if (n >= 1_000_000)
            return `${(n / 1_000_000).toFixed(1)}M`;
        if (n >= 1_000)
            return `${Math.round(n / 100) / 10}k`;
        return String(n);
    }
    function statusLine(width) {
        const model = miState?.model;
        const modelName = model ? `${model.provider}/${model.id}` : MI_MODEL;
        const thinking = miState?.thinkingLevel ? ` ${miState.thinkingLevel}` : '';
        const left = messageQueue.length > 0 ? `q${messageQueue.length}` : '';
        const right = `${modelName}${thinking}`;
        const available = Math.max(1, width - widthOf(left) - widthOf(right));
        if (left && available > 1)
            return fgDim(`${left}${' '.repeat(available)}${right}`);
        return fgDim(right.padStart(Math.max(widthOf(right), width)));
    }
    function shouldStartBackgroundWorkerFromMi(text) {
        const normalized = text.trim().toLowerCase();
        if (!normalized || normalized.startsWith('/'))
            return false;
        return /\b(fix|debug|investigate|implement|update|repair|patch|make|add|create)\b/.test(normalized)
            || /\b(does(?:n't| not) work|not working|broken|bug|issue|error|failing|fails|failure|regression)\b/.test(normalized);
    }
    async function startBackgroundWorkerFromMi(text) {
        const name = taskNameFromPrompt(text);
        const result = await sendTaskSocketRequest({ type: 'run_worker', name, cwd: HOME, message: text, background: true }, 30000);
        return result.text || `Started background task: ${name}.`;
    }
    async function buildMiTurnPrompt(text) {
        const recent = (await readThreadMessages('main', 15)).filter((message) => message.role === 'user' || message.role === 'assistant');
        const history = recent.map((message) => `${message.role}: ${message.text}`).join('\n');
        return [
            `You are Mi, ${miUserPossessive()} private persistent assistant. Reply naturally and use recent conversation context. Do not mention hidden context unless it is useful.`,
            history ? `Recent conversation history for context only:\n${history}` : '',
            `New message to answer:\n${text}`,
        ].filter(Boolean).join('\n\n');
    }
    function footerLines(width, height) {
        editorTui.terminal.rows = height;
        const piEditor = renderPiEditor(inputEditor, width);
        const inputTopPadding = 1;
        return {
            piEditor,
            inputTopPadding,
            lines: [
                '',
                ...piEditor.markedLines.map((line) => truncateText(line, width)),
                statusLine(width),
                '',
            ],
        };
    }
    function renderInputLine() {
        requestRender();
    }
    function renderMiLines(width = cols()) {
        if (closed)
            return [];
        const height = rows();
        if (modelPicker) {
            const lines = modelPicker.render(width);
            while (lines.length < height)
                lines.push('');
            return lines.slice(0, height);
        }
        const footer = footerLines(width, height);
        const body = [];
        body.push(...renderMiTranscript(transcript, width));
        if (pending) {
            body.push('');
            body.push(workingLine(workingFrame));
        }
        const lines = [
            ...body.map((line) => truncateText(line, width)),
            ...footer.lines,
        ];
        while (lines.length < height)
            lines.unshift('');
        return lines;
    }
    async function askOne(text) {
        setPending(true);
        transcript.push({ role: 'user', text });
        scrollOffset = 0;
        await appendThreadMessage('main', 'user', text, { unread: false, source: 'mi-cli' });
        requestRender();
        try {
            const response = shouldStartBackgroundWorkerFromMi(text)
                ? await startBackgroundWorkerFromMi(text)
                : await sendToMiMain(await buildMiTurnPrompt(text));
            getMiState().then((state) => {
                miState = state;
                requestRender();
            }).catch(() => undefined);
            await appendThreadMessage('main', 'assistant', response, { unread: false, source: 'mi-main' });
            transcript.push({ role: 'assistant', text: response });
            await sendPushover('Mi', response).catch(() => undefined);
        }
        catch (error) {
            const errorText = error instanceof Error ? error.message : String(error);
            transcript.push({ role: 'assistant', text: errorText });
        }
        finally {
            scrollOffset = 0;
            requestRender();
        }
    }
    async function processQueue() {
        if (pending)
            return;
        while (messageQueue.length > 0) {
            const next = messageQueue.shift();
            if (closed)
                break;
            await askOne(next);
        }
        setPending(false);
        requestRender();
    }
    function enqueueMessage(text) {
        messageQueue.push(text);
        void processQueue();
        requestRender();
    }
    function cleanup() {
        if (closed)
            return;
        closed = true;
        if (workingTimer)
            clearInterval(workingTimer);
        if (pendingEscapeTimer)
            clearTimeout(pendingEscapeTimer);
        tui?.stop();
        tui = undefined;
    }
    function scrollBy(delta) {
        scrollOffset = Math.max(0, scrollOffset + delta);
        requestRender();
    }
    function piCycleThinkingLevel(tier, modelSpec) {
        return piCycleConfig.thinkingLevels?.[`${tier}:${modelSpec}`] || piCycleConfig.thinkingLevels?.[modelSpec];
    }
    async function applyPiCycle(text) {
        piCycleConfig = await loadPiCycleConfig();
        const shortcut = piCycleConfig.shortcut || 'z';
        const escaped = shortcut.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const match = text.match(new RegExp(`^((?:${escaped}){1,3})(?:\\s+([\\s\\S]*)|$)`));
        if (!match || match[1].length % shortcut.length !== 0)
            return { handled: false, body: text };
        const tier = String(match[1].length / shortcut.length);
        const models = piCycleConfig.tiers[tier] || [];
        if (models.length === 0)
            throw new Error(`pi-cycle tier ${tier} has no models`);
        const index = piCycleNextIndex[tier] % models.length;
        const modelSpec = models[index];
        piCycleNextIndex[tier] = (index + 1) % models.length;
        const level = piCycleThinkingLevel(tier, modelSpec);
        miThinkingLevel = level || miThinkingLevel;
        inputEditor.borderColor = thinkingBorderColor(miThinkingLevel);
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
        const currentLevel = THINKING_LEVELS.includes(miState?.thinkingLevel) ? miState.thinkingLevel : (miThinkingLevel || 'low');
        const currentIndex = THINKING_LEVELS.indexOf(currentLevel);
        const next = THINKING_LEVELS[(currentIndex + 1) % THINKING_LEVELS.length];
        statusMessage = `Switching to gpt-5.5 ${next}...`;
        requestRender();
        try {
            const result = await setMiThinking(next);
            miState = await getMiState();
            if (result?.thinkingLevel)
                miState.thinkingLevel = result.thinkingLevel;
            miThinkingLevel = miState?.thinkingLevel || next;
            inputEditor.borderColor = thinkingBorderColor(miThinkingLevel);
            statusMessage = `Shift+Tab thinking • ${piCycleConfig.shortcut}/${piCycleConfig.shortcut.repeat(2)}/${piCycleConfig.shortcut.repeat(3)} pi-cycle`;
        }
        catch (error) {
            statusMessage = error instanceof Error ? error.message : String(error);
        }
        requestRender();
    }
    async function openPiFromMi(value) {
        cleanup();
        await new Promise((resolve, reject) => {
            const child = spawn(process.env.PI_CMD || 'pi', [value], { cwd: HOME, env: process.env, stdio: 'inherit' });
            child.on('error', reject);
            child.on('close', () => resolve());
        });
    }
    function submitInput() {
        const text = inputLine.trim();
        if (!text)
            return;
        inputLine = '';
        inputEditor.setText('');
        renderInputLine();
        if (text === '/quit') {
            cleanup();
            return;
        }
        if (text === '/scoped-models') {
            statusMessage = 'Loading scoped models...';
            requestRender();
            void (async () => {
                modelPicker = await createExactPiScopedModelsSelector(tui, () => {
                    modelPicker = undefined;
                    statusMessage = `tmux scrollback for history • Shift+Tab thinking • ${piCycleConfig.shortcut}/${piCycleConfig.shortcut.repeat(2)}/${piCycleConfig.shortcut.repeat(3)} pi-cycle`;
                    requestRender();
                }, (message) => { statusMessage = message; });
                statusMessage = 'Configure scoped models';
                requestRender();
            })().catch((error) => {
                statusMessage = error instanceof Error ? error.message : String(error);
                requestRender();
            });
            return;
        }
        if (text === '/model' || text.startsWith('/model ')) {
            const modelQuery = text.replace(/^\/model\b/, '').trim();
            statusMessage = 'Loading models...';
            requestRender();
            void (async () => {
                modelPicker = await createExactPiModelSelector(tui, miState?.model, (model) => {
                    const modelSpec = modelRef(model);
                    modelPicker = undefined;
                    statusMessage = `Switching to ${modelSpec}...`;
                    requestRender();
                    void setMiModelThinking(modelSpec, miThinkingLevel)
                        .then((state) => { miState = state; statusMessage = `Model: ${modelSpec}${miThinkingLevel ? ` ${miThinkingLevel}` : ''}`; requestRender(); })
                        .catch((error) => { statusMessage = error instanceof Error ? error.message : String(error); requestRender(); });
                }, () => {
                    modelPicker = undefined;
                    statusMessage = `tmux scrollback for history • Shift+Tab thinking • ${piCycleConfig.shortcut}/${piCycleConfig.shortcut.repeat(2)}/${piCycleConfig.shortcut.repeat(3)} pi-cycle`;
                    requestRender();
                }, modelQuery || undefined);
                statusMessage = 'Select model';
                requestRender();
            })().catch((error) => {
                statusMessage = error instanceof Error ? error.message : String(error);
                requestRender();
            });
            return;
        }
        if (text.startsWith('/') && !isMiLocalSlashCommand(text)) {
            if (MI_BLOCKED_PI_SLASH_COMMANDS.has(slashCommandName(text))) {
                statusMessage = `${slashCommandName(text)} is a Pi app command; open Pi directly to use it.`;
                requestRender();
                return;
            }
            void openPiFromMi(text).catch((error) => {
                statusMessage = error instanceof Error ? error.message : String(error);
                requestRender();
            });
            return;
        }
        void applyPiCycle(text)
            .then(({ body }) => {
            if (body)
                enqueueMessage(body);
            else
                requestRender();
        })
            .catch((error) => {
            statusMessage = error instanceof Error ? error.message : String(error);
            requestRender();
        });
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
        }
        else {
            inputLine = '';
            inputEditor.setText('');
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
        }
        else {
            inputLine = '';
            inputEditor.setText('');
            requestRender();
        }
    }
    function isCompleteEscapeSequence(data) {
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
        if (data === '\x1b')
            handleEscapeKey();
        else
            handleInputData(data);
    }
    function handleInputData(data) {
        if (modelPicker) {
            modelPicker.handleInput(data);
            requestRender();
            return;
        }
        if (data === '\x1b') {
            handleEscapeKey();
            return;
        }
        if (data === '\x03') {
            handleCtrlC();
            return;
        }
        if (matchesKey(data, 'shift+tab') || data === '\x1b[Z' || data === '\x1b[1;2Z' || data === '\x1b\t' || data.includes('\x1b[Z') || data.includes('\x1b[1;2Z')) {
            void cycleThinking();
        }
        else if (isPageUpKey(data) || isPageDownKey(data) || isUpKey(data) || isDownKey(data)) {
            inputEditor.handleInput(data);
            inputLine = inputEditor.getText();
            renderInputLine();
        }
        else if (data.includes('\r') || data.includes('\n')) {
            const parts = data.split(/[\r\n]+/);
            const beforeEnter = parts.shift() || '';
            const textBeforeEnter = beforeEnter.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
            if (textBeforeEnter) {
                inputEditor.insertTextAtCursor(textBeforeEnter);
                inputLine = inputEditor.getText();
            }
            submitInput();
            const afterEnter = parts.join('');
            const textAfterEnter = afterEnter.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
            if (textAfterEnter)
                inputEditor.insertTextAtCursor(textAfterEnter);
            inputLine = inputEditor.getText();
            renderInputLine();
        }
        else {
            inputEditor.handleInput(data);
            inputLine = inputEditor.getText();
            renderInputLine();
        }
    }
    function onData(data) {
        const keyParts = splitTerminalInput(data);
        if (keyParts.length > 1) {
            for (const keyPart of keyParts)
                onData(keyPart);
            return;
        }
        if (pendingEscapeTimer) {
            clearTimeout(pendingEscapeTimer);
            pendingEscapeTimer = undefined;
        }
        if (pendingEscapeData) {
            pendingEscapeData += data;
            if (isCompleteEscapeSequence(pendingEscapeData) || pendingEscapeData.length >= 8)
                flushPendingEscape();
            else
                pendingEscapeTimer = setTimeout(flushPendingEscape, 40);
            return;
        }
        if (data.startsWith('\x1b') && !isCompleteEscapeSequence(data) && data.length < 8) {
            pendingEscapeData = data;
            pendingEscapeTimer = setTimeout(flushPendingEscape, 40);
            return;
        }
        handleInputData(data);
    }
    // Like pi, leave conversation history in normal terminal scrollback by
    // rendering the whole conversation into the normal terminal buffer.
    tui = startPiTuiScreen(new FunctionScreen(renderMiLines, onData), { clearScreen: false });
    if (initial.trim())
        enqueueMessage(initial.trim());
    await new Promise((resolve) => {
        const interval = setInterval(() => {
            if (closed) {
                clearInterval(interval);
                resolve();
            }
        }, 50);
    });
}
async function launchPiMain(args) {
    const prompt = [
        `You are Mi, ${miUserPossessive()} private persistent assistant.`,
        'Be concise and minimal.',
        'Do not use emoji.',
        'Risky actions require explicit approval.',
        `All Mi tasks, goals, objectives, todos, plans, and work queues must be stored and maintained as Markdown files under ${MI_TASKS_DIR}/.`,
        'Do not deploy, merge, push, publish, edit secrets, or change production settings unless explicitly approved.',
        `Use the /mi command for side-channel notes, /mi read for unread Mi messages, and /mi bring-in only when ${miUserName()} asks to bring Mi thread context into this pi conversation.`,
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
    await new Promise((resolve, reject) => {
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
    if (!command)
        return miTuiCommand('');
    if (command === 'help' || command === '--help' || command === '-h') {
        console.log(usage());
        return;
    }
    if (command === '--once')
        return onceCommand(args);
    if (command === 'raw')
        return chatCommand(args[0] || 'main');
    if (command === 'pi')
        return launchPiMain(args);
    if (command === 'ui')
        return miTuiCommand(args.join(' '));
    if (command === 'chat' || command === 'open')
        return chatCommand(args[0] || 'main');
    if (command === 'ask')
        return askCommand(args);
    if (command === 'inbox' || command === 'threads')
        return inboxCommand();
    if (command === 'temp')
        return tempCommand(args);
    if (command === 'compact')
        return compactCommand(args);
    if (command === 'agents')
        return miAgentsCommand();
    if (command === 'task')
        return taskCommand(args);
    if (command === 'make')
        return makeCommand(args);
    if (command === 'run')
        return runCommand(args);
    if (command === 'edit')
        return editCommand(args);
    if (command === 'check')
        return checkCommand(args);
    if (command === 'logs')
        return logsCommand(args);
    throw new Error(`unknown command: ${command}`);
}
try {
    await main();
}
catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
}
