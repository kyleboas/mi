#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../pi/extensions/mi.ts', import.meta.url), 'utf8');

const checks = [
  ['poll timer while panel is open', /threadPollTimer\s*=\s*setInterval\(\(\) => void this\.pollThread\(\), MI_THREAD_POLL_INTERVAL_MS\)/],
  ['panel loads only recent messages', /readMessages\(MAIN_THREAD_ID, MI_THREAD_PANEL_MESSAGE_LIMIT\)/],
  ['poll reads fresh recent thread messages', /private async pollThread\(\)[\s\S]*readMessages\(MAIN_THREAD_ID, MI_THREAD_POLL_MESSAGE_LIMIT\)[\s\S]*seenMessageIds/],
  ['poll marks messages read after rendering them', /pollThread\(\)[\s\S]*markRead\(MAIN_THREAD_ID\)/],
  ['focus propagates to the embedded pi CustomEditor', /set focused\(value: boolean\)[\s\S]*this\.editor\.focused = value/],
  ['Mi uses pi CustomEditor and pi-style editor theme', /new CustomEditor\(tui, miEditorTheme\(theme\), keybindings\)/],
  ['Mi uses pi user message component', /new UserMessageComponent\(text, getMarkdownTheme\(\)\)/],
  ['Mi uses pi assistant message component', /new AssistantMessageComponent\(\{ content: \[\{ type: "text", text: trimmed \}\] \} as any, false, getMarkdownTheme\(\)\)/],
  ['Mi-like separator and status line below input', /lines\.push\(this\.theme\.fg\("accent", truncateToWidth\("─"\.repeat\(width\)/],
  ['queued input is accepted while pending', /private messageQueue: string\[\][\s\S]*private enqueue\(text: string\)/],
  ['timers are cleaned up on close', /private close\(\)[\s\S]*clearInterval\(this\.threadPollTimer\)/],
  ['pi sessions expose a live bridge socket', /function piBridgeSocketPath\(sessionFile: string\)[\s\S]*async function startPiSessionBridge\(pi: ExtensionAPI, ctx: any\)[\s\S]*process\.env\.MI_WORKER === "1"[\s\S]*type === "send_user_message"[\s\S]*pi\.sendUserMessage/],
  ['pi session events publish to Mi daemon', /function publishPiSessionEvent\(ctx: any[\s\S]*type: "pi_session_event"[\s\S]*pi\.on\("agent_start"[\s\S]*pi\.on\("agent_end"/],
  ['pi session tool progress is summarized', /function summarizePiSessionToolStart\(toolName: unknown[\s\S]*name === "bash"\) return "running shell command"[\s\S]*pi\.on\("tool_execution_start"[\s\S]*summarizePiSessionToolStart\(event\.toolName, toolEventInput\(event\)\)/],
  ['pi session progress ignores thinking deltas', /pi\.on\("message_update"[\s\S]*const update = event\?\.assistantMessageEvent \|\| \{\}[\s\S]*if \(update\.type !== "text_delta"\) return[\s\S]*publishPiSessionEvent\(ctx, \{ kind: "assistant_delta"/],
];

const failures = checks.filter(([, pattern]) => !pattern.test(source));
if (failures.length > 0) {
  console.error('Mi pi extension UI checks failed:');
  for (const [name] of failures) console.error(`- ${name}`);
  process.exit(1);
}

console.log('Mi pi extension UI checks passed.');
