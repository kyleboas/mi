#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../pi/extensions/mi.ts', import.meta.url), 'utf8');

const checks = [
  ['poll timer while panel is open', /threadPollTimer\s*=\s*setInterval\(\(\) => void this\.pollThread\(\), 2000\)/],
  ['poll reads fresh thread messages', /private async pollThread\(\)[\s\S]*readMessages\(MAIN_THREAD_ID\)[\s\S]*seenMessageIds/],
  ['poll marks messages read after rendering them', /pollThread\(\)[\s\S]*markRead\(MAIN_THREAD_ID\)/],
  ['focus propagates to the embedded pi Input', /set focused\(value: boolean\)[\s\S]*this\.input\.focused = value/],
  ['Mi-like user message block background', /theme\.bg \? this\.theme\.bg\("userMessageBg"/],
  ['Mi-like separator and status line below input', /lines\.push\(this\.theme\.fg\("accent", truncateToWidth\("─"\.repeat\(width\)/],
  ['queued input is accepted while pending', /private messageQueue: string\[\][\s\S]*private enqueue\(text: string\)/],
  ['timers are cleaned up on close', /private close\(\)[\s\S]*clearInterval\(this\.threadPollTimer\)/],
];

const failures = checks.filter(([, pattern]) => !pattern.test(source));
if (failures.length > 0) {
  console.error('Mi pi extension UI checks failed:');
  for (const [name] of failures) console.error(`- ${name}`);
  process.exit(1);
}

console.log('Mi pi extension UI checks passed.');
