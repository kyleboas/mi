import { defineTool, defineWorker, type Tool } from '../../src/primitives.js';
import { runPiInspectWorker, runPiRepairWorker } from '../../src/workers.js';

export const piInspect = defineTool({
  name: 'pi.inspect',
  description: 'Use pi for read-only repo, file, log, wiki, or service inspection.',
  permissions: ['read'],
  async run(input: { issue: string; evidence?: string; repoPath?: string }) {
    return runPiInspectWorker({ kind: 'pi.inspect', ...input });
  },
});

export const piRepair = defineTool({
  name: 'pi.repair',
  description: 'Use pi to attempt a code repair in a branch/worktree after approval.',
  permissions: ['write', 'approval_required'],
  async run(input: { issue: string; evidence?: string; repoPath?: string; dryRun?: boolean }) {
    return runPiRepairWorker({ kind: 'pi.repair', ...input });
  },
});

export const piInspectWorker = defineWorker({
  kind: 'pi.inspect',
  description: 'Read-only pi worker.',
  run: runPiInspectWorker,
});

export const piRepairWorker = defineWorker({
  kind: 'pi.repair',
  description: 'Code-changing pi repair worker; disabled unless approval enables it.',
  run: runPiRepairWorker,
});

export const tools: Tool[] = [piInspect, piRepair];
export const workers = [piInspectWorker, piRepairWorker];
