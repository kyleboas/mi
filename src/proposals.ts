import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { redactSecrets } from './redact.js';

export type ProposalStatus = 'queued' | 'accepted' | 'rejected' | 'completed' | 'superseded';

export type Proposal = {
  id: string;
  createdAt: string;
  source: string;
  title: string;
  detail?: string;
  action: string;
  status: ProposalStatus;
  dedupeKey: string;
};

export type ProposalQueue = { version: 1; proposals: Proposal[] };

function miRoot() {
  return process.env.MI_ROOT || join(homedir(), 'assistant');
}

export function proposalQueuePath() {
  return process.env.MI_PROPOSALS_PATH || join(resolve(miRoot()), 'state', 'proposals.json');
}

function hash(value: string) {
  return createHash('sha256').update(value.toLowerCase().replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 12);
}

function clean(value: string, max = 240) {
  const text = String(redactSecrets(value || '')).replace(/[\p{Extended_Pictographic}\uFE0F]/gu, '').replace(/[—–]/g, '-').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

export async function readProposalQueue(path = proposalQueuePath()): Promise<ProposalQueue> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<ProposalQueue>;
    const proposals = Array.isArray(parsed.proposals) ? parsed.proposals.filter((item) => item && typeof item.title === 'string' && typeof item.action === 'string') as Proposal[] : [];
    return { version: 1, proposals: proposals.slice(-200) };
  } catch {
    return { version: 1, proposals: [] };
  }
}

export async function writeProposalQueue(queue: ProposalQueue, path = proposalQueuePath()) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({ version: 1, proposals: queue.proposals.slice(-200) }, null, 2), { mode: 0o600 });
}

export async function enqueueProposal(input: { source: string; title: string; action: string; detail?: string; dedupeKey?: string }, path = proposalQueuePath()) {
  const queue = await readProposalQueue(path);
  const dedupeKey = input.dedupeKey || hash(`${input.source}:${input.title}:${input.action}`);
  const existing = queue.proposals.find((proposal) => proposal.dedupeKey === dedupeKey && proposal.status === 'queued');
  if (existing) return existing;
  const proposal: Proposal = {
    id: `p_${hash(`${Date.now()}:${dedupeKey}:${Math.random()}`)}`,
    createdAt: new Date().toISOString(),
    source: clean(input.source, 80),
    title: clean(input.title, 160),
    detail: input.detail ? clean(input.detail, 320) : undefined,
    action: clean(input.action, 240),
    status: 'queued',
    dedupeKey,
  };
  queue.proposals.push(proposal);
  await writeProposalQueue(queue, path);
  return proposal;
}

export async function resolveProposal(selector: string, status: ProposalStatus, path = proposalQueuePath()) {
  const queue = await readProposalQueue(path);
  const queued = queue.proposals.filter((proposal) => proposal.status === 'queued');
  const numeric = selector.match(/^\d+$/) ? Number(selector) : 0;
  const proposal = numeric > 0 ? queued[numeric - 1] : queue.proposals.find((item) => item.id === selector || item.id.startsWith(selector));
  if (!proposal) return undefined;
  proposal.status = status;
  await writeProposalQueue(queue, path);
  return proposal;
}

export async function acceptProposal(selector: string, path = proposalQueuePath()) {
  return resolveProposal(selector, 'accepted', path);
}

export function queuedProposals(queue: ProposalQueue, max = Number(process.env.MI_PROPOSALS_MAX_PER_DAY || 3)) {
  return queue.proposals
    .filter((proposal) => proposal.status === 'queued')
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
    .slice(0, Math.max(0, max));
}

export function renderNumberedProposals(proposals: Proposal[]) {
  return proposals.map((proposal, index) => {
    const line = `${index + 1}. ${proposal.title} - ${proposal.action}`;
    return proposal.detail ? `${line} (${proposal.detail})` : line;
  });
}
