import { createHash } from 'node:crypto';
import { appendFile, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { notifyImessage } from './notify.js';
import { appendThreadMessage } from './threads.js';
import { logEvent } from './state.js';
import { sendTaskSocketRequest } from './mi-daemon-client.js';
import { recordMinedLoopSelection } from './loop-factory.js';

export type LoopDiscoveryCandidate = {
  key: string;
  name: string;
  why: string;
  evidenceCount: number;
  painCount: number;
  dateSpan: string;
  likelyTrigger: string;
  likelyCheckpoint: string;
  expectedBenefit: string;
  implementationSurface: string;
  risksOpenQuestions: string[];
  existingSpec?: string;
  status: 'new workflow candidate' | 'existing spec needs revision';
  score: number;
  snippets: string[];
};

export type LoopDiscoveryState = {
  lastRunAt?: string;
  analyzedFiles?: Record<string, { mtimeMs: number; size: number; hash: string }>;
  candidateHistory?: Array<{ runId: string; at: string; count: number; top: Array<Pick<LoopDiscoveryCandidate, 'key' | 'name' | 'evidenceCount' | 'painCount' | 'status'>> }>;
  latestBrief?: { id: string; at: string; deliveredTo?: string; candidates: LoopDiscoveryCandidate[]; runnersUp: string[]; message: string; selected?: boolean };
  selections?: Array<{ at: string; briefId: string; value: string; candidateKey?: string; candidateName?: string; taskId?: string; sessionFile?: string; ok: boolean; error?: string }>;
  spawnedTasks?: Array<{ at: string; candidateKey: string; candidateName: string; taskId?: string; sessionFile?: string; sessionName?: string }>;
  deliveryFailures?: Array<{ at: string; channel: 'imessage' | 'mi-main'; briefId?: string; error: string }>;
};

export type LoopDiscoveryRunOptions = {
  mode?: 'scheduled' | 'manual';
  force?: boolean;
  dryRun?: boolean;
  notify?: boolean;
  windowDays?: number;
  draftAll?: boolean;
};

export type LoopDiscoveryRunResult = {
  status: 'skipped' | 'no-candidates' | 'brief' | 'dry-run' | 'error';
  message: string;
  briefId?: string;
  candidates: LoopDiscoveryCandidate[];
  runnersUp: string[];
  notified?: boolean;
  spawned?: number;
  error?: string;
};

const HOME = homedir();
const defaultStatePath = join(HOME, '.pi', 'agent', 'state', 'loop-discovery.json');
const defaultNotesPath = join(HOME, 'NOTES.md');
const defaultWorkflowsDir = join(HOME, 'workflows');
const statePath = process.env.MI_LOOP_DISCOVERY_STATE_PATH || defaultStatePath;
const notesPath = process.env.MI_LOOP_DISCOVERY_NOTES_PATH || defaultNotesPath;
const workflowsDir = process.env.MI_LOOP_DISCOVERY_WORKFLOWS_DIR || defaultWorkflowsDir;
const sourceRoots = (process.env.MI_LOOP_DISCOVERY_SESSION_ROOTS || [
  join(HOME, '.pi', 'agent', 'sessions'),
  join(HOME, '.pi', 'security-fix-sessions'),
].join(':')).split(':').map((p) => p.trim()).filter(Boolean);

const painPattern = /\b(?:again|why|stuck|not working|broken|too slow|slow|fix that|failed|failing|failure|annoying|wrong|regression|doesn't work|does not work|keeps|looping|rework|redo)\b/i;
const skipSnippetPattern = /(BEGIN [A-Z ]*PRIVATE KEY|PASSWORD\s*=|SECRET\s*=|TOKEN\s*=|API[_-]?KEY\s*=|\.env\b|infisical|agent-secrets)/i;
const lowInfoPattern = /^(?:go|continue|ok|okay|yes|no|thanks|thank you|do it|please do|proceed)$/i;

const candidateDefinitions = [
  {
    key: 'pr-creation-merge-handling',
    name: 'PR creation and merge handling',
    why: 'turn repeated GitHub hygiene into a checklist',
    patterns: [/\bPR\b|pull request|github|merge|branch|push|commit/i],
    trigger: 'When code changes are ready for review, merge, or cleanup.',
    checkpoint: 'Ask before merging or deleting branches; report PR URL and test evidence.',
    benefit: 'Less repeated local-change checking, PR creation, merge, and push work.',
    surface: 'Git/GitHub CLI plus repo test/build commands.',
  },
  {
    key: 'tactics-journal-research-operations',
    name: 'Tactics Journal research operations',
    why: 'reduce repeated candidate/report repair work',
    patterns: [/tactics\s+journal|detect candidates?|research|report generation|report repair|candidate review|step-ingest|step-detect/i],
    trigger: 'When new research candidates, reports, or health sidecars need review.',
    checkpoint: 'Ask before publishing, deleting, or changing scoring thresholds.',
    benefit: 'Faster candidate ingestion, report generation, and monitor recovery.',
    surface: 'research-pr Make targets, report scripts, and monitor health files.',
  },
  {
    key: 'mi-imessage-background-worker-ops',
    name: 'Mi/iMessage and background-worker operations',
    why: 'stop re-debugging handoffs and phone delivery',
    patterns: [/\bmi\b|imessage|photon|background worker|handoff|web chat|routing|worker ack|Mi agents/i],
    trigger: 'When Mi routing, iMessage delivery, memory, tone, or workers regress.',
    checkpoint: 'Ask before exposing new public control paths or changing write permissions.',
    benefit: 'More reliable phone-to-Mi task handoffs and fewer stuck workers.',
    surface: 'assistant scripts, mi tick, Photon bridge, daemon, and routing tests.',
  },
  {
    key: 'pi-harness-maintenance',
    name: 'Pi harness maintenance',
    why: 'make recurring Pi/router fixes repeatable',
    patterns: [/\bpi\b|router|\/plan|model routing|extension|skill|theme|TUI|coding agent|codex/i],
    trigger: 'When Pi routing, planning, models, extensions, skills, or TUI behavior changes.',
    checkpoint: 'Ask before changing global agent behavior or provider configuration.',
    benefit: 'Faster diagnosis of harness regressions and eval failures.',
    surface: 'local Pi installation, docs, extensions, settings, and tests.',
  },
  {
    key: 'security-dependency-repair',
    name: 'Security dependency repair',
    why: 'standardize scheduled vulnerability fixes',
    patterns: [/security fix|security-fix|dependency|dependencies|vulnerabilit|npm audit|dependabot|CVE/i],
    trigger: 'When scheduled security-fix sessions or dependency alerts appear.',
    checkpoint: 'Ask before major upgrades, lockfile churn, or risky migrations.',
    benefit: 'Cleaner recurring dependency PRs with less manual triage.',
    surface: 'repo package managers, tests, security-fix session logs, and GitHub PRs.',
  },
  {
    key: 'vps-service-health',
    name: 'VPS and service health checks',
    why: 'make service triage less ad hoc',
    patterns: [/VPS|disk|cron|systemd|railway|cloudflare|deploy|service|health|monitor|stale|worker service/i],
    trigger: 'When services are stale, slow, degraded, or deployment checks fail.',
    checkpoint: 'Ask before destructive operations, billing changes, or credential work.',
    benefit: 'Faster health triage without repeatedly rebuilding the same checks.',
    surface: 'systemd, Cloudflare/Railway brokers, cron state, health sidecars, logs.',
  },
  {
    key: 'thumbnail-image-generation',
    name: 'Thumbnail and image generation',
    why: 'reuse the prompt/review loop',
    patterns: [/thumbnail|image generation|generate image|prompt planning|subject extraction|imagegen|gpt-image/i],
    trigger: 'When an article/report needs a thumbnail or generated image.',
    checkpoint: 'Ask before final image generation when subject/style is ambiguous.',
    benefit: 'Less repeated subject extraction and prompt planning.',
    surface: 'imagegen tool, Tactics Journal metadata, and thumbnail prompt specs.',
  },
  {
    key: 'eval-benchmark-runs',
    name: 'Eval and benchmark runs',
    why: 'make score comparisons routine',
    patterns: [/eval|benchmark|score comparison|baseline|model eval|router eval|scores/i],
    trigger: 'When model/router behavior needs measurement against a baseline.',
    checkpoint: 'Ask before adopting a new model/routing default.',
    benefit: 'Repeatable eval runs and clearer score deltas.',
    surface: 'local eval scripts, result artifacts, and model routing config.',
  },
];

type SessionEvidence = { path: string; ts: string; cwd?: string; intents: string[]; snippets: string[]; secretLike: boolean; pain: boolean };
type WorkingCandidate = LoopDiscoveryCandidate & { dates: string[]; files: Set<string> };

function nowIso() { return new Date().toISOString(); }
function daysMs(days: number) { return days * 24 * 60 * 60_000; }
function slug(value: string) { return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 72) || 'loop'; }
function normalize(value: string) { return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim(); }

export async function readLoopDiscoveryState(): Promise<LoopDiscoveryState> {
  try {
    const parsed = JSON.parse(await readFile(statePath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

async function writeLoopDiscoveryState(state: LoopDiscoveryState) {
  await mkdir(dirname(statePath), { recursive: true, mode: 0o700 });
  await writeFile(statePath, JSON.stringify(state, null, 2), { mode: 0o600 });
}

async function listJsonlFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string) {
    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (/secret-store|\.env(?:\.|$)|infisical|agent-secrets/i.test(full)) continue;
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(full);
    }
  }
  await walk(root);
  return out;
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part) => {
    if (typeof part === 'string') return part;
    if (part && typeof part === 'object' && 'text' in part && typeof (part as { text?: unknown }).text === 'string') return (part as { text: string }).text;
    return '';
  }).filter(Boolean).join('\n');
  return '';
}

