/**
 * Cost-driven auto-compaction with pi context governance v2.
 *
 * Nanobot-inspired pieces ported here:
 * - large compactable tool results are offloaded to ~/.pi/offload
 * - older compactable tool-result messages are microcompacted in the context hook
 * - whole-session compaction still runs, with PI_INFLIGHT_TARGET_RATIO headroom
 *
 * Configure with PI_AUTO_COMPACT_TOKENS (default 80000, 0 disables).
 * Set PI_OFFLOAD_MIN_CHARS=0 to disable tool-result offload.
 */

import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const DEFAULT_THRESHOLD = 80_000;
const DEFAULT_OFFLOAD_MIN_CHARS = 4000;
const DEFAULT_MICROCOMPACT_KEEP_RECENT = 10;
const DEFAULT_MICROCOMPACT_MIN_CHARS = 500;
const DEFAULT_INFLIGHT_TARGET_RATIO = 0.85;
const DEFAULT_OFFLOAD_MAX_MB = 200;

const COMPACTABLE = new Set(["read", "grep", "find", "ls", "bash", "exec", "web_fetch", "fetch"]);
const SECRET_PATTERNS = [
	/\b[A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY)[A-Za-z0-9_]*\s*=\s*[^\s]+/i,
	/\bsk-[A-Za-z0-9_-]{16,}\b/,
	/[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{24,}/,
	/https?:\/\/[^\s:@/]+:[^\s@/]+@/i,
];

export type OffloadDecision = { offload: boolean; reason?: string; pointer?: string; excerpt?: string };
export type MicrocompactResult = { messages: any[]; changed: number };

function envNumber(name: string, fallback: number) {
	const raw = process.env[name];
	if (raw === undefined || raw === "") return fallback;
	const n = Number(raw);
	return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function threshold(): number { return envNumber("PI_AUTO_COMPACT_TOKENS", DEFAULT_THRESHOLD); }
function offloadMinChars(): number { return envNumber("PI_OFFLOAD_MIN_CHARS", DEFAULT_OFFLOAD_MIN_CHARS); }
function microcompactKeepRecent(): number { return Math.floor(envNumber("PI_MICROCOMPACT_KEEP_RECENT", DEFAULT_MICROCOMPACT_KEEP_RECENT)); }
function microcompactMinChars(): number { return envNumber("PI_MICROCOMPACT_MIN_CHARS", DEFAULT_MICROCOMPACT_MIN_CHARS); }
function inflightTargetRatio(): number { return envNumber("PI_INFLIGHT_TARGET_RATIO", DEFAULT_INFLIGHT_TARGET_RATIO); }
function offloadMaxMb(): number { return envNumber("PI_OFFLOAD_MAX_MB", DEFAULT_OFFLOAD_MAX_MB); }

export function offloadRoot() { return process.env.PI_OFFLOAD_DIR || join(homedir(), ".pi", "offload"); }

function safeSegment(value: string | undefined, fallback: string) {
	return String(value || fallback).replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 120) || fallback;
}

export function textFromToolContent(content: any): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) return content.map((item) => typeof item === "string" ? item : typeof item?.text === "string" ? item.text : "").filter(Boolean).join("\n");
	if (content && typeof content === "object" && typeof content.text === "string") return content.text;
	return "";
}

export function hasSecretLikeContent(text: string) {
	return SECRET_PATTERNS.some((re) => re.test(text));
}

export function isCompactableTool(toolName: string | undefined) {
	return Boolean(toolName && COMPACTABLE.has(toolName));
}

export function isOffloadReadLoop(toolName: string | undefined, input: any) {
	if (!toolName || !/^read(?:_file)?$/.test(toolName)) return false;
	const path = typeof input?.path === "string" ? input.path : "";
	return path.includes("/.pi/offload/") || path.startsWith(offloadRoot());
}

export function excerptWithPointer(text: string, pointer: string, head = 1200, tail = 800) {
	const omitted = Math.max(0, text.length - head - tail);
	const body = omitted > 0 ? `${text.slice(0, head)}\n\n[...snipped ${omitted} chars...]\n\n${text.slice(-tail)}` : text;
	return `${body}\n\n[full output persisted to ${pointer}; read it if needed]`;
}

export function decideToolResultOffload(args: { toolName?: string; input?: any; text: string; minChars?: number; pointer: string }): OffloadDecision {
	const min = args.minChars ?? offloadMinChars();
	if (min === 0) return { offload: false, reason: "offload-disabled" };
	if (!isCompactableTool(args.toolName)) return { offload: false, reason: "tool-not-compactable" };
	if (isOffloadReadLoop(args.toolName, args.input)) return { offload: false, reason: "offload-read-exempt" };
	if (args.text.length < min) return { offload: false, reason: "below-threshold" };
	if (hasSecretLikeContent(args.text)) return { offload: false, reason: "secret-like-content" };
	return { offload: true, pointer: args.pointer, excerpt: excerptWithPointer(args.text, args.pointer) };
}

