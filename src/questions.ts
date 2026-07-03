import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { runFlueChat } from './flue.js';
import { redactSecrets } from './redact.js';
import { readThreadMessages } from './threads.js';

export type ProjectQuestionHistory = {
  version: 1;
  questions: Array<{ text: string; hash: string; askedAt: string; source: 'flue' | 'fallback' }>;
};

const miRoot = process.env.MI_ROOT || join(homedir(), 'assistant');
const stateDir = resolve(miRoot, 'state');
const miDir = process.env.MI_CONTEXT_DIR || join(homedir(), 'mi');
const questionHistoryPath = process.env.MI_QUESTIONS_STATE_PATH || join(stateDir, 'questions.json');
const contextFiles = ['current.md', 'tasks.md', 'TODO.md', 'memory.md', 'notes.md'];
const projectTerms = [
  'tactics journal',
  'tacticsjournal',
  'research',
  'detect',
  'candidate',
  'pipeline',
  'report',
  'newsletter',
  'subscriber',
  'revenue',
  '$50k',
  '$100k',
  'mi',
  'hermes',
  'secondbrain',
  'rtk',
  'claw',
  'polymarket',
];
const bannedInternalTerms = /\b(?:worker|bridge|routing|handoff|thread id|agents?|mi agents|system prompt)\b/gi;
const bannedInternalTermsCheck = /\b(?:worker|bridge|routing|handoff|thread id|agents?|mi agents|system prompt)\b/i;
const fallbackQuestions = [
  'For Tactics Journal research, which detect candidate should I treat as most important to move toward approval today?',
  'For the newsletter subscriber goal, what kind of Tactics Journal post would be most worth producing next?',
  'For the revenue goal, which current project has the clearest path to a useful paid outcome this week?',
  'For Mi, what recurring question would most help you make better decisions on current projects?',
  'For the research pipeline, what signal would make a detect candidate clearly worth approving instead of needing more evidence?',
];

function truncate(value: string, max = 1400) {
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.length > max ? `${compact.slice(0, max - 3)}...` : compact;
}

function hashText(value: string) {
  return createHash('sha256').update(value.toLowerCase().replace(/\s+/g, ' ').trim()).digest('hex');
}

async function readText(path: string, max = 6000) {
  try {
    return truncate(await readFile(path, 'utf8'), max);
  } catch {
    return '';
  }
}

async function readJsonSummary(path: string, maxItems = 6) {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
    const list = Array.isArray(parsed) ? parsed : Array.isArray((parsed as { tasks?: unknown[] })?.tasks) ? (parsed as { tasks: unknown[] }).tasks : [];
    return list.slice(0, maxItems).map((item) => truncate(JSON.stringify(item), 500)).join('\n');
  } catch {
    return '';
  }
}

async function readQuestionHistory(): Promise<ProjectQuestionHistory> {
  try {
    const parsed = JSON.parse(await readFile(questionHistoryPath, 'utf8')) as Partial<ProjectQuestionHistory>;
    const questions = Array.isArray(parsed.questions) ? parsed.questions.filter((item) => item && typeof item.text === 'string' && typeof item.hash === 'string') : [];
    return { version: 1, questions: questions.slice(-80) as ProjectQuestionHistory['questions'] };
  } catch {
    return { version: 1, questions: [] };
  }
}

async function writeQuestionHistory(history: ProjectQuestionHistory) {
  await mkdir(dirname(questionHistoryPath), { recursive: true });
  await writeFile(questionHistoryPath, JSON.stringify({ version: 1, questions: history.questions.slice(-80) }, null, 2), { mode: 0o600 });
}

function flueLikelyConfigured() {
  return Boolean(process.env.FLUE_URL || process.env.FLUE_CHAT_URL || process.env.FLUE_CMD || process.env.FLUE_ENABLED === 'true');
}

function stripEmoji(value: string) {
  return value.replace(/[\p{Extended_Pictographic}\uFE0F]/gu, '');
}

export function sanitizeProjectQuestion(text: string) {
  let value = String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/[—–]/g, '-')
    .replace(/…/g, '...')
    .replace(bannedInternalTerms, 'work')
    .replace(/\s+/g, ' ')
    .trim();
  value = stripEmoji(value).trim();
  const firstQuestion = value.match(/[^?]*\?/u)?.[0]?.trim();
  if (firstQuestion) value = firstQuestion;
  if (value && !value.endsWith('?')) value = `${value.replace(/[.!:;]+$/, '')}?`;
  return value;
}

