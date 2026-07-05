import { spawn } from 'node:child_process';

export type WorkerKind = 'pi.inspect' | 'pi.repair';

export type WorkerRequest = {
  kind: WorkerKind;
  repoPath?: string;
  issue: string;
  evidence?: string;
  dryRun?: boolean;
};

export type WorkerResult = {
  kind: WorkerKind;
  status: 'ok' | 'approval_required' | 'error';
  summary: string;
  output?: string;
  approvalReason?: string;
};

function piModelArgs() {
  const model = process.env.PI_WORKER_MODEL || process.env.PI_MODEL;
  return model ? ['--model', model] : [];
}

function collectPiText(stdout: string) {
  let text = '';
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta') text += event.assistantMessageEvent.delta || '';
      if (event.type === 'message_end' && event.message?.errorMessage && !text) text += event.message.errorMessage;
    } catch {}
  }
  return text.trim();
}

async function runPi(prompt: string, cwd: string, tools: string, timeoutMs = 180_000): Promise<WorkerResult> {
  if (process.env.MI_MEMORY_IN_WORKERS !== 'false') {
    const { memorySystemBlock } = await import('./memory.js');
    const memory = await memorySystemBlock().catch(() => '');
    if (memory) prompt = `${memory}\n\n${prompt}`;
  }
  const cmd = process.env.PI_CMD || 'pi';
  const args = ['--mode', 'json', ...piModelArgs(), '--tools', tools, prompt];

  return await new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env: process.env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      resolve({ kind: 'pi.inspect', status: 'error', summary: `pi worker timed out after ${timeoutMs}ms`, output: collectPiText(stdout) || stderr });
    }, timeoutMs);

    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ kind: 'pi.inspect', status: 'error', summary: `failed to start pi: ${e.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const output = collectPiText(stdout) || stderr.trim();
      resolve({ kind: 'pi.inspect', status: code === 0 ? 'ok' : 'error', summary: code === 0 ? 'pi worker completed' : `pi worker exited ${code}`, output });
    });
  });
}

export async function runPiInspectWorker(request: WorkerRequest): Promise<WorkerResult> {
  const cwd = request.repoPath || process.env.HOME || process.cwd();
  const prompt = `Inspect only. Do not edit files. Do not deploy. Do not publish. Do not merge. Do not delete. Do not expose secrets.\n\nIssue:\n${request.issue}\n\nEvidence:\n${request.evidence || 'none'}`;
  const result = await runPi(prompt, cwd, 'read,grep,find,ls');
  return { ...result, kind: 'pi.inspect' };
}

export async function runPiRepairWorker(request: WorkerRequest): Promise<WorkerResult> {
  if (process.env.PI_REPAIR_ENABLED !== 'true' || request.dryRun !== false) {
    return {
      kind: 'pi.repair',
      status: 'approval_required',
      summary: 'pi repair worker is defined but disabled by default. Create an approval before enabling code-changing repair runs.',
      approvalReason: 'pi.repair may edit files, create branches, run tests, and prepare PRs.',
    };
  }

  const cwd = request.repoPath || process.cwd();
  const prompt = `Coding repair worker. Work in a branch or isolated worktree. Do not deploy, merge, publish, edit secrets, or change production settings. Prepare a concise report of changes and tests.\n\nIssue:\n${request.issue}\n\nEvidence:\n${request.evidence || 'none'}`;
  const result = await runPi(prompt, cwd, 'read,grep,find,ls,bash,edit,write');
  return { ...result, kind: 'pi.repair' };
}

export async function runWorker(request: WorkerRequest): Promise<WorkerResult> {
  if (request.kind === 'pi.inspect') return runPiInspectWorker(request);
  if (request.kind === 'pi.repair') return runPiRepairWorker(request);
  return { kind: request.kind, status: 'error', summary: `unknown worker: ${request.kind}` };
}