function extractHandoffIntent(text: string) {
  const patterns = [
    /Current user request:\s*\n([\s\S]*?)(?:\n\n[A-Z][^\n]{0,80}:|\n\nHandoff reason:|\n\nRelevant chat context|\n\nPlan for the background worker:|$)/i,
    /Problem to fix\s*\/\s*task to complete:\s*\n([\s\S]*?)(?:\n\n[A-Z][^\n]{0,80}:|\n\nHandoff reason:|\n\nRelevant chat context|$)/i,
    /Original\/current user request:\s*\n([\s\S]*?)(?:\n\n[A-Z][^\n]{0,80}:|$)/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const extracted = match?.[1]?.trim();
    if (extracted) return extracted;
  }
  return text;
}

export function redactLoopSnippet(text: string) {
  let safe = text.replace(/https?:\/\/\S+/gi, '[link omitted]');
  safe = safe.replace(/\b[A-Za-z_][A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY)[A-Za-z0-9_]*\s*=\s*\S+/gi, '[redacted]');
  safe = safe.replace(/\b(?:sk|pk)-[A-Za-z0-9_-]{20,}\b/g, '[redacted]');
  safe = safe.replace(/\b[A-Za-z0-9_-]{32,}\b/g, '[redacted]');
  return safe.replace(/\s+/g, ' ').trim().slice(0, 160);
}

