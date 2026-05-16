import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { Input, Key, matchesKey, truncateToWidth, wrapTextWithAnsi, type Component, type Focusable } from "@mariozechner/pi-tui";
import { spawn } from "node:child_process";
import net from "node:net";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

const MI_ROOT = process.env.MI_ROOT || "/home/kyle/assistant";
const THREADS_DIR = join(MI_ROOT, "state", "threads");
const INDEX_PATH = join(THREADS_DIR, "index.json");
const MAIN_THREAD_ID = "main";
const MI_MAX_RESPONSE_CHARS = 255;
const MI_PROMPT_PREFIX = `Answer in ${MI_MAX_RESPONSE_CHARS} characters or fewer. Do not exceed the limit. Be concise.\n\n`;
const MI_REWRITE_PREFIX = `Rewrite this answer in ${MI_MAX_RESPONSE_CHARS} characters or fewer.`;
const MI_RUNTIME_DIR = process.env.MI_RUNTIME_DIR || "/home/kyle/.pi/agent/mi";
const MI_SOCKET_PATH = process.env.MI_SOCKET_PATH || join(MI_RUNTIME_DIR, "main.sock");
const MI_DAEMON_PATH = process.env.MI_DAEMON_PATH || "/home/kyle/.pi/agent/extensions/mi-daemon.mjs";
const MI_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

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

async function readMessages(threadId = MAIN_THREAD_ID, limit?: number) {
	await ensureMainThread();
	try {
		const messages = (await readFile(threadPath(threadId), "utf8"))
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as ThreadMessage);
		return typeof limit === "number" ? messages.slice(-limit) : messages;
	} catch {
		return [];
	}
}

async function markRead(threadId = MAIN_THREAD_ID) {
	await ensureMainThread();
	const threads = await readIndex();
	const record = threads.find((thread) => thread.id === threadId);
	if (record) record.unread = 0;
	await writeIndex(threads);

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
	await markRead(MAIN_THREAD_ID);
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
	return text.trim() || "Mi completed without text.";
}

function miPrompt(message: string) {
	return `${MI_PROMPT_PREFIX}${message}`;
}

async function requestMi(message: string) {
	const response = await sendSocketRequest({ type: "prompt", message });
	return normalizeMiResponse(response.text || "");
}