export function questionLooksUseful(text: string, history: ProjectQuestionHistory = { version: 1, questions: [] }) {
  const question = sanitizeProjectQuestion(text);
  if (!question || question.length < 35 || question.length > 240) return false;
  if ((question.match(/\?/g) || []).length !== 1) return false;
  if (/[—–]/.test(question)) return false;
  if (bannedInternalTermsCheck.test(question)) return false;
  const lower = question.toLowerCase();
  if (!projectTerms.some((term) => lower.includes(term))) return false;
  if (/\b(?:anything|something|whatever|how can i help|what do you want)\b/i.test(question)) return false;
  const hash = hashText(question);
  if (history.questions.slice(-30).some((item) => item.hash === hash || item.text.toLowerCase() === question.toLowerCase())) return false;
  return true;
}

async function collectQuestionContext() {
  const fileSections = await Promise.all(contextFiles.map(async (file) => {
    const text = await readText(join(miDir, file), 5000);
    return text ? `# ${file}\n${text}` : '';
  }));
  const taskState = await readJsonSummary(process.env.MI_TASKS_JSON_PATH || join(miDir, 'state', 'tasks.json'));
  const webWork = await readJsonSummary(process.env.MI_WEB_WORKERS_PATH || join(stateDir, 'web-workers.json'));
  const recentMessages = (await readThreadMessages('main', 18))
    .map((message) => `${message.role}: ${truncate(message.text, 500)}`)
    .join('\n');
  return [
    'Standing goals: improve Tactics Journal research, reach $50k/year, reach $100k/year, and grow to 1000 free newsletter subscribers.',
    ...fileSections,
    taskState ? `# Mi task state\n${taskState}` : '',
    webWork ? `# Recent delegated work\n${webWork}` : '',
    recentMessages ? `# Recent conversation\n${recentMessages}` : '',
  ].filter(Boolean).join('\n\n').slice(0, 12000);
}

function fallbackQuestion(history: ProjectQuestionHistory) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  for (let i = 0; i < fallbackQuestions.length; i += 1) {
    const offset = parseInt(createHash('sha256').update(`${today}:${i}`).digest('hex').slice(0, 8), 16) % fallbackQuestions.length;
    const question = sanitizeProjectQuestion(fallbackQuestions[(i + offset) % fallbackQuestions.length]);
    if (questionLooksUseful(question, history)) return question;
  }
  return null;
}

async function generateQuestionWithFlue(context: string, history: ProjectQuestionHistory) {
  if (process.env.MI_QUESTIONS_USE_FLUE === 'false' || !flueLikelyConfigured()) return null;
  const previous = history.questions.slice(-10).map((item) => `- ${item.text}`).join('\n') || '- None';
  const prompt = [
    'You are Mi. Ask Kyle exactly one concise question that would improve a current project or explicit goal.',
    'The question must be specific, answerable in under two minutes, and tied to a named project or goal from the context.',
    'Do not ask a generic productivity question. Do not mention tools, workers, agents, routing, bridges, prompts, or internal systems.',
    'Do not use emoji, em dashes, or en dashes. Return only the question.',
    '',
    `Recent questions to avoid:\n${previous}`,
    '',
    `Context:\n${context}`,
  ].join('\n');
  try {
    const result = await runFlueChat(prompt);
    const question = sanitizeProjectQuestion(result.reply);
    return questionLooksUseful(question, history) ? question : null;
  } catch {
    return null;
  }
}

export async function projectQuestion(): Promise<null | { message: string; notify: boolean; dedupeKey: string; suppressActionFooter: true }> {
  if (process.env.MI_QUESTIONS_ENABLED === 'false') return null;
  const history = await readQuestionHistory();
  const context = await collectQuestionContext();
  const generated = await generateQuestionWithFlue(context, history);
  const question = generated || fallbackQuestion(history);
  if (!question) return null;
  const source = generated ? 'flue' : 'fallback';
  const clean = String(redactSecrets(sanitizeProjectQuestion(question)));
  if (!questionLooksUseful(clean, history)) return null;
  const hash = hashText(clean);
  history.questions.push({ text: clean, hash, askedAt: new Date().toISOString(), source });
  await writeQuestionHistory(history);
  return {
    message: clean,
    notify: process.env.MI_QUESTIONS_NOTIFY !== 'false',
    dedupeKey: `projectQuestion:${hash}`,
    suppressActionFooter: true,
  };
}