async function parseSessionFile(file: string): Promise<SessionEvidence | undefined> {
  let text: string;
  try { text = await readFile(file, 'utf8'); } catch { return undefined; }
  const lines = text.split(/\r?\n/).filter(Boolean);
  let ts = '';
  let cwd = '';
  const intents: string[] = [];
  let secretLike = false;
  for (const line of lines) {
    let record: any;
    try { record = JSON.parse(line); } catch { continue; }
    if (!ts && typeof record.timestamp === 'string') ts = record.timestamp;
    if (!cwd && typeof record.cwd === 'string') cwd = record.cwd;
    if (record.type !== 'message' || record.message?.role !== 'user') continue;
    const raw = textFromContent(record.message.content);
    const intent = extractHandoffIntent(raw).trim();
    if (!intent || lowInfoPattern.test(intent) || intent.length < 8) continue;
    if (skipSnippetPattern.test(intent)) secretLike = true;
    intents.push(intent.slice(0, 2000));
  }
  if (intents.length === 0) return undefined;
  const joined = intents.join('\n');
  const snippets = secretLike ? [] : intents.map(redactLoopSnippet).filter(Boolean).slice(0, 3);
  return { path: file, ts: ts || (await stat(file)).mtime.toISOString(), cwd, intents, snippets, secretLike, pain: painPattern.test(joined) };
}

