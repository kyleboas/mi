import { ChiefOfStaffStore, type Action, type Commitment } from './chief-of-staff.js';
import { notify } from './notify.js';
import { appendThreadMessage } from './threads.js';
import { redactSecrets } from './redact.js';

export type ChiefReviewOptions = { dryRun?: boolean; notify?: boolean; now?: Date; store?: ChiefOfStaffStore };
export type ChiefReviewResult = { message: string; messages: string[]; notices: number; appended: boolean; notified: boolean; deduped: number };

type Candidate = { key: string; intervalMs: number; text: string; entityType: string; entityId: string };
const FOLLOW_UP_TRANSPORT_CHARS = 820;
const FOLLOW_UP_CONTEXT_CHARS = 3200;
const FOLLOW_UP_ITEM_LIMIT = 12;

function safeText(value: string) {
  return String(redactSecrets(value || '')).replace(/\r\n?/g, '\n').replace(/[\t ]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}
function endsInSilentTruncation(value: string) { return /(?:…|\.\.\.)\s*$/.test(value.trim()); }
function explicitBound(value: string, max = FOLLOW_UP_CONTEXT_CHARS) {
  const text = safeText(value);
  if (text.length <= max) return text;
  const boundary = Math.max(text.lastIndexOf(' ', max), text.lastIndexOf('\n', max));
  const kept = text.slice(0, boundary > max * 0.7 ? boundary : max).trimEnd();
  return `${kept}\n\nI have more context in the original conversation. Ask me to pull it up.`;
}
type CommitmentPresentation = { subject: string; detail?: string };
function withoutSilentEnding(value: string) { return safeText(value).replace(/(?:…|\.\.\.)\s*$/, '').trimEnd(); }
function removeSubjectFromDetail(detail: string, subject: string) {
  const full = safeText(detail), concise = safeText(subject);
  if (!full.toLowerCase().startsWith(concise.toLowerCase())) return full;
  return full.slice(concise.length).replace(/^\s*(?::|[-—])\s*/, '').trim();
}
function derivePresentation(value: string): CommitmentPresentation {
  const full = explicitBound(value);
  const separator = full.match(/:\s+/);
  if (separator?.index !== undefined && separator.index >= 12 && separator.index <= 220) {
    return { subject: full.slice(0, separator.index).trim(), detail: full.slice(separator.index + separator[0].length).trim() || undefined };
  }
  const sentence = full.slice(0, 240).match(/^(.{40,}?[.!?])(?:\s|$)/)?.[1];
  if (sentence && sentence.length < full.length) return { subject: sentence, detail: full.slice(sentence.length).trim() || undefined };
  if (full.length <= 220) return { subject: full };
  const boundary = full.lastIndexOf(' ', 180);
  const at = boundary > 90 ? boundary : 180;
  return { subject: `${full.slice(0, at).trimEnd()} (full request below)`, detail: full.slice(at).trim() || undefined };
}
function commitmentPresentation(item: Commitment): CommitmentPresentation {
  const rawTitle = safeText(item.title || 'this commitment');
  const titleWasTruncated = endsInSilentTruncation(rawTitle);
  const title = withoutSilentEnding(rawTitle) || 'This commitment';
  const detail = safeText(item.detail || '');
  const source = safeText(item.sourceExcerpt || '');
  if (titleWasTruncated && detail.length > title.length) return derivePresentation(detail);
  if (titleWasTruncated && source.length > title.length) return derivePresentation(source);
  const distinctDetail = detail ? removeSubjectFromDetail(detail, title) : '';
  if (distinctDetail) return { subject: explicitBound(title, 500), detail: explicitBound(distinctDetail) };
  if (titleWasTruncated) return { subject: explicitBound(title, 500), detail: 'I only have part of the original note here. Ask me to pull up the source conversation.' };
  return { subject: explicitBound(title, 500) };
}
function subjectSentence(subject: string) { return /[.!?]$/.test(subject.trim()) ? subject.trim() : `${subject.trim()}.`; }
function presentationContext(presentation: CommitmentPresentation) {
  return presentation.detail ? `\n\nHere’s the context:\n${presentation.detail}` : '';
}
function actionContext(item: Action, commitment?: Commitment) {
  if (commitment) {
    const presentation = commitmentPresentation(commitment);
    return `${presentation.subject}${presentationContext(presentation)}`;
  }
  const title = explicitBound(item.title || 'this work');
  return endsInSilentTruncation(title)
    ? `${withoutSilentEnding(title)}\n\nI only have part of the original note here. Ask me to pull up the source conversation.`
    : title;
}
function humanDate(value?: string) {
  if (!value) return 'the planned date';
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return value;
  return new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'long', day: 'numeric', year: parsed.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' }).format(parsed);
}
function candidateForCommitment(item: Commitment, now: Date): Candidate | undefined {
  const nowMs = now.getTime(), due = item.dueAt ? Date.parse(item.dueAt) : 0, review = item.reviewAt ? Date.parse(item.reviewAt) : 0;
  const presentation = commitmentPresentation(item);
  const context = presentationContext(presentation);
  if (item.status === 'needs_clarification' && (!review || review <= nowMs)) return { key: `clarification:${item.id}`, intervalMs: 24 * 60 * 60_000, text: `You mentioned this: ${subjectSentence(presentation.subject)}${context}\n\nI’m not sure you wanted me to keep tracking it. Should I?`, entityType: 'commitment', entityId: item.id };
  if (item.status === 'blocked') return { key: `blocked:${item.id}`, intervalMs: 24 * 60 * 60_000, text: `I still have this paused: ${subjectSentence(presentation.subject)}${context}\n\nWhat would you like me to do with it?`, entityType: 'commitment', entityId: item.id };
  if (due && due < nowMs && ['active', 'proposed'].includes(item.status)) return { key: `overdue:${item.id}`, intervalMs: 12 * 60 * 60_000, text: `You planned to do this by ${humanDate(item.dueAt)}: ${subjectSentence(presentation.subject)}${context}\n\nIs it still active, or should I update the plan?`, entityType: 'commitment', entityId: item.id };
  if (review && review < nowMs && ['active', 'proposed'].includes(item.status)) return { key: `review:${item.id}`, intervalMs: 24 * 60 * 60_000, text: `You asked me to keep track of this: ${subjectSentence(presentation.subject)}${context}\n\nIs it still something you want to keep open?`, entityType: 'commitment', entityId: item.id };
  if (item.status === 'active' && nowMs - Date.parse(item.updatedAt) > 7 * 24 * 60 * 60_000) return { key: `stalled:${item.id}`, intervalMs: 3 * 24 * 60 * 60_000, text: `I haven’t seen an update on this in over a week: ${subjectSentence(presentation.subject)}${context}\n\nIs it still active?`, entityType: 'commitment', entityId: item.id };
  return undefined;
}
function candidateForAction(item: Action, now: Date, commitment?: Commitment): Candidate | undefined {
  const context = actionContext(item, commitment);
  if (item.status === 'failed') return { key: `action-failed:${item.id}`, intervalMs: 6 * 60 * 60_000, text: `I couldn’t finish this:\n\n${context}\n\nWant me to look into what went wrong?`, entityType: 'action', entityId: item.id };
  if (item.status === 'verification_required') return { key: `action-verify:${item.id}`, intervalMs: 24 * 60 * 60_000, text: `The work on this is finished, but I haven’t checked the result yet:\n\n${context}\n\nWant me to verify it before I close this?`, entityType: 'action', entityId: item.id };
  if (item.status === 'proposed' && item.approvalRequired) return { key: `action-approval:${item.id}`, intervalMs: 24 * 60 * 60_000, text: `You asked me to do this:\n\n${context}\n\nI’m waiting for your go-ahead. Should I proceed?`, entityType: 'action', entityId: item.id };
  if (item.status === 'executing' && now.getTime() - Date.parse(item.updatedAt) > 24 * 60 * 60_000) return { key: `action-stalled:${item.id}`, intervalMs: 12 * 60 * 60_000, text: `I haven’t seen progress on this since ${humanDate(item.updatedAt)}:\n\n${context}\n\nWant me to check on it?`, entityType: 'action', entityId: item.id };
  return undefined;
}

function summaryText(value: string, max = 150) {
  const text = safeText(value).replace(/\n+/g, ' ');
  if (text.length <= max) return text;
  const boundary = text.lastIndexOf(' ', max - 24);
  return `${text.slice(0, boundary > 60 ? boundary : max - 24).trimEnd()} (full context in Mi)`;
}
export function chiefOfStaffCommitmentSummary(item: Commitment) { return summaryText(commitmentPresentation(item).subject); }

export function chiefOfStaffBriefLines(store: ChiefOfStaffStore, now = new Date()) {
  const commitments = store.listCommitments({ status: ['needs_clarification', 'blocked', 'active', 'proposed'], limit: 50 });
  const priority = [...commitments].sort((a, b) => {
    const rank = (item: Commitment) => item.status === 'needs_clarification' ? 0 : item.status === 'blocked' ? 1 : item.dueAt && Date.parse(item.dueAt) < now.getTime() ? 2 : item.status === 'active' ? 3 : 4;
    return rank(a) - rank(b) || Date.parse(a.dueAt || a.reviewAt || '9999') - Date.parse(b.dueAt || b.reviewAt || '9999');
  }).slice(0, 8);
  const actions = store.listActions({ status: ['proposed', 'executing', 'verification_required', 'failed'], limit: 30 });
  const actionSummary = (item: Action) => summaryText(actionContext(item, item.commitmentId ? store.getCommitment(item.commitmentId) : undefined));
  return {
    commitments: priority.map((item) => `- ${chiefOfStaffCommitmentSummary(item)}${item.dueAt ? ` — planned for ${humanDate(item.dueAt)}` : ''}`),
    decisions: actions.filter((item) => item.approvalRequired && item.status === 'proposed').slice(0, 5).map((item) => `- ${actionSummary(item)} — waiting for your go-ahead.`),
    delegated: actions.filter((item) => ['executing', 'verification_required', 'failed'].includes(item.status)).slice(0, 6).map((item) => `- ${actionSummary(item)} — ${item.status === 'executing' ? 'still in progress.' : item.status === 'verification_required' ? 'ready for me to check.' : 'needs another look.'}`),
  };
}

function splitAtNaturalBoundary(text: string, max: number) {
  const parts: string[] = [];
  let remaining = text.trim();
  while (remaining.length > max) {
    const paragraph = remaining.lastIndexOf('\n\n', max);
    const sentence = Math.max(remaining.lastIndexOf('. ', max), remaining.lastIndexOf('? ', max), remaining.lastIndexOf('! ', max));
    const word = remaining.lastIndexOf(' ', max);
    const cut = Math.max(paragraph, sentence >= 0 ? sentence + 1 : -1, word);
    const at = cut > max * 0.55 ? cut : max;
    parts.push(remaining.slice(0, at).trim());
    remaining = remaining.slice(at).trim();
  }
  if (remaining) parts.push(remaining);
  return parts;
}
export function splitFollowUpForTransport(text: string, max = FOLLOW_UP_TRANSPORT_CHARS) {
  const safe = safeText(text);
  if (safe.length <= max) return [safe];
  const raw = splitAtNaturalBoundary(safe, Math.max(120, max - 42));
  return raw.map((part, index) => `A longer note, part ${index + 1} of ${raw.length}:\n\n${part}`);
}
function packFollowUpMessages(candidates: Candidate[], omitted: number) {
  if (candidates.length === 1 && omitted === 0) return splitFollowUpForTransport(candidates[0].text);
  const blocks = candidates.map((item) => item.text);
  if (omitted > 0) blocks.push(`I have ${omitted} more ${omitted === 1 ? 'thing' : 'things'} to go through. Ask me to show you the rest when you’re ready.`);
  const messages: string[] = [];
  let group: string[] = [];
  let started = false;
  const opener = () => !started
    ? (blocks.length === 2 ? 'A couple of things need your attention.' : 'A few things need your attention.')
    : 'A couple more things need your attention.';
  const flush = () => {
    if (!group.length) return;
    const body = `${opener()}\n\n${group.join('\n\n')}`;
    messages.push(...splitFollowUpForTransport(body));
    started = true;
    group = [];
  };
  for (const block of blocks) {
    const openerBudget = 50;
    const proposed = [...group, block].join('\n\n');
    if (group.length && proposed.length + openerBudget > FOLLOW_UP_TRANSPORT_CHARS) flush();
    if (block.length + openerBudget > FOLLOW_UP_TRANSPORT_CHARS) {
      flush();
      messages.push(...splitFollowUpForTransport(`${opener()}\n\n${block}`));
      started = true;
    } else group.push(block);
  }
  flush();
  return messages;
}

export async function runChiefOfStaffReview(options: ChiefReviewOptions = {}): Promise<ChiefReviewResult> {
  const owned = !options.store; const store = options.store || new ChiefOfStaffStore(); const now = options.now || new Date();
  try {
    const actions = store.listActions({ status: ['proposed', 'executing', 'verification_required', 'failed'], limit: 200 });
    const actionCandidates = actions.map((item) => candidateForAction(item, now, item.commitmentId ? store.getCommitment(item.commitmentId) : undefined)).filter((item): item is Candidate => Boolean(item));
    const commitmentsWithActionNotice = new Set(actions.filter((item) => actionCandidates.some((candidate) => candidate.entityId === item.id)).map((item) => item.commitmentId).filter(Boolean));
    const raw = [
      ...store.listCommitments({ status: ['needs_clarification', 'blocked', 'active', 'proposed'], limit: 200 }).filter((item) => !commitmentsWithActionNotice.has(item.id)).map((item) => candidateForCommitment(item, now)),
      ...actionCandidates,
      ...store.listFollowUps().filter((item) => Date.parse(item.dueAt) <= now.getTime()).map((item) => ({ key: `follow-up:${item.id}`, intervalMs: 24 * 60 * 60_000, text: `You wanted to follow up on this:\n\n${explicitBound(item.reason)}\n\nIs now a good time, or should I remind you later?`, entityType: 'follow_up', entityId: item.id })),
    ].filter((item): item is Candidate => Boolean(item));
    const due = raw.filter((item) => store.shouldDeliver(item.key, item.intervalMs, now.toISOString()));
    if (!due.length) return { message: 'Nothing needs your attention right now.', messages: [], notices: 0, appended: false, notified: false, deduped: raw.length };
    const shown = due.slice(0, FOLLOW_UP_ITEM_LIMIT);
    const messages = packFollowUpMessages(shown, due.length - shown.length).map((message) => String(redactSecrets(message)));
    const message = messages.join('\n\n');
    let appended = false, notified = false;
    if (!options.dryRun) {
      for (const outgoing of messages) await appendThreadMessage('main', 'assistant', outgoing, { unread: true, source: 'mi:chief-of-staff' });
      appended = messages.length > 0;
      for (const item of due) store.recordDelivery({ kind: 'follow-up', dedupeKey: item.key, entityType: item.entityType, entityId: item.entityId, payloadExcerpt: item.text });
      if (options.notify !== false) {
        for (const outgoing of messages) {
          const result = await notify('Mi', outgoing).catch(() => ({ skipped: true }));
          if (!(result as any)?.skipped) notified = true;
        }
      }
    }
    return { message, messages, notices: due.length, appended, notified, deduped: raw.length - due.length };
  } finally { if (owned) store.close(); }
}

export async function deliverChiefOfStaffReconciliation(kind: 'evening' | 'weekly', message: string, options: { dryRun?: boolean; notify?: boolean; store?: ChiefOfStaffStore; dateKey?: string } = {}) {
  const owned = !options.store; const store = options.store || new ChiefOfStaffStore();
  try {
    const dateKey = options.dateKey || new Date().toISOString().slice(0, 10); const key = `${kind}:${dateKey}`;
    const messages = splitFollowUpForTransport(String(redactSecrets(message)));
    if (!store.shouldDeliver(key, 20 * 60 * 60_000)) return { delivered: false, deduped: true, message, messages };
    if (!options.dryRun) {
      for (const outgoing of messages) await appendThreadMessage('main', 'assistant', outgoing, { unread: true, source: `mi:${kind}-review` });
      store.recordDelivery({ kind, dedupeKey: key, payloadExcerpt: message });
      if (options.notify !== false) for (const outgoing of messages) await notify('Mi', outgoing).catch(() => ({ skipped: true }));
    }
    return { delivered: !options.dryRun, deduped: false, message, messages };
  } finally { if (owned) store.close(); }
}

export function renderEveningReconciliation(store: ChiefOfStaffStore, now = new Date()) {
  const brief = chiefOfStaffBriefLines(store, now);
  const completed = store.listCommitments({ status: 'completed', limit: 100 }).filter((item) => Date.parse(item.completedAt || '') >= new Date(now.toISOString().slice(0, 10)).getTime()).slice(0, 8);
  return [
    'Good evening. Here’s the short version of where things stand.',
    '',
    'What got done',
    ...(completed.length ? completed.map((item) => `- ${chiefOfStaffCommitmentSummary(item)}`) : ['- I don’t have a verified completion recorded today.']),
    '',
    'Still in motion',
    ...(brief.commitments.length ? brief.commitments : ['- Nothing is currently open.']),
    '',
    'Needs your input',
    ...(brief.decisions.length || brief.delegated.length ? [...brief.decisions, ...brief.delegated] : ['- Nothing needs a decision or a check.']),
  ].join('\n');
}
