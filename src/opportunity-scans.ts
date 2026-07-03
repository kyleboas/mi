import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { enqueueProposal } from './proposals.js';
import { logEvent } from './state.js';

export type OpportunityScanResult = { status: 'ok' | 'skipped' | 'error'; proposals: number; error?: string };

function plansDir() {
  return process.env.MI_PLANS_DIR || join(homedir(), 'code', 'plans');
}

function enabled() {
  return process.env.MI_OPPORTUNITY_SCANS_ENABLED !== 'false';
}

async function planFiles(root = plansDir()) {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile() && entry.name.endsWith('.md') && entry.name !== 'README.md').map((entry) => join(root, entry.name));
  } catch {
    return [];
  }
}

function datedCommitment(text: string) {
  const match = text.match(/\b(20\d{2}-\d{2}-\d{2}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2})\b/i);
  return match?.[0];
}

export async function runOpportunityScans(): Promise<OpportunityScanResult> {
  if (!enabled()) return { status: 'skipped', proposals: 0 };
  try {
    let proposals = 0;
    const max = Math.max(0, Number(process.env.MI_OPPORTUNITY_SCAN_MAX_PROPOSALS || 3));
    for (const file of await planFiles()) {
      if (proposals >= max) break;
      const info = await stat(file).catch(() => undefined);
      const text = await readFile(file, 'utf8').catch(() => '');
      const title = text.match(/^#\s+(.+)$/m)?.[1]?.trim() || basename(file, '.md');
      const commitment = datedCommitment(text);
      const old = info ? Date.now() - info.mtimeMs > 7 * 24 * 60 * 60_000 : false;
      if (!commitment && !old) continue;
      await enqueueProposal({
        source: commitment ? 'deadline-radar' : 'stale-work-sweep',
        title: commitment ? `Check deadline in ${title}` : `Review stale plan ${title}`,
        detail: commitment ? `dated commitment: ${commitment}` : 'plan file untouched for more than 7 days',
        action: `Reply ${proposals + 1} and I will inspect ${basename(file)} against current repo state`,
        dedupeKey: `plan:${basename(file)}:${commitment || 'stale'}`,
      });
      proposals += 1;
    }
    await logEvent('mi.opportunity_scans.complete', { proposals });
    return { status: 'ok', proposals };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await logEvent('mi.opportunity_scans.error', { error: message });
    return { status: 'error', proposals: 0, error: message };
  }
}