async function existingWorkflowMap() {
  const map = new Map<string, string>();
  let files: string[] = [];
  try { files = (await readdir(workflowsDir)).filter((name) => name.endsWith('.md')).map((name) => join(workflowsDir, name)); } catch { return map; }
  for (const file of files) {
    let text = '';
    try { text = await readFile(file, 'utf8'); } catch { continue; }
    const keyText = normalize(`${basename(file, '.md')} ${text.slice(0, 2000)}`);
    for (const def of candidateDefinitions) {
      const terms = normalize(`${def.name} ${def.key}`).split(' ').filter((word) => word.length > 3);
      if (terms.some((term) => keyText.includes(term)) && def.patterns.some((pattern) => pattern.test(text) || pattern.test(file))) map.set(def.key, file);
    }
  }
  return map;
}

function classify(intent: string) {
  return candidateDefinitions.filter((def) => def.patterns.some((pattern) => pattern.test(intent)));
}

async function fileMetadata(files: string[]) {
  const analyzedFiles: NonNullable<LoopDiscoveryState['analyzedFiles']> = {};
  for (const file of files) {
    try {
      const s = await stat(file);
      const hash = createHash('sha1').update(`${file}:${s.mtimeMs}:${s.size}`).digest('hex');
      analyzedFiles[file] = { mtimeMs: s.mtimeMs, size: s.size, hash };
    } catch {}
  }
  return analyzedFiles;
}

function candidateThreshold(candidate: WorkingCandidate) {
  return candidate.evidenceCount >= 3 || (candidate.evidenceCount >= 2 && candidate.painCount > 0);
}

function buildCandidates(sessions: SessionEvidence[], specs: Map<string, string>) {
  const working = new Map<string, WorkingCandidate>();
  for (const session of sessions) {
    const matchedKeys = new Set<string>();
    for (const intent of session.intents) for (const def of classify(intent)) matchedKeys.add(def.key);
    for (const key of matchedKeys) {
      const def = candidateDefinitions.find((item) => item.key === key)!;
      let candidate = working.get(key);
      if (!candidate) {
        candidate = {
          key,
          name: def.name,
          why: def.why,
          evidenceCount: 0,
          painCount: 0,
          dateSpan: '',
          likelyTrigger: def.trigger,
          likelyCheckpoint: def.checkpoint,
          expectedBenefit: def.benefit,
          implementationSurface: def.surface,
          risksOpenQuestions: ['What exact trigger should start this loop?', 'Where should the first human checkpoint appear?'],
          existingSpec: specs.get(key),
          status: specs.has(key) ? 'existing spec needs revision' : 'new workflow candidate',
          score: 0,
          snippets: [],
          dates: [],
          files: new Set<string>(),
        };
        working.set(key, candidate);
      }
      if (candidate.files.has(session.path)) continue;
      candidate.files.add(session.path);
      candidate.evidenceCount += 1;
      if (session.pain) candidate.painCount += 1;
      candidate.dates.push(session.ts);
      for (const snippet of session.snippets) if (candidate.snippets.length < 3 && !candidate.snippets.includes(snippet)) candidate.snippets.push(snippet);
    }
  }
  const result = [...working.values()].map((candidate) => {
    const sortedDates = candidate.dates.map((d) => Date.parse(d)).filter(Number.isFinite).sort((a, b) => a - b);
    const first = sortedDates[0] ? new Date(sortedDates[0]).toISOString().slice(0, 10) : 'unknown';
    const last = sortedDates.at(-1) ? new Date(sortedDates.at(-1)!).toISOString().slice(0, 10) : first;
    candidate.dateSpan = first === last ? first : `${first} to ${last}`;
    const repeatable = /cron|schedule|daily|weekly|monitor|again|repeat|when|whenever/i.test(`${candidate.name} ${candidate.snippets.join(' ')}`) ? 5 : 0;
    const existingPenalty = candidate.existingSpec ? -4 : 0;
    candidate.score = candidate.evidenceCount * 10 + candidate.painCount * 8 + repeatable + existingPenalty;
    return candidate;
  });
  return result.filter(candidateThreshold).sort((a, b) => b.score - a.score || b.evidenceCount - a.evidenceCount || a.name.localeCompare(b.name));
}