function dirSize(path: string): number {
	try {
		return readdirSync(path, { withFileTypes: true }).reduce((sum, entry) => {
			const full = join(path, entry.name);
			return sum + (entry.isDirectory() ? dirSize(full) : statSync(full).size);
		}, 0);
	} catch {
		return 0;
	}
}

export function pruneOffloadRoot(root = offloadRoot(), maxMb = offloadMaxMb()) {
	if (maxMb === 0) return { pruned: 0, bytes: dirSize(root) };
	const maxBytes = maxMb * 1024 * 1024;
	let bytes = dirSize(root);
	let pruned = 0;
	try {
		const entries = readdirSync(root, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => ({ path: join(root, entry.name), mtime: statSync(join(root, entry.name)).mtimeMs }));
		for (const entry of entries.sort((a, b) => a.mtime - b.mtime)) {
			if (bytes <= maxBytes) break;
			const removedBytes = dirSize(entry.path);
			rmSync(entry.path, { recursive: true, force: true });
			bytes -= removedBytes;
			pruned += 1;
		}
	} catch {}
	return { pruned, bytes: Math.max(0, bytes) };
}

function compactedContent(content: any, toolName: string, pointer: string) {
	const text = `[older ${toolName} result microcompacted; full output persisted to ${pointer}; read it if needed]`;
	if (typeof content === "string") return text;
	if (Array.isArray(content)) return [{ type: "text", text }];
	if (content && typeof content === "object" && typeof content.text === "string") return { ...content, text };
	return text;
}

export function microcompactMessages(messages: any[], opts: { keepRecent?: number; minChars?: number } = {}): MicrocompactResult {
	const keepRecent = opts.keepRecent ?? microcompactKeepRecent();
	const minChars = opts.minChars ?? microcompactMinChars();
	const cutoff = Math.max(0, messages.length - keepRecent);
	let changed = 0;
	const next = messages.map((message, index) => {
		if (index >= cutoff) return message;
		const text = textFromToolContent(message.content);
		const toolName = message.toolName || message.name || message.tool_call?.name;
		if (text.length < minChars || !isCompactableTool(toolName) || hasSecretLikeContent(text)) return message;
		changed += 1;
		const pointer = message.offloadPath || join(offloadRoot(), "session", `${safeSegment(message.toolCallId, "tool")}.txt`);
		return { ...message, content: compactedContent(message.content, toolName, pointer) };
	});
	return { messages: next, changed };
}

export function shouldWholeCompact(tokens: number | null | undefined, limit = threshold(), ratio = inflightTargetRatio()) {
	if (!tokens || limit === 0) return false;
	return tokens >= Math.floor(limit * ratio);
}

function sessionSegment(ctx: any) {
	return safeSegment(ctx?.sessionManager?.getSessionFile?.() || ctx?.sessionId || "session", "session");
}

export default function (pi: any) {
	let compacting = false;
	pruneOffloadRoot();

	pi.on("tool_result", async (event: any, ctx: any) => {
		const text = textFromToolContent(event.content);
		if (!text) return undefined;
		const pointer = join(offloadRoot(), sessionSegment(ctx), `${safeSegment(event.toolCallId, "tool")}.txt`);
		const decision = decideToolResultOffload({ toolName: event.toolName, input: event.input, text, pointer });
		if (!decision.offload || !decision.excerpt) return undefined;
		mkdirSync(dirname(pointer), { recursive: true, mode: 0o700 });
		writeFileSync(pointer, text, { mode: 0o600 });
		return { content: [{ type: "text", text: decision.excerpt }], details: { ...(event.details || {}), offloadPath: pointer } };
	});

	pi.on("context", async (event: any) => {
		const result = microcompactMessages(event.messages || []);
		if (result.changed) return { messages: result.messages };
		return undefined;
	});

	pi.on("agent_end", async (_event: any, ctx: any) => {
		const limit = threshold();
		if (limit === 0 || compacting) return;
		const usage = ctx.getContextUsage();
		if (!shouldWholeCompact(usage?.tokens, limit, inflightTargetRatio())) return;
		compacting = true;
		ctx.ui.notify(
			`Context at ${Math.round((usage?.tokens || 0) / 1000)}k tokens (budget ${Math.round(limit / 1000)}k); auto-compacting`,
			"info",
		);
		ctx.compact({
			onComplete: () => { compacting = false; },
			onError: (error: Error) => {
				compacting = false;
				ctx.ui.notify(`Auto-compact failed: ${error.message}`, "warning");
			},
		});
	});
}
