import {
	AssistantMessageComponent,
	CustomEditor,
	getMarkdownTheme,
	UserMessageComponent,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type KeybindingsManager,
} from "@mariozechner/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, type Component, type Focusable, type TUI } from "@mariozechner/pi-tui";
import { spawn } from "node:child_process";
import net from "node:net";
import { createHash } from "node:crypto";
import { appendFile, mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const HOME = homedir();
const MI_ROOT = process.env.MI_ROOT || join(HOME, "assistant");
const THREADS_DIR = join(MI_ROOT, "state", "threads");
const INDEX_PATH = join(THREADS_DIR, "index.json");
const MAIN_THREAD_ID = "main";
const MI_RUNTIME_DIR = process.env.MI_RUNTIME_DIR || join(HOME, ".pi", "agent", "mi");
const MI_SOCKET_PATH = process.env.MI_SOCKET_PATH || join(MI_RUNTIME_DIR, "main.sock");
const MI_DAEMON_PATH = process.env.MI_DAEMON_PATH || join(HOME, ".pi", "agent", "extensions", "mi-daemon.mjs");
const MI_PI_BRIDGE_DIR = join(MI_RUNTIME_DIR, "pi-bridges");
const MI_TASKS_DIR = join(HOME, "mi");
const MI_PREFERENCES_PATH = join(MI_TASKS_DIR, "preferences.md");
const PI_SESSION_DIR = join(HOME, ".pi", "agent", "sessions");
const MI_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const MI_THREAD_PANEL_MESSAGE_LIMIT = Number(process.env.MI_THREAD_PANEL_MESSAGE_LIMIT || 50);
const MI_THREAD_POLL_MESSAGE_LIMIT = Number(process.env.MI_THREAD_POLL_MESSAGE_LIMIT || 50);
const MI_THREAD_POLL_INTERVAL_MS = Number(process.env.MI_THREAD_POLL_INTERVAL_MS || 10000);

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

type ThreadRole = "user" | "assistant" | "system";

type ThreadRecord = {
	id: string;
	title: string;
	kind: "main" | "temporary";
	createdAt: string;
	updatedAt: string;
	unread: number;
	archived?: boolean;
};

type ThreadMessage = {
	id: string;
	threadId: string;
	role: ThreadRole;
	text: string;
	ts: string;
	unread?: boolean;
	source?: string;
};

function now() {
	return new Date().toISOString();
}

function id(prefix = "msg") {
	return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function threadPath(threadId: string) {
	return join(THREADS_DIR, `${threadId}.jsonl`);
}

async function readIndex(): Promise<ThreadRecord[]> {
	await mkdir(THREADS_DIR, { recursive: true });
	try {
		return JSON.parse(await readFile(INDEX_PATH, "utf8")) as ThreadRecord[];
	} catch {
		return [];
	}
}

async function writeIndex(threads: ThreadRecord[]) {
	await mkdir(THREADS_DIR, { recursive: true });
	await writeFile(INDEX_PATH, JSON.stringify(threads, null, 2));
}

async function ensureMainThread() {
	const threads = await readIndex();
	if (!threads.some((thread) => thread.id === MAIN_THREAD_ID)) {
		const ts = now();
		threads.unshift({ id: MAIN_THREAD_ID, title: "main", kind: "main", createdAt: ts, updatedAt: ts, unread: 0 });
		await writeIndex(threads);
	}
}

async function listThreads() {
	await ensureMainThread();
	return (await readIndex()).filter((thread) => !thread.archived);
}

async function appendMessage(threadId: string, role: ThreadRole, text: string, options: { unread?: boolean; source?: string } = {}) {
	await ensureMainThread();
	const threads = await readIndex();
	const record = threads.find((thread) => thread.id === threadId);
	if (!record) throw new Error(`Mi thread not found: ${threadId}`);

	const message: ThreadMessage = {
		id: id(),
		threadId,
		role,
		text,
		ts: now(),
		unread: options.unread ?? role === "assistant",
		source: options.source,
	};

	await appendFile(threadPath(threadId), `${JSON.stringify(message)}\n`);
	record.updatedAt = message.ts;
	if (message.unread) record.unread += 1;
	await writeIndex(threads);
	return message;
}

function parseMessageLines(text: string, limit?: number) {
	const lines = text.trim().split("\n").filter(Boolean);
	const selected = typeof limit === "number" ? lines.slice(-limit) : lines;
	return selected.map((line) => JSON.parse(line) as ThreadMessage);
}

async function readMessages(threadId = MAIN_THREAD_ID, limit?: number) {
	await ensureMainThread();
	const path = threadPath(threadId);
	try {
		if (typeof limit !== "number") return parseMessageLines(await readFile(path, "utf8"));

		const handle = await open(path, "r");
		try {
			const { size } = await handle.stat();
			let bytes = Math.min(size, 64 * 1024);
			while (true) {
				const start = Math.max(0, size - bytes);
				const buffer = Buffer.alloc(size - start);
				await handle.read(buffer, 0, buffer.length, start);
				const text = buffer.toString("utf8");
				const lines = text.trim().split("\n").filter(Boolean);
				if (start === 0 || lines.length > limit) return parseMessageLines(start === 0 ? text : lines.slice(1).join("\n"), limit);
				bytes = Math.min(size, bytes * 2);
			}
		} finally {
			await handle.close();
		}
	} catch {
		return [];
	}
}

async function markRead(threadId = MAIN_THREAD_ID, rewriteMessages = false) {
	await ensureMainThread();
	const threads = await readIndex();
	const record = threads.find((thread) => thread.id === threadId);
	if (record) record.unread = 0;
	await writeIndex(threads);
	if (!rewriteMessages) return;

	const messages = await readMessages(threadId);
	if (messages.length === 0) return;
	await writeFile(
		threadPath(threadId),
		messages.map((message) => JSON.stringify({ ...message, unread: false })).join("\n") + "\n",
	);
}

function formatThread(thread: ThreadRecord) {
	const unread = thread.unread > 0 ? ` (${thread.unread} unread)` : "";
	const label = thread.kind === "main" ? "main" : `temp: ${thread.title}`;
	return `${label}${unread}`;
}

function formatMessages(messages: ThreadMessage[]) {
	if (messages.length === 0) return "No Mi messages.";
	return messages.map((message) => `${message.role}> ${message.text}`).join("\n");
}

function textPart(part: unknown): string {
	if (typeof part === "string") return part;
	if (!part || typeof part !== "object") return "";
	const candidate = part as { type?: unknown; text?: unknown; content?: unknown };
	if (candidate.type === "text" && typeof candidate.text === "string") return candidate.text;
	if (typeof candidate.text === "string") return candidate.text;
	if (typeof candidate.content === "string") return candidate.content;
	return "";
}

function messageText(message: unknown): string {
	if (!message || typeof message !== "object") return "";
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content.trim();
	if (Array.isArray(content)) return content.map(textPart).filter(Boolean).join("\n").trim();
	return "";
}

function messageRole(message: unknown): ThreadRole | undefined {
	if (!message || typeof message !== "object") return undefined;
	const role = (message as { role?: unknown }).role;
	return role === "user" || role === "assistant" || role === "system" ? role : undefined;
}

async function notify(ctx: ExtensionCommandContext, text: string, kind: "info" | "success" | "warning" | "error" = "info") {
	ctx.ui.notify(text, kind);
}

async function handleRead(ctx: ExtensionCommandContext) {
	const messages = await readMessages(MAIN_THREAD_ID);
	const unread = messages.filter((message) => message.unread);
	const shown = unread.length > 0 ? unread : messages.slice(-8);
	await notify(ctx, formatMessages(shown), unread.length > 0 ? "info" : "success");
	await markRead(MAIN_THREAD_ID, true);
}

async function handleInbox(ctx: ExtensionCommandContext) {
	const threads = await listThreads();
	await notify(ctx, threads.map(formatThread).join("\n") || "No Mi threads.");
}

async function sendSocketRequest(payload: unknown, timeoutMs = 120000): Promise<{ ok?: boolean; error?: string; text?: string }> {
	return new Promise((resolve, reject) => {
		const socket = net.createConnection(MI_SOCKET_PATH);
		let data = "";
		const timer = setTimeout(() => {
			socket.destroy();
			reject(new Error("Timed out waiting for Mi main"));
		}, timeoutMs);
		socket.on("connect", () => socket.write(`${JSON.stringify(payload)}\n`));
		socket.on("data", (chunk) => {
			data += chunk.toString("utf8");
			if (!data.includes("\n")) return;
			clearTimeout(timer);
			socket.end();
			try {
				const response = JSON.parse(data.slice(0, data.indexOf("\n"))) as { ok?: boolean; error?: string; text?: string };
				if (response.ok) resolve(response);
				else reject(new Error(response.error || "Mi main returned an error"));
			} catch (error) {
				reject(error);
			}
		});
		socket.on("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
	});
}

async function startMiDaemon() {
	await mkdir(dirname(MI_SOCKET_PATH), { recursive: true });
	const child = spawn(process.execPath, [MI_DAEMON_PATH], {
		detached: true,
		stdio: "ignore",
		env: { ...process.env, MI_SOCKET_PATH, MI_RUNTIME_DIR },
	});
	child.unref();
	for (let i = 0; i < 20; i++) {
		try {
			await sendSocketRequest({ type: "health" }, 500);
			return;
		} catch {
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
	}
	throw new Error("Mi main did not start");
}

function normalizeMiResponse(text: string) {
	const trimmed = text.trim();
	if (!trimmed) throw new Error("Mi produced no response text.");
	return trimmed;
}

function miPrompt(message: string) {
	return message;
}

async function requestMi(message: string) {
	const response = await sendSocketRequest({ type: "prompt", message });
	return normalizeMiResponse(response.text || "");
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

async function handleBringIn(pi: ExtensionAPI, ctx: ExtensionCommandContext) {
	const messages = await readMessages(MAIN_THREAD_ID, 12);
	if (messages.length === 0) {
		await notify(ctx, "No Mi context to bring in.", "warning");
		return;
	}
	await markRead(MAIN_THREAD_ID);
	pi.sendUserMessage(`Relevant Mi context from the persistent main thread:\n\n${formatMessages(messages)}`);
	await notify(ctx, "Brought recent Mi context into this pi conversation.", "success");
}

type MiTheme = { fg: (style: any, text: string) => string; bg?: (style: any, text: string) => string };

function miEditorTheme(theme: MiTheme) {
	return {
		borderColor: (text: string) => theme.fg("borderMuted", text),
		selectList: {
			selectedPrefix: (text: string) => theme.fg("accent", text),
			selectedText: (text: string) => theme.fg("accent", text),
			description: (text: string) => theme.fg("muted", text),
			scrollInfo: (text: string) => theme.fg("muted", text),
			noMatch: (text: string) => theme.fg("muted", text),
		},
	};
}

class MiThreadPanel implements Component, Focusable {
	private editor: CustomEditor;
	private transcript: Array<{ role: "user" | "assistant"; text: string }> = [];
	private seenMessageIds = new Set<string>();
	private pending = false;
	private scrollOffset = 0;
	private cachedWidth?: number;
	private cachedLines?: string[];
	private requestRender?: () => void;
	private workingTimer?: NodeJS.Timeout;
	private threadPollTimer?: NodeJS.Timeout;
	private messageQueue: string[] = [];
	private statusMessage = "Esc/Ctrl+C stop or close • PageUp/PageDown scroll";
	private closed = false;
	private _focused = false;

	get focused() {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.editor.focused = value;
	}

	constructor(
		initial: string,
		private done: () => void,
		private theme: MiTheme,
		tui: TUI,
		keybindings: KeybindingsManager,
	) {
		this.editor = new CustomEditor(tui, miEditorTheme(theme), keybindings);
		this.editor.onSubmit = (value) => {
			const text = value.trim();
			if (!text) return;
			this.editor.setText("");
			this.editor.addToHistory(text);
			this.enqueue(text);
		};
		void this.load(initial);
		this.threadPollTimer = setInterval(() => void this.pollThread(), MI_THREAD_POLL_INTERVAL_MS);
	}

	setRequestRender(requestRender: () => void) {
		this.requestRender = requestRender;
	}

	private async load(initial: string) {
		const messages = await readMessages(MAIN_THREAD_ID, MI_THREAD_PANEL_MESSAGE_LIMIT);
		this.seenMessageIds = new Set(messages.map((message) => message.id));
		this.transcript = messages
			.filter((message) => message.role === "user" || message.role === "assistant")
			.map((message) => ({ role: message.role as "user" | "assistant", text: message.text }));
		await markRead(MAIN_THREAD_ID).catch(() => undefined);
		this.invalidate();
		this.requestRender?.();
		if (initial.trim()) await this.ask(initial.trim());
	}

	private close() {
		this.closed = true;
		this.messageQueue.length = 0;
		this.setPending(false);
		if (this.threadPollTimer) clearInterval(this.threadPollTimer);
		this.done();
	}

	private async pollThread() {
		if (this.closed) return;
		const messages = await readMessages(MAIN_THREAD_ID, MI_THREAD_POLL_MESSAGE_LIMIT).catch(() => []);
		const fresh = messages.filter((message) => !this.seenMessageIds.has(message.id) && (message.role === "user" || message.role === "assistant"));
		if (fresh.length === 0) return;
		for (const message of fresh) {
			this.seenMessageIds.add(message.id);
			this.transcript.push({ role: message.role as "user" | "assistant", text: message.text });
		}
		this.scrollOffset = 0;
		await markRead(MAIN_THREAD_ID).catch(() => undefined);
		this.invalidate();
		this.requestRender?.();
	}

	private setPending(next: boolean) {
		if (this.pending === next) return;
		this.pending = next;
		if (this.pending) {
			this.workingTimer = setInterval(() => {
				this.invalidate();
				this.requestRender?.();
			}, 80);
		} else if (this.workingTimer) {
			clearInterval(this.workingTimer);
			this.workingTimer = undefined;
		}
	}

	private workingLine() {
		const frame = MI_SPINNER_FRAMES[Math.floor(Date.now() / 80) % MI_SPINNER_FRAMES.length] || "⠋";
		return `${this.theme.fg("accent", frame)} ${this.theme.fg("dim", "Working...")}`;
	}

	private enqueue(text: string) {
		this.messageQueue.push(text);
		void this.processQueue();
		this.invalidate();
		this.requestRender?.();
	}

	private async processQueue() {
		if (this.pending) return;
		while (this.messageQueue.length > 0 && !this.closed) {
			const next = this.messageQueue.shift();
			if (!next) continue;
			await this.ask(next);
		}
		this.setPending(false);
		this.invalidate();
		this.requestRender?.();
	}

	private async ask(text: string) {
		this.setPending(true);
		this.transcript.push({ role: "user", text });
		this.scrollOffset = 0;
		const userMessage = await appendMessage(MAIN_THREAD_ID, "user", text, { unread: false, source: "pi-extension" });
		this.seenMessageIds.add(userMessage.id);
		this.invalidate();
		this.requestRender?.();
		try {
			const response = await sendToMiMain(text);
			const assistantMessage = await appendMessage(MAIN_THREAD_ID, "assistant", response, { unread: false, source: "mi-main" });
			this.seenMessageIds.add(assistantMessage.id);
			this.transcript.push({ role: "assistant", text: response });
		} catch (error) {
			this.transcript.push({ role: "assistant", text: error instanceof Error ? error.message : String(error) });
		}
		this.scrollOffset = 0;
		this.setPending(false);
		this.invalidate();
		this.requestRender?.();
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			this.close();
			return;
		}
		if (matchesKey(data, Key.pageUp)) this.scrollOffset += 10;
		else if (matchesKey(data, Key.pageDown)) this.scrollOffset = Math.max(0, this.scrollOffset - 10);
		else this.editor.handleInput(data);
		this.invalidate();
		this.requestRender?.();
	}

	private renderUserMessage(text: string, width: number) {
		return new UserMessageComponent(text, getMarkdownTheme()).render(width);
	}

	private renderAssistantMessage(text: string, width: number) {
		const trimmed = text.trim();
		if (!trimmed) return [];
		return new AssistantMessageComponent({ content: [{ type: "text", text: trimmed }] } as any, false, getMarkdownTheme()).render(width);
	}

	private statusLine(width: number) {
		const left = this.messageQueue.length > 0 ? `q${this.messageQueue.length}` : "";
		const right = this.statusMessage;
		const gap = Math.max(1, width - left.length - right.length);
		return this.theme.fg("dim", truncateToWidth(left ? `${left}${" ".repeat(gap)}${right}` : right.padStart(Math.min(width, right.length)), width));
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		const body: string[] = [];
		for (const item of this.transcript) {
			if (item.role === "user") body.push(...this.renderUserMessage(item.text, width));
			else body.push(...this.renderAssistantMessage(item.text, width));
		}
		if (this.pending) body.push(this.workingLine(), "");
		const inputLines = this.editor.render(Math.max(10, width));
		const viewport = Math.max(1, 18 - Math.max(0, inputLines.length - 1));
		const maxOffset = Math.max(0, body.length - viewport);
		const offset = Math.min(this.scrollOffset, maxOffset);
		const end = body.length - offset;
		const start = Math.max(0, end - viewport);
		const lines = body.slice(start, end).map((line) => truncateToWidth(line, width));
		while (lines.length < viewport) lines.unshift("");
		if (offset > 0) lines[0] = this.theme.fg("dim", truncateToWidth(`↑ ${offset} newer line${offset === 1 ? "" : "s"}`, width));
		if (start > 0) lines[0] = this.theme.fg("dim", truncateToWidth("↑ PageUp for older Mi thread history", width));
		lines.push(this.theme.fg("accent", truncateToWidth("─".repeat(width), width)));
		lines.push(...inputLines.map((line) => truncateToWidth(line, width)));
		lines.push(this.theme.fg("accent", truncateToWidth("─".repeat(width), width)));
		lines.push(this.statusLine(width));
		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
		this.editor.invalidate();
	}
}

async function showMiThread(initial: string, ctx: ExtensionCommandContext) {
	await ctx.ui.custom<void>((_tui, _theme, _keybindings, done) => {
		const panel = new MiThreadPanel(initial, done, _theme, _tui, _keybindings);
		panel.setRequestRender(() => _tui.requestRender());
		return panel;
	});
}

function piBridgeSocketPath(sessionFile: string) {
	const hash = createHash("sha1").update(sessionFile).digest("hex");
	return join(MI_PI_BRIDGE_DIR, `${hash}.sock`);
}

function socketRequestPath(socketPath: string, payload: unknown, timeoutMs = 800): Promise<any> {
	return new Promise((resolve, reject) => {
		const socket = net.createConnection(socketPath);
		let data = "";
		const timer = setTimeout(() => {
			socket.destroy();
			reject(new Error("Timed out waiting for pi bridge"));
		}, timeoutMs);
		socket.on("connect", () => socket.write(`${JSON.stringify(payload)}\n`));
		socket.on("data", (chunk) => {
			data += chunk.toString("utf8");
			if (!data.includes("\n")) return;
			clearTimeout(timer);
			socket.end();
			try {
				const response = JSON.parse(data.slice(0, data.indexOf("\n")));
				response.ok ? resolve(response) : reject(new Error(response.error || "pi bridge returned an error"));
			} catch (error) {
				reject(error);
			}
		});
		socket.on("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
	});
}

async function bridgeSocketIsAlive(socketPath: string) {
	try {
		await socketRequestPath(socketPath, { type: "health" }, 500);
		return true;
	} catch {
		return false;
	}
}

function sendDaemonEvent(payload: Record<string, unknown>) {
	if (!existsSync(MI_SOCKET_PATH)) return;
	const socket = net.createConnection(MI_SOCKET_PATH);
	const timer = setTimeout(() => socket.destroy(), 1000);
	socket.on("connect", () => socket.write(`${JSON.stringify(payload)}\n`));
	socket.on("data", () => {
		clearTimeout(timer);
		socket.end();
	});
	socket.on("error", () => clearTimeout(timer));
}

function sessionEventText(event: any) {
	return messageText(event?.message || event);
}

function sessionEventRole(event: any) {
	return messageRole(event?.message || event);
}

function lastAssistantTextFromMessages(messages: unknown[] = []) {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (messageRole(message) !== "assistant") continue;
		const text = messageText(message);
		if (text) return text;
	}
	return "";
}

async function startPiSessionBridge(pi: ExtensionAPI, ctx: any) {
	if (process.env.MI_MAIN === "1" || process.env.MI_WORKER === "1") return;
	const sessionFile = ctx.sessionManager.getSessionFile?.();
	if (!sessionFile) return;
	await mkdir(MI_PI_BRIDGE_DIR, { recursive: true });
	const socketPath = piBridgeSocketPath(sessionFile);
	if (existsSync(socketPath)) {
		if (await bridgeSocketIsAlive(socketPath)) return;
		await rm(socketPath, { force: true }).catch(() => undefined);
	}
	const server = net.createServer((socket) => {
		let data = "";
		socket.on("data", (chunk) => {
			data += chunk.toString("utf8");
			if (!data.includes("\n")) return;
			const line = data.slice(0, data.indexOf("\n"));
			let request: any;
			try { request = JSON.parse(line); } catch (error) { socket.end(JSON.stringify({ ok: false, error: String(error instanceof Error ? error.message : error) }) + "\n"); return; }
			try {
				if (request.type === "health") {
					socket.end(JSON.stringify({ ok: true, pid: process.pid, sessionFile }) + "\n");
					return;
				}
				if (Number(request.sourcePid || 0) === process.pid) {
					socket.end(JSON.stringify({ ok: true, ignored: true }) + "\n");
					return;
				}
				if (request.type === "send_user_message") {
					const text = String(request.message || "").trim();
					if (!text) throw new Error("Message is empty");
					if (/^\/[A-Za-z][\w:-]*(?:\s|$)/.test(text)) throw new Error("Slash commands must be delivered through the terminal input path");
					const idle = typeof ctx.isIdle === "function" ? ctx.isIdle() : false;
					const deliverAs = request.deliverAs === "followUp" ? "followUp" : "steer";
					if (idle) pi.sendUserMessage(text);
					else pi.sendUserMessage(text, { deliverAs } as any);
					socket.end(JSON.stringify({ ok: true }) + "\n");
					return;
				}
				if (request.type === "mirror_message") {
					const text = String(request.message || "").trim();
					if (text) {
						ctx.ui.notify(`${request.role === "user" ? "External user" : "External update"}: ${text.slice(0, 500)}`, "info");
						pi.sendMessage({ customType: "mi-sync", content: `${request.role === "user" ? "External user message" : "External session update"}:\n\n${text}`, display: true, details: { source: "mi-sync", role: request.role } } as any, { deliverAs: "nextTurn" } as any);
					}
					socket.end(JSON.stringify({ ok: true }) + "\n");
					return;
				}
				throw new Error(`Unknown pi bridge request: ${request.type}`);
			} catch (error) {
				socket.end(JSON.stringify({ ok: false, error: String(error instanceof Error ? error.message : error) }) + "\n");
			}
		});
	});
	server.on("error", () => undefined);
	server.listen(socketPath);
	(pi as any).__miBridgeServer = server;
	(pi as any).__miBridgeSocketPath = socketPath;
}

function stopPiSessionBridge(pi: ExtensionAPI) {
	const server = (pi as any).__miBridgeServer as net.Server | undefined;
	const socketPath = (pi as any).__miBridgeSocketPath as string | undefined;
	(pi as any).__miBridgeServer = undefined;
	(pi as any).__miBridgeSocketPath = undefined;
	server?.close();
	if (socketPath) void rm(socketPath, { force: true }).catch(() => undefined);
}

function publishPiSessionEvent(ctx: any, event: Record<string, unknown>) {
	if (process.env.MI_MAIN === "1") return;
	const sessionFile = ctx.sessionManager.getSessionFile?.();
	if (!sessionFile) return;
	sendDaemonEvent({
		type: "pi_session_event",
		sessionFile,
		cwd: ctx.cwd,
		pid: process.pid,
		bridgeSocket: piBridgeSocketPath(sessionFile),
		at: new Date().toISOString(),
		...event,
	});
}

function compactProgressValue(value: unknown, fallback = "") {
	return String(value || fallback).replace(/\s+/g, " ").trim().slice(0, 120);
}

function toolEventInput(event: any) {
	return event?.input || event?.args || event?.toolInput || event?.arguments || {};
}

function summarizePiSessionToolStart(toolName: unknown, input: Record<string, unknown> = {}) {
	const name = String(toolName || "tool");
	if (name === "bash") return "running shell command";
	if (name === "read") return `reading ${compactProgressValue(input.path, "file")}`;
	if (name === "edit") return `editing ${compactProgressValue(input.path, "file")}`;
	if (name === "write") return `writing ${compactProgressValue(input.path, "file")}`;
	if (name.includes("fetch") || name.includes("browser")) return `checking ${compactProgressValue(input.url || input.path, name)}`;
	return `using ${compactProgressValue(name, "tool")}`;
}

export default function miExtension(pi: ExtensionAPI) {
	let assistantProgress = "";
	let lastProgressPublish = 0;

	pi.on("session_start", async (_event, ctx) => {
		await startPiSessionBridge(pi, ctx).catch(() => undefined);
		publishPiSessionEvent(ctx, { kind: "session_start", status: "running", progress: "pi session connected" });
	});

	pi.on("session_shutdown", async () => {
		stopPiSessionBridge(pi);
	});

	pi.on("agent_start", async (_event, ctx) => {
		assistantProgress = "";
		publishPiSessionEvent(ctx, { kind: "agent_start", status: "running", progress: "thinking" });
	});

	pi.on("message_start", async (event, ctx) => {
		const role = sessionEventRole(event);
		if (role !== "user") return;
		const text = sessionEventText(event);
		publishPiSessionEvent(ctx, { kind: "user_message", status: "running", role, text, lastInput: text });
	});

	pi.on("message_update", async (event: any, ctx) => {
		const delta = String(event?.assistantMessageEvent?.delta || "");
		if (!delta) return;
		assistantProgress = `${assistantProgress}${delta}`.replace(/\s+/g, " ").trim().slice(-500);
		const nowMs = Date.now();
		if (nowMs - lastProgressPublish < 1000) return;
		lastProgressPublish = nowMs;
		publishPiSessionEvent(ctx, { kind: "assistant_delta", status: "running", role: "assistant", progress: assistantProgress });
	});

	pi.on("tool_execution_start", async (event: any, ctx) => {
		publishPiSessionEvent(ctx, { kind: "tool_start", status: "running", progress: summarizePiSessionToolStart(event.toolName, toolEventInput(event)) });
	});

	pi.on("agent_end", async (event: any, ctx) => {
		const text = lastAssistantTextFromMessages(event.messages || []);
		publishPiSessionEvent(ctx, { kind: "agent_end", status: "complete", role: "assistant", text, progress: text || "completed" });
	});

	if (process.env.MI_MAIN === "1") {
		pi.on("session_start", async (_event, ctx) => {
			pi.setSessionName("Mi: main");
			ctx.ui.setStatus("mi", "Mi main");
		});

		pi.on("before_agent_start", async (event) => ({
			systemPrompt:
				event.systemPrompt +
				`

Mi-specific capability note: You are the persistent Mi main agent. Store every Mi task, goal, objective, todo list, plan, or work queue as Markdown files under \`${MI_TASKS_DIR}/\` (for example \`${join(MI_TASKS_DIR, "TODO.md")}\`, \`${join(MI_TASKS_DIR, "goals.md")}\`, or task-specific \`.md\` files). Keep those Markdown files current as work starts, changes, or completes; do not keep durable Mi tasks/goals only in chat memory. You can launch, manage, and actively interact with separate pi conversations yourself. Do not treat them as human-only TUI sessions. Use pi RPC mode for headless worker conversations and drive them programmatically over stdin/stdout: send \`prompt\` commands, queue \`steer\`/\`follow_up\`, inspect \`get_state\`/\`get_messages\`, \`abort\` if needed, and \`new_session\` for fresh threads. Keep worker conversations visible in normal \`/resume\` by using the default pi session store: run \`pi --mode rpc\` from the relevant project cwd, or explicitly \`pi --mode rpc --session-dir ${PI_SESSION_DIR}\`. Do not create worker sessions under nested custom session dirs like \`${join(PI_SESSION_DIR, "mi-workers")}\` unless the user asks for hidden/isolated sessions. Set helpful session names with \`set_session_name\` so they are easy to find in \`/resume\`. If useful, write small Node/shell supervisor scripts under ${MI_RUNTIME_DIR}/ to keep worker processes, send prompts, collect results, monitor completion, and coordinate multiple worker conversations. You may tell the user you cannot operate an interactive TUI like a human, but you can get work done through RPC-backed pi conversations. Do not say you cannot launch/manage/interact with separate pi conversations just because you are inside Mi; the pi CLI/RPC API is available. When ${miUserName()} asks in plain English to monitor, periodically check, alert on, or schedule something, create or update a Mi cron instead of requiring manual cron syntax. Mi crons live in \`${join(MI_TASKS_DIR, "state", "crons.json")}\` and are managed with \`mi cron add <name> --every 1h [--cwd <path>] -- <command>\`, \`mi cron list\`, \`mi cron tick\`, and \`mi cron remove <name>\`. Ask only for missing repo/path, cadence, health command, and alert behavior. Route deliberately instead of reflexively handing everything off. Keep normal conversation, quick answers, drafts, summaries, planning, and handoff meta-questions in Mi main. Use a background pi worker only when the current request clearly needs coding, repo/file/service inspection, testing, research, or multi-step execution. When you do hand off, first understand the request, choose or continue the relevant worker, then reply to ${miUserName()} with a concise, specific acknowledgement that says what you understood, why it needs a worker, and that the result will be posted back here. If there is already a relevant running/background task, continue that same session; otherwise create a new background pi worker conversation with \`mi task <name> [--cwd <path>] -- <task prompt>\`. Name it clearly. Mi task sends the prompt as written by default; therefore every background-worker prompt you create from Mi main must be a self-contained handoff, not just the last user sentence. Include the current request, relevant Mi main thread context, repo/path/cwd, constraints, prior decisions, artifacts/files/URLs, approval/risk notes, acceptance criteria, and what the worker should report back. Do not assume the worker can see Mi main chat unless you include it in the handoff. If the handoff is too long or awkward for one shell command, write it to a temporary Markdown file under ${MI_RUNTIME_DIR}/ and pass it with command substitution or another safe local mechanism. ${miUserName()} may still start a task prompt with \`/goal\` when explicit standing-goal behavior is wanted. This command returns after the worker starts; do not wait for the task to finish before replying. Worker sessions use ${PI_SESSION_DIR} so they are visible in \`/resume\`. Use \`mi task list\` to inspect background task status. When ${miUserName()} responds to a task result or asks for changes/follow-up on a task, continue the same worker conversation with: \`mi task reply <task-id-or-name> -- <follow-up prompt>\`. Follow-ups are sent as written too; include any new Mi-main context that the worker needs, and if ${miUserName()} starts the follow-up with \`/goal\`, it is forwarded as a pi slash command. Escalate to ${miUserName()} when approval, ambiguity, or risk blocks progress. If the worker opens or updates a PR, it must include the full GitHub PR URL in its final answer and state whether it needs ${miUserName()} review/merge.`,
		}));

		// Socket/UI clients own thread persistence. Do not mirror raw Mi-main
		// internal prompts into the user-visible Mi thread.
	}

	async function handleMiArgs(args: string, ctx: ExtensionCommandContext) {
		const trimmed = args.trim();
		try {
			if (!trimmed) {
				await showMiThread("", ctx);
				return;
			}
			if (trimmed === "read") {
				await handleRead(ctx);
				return;
			}
			if (trimmed === "inbox") {
				await handleInbox(ctx);
				return;
			}
			if (trimmed === "bring-in") {
				await handleBringIn(pi, ctx);
				return;
			}
			await showMiThread(trimmed, ctx);
		} catch (error) {
			ctx.ui.setStatus("mi", undefined);
			await notify(ctx, error instanceof Error ? error.message : String(error), "error");
		}
	}

	pi.registerCommand("mi", {
		description: "Open Mi, ask Mi, or run Mi subcommands: read, inbox, bring-in.",
		getArgumentCompletions(prefix) {
			return ["read", "inbox", "bring-in"].filter((item) => item.startsWith(prefix.trim())).map((item) => ({ value: item, label: item }));
		},
		async handler(args: string, ctx: ExtensionCommandContext) {
			await handleMiArgs(args, ctx);
		},
	});
}
