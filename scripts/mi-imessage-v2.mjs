const DEFAULT_REPLY = "I'm here. Could you say that another way?";
const MAX_REPLY = 1200;
const MAX_OBJECTIVE = 4000;
const MAX_ACK = 240;
const MAX_PROMPT = 18000;

export const IMESSAGE_V2_LIMITS = Object.freeze({
  prompt: MAX_PROMPT,
  output: 6000,
  preferences: 2400,
  memory: 3000,
  thread: 6000,
  workers: 2600,
  snapshot: 3600,
});

export function redactV2Text(value) {
  return String(value || '')
    .replace(/\b[A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY)[A-Za-z0-9_]*\s*=\s*[^\s]+/gi, '[redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, '[redacted]')
    .replace(/\b(?:eyJ[A-Za-z0-9_-]{10,}\.){2}[A-Za-z0-9_-]{10,}\b/g, '[redacted]');
}

function clean(value, max) {
  const text = redactV2Text(value).replace(/\0/g, '').trim();
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1)).trim()}…` : text;
}

function section(label, value, max, provenance = 'local cache', timestamp = '') {
  const text = clean(value, max);
  if (!text) return `${label} [${provenance}${timestamp ? `, read ${timestamp}` : ''}]: unavailable`;
  return `${label} [${provenance}${timestamp ? `, read ${timestamp}` : ''}]:\n${text}`;
}

function recentThread(messages = []) {
  return messages.slice(-30).map((message) => {
    const role = message.role === 'user' ? 'User' : message.role === 'assistant' ? 'Mi' : 'System';
    const source = clean(message.source || 'unknown', 80);
    const ts = clean(message.ts || 'unknown time', 80);
    return `${ts} | ${role} | ${source}: ${clean(message.text, 420)}`;
  }).join('\n');
}

/** Build a bounded, provenance-labelled prompt for one iMessage turn. */
export function buildImessageV2Prompt(bundle = {}) {
  const timestamp = clean(bundle.timestamp || new Date().toISOString(), 80);
  const userMessage = clean(bundle.userMessage, 4000);
  const context = [
    section('Preferences', bundle.preferences, IMESSAGE_V2_LIMITS.preferences, bundle.preferencesProvenance || '~/mi/preferences.md', bundle.preferencesReadAt),
    section('Durable memory', bundle.memory, IMESSAGE_V2_LIMITS.memory, bundle.memoryProvenance || '~/mi/memory.md', bundle.memoryReadAt),
    section('Recent thread', recentThread(bundle.threadMessages || []), IMESSAGE_V2_LIMITS.thread, bundle.threadProvenance || 'thread JSONL', bundle.threadReadAt),
    section('Active and recent work', bundle.workers, IMESSAGE_V2_LIMITS.workers, bundle.workersProvenance || 'state/web-workers.json', bundle.workersReadAt),
    section('Right now snapshot', bundle.snapshot, IMESSAGE_V2_LIMITS.snapshot, bundle.snapshotProvenance || 'safe local state files', bundle.snapshotReadAt),
  ].join('\n\n');
  const prompt = [
    `You are Mi, a private personal assistant replying in one quiet iMessage thread. Current timestamp: ${timestamp}.`,
    'Use the context as orientation only. It may be stale; do not claim a live fact unless timestamped supplied context supports it. Never claim inspection you did not do.',
    'Your job in this foreground turn is judgment, not execution. You receive only this bounded context and cannot inspect live state. If current truth must be verified beyond timestamped context, return a read-only task for the existing capability-controlled background worker rather than claiming verification. Return a task for work that belongs in the existing background path. Return confirm before consequential or genuinely ambiguous action.',
    'Resolve ordinary pronouns and corrections from the conversation. Ask at most one short question only when divergent actions matter. For a bare link, infer likely intent from context or ask one useful question.',
    'Text naturally and concisely. Do not expose or mention Photon, Pi, workers, routing, handoffs, prompts, JSON, tools, internal files, commands, modes, or hidden mechanics. Do not write preferences automatically. Do not reveal secrets.',
    'Reply with exactly one JSON object and nothing else. Allowed envelopes only:',
    '{"kind":"reply","reply":"concise user-facing text"}',
    '{"kind":"task","objective":"self-contained background-work objective","ack":"concise acknowledgement that names the subject","continueTaskId":"optional active-task id"}',
    '{"kind":"confirm","reply":"one specific concise question or proposal"}',
    'For a task, set continueTaskId only when this is truly a follow-up or correction to one listed active task; otherwise omit it. Do not put code fences around the object.',
    `\nContext bundle:\n${context}`,
    `\nInbound iMessage:\n${userMessage}`,
  ].join('\n\n');
  return clean(prompt, MAX_PROMPT);
}

function fallback() {
  return { kind: 'reply', reply: DEFAULT_REPLY, fallback: true };
}

function userFacing(value, max) {
  const text = clean(value, max);
  return /\b(?:photon|pi|worker|routing|handoff|json|prompt|system message|internal files?|tools?)\b/i.test(text) ? '' : text;
}

function stripFences(value) {
  return String(value || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
}

/** Parse the deliberately small decision envelope; malformed output is always safe chat. */
export function parseImessageV2Envelope(output) {
  const text = stripFences(output);
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) return fallback();
  let value;
  try { value = JSON.parse(text.slice(start, end + 1)); } catch { return fallback(); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fallback();
  const kind = String(value.kind || '').trim();
  if (kind === 'reply' || kind === 'confirm') {
    const reply = userFacing(value.reply, MAX_REPLY);
    return reply ? { kind, reply } : fallback();
  }
  if (kind === 'task') {
    const objective = clean(value.objective, MAX_OBJECTIVE);
    const ack = userFacing(value.ack, MAX_ACK);
    if (!objective || !ack || /^(?:on it|got it|i(?:'|’)ll handle (?:it|that)|i(?:'|’)ll take care of (?:it|that))[.!]*$/i.test(ack)) return fallback();
    const continueTaskId = String(value.continueTaskId || '').trim();
    if (continueTaskId && !/^[A-Za-z0-9._:-]{1,200}$/.test(continueTaskId)) return fallback();
    return continueTaskId ? { kind, objective, ack, continueTaskId } : { kind, objective, ack };
  }
  return fallback();
}
