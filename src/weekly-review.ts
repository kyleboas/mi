import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { queuedProposals, readProposalQueue, renderNumberedProposals } from './proposals.js';
import { readRunRecords } from './primitives.js';
import { readRecentEvents } from './state.js';

export type WeeklyReviewInput = {
  now?: Date;
  projectsStatusPath?: string;
  maxProposals?: number;
};

function pathDefault(name: string) {
  return join(homedir(), 'pi-docs', name);
}

function nyWeekday(date = new Date()) {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' }).format(date);
}

export function weeklyReviewDue(lastWeeklyReviewDate?: string, now = new Date()) {
  if (process.env.MI_WEEKLY_REVIEW_ENABLED === 'false') return false;
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  return nyWeekday(now) === (process.env.MI_WEEKLY_REVIEW_DAY || 'Sun') && lastWeeklyReviewDate !== today;
}

function compact(lines: string[], fallback: string) {
  const filtered = lines.map((line) => line.trim()).filter(Boolean);
  return filtered.length > 0 ? filtered : [fallback];
}

export async function renderWeeklyReview(input: WeeklyReviewInput = {}) {
  const projectsStatus = await readFile(input.projectsStatusPath || pathDefault('projects-status.md'), 'utf8').catch(() => '');
  const proposalLines = renderNumberedProposals(queuedProposals(await readProposalQueue(), input.maxProposals ?? 5));
  const runs = await readRunRecords(50).catch(() => []);
  const events = await readRecentEvents(200).catch(() => []);
  const delegated = runs.filter((run: any) => run.assistant === 'delegated-action').slice(-5).map((run: any) => `- ${run.summary || run.id}`);
  const stuckProjects = projectsStatus.split('\n').filter((line) => /\|\s*kyleboas\//.test(line) && /\|\s*(unknown|error|degraded|stale|[1-9]\d*)\s*\|/.test(line)).slice(0, 5).map((line) => `- ${line.split('|').slice(1, 4).map((cell) => cell.trim()).join(' - ')}`);
  const incidentCount = events.filter((event: any) => String(event.type || '').includes('incident') || String(event.type || '').includes('error')).length;
  return [
    'Weekly review',
    '',
    'WHAT MOVED',
    ...compact(delegated, '- No delegated completions recorded this week.'),
    '',
    'STUCK OR RISKY',
    ...compact(stuckProjects, '- No generated project-status risks found.'),
    '',
    'DECISIONS',
    ...compact(proposalLines, '- No queued proposals.'),
    '',
    'SELF-AUDIT',
    `- Recent incident/error events: ${incidentCount}`,
  ].join('\n');
}
