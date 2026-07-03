import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { notifyImessage } from './notify.js';
import { appendThreadMessage } from './threads.js';
import { logEvent } from './state.js';
import { sendTaskSocketRequest } from './mi-daemon-client.js';

export type LoopFactoryStatus = 'captured' | 'triaged_low' | 'ready_to_grill' | 'grilling' | 'build_ready' | 'implementation_queued' | 'rejected' | 'superseded';
export type LoopFactorySource = 'pi' | 'mi' | 'imessage' | 'web' | 'loop-discovery' | 'manual';

export type LoopFactoryCandidate = {
  id: string;
  name: string;
  status: LoopFactoryStatus;
  source: LoopFactorySource | string;
  captured_at: string;
  updated_at?: string;
  examples_count: number;
  pain: 'low' | 'medium' | 'high';
  trigger_guess: string;
  owner: string;
  spec_path?: string;
  triage_score: number;
  next_action: string;
  short_rationale: string;
  snippet?: string;
  source_refs?: string[];
  taskId?: string;
  sessionFile?: string;
  sessionName?: string;
  buildReadyNotifiedAt?: string;
  implementationDecision?: 'queue now' | 'later' | 'never';
};

export type LoopFactoryState = {
  version?: number;
  lastRunAt?: string;
  lastDigestAt?: string;
  activeGrilling?: { candidateId: string; taskId?: string; sessionFile?: string; startedAt: string; lastNudgedAt?: string };
  active_grilling_session_ids?: string[];
  lastQuestionAsked?: { candidateId: string; question?: string; recommendedAnswer?: string; at: string };
  decisionHistory?: Array<{ at: string; candidateId?: string; action: string; detail?: string }>;
  candidates?: LoopFactoryCandidate[];
  deliveryFailures?: Array<{ at: string; channel: 'imessage' | 'mi-main'; error: string }>;
};

export type LoopFactoryCaptureOptions = { source?: LoopFactorySource | string; startGrilling?: boolean; notify?: boolean; contextRef?: string };
export type LoopFactoryResult = { ok: boolean; reply: string; candidate?: LoopFactoryCandidate; started?: boolean; handoff?: boolean; status?: string };

const HOME = homedir();
const defaultStatePath = join(HOME, '.pi', 'agent', 'state', 'loop-factory.json');
const defaultNotesPath = join(HOME, 'NOTES.md');
const defaultWorkflowsDir = join(HOME, 'workflows');
const statePath = process.env.MI_LOOP_FACTORY_STATE_PATH || defaultStatePath;
const notesPath = process.env.MI_LOOP_FACTORY_NOTES_PATH || defaultNotesPath;
const workflowsDir = process.env.MI_LOOP_FACTORY_WORKFLOWS_DIR || defaultWorkflowsDir;
const digestIntervalMs = Math.max(daysMs(1), Number(process.env.MI_LOOP_FACTORY_INTERVAL_MS || daysMs(7)));
const buildReadyMarker = '<!-- loop-factory:build_ready -->';

const capturePhrasePattern = /\b(?:this is a loop|make this a workflow|automate this recurring thing|i keep doing this|next time do this automatically|turn this into a workflow|workflow this|make a workflow for this)\b/i;
const recurrenceIntentPattern = /\b(?:again and again|over and over|every time|whenever|recurring|repeated|repeatable|i keep|keeps happening|done this (?:three|3)\+? times|3\+ times|third time)\b[\s\S]{0,100}\b(?:workflow|automate|delegate|loop|capture|systematize)\b/i;
const painPattern = /\b(?:annoying|pain|painful|friction|stuck|broken|failed|failing|waste|tedious|manual|hate|keeps|again)\b/i;
const highPainPattern = /\b(?:very annoying|high pain|urgent|blocked|keeps failing|keep failing|wasting hours|hate doing this|painful)\b/i;
const riskyPattern = /\b(?:deploy|production|secrets?|credentials?|delete|billing|payment|dns|database|migration|merge|publish)\b/i;
const delegablePattern = /\b(?:workflow|automate|delegate|checklist|steps?|trigger|when|whenever|recurring|repeatable|do this automatically)\b/i;
const secretPattern = /(BEGIN [A-Z ]*PRIVATE KEY|PASSWORD\s*=|SECRET\s*=|TOKEN\s*=|API[_-]?KEY\s*=|\.env\b|infisical|agent-secrets|sk-[A-Za-z0-9_-]{20,})/i;

