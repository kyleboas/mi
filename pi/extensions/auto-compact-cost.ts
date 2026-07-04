/**
 * Cost-driven auto-compaction.
 *
 * Pi's native auto-compaction only fires near the model's context window
 * (contextWindow - reserveTokens), which gpt-5.5 sessions rarely reach.
 * Cost, however, scales with context size on every call: long sessions
 * replay 60-100k+ tokens per call as cache reads. This extension triggers
 * pi's built-in compaction whenever context exceeds a fixed token budget,
 * keeping per-call replay bounded.
 *
 * Configure with PI_AUTO_COMPACT_TOKENS (default 80000, 0 disables).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_THRESHOLD = 80_000;

function threshold(): number {
	const raw = process.env.PI_AUTO_COMPACT_TOKENS;
	if (raw === undefined || raw === "") return DEFAULT_THRESHOLD;
	const n = Number(raw);
	return Number.isFinite(n) && n >= 0 ? n : DEFAULT_THRESHOLD;
}

function resultText(content: any) { return typeof content === "string" ? content : JSON.stringify(content ?? ""); }
function offloadRoot() { return join(homedir(), ".pi", "offload"); }
function pruneOffload(maxMb = Number(process.env.PI_OFFLOAD_MAX_MB || 200)) {
	try {
		const root = offloadRoot();
		const entries = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => ({ path: join(root, e.name), mtime: statSync(join(root, e.name)).mtimeMs }));
		let total = entries.reduce((sum, e) => sum + dirSize(e.path), 0);
		for (const entry of entries.sort((a, b) => a.mtime - b.mtime)) { if (total <= maxMb * 1024 * 1024) break; total -= dirSize(entry.path); rmSync(entry.path, { recursive: true, force: true }); }
	} catch {}
}
function dirSize(path: string): number { try { return readdirSync(path, { withFileTypes: true }).reduce((sum, e) => sum + (e.isDirectory() ? dirSize(join(path, e.name)) : statSync(join(path, e.name)).size), 0); } catch { return 0; } }

export default function (pi: ExtensionAPI) {
	let compacting = false;
	pruneOffload();
	pi.on("tool_result", async (event: any, ctx: any) => {
		const session = (ctx.sessionManager?.getSessionFile?.() || "session").replace(/[^a-zA-Z0-9_.-]/g, "_");
		const dir = join(offloadRoot(), session);
		const pointer = join(dir, `${event.toolCallId || Date.now()}.txt`);
		const text = resultText(event.content);
		const decision = decideToolResultOffload({ toolName: event.toolName, input: event.input, text, pointer });
		if (!decision.offload) return;
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		writeFileSync(pointer, text, { mode: 0o600 });
		return { content: [{ type: "text", text: decision.excerpt }] };
	});
	pi.on("context", async (event: any) => {
		const result = microcompactMessages(event.messages || []);
		if (result.changed) return { messages: result.messages };
	});

	pi.on("agent_end", async (_event, ctx) => {
		const limit = threshold();
		if (limit === 0 || compacting) return;

		const usage = ctx.getContextUsage();
		if (!usage || usage.tokens === null || usage.tokens < limit) return;

		compacting = true;
		ctx.ui.notify(
			`Context at ${Math.round(usage.tokens / 1000)}k tokens (budget ${Math.round(limit / 1000)}k); auto-compacting`,
			"info",
		);
		ctx.compact({
			onComplete: () => {
				compacting = false;
			},
			onError: (error) => {
				compacting = false;
				ctx.ui.notify(`Auto-compact failed: ${error.message}`, "warning");
			},
		});
	});
}

// Context governance v2 helpers. Exported for Mi tests.
export type OffloadDecision = { offload: boolean; reason?: string; pointer?: string; excerpt?: string };
const COMPACTABLE = new Set(['read', 'grep', 'find', 'ls', 'bash', 'exec', 'web_fetch', 'fetch']);
const SECRET_PATTERNS = [/api[_-]?key/i, /token/i, /password/i, /secret/i, /sk-[A-Za-z0-9_-]{12,}/, /[A-Za-z]+:\/\/[^\s/@]+:[^\s/@]+@/];
export function hasSecretLikeContent(text: string) { return SECRET_PATTERNS.some((re) => re.test(text)); }
export function isCompactableTool(toolName: string) { return COMPACTABLE.has(toolName); }
export function isOffloadReadLoop(toolName: string, input: any) { return toolName === 'read' && typeof input?.path === 'string' && input.path.includes('/.pi/offload/'); }
export function excerptWithPointer(text: string, pointer: string, head = 1200, tail = 800) { return `${text.slice(0, head)}\n\n[full output persisted to ${pointer}; read it if needed]\n\n${text.slice(Math.max(head, text.length - tail))}`; }
export function decideToolResultOffload(args: { toolName: string; input?: any; text: string; minChars?: number; pointer: string }): OffloadDecision {
	const min = args.minChars ?? Number(process.env.PI_OFFLOAD_MIN_CHARS || 4000);
	if (!isCompactableTool(args.toolName)) return { offload: false, reason: 'tool-not-compactable' };
	if (isOffloadReadLoop(args.toolName, args.input)) return { offload: false, reason: 'offload-read-exempt' };
	if (args.text.length < min) return { offload: false, reason: 'below-threshold' };
	if (hasSecretLikeContent(args.text)) return { offload: false, reason: 'secret-like-content' };
	return { offload: true, pointer: args.pointer, excerpt: excerptWithPointer(args.text, args.pointer) };
}
export function microcompactMessages(messages: any[], opts: { keepRecent?: number; minChars?: number } = {}) {
	const keepRecent = opts.keepRecent ?? Number(process.env.PI_MICROCOMPACT_KEEP_RECENT || 10);
	const minChars = opts.minChars ?? Number(process.env.PI_MICROCOMPACT_MIN_CHARS || 500);
	const cutoff = Math.max(0, messages.length - keepRecent);
	let changed = 0;
	const next = messages.map((message, index) => {
		if (index >= cutoff) return message;
		const text = typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '');
		const toolName = message.toolName || message.name || message.tool_call?.name || 'unknown';
		if (text.length < minChars || !isCompactableTool(toolName) || hasSecretLikeContent(text)) return message;
		changed++;
		return { ...message, content: `[older ${toolName} result compacted; full output was offloaded when available] ${text.slice(0, 160)}` };
	});
	return { messages: next, changed };
}