export function formatLoopDiscoveryBrief(candidates: LoopDiscoveryCandidate[], runnersUp: string[]) {
  const top = candidates.slice(0, 5);
  const count = top.length;
  const lines = [`I found ${count} loop${count === 1 ? '' : 's'} worth looking at:`];
  top.forEach((candidate, index) => lines.push(`${index + 1}) ${candidate.name} - ${candidate.why}`));
  if (runnersUp.length > 0) lines.push(`Also saw: ${runnersUp.join(', ')}.`);
  lines.push('Reply with a number or name and I’ll start grilling it in Pi.');
  return lines.join('\n');
}

async function appendNotes(candidates: LoopDiscoveryCandidate[]) {
  const markerStart = '<!-- loop-discovery:start -->';
  const markerEnd = '<!-- loop-discovery:end -->';
  const lines = [
    markerStart,
    '## Loop discovery snapshot',
    '',
    `Last updated: ${nowIso().slice(0, 10)}. Aggregate-only notes from Pi conversation loop discovery; re-check source repos/session state before acting.`,
    '',
    ...candidates.slice(0, 8).map((candidate) => `- ${candidate.name}: ${candidate.evidenceCount} sessions (${candidate.dateSpan}); ${candidate.status}. Likely surface: ${candidate.implementationSurface}`),
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

async function deliverBrief(state: LoopDiscoveryState, briefId: string, message: string, notifyUser: boolean) {
  if (!notifyUser) return { deliveredTo: 'stdout' };
  const imessage = await notifyImessage('Loop discovery', message).catch((error) => ({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  if ((imessage as { ok?: boolean }).ok) return { deliveredTo: 'imessage', imessage };
  const error = (imessage as { skipped?: boolean; error?: string; status?: number }).skipped ? 'iMessage notification disabled' : (imessage as { error?: string; status?: number }).error || `iMessage notify failed: ${(imessage as { status?: number }).status || 'unknown'}`;
  state.deliveryFailures = [...(state.deliveryFailures || []), { at: nowIso(), channel: 'imessage', briefId, error }];
  try {
    await appendThreadMessage('main', 'assistant', message, { unread: true, source: 'loop-discovery' });
    return { deliveredTo: 'mi-main', imessage };
  } catch (fallbackError) {
    state.deliveryFailures.push({ at: nowIso(), channel: 'mi-main', briefId, error: fallbackError instanceof Error ? fallbackError.message : String(fallbackError) });
    return { deliveredTo: 'failed', imessage };
  }
}

export async function loopDiscoveryDue(now = new Date()) {
  if (process.env.MI_LOOP_DISCOVERY_ENABLED === 'false') return false;
  const state = await readLoopDiscoveryState();
  const last = state.lastRunAt ? Date.parse(state.lastRunAt) : 0;
  const intervalMs = Math.max(daysMs(1), Number(process.env.MI_LOOP_DISCOVERY_INTERVAL_MS || daysMs(7)));
  const dueHour = Number(process.env.MI_LOOP_DISCOVERY_HOUR || 3);
  const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', hour12: false }).format(now));
  return (!last || now.getTime() - last >= intervalMs) && hour >= dueHour;
}

export async function runLoopDiscovery(options: LoopDiscoveryRunOptions = {}): Promise<LoopDiscoveryRunResult> {
  const mode = options.mode || 'manual';
  const windowDays = options.windowDays || 90;
  const state = await readLoopDiscoveryState();
  if (mode === 'scheduled' && !options.force && !await loopDiscoveryDue()) return { status: 'skipped', message: 'Loop discovery is not due.', candidates: [], runnersUp: [] };
  const runId = `loop_${Date.now().toString(36)}`;
  const cutoff = Date.now() - daysMs(windowDays);
  const files = (await Promise.all(sourceRoots.map(listJsonlFiles))).flat();
  const recentFiles: string[] = [];
  for (const file of files) {
    try { if ((await stat(file)).mtimeMs >= cutoff) recentFiles.push(file); } catch {}
  }
  const metadata = await fileMetadata(recentFiles);
  const previous = state.analyzedFiles || {};
  const changed = recentFiles.some((file) => previous[file]?.hash !== metadata[file]?.hash);
  if (mode === 'scheduled' && state.lastRunAt && !options.force && !changed) {
    state.lastRunAt = nowIso();
    state.analyzedFiles = metadata;
    if (!options.dryRun) await writeLoopDiscoveryState(state);
    return { status: 'skipped', message: 'Loop discovery skipped because no new Pi sessions changed.', candidates: [], runnersUp: [] };
  }
  const sessions = (await Promise.all(recentFiles.map(parseSessionFile))).filter((item): item is SessionEvidence => Boolean(item));
  const recentSessions = sessions.filter((session) => Date.parse(session.ts) >= cutoff || recentFiles.includes(session.path));
  const specs = await existingWorkflowMap();
  const candidates = buildCandidates(recentSessions, specs);
  const top = candidates.slice(0, 5);
  const runnersUp = candidates.slice(5, 12).map((candidate) => candidate.name);
  state.lastRunAt = nowIso();
  state.analyzedFiles = metadata;
  state.candidateHistory = [...(state.candidateHistory || []), { runId, at: state.lastRunAt, count: candidates.length, top: top.map(({ key, name, evidenceCount, painCount, status }) => ({ key, name, evidenceCount, painCount, status })) }].slice(-20);

  if (candidates.length === 0) {
    if (!options.dryRun) await writeLoopDiscoveryState(state);
    await logEvent('mi.loop_discovery.no_candidates', { mode, sessions: recentSessions.length });
    return { status: 'no-candidates', message: 'No loop candidates met the frequency-plus-pain threshold.', candidates: [], runnersUp: [] };
  }

  if (!options.dryRun) await appendNotes(candidates);
  const briefId = `${runId}_${createHash('sha1').update(top.map((c) => c.key).join('|')).digest('hex').slice(0, 8)}`;
  const message = formatLoopDiscoveryBrief(top, runnersUp);
  state.latestBrief = { id: briefId, at: state.lastRunAt, candidates: top, runnersUp, message, selected: false };
  let deliveredTo = 'not-requested';
  if (!options.dryRun) {
    const delivery = await deliverBrief(state, briefId, message, Boolean(options.notify || mode === 'scheduled'));
    deliveredTo = delivery.deliveredTo || deliveredTo;
    state.latestBrief.deliveredTo = deliveredTo;
    await writeLoopDiscoveryState(state);
  }
  let spawned = 0;
  if (options.draftAll && !options.dryRun) {
    for (const candidate of top) {
      const selection = await handleLoopDiscoverySelection(candidate.name, { notify: false, allowAlreadySelected: true });
      if (selection.started) spawned += 1;
    }
  }
  await logEvent('mi.loop_discovery.brief', { mode, candidates: top.length, runnersUp: runnersUp.length, deliveredTo, dryRun: Boolean(options.dryRun) });
  return { status: options.dryRun ? 'dry-run' : 'brief', message, briefId, candidates: top, runnersUp, notified: deliveredTo === 'imessage', spawned };
}

function candidateMatches(candidate: LoopDiscoveryCandidate, value: string) {
  const target = normalize(value);
  if (!target) return false;
  const haystack = normalize(`${candidate.name} ${candidate.key} ${candidate.why}`);
  return haystack.includes(target) || target.split(' ').filter((part) => part.length > 3).some((part) => haystack.includes(part));
}

function workflowFilenameFor(candidate: LoopDiscoveryCandidate) {
  return `${slug(candidate.name)}.md`;
}

function grillingPrompt(candidate: LoopDiscoveryCandidate) {
  const existing = candidate.existingSpec ? `Existing related spec: ${candidate.existingSpec}` : `Suggested draft path: ${workflowFilenameFor(candidate)}`;
  return [
    `Start a /grilling workflow-spec task for this recurring Pi loop: ${candidate.name}.`,
    '',
    'Discipline: ask exactly one question at a time. Each question must include a recommended answer. Keep the grilling inside this Pi/Mi agents task; do not send questions over iMessage. If the workflow becomes build-ready, create or update the relevant markdown spec in this workflows directory.',
    '',
    existing,
    `Why selected: ${candidate.why}`,
    `Evidence: ${candidate.evidenceCount} sessions from ${candidate.dateSpan}; pain/rework signals in ${candidate.painCount}.`,
    `Likely trigger: ${candidate.likelyTrigger}`,
    `Likely checkpoint: ${candidate.likelyCheckpoint}`,
    `Expected benefit: ${candidate.expectedBenefit}`,
    `Implementation surface: ${candidate.implementationSurface}`,
    `Risks/open questions: ${candidate.risksOpenQuestions.join('; ')}`,
    '',
    'Privacy: do not quote raw transcripts. Use only this aggregate evidence and ask Kyle for missing details.',
  ].join('\n');
}

export async function handleLoopDiscoverySelection(value: string, options: { notify?: boolean; allowAlreadySelected?: boolean } = {}) {
  const state = await readLoopDiscoveryState();
  const brief = state.latestBrief;
  if (!brief?.candidates?.length) return { matched: false, started: false, reply: 'I do not have a pending loop-discovery brief to choose from.' };
  const trimmed = value.trim();
  let candidate: LoopDiscoveryCandidate | undefined;
  const numeric = trimmed.match(/^#?([1-5])\b/);
  if (numeric) candidate = brief.candidates[Number(numeric[1]) - 1];
  if (!candidate) candidate = brief.candidates.find((item) => candidateMatches(item, trimmed));
  if (!candidate) return { matched: false, started: false, reply: 'I could not match that to one of the loop candidates.' };
  const prior = state.selections?.find((selection) => selection.briefId === brief.id && selection.candidateKey === candidate!.key && selection.ok);
  if (prior && !options.allowAlreadySelected) return { matched: true, started: false, reply: `I already started grilling ${candidate.name} in Pi.` };

  try {
    await mkdir(workflowsDir, { recursive: true });
    const result = await sendTaskSocketRequest({
      type: 'run_worker',
      name: `grill-${slug(candidate.name)}`,
      cwd: resolve(workflowsDir),
      message: grillingPrompt(candidate),
      lastInput: `Grill workflow candidate: ${candidate.name}`,
      background: true,
      reportToMain: true,
      capabilityProfile: 'worker-write-scoped',
      allowDuplicate: true,
    }, 30000);
    const reply = `Got it, I started grilling the ${candidate.name} loop in Pi. I’ll come back when I need your call on something.`;
    brief.selected = true;
    state.selections = [...(state.selections || []), { at: nowIso(), briefId: brief.id, value, candidateKey: candidate.key, candidateName: candidate.name, taskId: result.taskId, sessionFile: result.sessionFile, ok: true }];
    state.spawnedTasks = [...(state.spawnedTasks || []), { at: nowIso(), candidateKey: candidate.key, candidateName: candidate.name, taskId: result.taskId, sessionFile: result.sessionFile, sessionName: result.sessionName }];
    await recordMinedLoopSelection({ name: candidate.name, why: candidate.why, sourceRef: `loop-discovery:${brief.id}:${candidate.key}`, specPath: candidate.existingSpec, taskId: result.taskId, sessionFile: result.sessionFile, sessionName: result.sessionName }).catch(() => undefined);
    await writeLoopDiscoveryState(state);
    if (options.notify) {
      const imessage = await notifyImessage('Loop discovery', reply).catch((error) => ({ ok: false, error: error instanceof Error ? error.message : String(error) }));
      if (!(imessage as { ok?: boolean }).ok) await appendThreadMessage('main', 'assistant', reply, { unread: true, source: 'loop-discovery' }).catch(() => undefined);
    }
    await logEvent('mi.loop_discovery.selection', { candidate: candidate.key, taskId: result.taskId });
    return { matched: true, started: true, reply, taskId: result.taskId, sessionFile: result.sessionFile };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    state.selections = [...(state.selections || []), { at: nowIso(), briefId: brief.id, value, candidateKey: candidate.key, candidateName: candidate.name, ok: false, error: message }];
    await writeLoopDiscoveryState(state);
    return { matched: true, started: false, reply: `I matched ${candidate.name}, but I could not start the Pi grilling task: ${message}` };
  }
}

export function loopDiscoveryPaths() {
  return { statePath, notesPath, workflowsDir, sourceRoots };
}