async function sendToMiMain(message: string): Promise<string> {
	try {
		let text = await requestMi(miPrompt(message));
		if (text.length <= MI_MAX_RESPONSE_CHARS) return text;
		text = await requestMi(`Rewrite this answer in ${MI_MAX_RESPONSE_CHARS} characters or fewer. Do not truncate; produce a complete concise answer.\n\n${text}`);
		return normalizeMiResponse(text);
	} catch (error) {
		if (existsSync(MI_SOCKET_PATH)) throw error;
	}
	await startMiDaemon();
	let text = await requestMi(miPrompt(message));
	if (text.length <= MI_MAX_RESPONSE_CHARS) return text;
	text = await requestMi(`Rewrite this answer in ${MI_MAX_RESPONSE_CHARS} characters or fewer. Do not truncate; produce a complete concise answer.\n\n${text}`);
	return normalizeMiResponse(text);
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

class MiThreadPanel implements Component, Focusable {
	private input = new Input();
	private transcript: Array<{ role: "user" | "assistant"; text: string }> = [];
	private pending = false;
	private scrollOffset = 0;
	private cachedWidth?: number;
	private cachedLines?: string[];
	private requestRender?: () => void;
	private workingTimer?: NodeJS.Timeout;
	focused = false;

	constructor(initial: string, private done: () => void, private theme: { fg: (style: any, text: string) => string }) {
		this.input.onSubmit = (value) => {
			const text = value.trim();
			if (!text || this.pending) return;
			this.input.setValue("");
			this.ask(text).catch((error) => {
				this.setPending(false);
				this.transcript.push({ role: "assistant", text: error instanceof Error ? error.message : String(error) });
				this.invalidate();
				this.requestRender?.();
			});
		};
		this.input.onEscape = () => {
			this.setPending(false);
			this.done();
		};
		void this.load(initial);
	}

	setRequestRender(requestRender: () => void) {
		this.requestRender = requestRender;
	}

	private async load(initial: string) {
		this.transcript = (await readMessages(MAIN_THREAD_ID, 20))
			.filter((message) => message.role === "user" || message.role === "assistant")
			.map((message) => ({ role: message.role as "user" | "assistant", text: message.text }));
		this.invalidate();
		this.requestRender?.();
		if (initial.trim()) await this.ask(initial.trim());
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

	private async ask(text: string) {
		this.setPending(true);
		this.transcript.push({ role: "user", text });
		this.scrollOffset = 0;
		await appendMessage(MAIN_THREAD_ID, "user", text, { unread: false, source: "pi-extension" });
		this.invalidate();
		this.requestRender?.();
		const response = await sendToMiMain(text);
		await appendMessage(MAIN_THREAD_ID, "assistant", response, { unread: false, source: "mi-main" });
		this.transcript.push({ role: "assistant", text: response });
		this.scrollOffset = 0;
		this.setPending(false);
		this.invalidate();
		this.requestRender?.();
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape)) {
			this.setPending(false);
			this.done();
			return;
		}
		if (matchesKey(data, Key.pageUp)) {
			this.scrollOffset += 10;
		} else if (matchesKey(data, Key.pageDown)) {
			this.scrollOffset = Math.max(0, this.scrollOffset - 10);
		} else if (!this.pending) {
			this.input.handleInput(data);
		}
		this.invalidate();
		this.requestRender?.();
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		const innerWidth = Math.max(20, width - 4);
		const lines = [truncateToWidth("Mi", width), truncateToWidth("─".repeat(width), width)];
		const body: string[] = [];
		for (const item of this.transcript) {
			const text = item.text;
			const styled = item.role === "user" ? this.theme.fg("muted", text) : text;
			body.push(...wrapTextWithAnsi(styled, innerWidth));
			body.push("");
		}
		if (this.pending) body.push(this.workingLine());
		const viewport = 18;
		const maxOffset = Math.max(0, body.length - viewport);
		const offset = Math.min(this.scrollOffset, maxOffset);
		const end = body.length - offset;
		const start = Math.max(0, end - viewport);
		if (offset > 0) lines.push(truncateToWidth(`↑ ${offset} line${offset === 1 ? "" : "s"} below`, width));
		lines.push(...body.slice(start, end).map((line) => truncateToWidth(line, width)));
		if (start > 0) lines.push(truncateToWidth("↑ PageUp for older Mi thread history", width));
		lines.push(truncateToWidth("─".repeat(width), width));
		const inputLine = this.pending ? "…" : this.input.render(Math.max(10, width - 3))[0] || "";
		lines.push(truncateToWidth(inputLine, width));
		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
		this.input.invalidate();
	}
}

async function showMiThread(initial: string, ctx: ExtensionCommandContext) {
	await ctx.ui.custom<void>((_tui, _theme, _keybindings, done) => {
		const panel = new MiThreadPanel(initial, done, _theme);
		panel.setRequestRender(() => _tui.requestRender());
		return panel;
	});
}

