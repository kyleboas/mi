import { open, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { runCapabilityGrantGc, writeCapabilityGrantGcMarker } from './capability-gc.js';
import { tickReminderCrons } from './crons.js';
import { runImessageMonitor } from './imessage-monitor.js';
import { loopDiscoveryDue, runLoopDiscovery } from './loop-discovery.js';
import { runLoopFactoryTick } from './loop-factory.js';
import { runOpportunityScans } from './opportunity-scans.js';
import { generateProjectsStatus } from './project-status.js';
import { runMiCheck } from './proactive.js';
import { logEvent } from './state.js';
import { runDreamConsolidation } from './memory.js';
import { renderWeeklyReview, weeklyReviewDue } from './weekly-review.js';

export type MiTickResult = {
  reminders: Array<{ name: string; status: 'ok' | 'error' | 'skipped' }>;
  health: Awaited<ReturnType<typeof runMiCheck>>;
  imessageMonitor: Awaited<ReturnType<typeof runImessageMonitor>>;
  capabilityGrantGc: Awaited<ReturnType<typeof runCapabilityGrantGc>>;
  dailyBrief?: Awaited<ReturnType<typeof runMiCheck>>;
  projectQuestion?: Awaited<ReturnType<typeof runMiCheck>>;
  loopDiscovery?: Awaited<ReturnType<typeof runLoopDiscovery>>;
  loopFactory?: Awaited<ReturnType<typeof runLoopFactoryTick>>;
  opportunityScans?: Awaited<ReturnType<typeof runOpportunityScans>>;
  projectStatus?: { status: 'ok' | 'skipped' | 'error'; projects: number; outputPath?: string; error?: string };
  weeklyReview?: { status: 'ok' | 'skipped' | 'error'; message?: string; error?: string };
  skippedDailyBrief: boolean;
  skippedProjectQuestion: boolean;
  skippedLoopDiscovery: boolean;
  skippedLoopFactory: boolean;
  skippedOpportunityScans: boolean;
  skippedProjectStatus: boolean;
  skippedWeeklyReview: boolean;
};

export type TickState = {
  lastDailyBriefDate?: string;
  questionDate?: string;
  questionsToday?: number;
  lastQuestionAt?: string;
  nextQuestionAfter?: string;
  lastWeeklyReviewDate?: string;
};

const miRoot = process.env.MI_ROOT || join(homedir(), 'assistant');
const stateDir = resolve(miRoot, 'state');
const tickStatePath = join(stateDir, 'tick.json');
const lockPath = process.env.MI_TICK_LOCK_PATH || join(stateDir, 'tick.lock');
const dailyBriefHour = Number(process.env.MI_TICK_DAILY_BRIEF_HOUR || 6);

function nyParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

function nyToday(date = new Date()) {
  const parts = nyParts(date);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function dailyBriefDue(state: TickState) {
  if (process.env.MI_TICK_DAILY_BRIEF === 'false') return false;
  const parts = nyParts();
  const today = `${parts.year}-${parts.month}-${parts.day}`;
  const hour = Number(parts.hour || 0);
  return hour >= dailyBriefHour && state.lastDailyBriefDate !== today;
}

function envNumber(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function questionConfig() {
  return {
    enabled: process.env.MI_QUESTIONS_ENABLED !== 'false' && process.env.MI_TICK_QUESTIONS_ENABLED !== 'false',
    maxPerDay: Math.max(0, Math.floor(envNumber('MI_QUESTIONS_MAX_PER_DAY', 3))),
    quietBefore: envNumber('MI_QUESTIONS_QUIET_BEFORE', 9),
    quietAfter: envNumber('MI_QUESTIONS_QUIET_AFTER', 21),
    minGapMs: Math.max(15 * 60_000, envNumber('MI_QUESTIONS_MIN_GAP_HOURS', 2) * 60 * 60_000),
    retryMs: Math.max(15 * 60_000, envNumber('MI_QUESTIONS_RETRY_MINUTES', 90) * 60_000),
  };
}

function stableUnit(seed: string) {
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 0xffffffff;
}

function minutesUntilNyMinute(now: Date, targetMinute: number) {
  const parts = nyParts(now);
  const currentMinute = Number(parts.hour || 0) * 60 + Number(parts.minute || 0);
  return targetMinute - currentMinute;
}

export function normalizeQuestionSchedule(state: TickState, now = new Date()): TickState {
  const cfg = questionConfig();
  const today = nyToday(now);
  if (state.questionDate !== today) {
    state.questionDate = today;
    state.questionsToday = 0;
    state.lastQuestionAt = undefined;
    state.nextQuestionAfter = undefined;
  }
  if (!cfg.enabled || cfg.maxPerDay <= 0) return state;
  if (state.nextQuestionAfter) return state;
  const windowStart = Math.max(0, Math.min(23, cfg.quietBefore)) * 60;
  const windowEnd = Math.max(windowStart + 60, Math.min(24, cfg.quietAfter) * 60);
  const slot = state.questionsToday || 0;
  const jitter = Math.floor(stableUnit(`${today}:${slot}:project-question`) * Math.max(1, windowEnd - windowStart));
  const targetMinute = windowStart + jitter;
  const diffMinutes = minutesUntilNyMinute(now, targetMinute);
  const delayMinutes = diffMinutes > 5 ? diffMinutes : 20 + Math.floor(stableUnit(`${today}:${slot}:delay`) * 70);
  state.nextQuestionAfter = new Date(now.getTime() + delayMinutes * 60_000).toISOString();
  return state;
}

export function dynamicProjectQuestionDue(state: TickState, now = new Date()) {
  const cfg = questionConfig();
  if (!cfg.enabled || cfg.maxPerDay <= 0) return false;
  const parts = nyParts(now);
  const hour = Number(parts.hour || 0);
  if (hour < cfg.quietBefore || hour >= cfg.quietAfter) return false;
  if ((state.questionsToday || 0) >= cfg.maxPerDay) return false;
  if (state.lastQuestionAt && now.getTime() - Date.parse(state.lastQuestionAt) < cfg.minGapMs) return false;
  if (state.nextQuestionAfter && Date.parse(state.nextQuestionAfter) > now.getTime()) return false;
  return true;
}

export function recordQuestionTick(state: TickState, sent: boolean, now = new Date()) {
  const cfg = questionConfig();
  if (sent) {
    state.questionsToday = (state.questionsToday || 0) + 1;
    state.lastQuestionAt = now.toISOString();
    const jitter = Math.floor(stableUnit(`${state.questionDate || nyToday()}:${state.questionsToday}:gap`) * 90 * 60_000);
    state.nextQuestionAfter = new Date(now.getTime() + cfg.minGapMs + jitter).toISOString();
  } else {
    state.nextQuestionAfter = new Date(now.getTime() + cfg.retryMs).toISOString();
  }
  return state;
}

async function readTickState(): Promise<TickState> {
  try {
    const parsed = JSON.parse(await readFile(tickStatePath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

async function writeTickState(state: TickState) {
  await mkdir(dirname(tickStatePath), { recursive: true });
  await writeFile(tickStatePath, JSON.stringify(state, null, 2), { mode: 0o600 });
}

async function withTickLock<T>(fn: () => Promise<T>): Promise<T> {
  await mkdir(dirname(lockPath), { recursive: true });
  let handle;
  try {
    handle = await open(lockPath, 'wx', 0o600);
  } catch {
    throw new Error(`Mi tick already running: ${lockPath}`);
  }
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    return await fn();
  } finally {
    await handle.close().catch(() => undefined);
    await rm(lockPath, { force: true }).catch(() => undefined);
  }
}

export async function runMiTick(): Promise<MiTickResult> {
  return withTickLock(async () => {
    const state = normalizeQuestionSchedule(await readTickState());
    const reminders = await tickReminderCrons();
    const capabilityGrantGc = await runCapabilityGrantGc();
    const dream = await runDreamConsolidation().catch((error) => ({ status: 'error' as const, error: error instanceof Error ? error.message : String(error) }));
    await writeCapabilityGrantGcMarker(capabilityGrantGc);
    const health = await runMiCheck({ checkIds: ['health-check'] });
    const imessageMonitor = await runImessageMonitor();
    let dailyBrief: MiTickResult['dailyBrief'];
    let projectQuestionResult: MiTickResult['projectQuestion'];
    let loopDiscoveryResult: MiTickResult['loopDiscovery'];
    let loopFactoryResult: MiTickResult['loopFactory'];
    let skippedDailyBrief = true;
    let skippedProjectQuestion = true;
    let skippedLoopDiscovery = true;
    let skippedLoopFactory = true;
    let skippedOpportunityScans = true;
    let skippedProjectStatus = true;
    let skippedWeeklyReview = true;
    const opportunityScans = await runOpportunityScans();
    skippedOpportunityScans = opportunityScans.status === 'skipped';
    let projectStatus: MiTickResult['projectStatus'] = { status: 'skipped', projects: 0 };
    if (process.env.MI_PROJECT_STATUS_ENABLED !== 'false') {
      try {
        const generated = await generateProjectsStatus();
        projectStatus = { status: 'ok', projects: generated.projects, outputPath: generated.outputPath };
        skippedProjectStatus = false;
      } catch (error) {
        projectStatus = { status: 'error', projects: 0, error: error instanceof Error ? error.message : String(error) };
        skippedProjectStatus = false;
        await logEvent('mi.project_status.error', { error: projectStatus.error });
      }
    }
    let weeklyReview: MiTickResult['weeklyReview'] = { status: 'skipped' };
    if (weeklyReviewDue(state.lastWeeklyReviewDate)) {
      try {
        weeklyReview = { status: 'ok', message: await renderWeeklyReview() };
        state.lastWeeklyReviewDate = nyToday();
        skippedWeeklyReview = false;
        await logEvent('mi.weekly_review.rendered', { length: weeklyReview.message?.length || 0 });
      } catch (error) {
        weeklyReview = { status: 'error', error: error instanceof Error ? error.message : String(error) };
        skippedWeeklyReview = false;
        await logEvent('mi.weekly_review.error', { error: weeklyReview.error });
      }
    }
    if (dailyBriefDue(state)) {
      dailyBrief = await runMiCheck({ checkIds: ['dailyBrief'] });
      state.lastDailyBriefDate = nyToday();
      skippedDailyBrief = false;
    }
    if (dynamicProjectQuestionDue(state)) {
      projectQuestionResult = await runMiCheck({ checkIds: ['question'] });
      recordQuestionTick(state, projectQuestionResult.notices.length > 0);
      skippedProjectQuestion = projectQuestionResult.notices.length === 0;
    }
    try {
      if (await loopDiscoveryDue()) {
        loopDiscoveryResult = await runLoopDiscovery({ mode: 'scheduled', notify: true });
        skippedLoopDiscovery = loopDiscoveryResult.status === 'skipped';
      }
    } catch (error) {
      loopDiscoveryResult = { status: 'error', message: 'Loop discovery failed.', candidates: [], runnersUp: [], error: error instanceof Error ? error.message : String(error) };
      skippedLoopDiscovery = false;
      await logEvent('mi.loop_discovery.error', { error: loopDiscoveryResult.error });
    }
    if (process.env.MI_LOOP_FACTORY_ENABLED !== 'false') {
      loopFactoryResult = await runLoopFactoryTick();
      skippedLoopFactory = loopFactoryResult.status === 'skipped';
    }
    await writeTickState(state);
    await logEvent('mi.tick.complete', { reminders: reminders.length, capabilityGrantGc, dream: dream.status, healthNotices: health.notices.length, imessageMonitor: imessageMonitor.status, dailyBrief: Boolean(dailyBrief), projectQuestion: Boolean(projectQuestionResult?.notices.length), loopDiscovery: loopDiscoveryResult?.status, loopFactory: loopFactoryResult?.status, opportunityScans: opportunityScans.status, projectStatus: projectStatus.status, weeklyReview: weeklyReview.status });
    return { reminders, health, imessageMonitor, capabilityGrantGc, dailyBrief, projectQuestion: projectQuestionResult, loopDiscovery: loopDiscoveryResult, loopFactory: loopFactoryResult, opportunityScans, projectStatus, weeklyReview, skippedDailyBrief, skippedProjectQuestion, skippedLoopDiscovery, skippedLoopFactory, skippedOpportunityScans, skippedProjectStatus, skippedWeeklyReview };
  });
}