function nowIso() { return new Date().toISOString(); }
function daysMs(days: number) { return days * 24 * 60 * 60_000; }
function slug(value: string) { return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 72) || 'loop'; }
function normalize(value: string) { return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim(); }
function hashId(value: string) { return createHash('sha1').update(value).digest('hex').slice(0, 12); }
function displayPath(file?: string) { return file ? file.replace(HOME, '~') : undefined; }

export function redactLoopFactoryText(text: string) {
  let safe = String(text || '').replace(/https?:\/\/\S+/gi, '[link omitted]');
  safe = safe.replace(/\b[A-Za-z_][A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY)[A-Za-z0-9_]*\s*=\s*\S+/gi, '[redacted]');
  safe = safe.replace(/\b(?:sk|pk)-[A-Za-z0-9_-]{20,}\b/g, '[redacted]');
  safe = safe.replace(/\b[A-Za-z0-9_-]{32,}\b/g, '[redacted]');
  return safe.replace(/\s+/g, ' ').trim().slice(0, 220);
}

export function looksLikeLoopFactoryCapture(message: string) {
  const text = String(message || '').trim();
  if (!text || secretPattern.test(text)) return false;
  return capturePhrasePattern.test(text) || recurrenceIntentPattern.test(text);
}

function extractCandidateName(message: string) {
  const cleaned = redactLoopFactoryText(message)
    .replace(capturePhrasePattern, '')
    .replace(/^(?:please|can you|could you|ok|so|also)[,\s]+/i, '')
    .replace(/\b(?:because|since)\b[\s\S]*$/i, '')
    .trim();
  const sentence = (cleaned.split(/[.!?]\s/)[0] || cleaned || 'Captured loop').trim();
  const words = sentence.split(/\s+/).filter(Boolean).slice(0, 9).join(' ');
  const name = words || 'Captured loop';
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function triggerGuess(message: string, name: string) {
  const text = redactLoopFactoryText(message);
  const when = text.match(/\b(?:when|whenever|every time|next time)\b[\s\S]{0,140}/i)?.[0];
  return when ? when.slice(0, 180) : `When ${name.toLowerCase()} recurs or the user says this is a loop.`;
}

function scoreCandidate(message: string, existingCount: number) {
  const text = String(message || '');
  const recurrence = Math.min(5, Math.max(existingCount, /\b(?:3\+|three|third)\b/i.test(text) ? 3 : looksLikeLoopFactoryCapture(text) ? 1 : 0));
  const pain = highPainPattern.test(text) ? 'high' : painPattern.test(text) ? 'medium' : 'low';
  const painScore = pain === 'high' ? 5 : pain === 'medium' ? 3 : 1;
  const delegability = delegablePattern.test(text) ? 4 : 2;
  const riskPenalty = riskyPattern.test(text) ? 2 : 0;
  const score = recurrence * 3 + painScore * 2 + delegability - riskPenalty;
  return { score, pain } as { score: number; pain: LoopFactoryCandidate['pain'] };
}

function candidateReady(candidate: LoopFactoryCandidate) {
  return candidate.examples_count >= 3 || candidate.pain === 'high' || candidate.triage_score >= 12;
}

function sameCandidate(candidate: LoopFactoryCandidate, name: string, snippet: string) {
  const a = normalize(candidate.name);
  const b = normalize(name);
  if (a && b && (a.includes(b) || b.includes(a))) return true;
  const terms = b.split(' ').filter((part) => part.length > 4);
  const haystack = normalize(`${candidate.name} ${candidate.snippet || ''}`);
  return terms.length >= 2 && terms.slice(0, 4).filter((term) => haystack.includes(term)).length >= 2 && normalize(snippet).length > 0;
}

export async function readLoopFactoryState(): Promise<LoopFactoryState> {
  try {
    const parsed = JSON.parse(await readFile(statePath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

async function writeLoopFactoryState(state: LoopFactoryState) {
  await mkdir(dirname(statePath), { recursive: true, mode: 0o700 });
  const normalized: LoopFactoryState = { version: 1, ...state };
  await writeFile(statePath, JSON.stringify(normalized, null, 2), { mode: 0o600 });
}

function workflowPathFor(candidate: Pick<LoopFactoryCandidate, 'name'>) {
  return join(workflowsDir, `${slug(candidate.name)}.md`);
}

function draftSpec(candidate: LoopFactoryCandidate) {
  return [
    `# ${candidate.name}`,
    '',
    '<!-- loop-factory:draft -->',
    '',
    '## Status',
    '',
    'Draft. Loop Factory grilling in progress.',
    '',
    '## Loop',
    '',
    candidate.short_rationale,
    '',
    '## Trigger',
    '',
    `- ${candidate.trigger_guess}`,
    '',
    '## Inputs',
    '',
    '- User-provided examples and source references captured by Loop Factory.',
    '',
    '## Processing steps',
    '',
    '- Open question: resolve during grilling.',
    '',
    '## State',
    '',
    '- Open question: resolve during grilling.',
    '',
    '## Outputs',
    '',
    '- Open question: resolve during grilling.',
    '',
    '## Checkpoints',
    '',
    '- Ask one question at a time with a recommended answer.',
    '',
    '## Failure handling',
    '',
    '- Open question: resolve during grilling.',
    '',
    '## Implementation surface',
    '',
    '- Open question: resolve during grilling.',
    '',
    '## Open questions',
    '',
    '- What exact trigger, inputs, state, outputs, checkpoints, failures, and implementation surface make this build-ready?',
    '',
  ].join('\n');
}

async function createOrUpdateDraftSpec(candidate: LoopFactoryCandidate) {
  await mkdir(workflowsDir, { recursive: true });
  const file = candidate.spec_path || workflowPathFor(candidate);
  if (!existsSync(file)) await writeFile(file, draftSpec({ ...candidate, spec_path: file }));
  candidate.spec_path = file;
  return file;
}

async function updateNotes(state: LoopFactoryState) {
  const markerStart = '<!-- loop-factory:start -->';
  const markerEnd = '<!-- loop-factory:end -->';
  const candidates = [...(state.candidates || [])].sort((a, b) => b.triage_score - a.triage_score || b.examples_count - a.examples_count).slice(0, 20);
  const lines = [
    markerStart,
    '## Loop Factory candidates',
    '',
    `Last updated: ${nowIso().slice(0, 10)}. Aggregate-only Loop Factory records; re-check specs/state before acting.`,
    '',
    ...candidates.map((candidate) => `- ${candidate.name}: ${candidate.status}; examples=${candidate.examples_count}; pain=${candidate.pain}; score=${candidate.triage_score}; next=${candidate.next_action}${candidate.spec_path ? `; spec=${displayPath(candidate.spec_path)}` : ''}`),
    markerEnd,
  ];
  const block = lines.join('\n');
  let current = '';
  try { current = await readFile(notesPath, 'utf8'); } catch { current = '# Notes\n'; }
  const next = current.includes(markerStart) && current.includes(markerEnd)
    ? current.replace(new RegExp(`${markerStart}[\\s\\S]*?${markerEnd}`), block)
    : `${current.trimEnd()}\n\n${block}\n`;
  await writeFile(notesPath, next);
}

function grillingPrompt(candidate: LoopFactoryCandidate) {
  return [
    `Run the Loop Factory grilling session for this workflow candidate: ${candidate.name}.`,
    '',
    'Output during this task should be workflow specs or exactly one grilling question at a time.',
    'Grilling discipline: ask exactly one question at a time; every question must include a recommended answer. If Kyle replies exactly r or R, treat it as accepting the recommended answer.',
    'After each resolved answer, edit the draft workflow spec. Do not call the workflow done until an implementer could build it without questions.',
    `When the spec is build-ready, add this exact marker anywhere in the spec: ${buildReadyMarker}`,
    '',
    `Spec path: ${candidate.spec_path ? basename(candidate.spec_path) : `${slug(candidate.name)}.md`}`,
    `Source: ${candidate.source}`,
    `Captured summary: ${candidate.snippet || candidate.short_rationale}`,
    `Examples count: ${candidate.examples_count}`,
    `Pain: ${candidate.pain}`,
    `Trigger guess: ${candidate.trigger_guess}`,
    `Rationale: ${candidate.short_rationale}`,
    '',
    'Required coverage before build-ready: trigger, inputs, processing steps, state, outputs, checkpoint/brief behavior, failure handling, implementation surface, and no open questions.',
    'Privacy: never quote private transcripts or raw secrets. Use redacted snippets and ask Kyle for missing details.',
  ].join('\n');
}

async function startGrillingIfPossible(state: LoopFactoryState, candidate: LoopFactoryCandidate) {
  if (state.activeGrilling?.candidateId && state.candidates?.some((item) => item.id === state.activeGrilling!.candidateId && item.status === 'grilling')) return false;
  await createOrUpdateDraftSpec(candidate);
  const result = await sendTaskSocketRequest({
    type: 'run_worker',
    name: `loop-factory-${slug(candidate.name)}`,
    cwd: resolve(workflowsDir),
    message: grillingPrompt(candidate),
    lastInput: `Loop Factory grilling: ${candidate.name}`,
    background: true,
    reportToMain: true,
    capabilityProfile: 'worker-write-scoped',
    allowDuplicate: true,
  }, 30000);
  candidate.status = 'grilling';
  candidate.next_action = 'Answer the active grilling question in Pi/Mi.';
  candidate.taskId = String(result.taskId || '');
  candidate.sessionFile = String(result.sessionFile || '');
  candidate.sessionName = String(result.sessionName || '');
  state.activeGrilling = { candidateId: candidate.id, taskId: candidate.taskId, sessionFile: candidate.sessionFile, startedAt: nowIso() };
  state.active_grilling_session_ids = [candidate.taskId, candidate.sessionFile].filter(Boolean) as string[];
  state.decisionHistory = [...(state.decisionHistory || []), { at: nowIso(), candidateId: candidate.id, action: 'started_grilling', detail: candidate.taskId }].slice(-100);
  await logEvent('mi.loop_factory.grilling_started', { candidateId: candidate.id, taskId: candidate.taskId, spec: candidate.spec_path });
  return true;
}

export async function runLoopFactoryCapture(message: string, options: LoopFactoryCaptureOptions = {}): Promise<LoopFactoryResult> {
  if (!looksLikeLoopFactoryCapture(message)) return { ok: false, reply: 'That does not look like a loop capture.' };
  const state = await readLoopFactoryState();
  const candidates = state.candidates || [];
  const name = extractCandidateName(message);
  const snippet = redactLoopFactoryText(message);
  let candidate = candidates.find((item) => sameCandidate(item, name, snippet));
  if (!candidate) {
    const id = `loop_${hashId(`${name}:${Date.now()}:${snippet}`)}`;
    candidate = {
      id,
      name,
      status: 'captured',
      source: options.source || 'manual',
      captured_at: nowIso(),
      examples_count: 0,
      pain: 'low',
      trigger_guess: triggerGuess(message, name),
      owner: 'Kyle',
      triage_score: 0,
      next_action: 'Triage pending.',
      short_rationale: `Captured because Kyle marked this as a recurring/delegable loop.`,
      source_refs: options.contextRef ? [options.contextRef] : [],
    };
    candidates.push(candidate);
  }
  candidate.updated_at = nowIso();
  candidate.examples_count += 1;
  candidate.snippet = snippet;
  candidate.source = options.source || candidate.source;
  if (options.contextRef && !(candidate.source_refs || []).includes(options.contextRef)) candidate.source_refs = [...(candidate.source_refs || []), options.contextRef];
  const scored = scoreCandidate(message, candidate.examples_count);
  candidate.pain = scored.pain === 'low' && candidate.pain !== 'low' ? candidate.pain : scored.pain;
  candidate.triage_score = Math.max(candidate.triage_score || 0, scored.score);
  candidate.trigger_guess = candidate.trigger_guess || triggerGuess(message, candidate.name);
  candidate.short_rationale = `${candidate.examples_count} captured example(s); ${candidate.pain} pain; user explicitly marked this as recurring/delegable.`;
  candidate.status = candidateReady(candidate) ? 'ready_to_grill' : 'triaged_low';
  candidate.next_action = candidate.status === 'ready_to_grill' ? 'Start Loop Factory grilling.' : 'Hold for weekly digest unless another example or high pain appears.';
  await createOrUpdateDraftSpec(candidate);
  state.candidates = candidates;

  let started = false;
  if (candidate.status === 'ready_to_grill' && options.startGrilling !== false) {
    try { started = await startGrillingIfPossible(state, candidate); } catch (error) { candidate.next_action = `Could not start grilling: ${error instanceof Error ? error.message : String(error)}`; }
  }
  await updateNotes(state);
  await writeLoopFactoryState(state);
  const reply = started
    ? `Captured ${candidate.name} as a loop and started grilling it in Pi. Spec: ${displayPath(candidate.spec_path)}`
    : `Captured ${candidate.name} as a loop. Status: ${candidate.status}. Spec: ${displayPath(candidate.spec_path)}`;
  if (options.notify) await deliverMessage('Loop Factory', reply, state).catch(() => undefined);
  await logEvent('mi.loop_factory.capture', { candidateId: candidate.id, status: candidate.status, started });
  return { ok: true, reply, candidate, started, handoff: started };
}

export async function recordMinedLoopSelection(input: { name: string; why?: string; sourceRef?: string; specPath?: string; taskId?: string; sessionFile?: string; sessionName?: string }) {
  const state = await readLoopFactoryState();
  const candidates = state.candidates || [];
  let candidate = candidates.find((item) => normalize(item.name) === normalize(input.name));
  if (!candidate) {
    candidate = {
      id: `loop_${hashId(`mined:${input.name}:${Date.now()}`)}`,
      name: input.name,
      status: 'grilling',
      source: 'loop-discovery',
      captured_at: nowIso(),
      examples_count: 3,
      pain: 'medium',
      trigger_guess: 'Selected from Pi conversation loop discovery.',
      owner: 'Kyle',
      spec_path: input.specPath,
      triage_score: 14,
      next_action: 'Answer the active grilling question in Pi/Mi.',
      short_rationale: input.why || 'Mined from repeated Pi conversation patterns and selected by Kyle.',
      source_refs: input.sourceRef ? [input.sourceRef] : [],
    };
    candidates.push(candidate);
  }
  candidate.status = 'grilling';
  candidate.taskId = input.taskId;
  candidate.sessionFile = input.sessionFile;
  candidate.sessionName = input.sessionName;
  candidate.updated_at = nowIso();
  state.candidates = candidates;
  state.activeGrilling = { candidateId: candidate.id, taskId: input.taskId, sessionFile: input.sessionFile, startedAt: nowIso() };
  state.active_grilling_session_ids = [input.taskId, input.sessionFile].filter(Boolean) as string[];
  state.decisionHistory = [...(state.decisionHistory || []), { at: nowIso(), candidateId: candidate.id, action: 'recorded_mined_selection', detail: input.name }].slice(-100);
  await updateNotes(state);
  await writeLoopFactoryState(state);
}

export async function handleLoopFactoryReply(message: string, options: { source?: string } = {}): Promise<LoopFactoryResult> {
  const state = await readLoopFactoryState();
  const active = state.activeGrilling;
  if (!active?.candidateId) return { ok: false, reply: 'No Loop Factory grilling session is active.' };
  const candidate = state.candidates?.find((item) => item.id === active.candidateId);
  if (!candidate) return { ok: false, reply: 'The active Loop Factory candidate is missing from state.' };
  const taskId = active.taskId || candidate.taskId;
  if (!taskId) return { ok: false, reply: 'The active Loop Factory session has no task id.' };
  const trimmed = String(message || '').trim();
  const replyText = /^[rR]$/.test(trimmed) ? 'r - accept the recommended answer for the current Loop Factory question and update the workflow spec.' : trimmed;
  const result = await sendTaskSocketRequest({ type: 'continue_worker', taskId, message: replyText, background: true, reportToMain: true }, 30000);
  state.lastQuestionAsked = { candidateId: candidate.id, question: undefined, recommendedAnswer: /^[rR]$/.test(trimmed) ? 'accepted' : undefined, at: nowIso() };
  state.decisionHistory = [...(state.decisionHistory || []), { at: nowIso(), candidateId: candidate.id, action: 'grilling_reply', detail: options.source || 'manual' }].slice(-100);
  await writeLoopFactoryState(state);
  await logEvent('mi.loop_factory.reply', { candidateId: candidate.id, taskId });
  return { ok: true, reply: `Sent your Loop Factory answer to ${candidate.name}.`, candidate, handoff: true, status: String(result.text || '') };
}

async function scanBuildReadySpecs(state: LoopFactoryState) {
  let changed = false;
  for (const candidate of state.candidates || []) {
    if (!candidate.spec_path || !['grilling', 'ready_to_grill', 'captured', 'triaged_low'].includes(candidate.status)) continue;
    let text = '';
    try { text = await readFile(candidate.spec_path, 'utf8'); } catch { continue; }
    if (text.includes(buildReadyMarker) || (/## Status[\s\S]{0,120}Build-ready/i.test(text) && /## Open questions[\s\S]{0,80}(?:None|No open questions)/i.test(text))) {
      candidate.status = 'build_ready';
      candidate.next_action = 'Ask Kyle whether to queue implementation now, later, or never.';
      candidate.updated_at = nowIso();
      if (state.activeGrilling?.candidateId === candidate.id) state.activeGrilling = undefined;
      changed = true;
    }
  }
  if (changed) state.active_grilling_session_ids = state.activeGrilling ? [state.activeGrilling.taskId, state.activeGrilling.sessionFile].filter(Boolean) as string[] : [];
  return changed;
}

function implementationBrief(candidate: LoopFactoryCandidate) {
  return [
    `${candidate.name} is build-ready.`,
    `Spec: ${displayPath(candidate.spec_path)}`,
    `Payoff: ${candidate.short_rationale}`,
    `Surface: ${candidate.trigger_guess}`,
    `Main checkpoint/risk: ${riskyPattern.test(`${candidate.trigger_guess} ${candidate.snippet || ''}`) ? 'risky operations need approval' : 'confirm trigger and first human checkpoint during implementation'}.`,
    'Reply: queue now, later, or never.',
  ].join('\n');
}

async function deliverMessage(title: string, message: string, state: LoopFactoryState) {
  const imessage = await notifyImessage(title, message).catch((error) => ({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  if ((imessage as { ok?: boolean }).ok) return { deliveredTo: 'imessage' };
  const error = (imessage as { skipped?: boolean; error?: string; status?: number }).skipped ? 'iMessage notification disabled' : (imessage as { error?: string; status?: number }).error || `iMessage notify failed: ${(imessage as { status?: number }).status || 'unknown'}`;
  const failures: NonNullable<LoopFactoryState['deliveryFailures']> = [...(state.deliveryFailures || []), { at: nowIso(), channel: 'imessage' as const, error }].slice(-50);
  state.deliveryFailures = failures;
  try {
    await appendThreadMessage('main', 'assistant', message, { unread: true, source: 'loop-factory' });
    return { deliveredTo: 'mi-main' };
  } catch (fallbackError) {
    failures.push({ at: nowIso(), channel: 'mi-main', error: fallbackError instanceof Error ? fallbackError.message : String(fallbackError) });
    state.deliveryFailures = failures.slice(-50);
    return { deliveredTo: 'failed' };
  }
}

async function sendBuildReadyBriefs(state: LoopFactoryState, notifyUser: boolean) {
  const sent: string[] = [];
  for (const candidate of state.candidates || []) {
    if (candidate.status !== 'build_ready' || candidate.buildReadyNotifiedAt) continue;
    const brief = implementationBrief(candidate);
    if (notifyUser) await deliverMessage('Loop Factory', brief, state);
    candidate.buildReadyNotifiedAt = nowIso();
    sent.push(candidate.id);
  }
  return sent;
}

async function sendBlockedNudge(state: LoopFactoryState, notifyUser: boolean) {
  const active = state.activeGrilling;
  if (!active?.candidateId || active.lastNudgedAt) return false;
  const started = Date.parse(active.startedAt || '') || 0;
  if (!started || Date.now() - started < daysMs(1)) return false;
  const candidate = state.candidates?.find((item) => item.id === active.candidateId);
  if (!candidate) return false;
  const message = `Loop Factory is still waiting on ${candidate.name}. Reply with the answer to the current one-question grill, or r to accept the recommended answer.`;
  if (notifyUser) await deliverMessage('Loop Factory nudge', message, state);
  active.lastNudgedAt = nowIso();
  return true;
}

export async function loopFactoryDue(now = new Date()) {
  if (process.env.MI_LOOP_FACTORY_ENABLED === 'false') return false;
  const state = await readLoopFactoryState();
  const last = state.lastRunAt ? Date.parse(state.lastRunAt) : 0;
  const dueHour = Number(process.env.MI_LOOP_FACTORY_HOUR || 4);
  const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', hour12: false }).format(now));
  return (!last || now.getTime() - last >= digestIntervalMs) && hour >= dueHour;
}

export async function runLoopFactoryDigest(options: { mode?: 'manual' | 'scheduled'; notify?: boolean; force?: boolean } = {}) {
  const state = await readLoopFactoryState();
  if (options.mode === 'scheduled' && !options.force && !(await loopFactoryDue())) return { status: 'skipped', message: 'Loop Factory is not due.' };
  const buildReadyChanged = await scanBuildReadySpecs(state);
  const buildReadySent = await sendBuildReadyBriefs(state, Boolean(options.notify));
  const nudged = await sendBlockedNudge(state, Boolean(options.notify));
  const actionable = (state.candidates || []).filter((candidate) => ['ready_to_grill', 'build_ready', 'triaged_low'].includes(candidate.status));
  state.lastRunAt = nowIso();
  state.lastDigestAt = nowIso();
  await updateNotes(state);
  await writeLoopFactoryState(state);
  if (actionable.length === 0 && buildReadySent.length === 0 && !nudged && !buildReadyChanged) return { status: 'no-action', message: 'Loop Factory has nothing actionable.' };
  const lines = ['Loop Factory digest:'];
  const ready = actionable.filter((candidate) => candidate.status === 'build_ready').slice(0, 5);
  const grill = actionable.filter((candidate) => candidate.status === 'ready_to_grill').slice(0, 5);
  const low = actionable.filter((candidate) => candidate.status === 'triaged_low').slice(0, 5);
  if (ready.length) lines.push(`Build-ready: ${ready.map((candidate) => `${candidate.name} (${displayPath(candidate.spec_path)})`).join('; ')}. Reply queue now, later, or never.`);
  if (grill.length) lines.push(`Ready to grill: ${grill.map((candidate) => candidate.name).join(', ')}.`);
  if (low.length) lines.push(`Low-priority captures: ${low.map((candidate) => candidate.name).join(', ')}.`);
  if (nudged) lines.push('Sent one blocked-session nudge.');
  const message = lines.join('\n');
  if (options.notify && lines.length > 1) await deliverMessage('Loop Factory digest', message, state);
  await logEvent('mi.loop_factory.digest', { status: 'digest', actionable: actionable.length, buildReadySent: buildReadySent.length, nudged });
  return { status: 'digest', message, actionable: actionable.length, buildReadySent: buildReadySent.length, nudged };
}

export async function runLoopFactoryTick() {
  try {
    return await runLoopFactoryDigest({ mode: 'scheduled', notify: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await logEvent('mi.loop_factory.error', { error: message });
    return { status: 'error', message: 'Loop Factory failed.', error: message };
  }
}

function latestBuildReadyCandidate(state: LoopFactoryState, value?: string) {
  const candidates = (state.candidates || []).filter((candidate) => candidate.status === 'build_ready');
  if (!value) return candidates.at(-1);
  const target = normalize(value);
  return candidates.find((candidate) => normalize(`${candidate.name} ${candidate.spec_path || ''}`).includes(target)) || candidates.at(-1);
}

export async function decideLoopFactoryImplementation(decision: string, value?: string) {
  const normalized = normalize(decision);
  const state = await readLoopFactoryState();
  const candidate = latestBuildReadyCandidate(state, value);
  if (!candidate) return { ok: false, reply: 'No build-ready Loop Factory candidate is waiting for an implementation decision.' };
  if (/\b(?:later|not now|hold)\b/.test(normalized)) {
    candidate.implementationDecision = 'later';
    candidate.next_action = 'Hold implementation for a later explicit queue-now decision.';
  } else if (/\b(?:never|reject|no)\b/.test(normalized)) {
    candidate.implementationDecision = 'never';
    candidate.status = 'rejected';
    candidate.next_action = 'Rejected for implementation.';
  } else if (/\b(?:queue now|now|implement|start)\b/.test(normalized)) {
    candidate.implementationDecision = 'queue now';
    candidate.status = 'implementation_queued';
    candidate.next_action = 'Implementation worker queued.';
    const prompt = [`Implement this build-ready workflow spec: ${candidate.spec_path}.`, 'Before changing code, read the spec and relevant repository files. Follow repo rules, run focused tests, and do not merge or deploy without explicit approval.'].join('\n');
    try {
      const result = await sendTaskSocketRequest({ type: 'run_worker', name: `implement-${slug(candidate.name)}`, cwd: HOME, message: prompt, lastInput: `Implement workflow: ${candidate.name}`, background: true, reportToMain: true, allowDuplicate: true }, 30000);
      candidate.taskId = String(result.taskId || candidate.taskId || '');
      candidate.sessionFile = String(result.sessionFile || candidate.sessionFile || '');
    } catch (error) {
      candidate.next_action = `Queue requested, but worker start failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  } else {
    return { ok: false, reply: 'Reply with queue now, later, or never.' };
  }
  candidate.updated_at = nowIso();
  state.decisionHistory = [...(state.decisionHistory || []), { at: nowIso(), candidateId: candidate.id, action: 'implementation_decision', detail: candidate.implementationDecision }].slice(-100);
  await updateNotes(state);
  await writeLoopFactoryState(state);
  await logEvent('mi.loop_factory.implementation_decision', { candidateId: candidate.id, decision: candidate.implementationDecision });
  return { ok: true, reply: `${candidate.name}: ${candidate.implementationDecision}.`, candidate };
}

export async function loopFactoryStatus() {
  const state = await readLoopFactoryState();
  await scanBuildReadySpecs(state);
  await writeLoopFactoryState(state);
  const candidates = state.candidates || [];
  const counts = candidates.reduce<Record<string, number>>((acc, candidate) => { acc[candidate.status] = (acc[candidate.status] || 0) + 1; return acc; }, {});
  return { state, counts, message: `Loop Factory: ${candidates.length} candidate(s). ${Object.entries(counts).map(([key, count]) => `${key}=${count}`).join(', ') || 'none'}.` };
}

export async function deleteRejectedDrafts() {
  const state = await readLoopFactoryState();
  for (const candidate of state.candidates || []) {
    if (candidate.status !== 'rejected' || !candidate.spec_path) continue;
    let text = '';
    try { text = await readFile(candidate.spec_path, 'utf8'); } catch { continue; }
    if (text.includes('<!-- loop-factory:draft -->') && !/resolved decisions|build-ready/i.test(text)) await rm(candidate.spec_path, { force: true });
  }
}

export async function listLoopFactorySpecs() {
  try { return (await readdir(workflowsDir)).filter((name) => name.endsWith('.md')).map((name) => join(workflowsDir, name)); } catch { return []; }
}

export function loopFactoryPaths() {
  return { statePath, notesPath, workflowsDir, buildReadyMarker };
}