export default function miExtension(pi: ExtensionAPI) {
	if (process.env.MI_MAIN === "1") {
		let skipNextInternalAssistant = false;

		pi.on("session_start", async (_event, ctx) => {
			pi.setSessionName("Mi: main");
			ctx.ui.setStatus("mi", "Mi main");
		});

		pi.on("before_agent_start", async (event) => ({
			systemPrompt:
				event.systemPrompt +
				"\n\nMi-specific capability note: You are the persistent Mi main agent. Store every Mi task, goal, objective, todo list, plan, or work queue as Markdown files under `/home/kyle/mi/` (for example `/home/kyle/mi/TODO.md`, `/home/kyle/mi/goals.md`, or task-specific `.md` files). Keep those Markdown files current as work starts, changes, or completes; do not keep durable Mi tasks/goals only in chat memory. You can launch, manage, and actively interact with separate pi conversations yourself. Do not treat them as human-only TUI sessions. Use pi RPC mode for headless worker conversations and drive them programmatically over stdin/stdout: send `prompt` commands, queue `steer`/`follow_up`, inspect `get_state`/`get_messages`, `abort` if needed, and `new_session` for fresh threads. Keep worker conversations visible in normal `/resume` by using the default pi session store: run `pi --mode rpc` from the relevant project cwd, or explicitly `pi --mode rpc --session-dir /home/kyle/.pi/agent/sessions`. Do not create worker sessions under nested custom session dirs like `/home/kyle/.pi/agent/sessions/mi-workers/...` unless the user asks for hidden/isolated sessions. Set helpful session names with `set_session_name` so they are easy to find in `/resume`. If useful, write small Node/shell supervisor scripts under /home/kyle/.pi/agent/mi/ to keep worker processes, send prompts, collect results, monitor completion, and coordinate multiple worker conversations. You may tell the user you cannot operate an interactive TUI like a human, but you can get work done through RPC-backed pi conversations. Do not say you cannot launch/manage/interact with separate pi conversations just because you are inside Mi; the pi CLI/RPC API is available. When Kyle asks in plain English to monitor, periodically check, alert on, or schedule something, create or update a Mi cron instead of requiring manual cron syntax. Mi crons live in `/home/kyle/mi/state/crons.json` and are managed with `mi cron add <name> --every 1h [--cwd <path>] -- <command>`, `mi cron list`, `mi cron tick`, and `mi cron remove <name>`. Ask only for missing repo/path, cadence, health command, and alert behavior. When Kyle gives Mi a substantive task that needs coding, repo inspection, testing, research, or multi-step work, immediately hand it off to a background pi worker instead of doing the work in Mi. If there is already a relevant running/background task, continue that same session; otherwise create a new background pi worker conversation with `mi task <name> [--cwd <path>] -- <task prompt>`. Name it clearly. Mi task wraps the prompt in /goal by default for sustained execution. This command returns after the worker starts; do not wait for the task to finish before replying to Kyle. Worker sessions use `/home/kyle/.pi/agent/sessions` so Kyle can see them in `/resume`. Use `mi task list` to inspect background task status. When Kyle responds to a task result or asks for changes/follow-up on a task, continue the same worker conversation with: `mi task reply <task-id-or-name> -- <follow-up prompt>`. Follow-ups are also wrapped in /goal by default unless already using /goal. Escalate to Kyle when approval, ambiguity, or risk blocks progress. If the worker opens or updates a PR, it must include the full GitHub PR URL in its final answer and state whether it needs Kyle review/merge.",
		}));

		pi.on("message_end", async (event) => {
			const role = messageRole(event.message);
			if (role !== "user" && role !== "assistant") return;
			const text = messageText(event.message);
			if (!text) return;
			if (role === "user" && (text.startsWith(`Answer in ${MI_MAX_RESPONSE_CHARS} characters or fewer.`) || text.startsWith(MI_REWRITE_PREFIX))) {
				skipNextInternalAssistant = true;
				return;
			}
			if (role === "assistant" && skipNextInternalAssistant) {
				skipNextInternalAssistant = false;
				return;
			}
			await appendMessage(MAIN_THREAD_ID, role, text, { unread: false, source: "pi-main" });
		});
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

	pi.on("input", async (event, ctx) => {
		if (event.source !== "interactive") return { action: "continue" };
		const match = event.text.match(/^mi(?:\s+|$)([\s\S]*)/i);
		if (!match) return { action: "continue" };
		await handleMiArgs(match[1] || "", ctx);
		return { action: "handled" };
	});

	pi.registerCommand("mi", {
		description: "Ask Mi a quick side question without adding it to the main assistant context; /mi read; /mi bring-in.",
		getArgumentCompletions(prefix) {
			return ["read", "inbox", "bring-in"].filter((item) => item.startsWith(prefix.trim())).map((item) => ({ value: item, label: item }));
		},
		async handler(args: string, ctx: ExtensionCommandContext) {
			await handleMiArgs(args, ctx);
		},
	});
}
