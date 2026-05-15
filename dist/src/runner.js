import { readFile } from 'node:fs/promises';
import { assistantPath, parseAssistantMarkdown, validateAssistantFile } from './assistant.js';
import { addApproval, addWorkerResult, createRunRecord, finishRunRecord, writeRunRecord } from './primitives.js';
import { assertRuntimeCannotSelfModify } from './safety.js';
import { runWorker } from './workers.js';
export async function startWorker(request) {
    if (request.kind === 'pi.repair') {
        return {
            kind: 'pi.repair',
            status: 'approval_required',
            summary: 'pi.repair requires an explicit approval gate before code-changing worker runs.',
            approvalReason: 'repair workers may edit files, create branches, run tests, and prepare PRs.',
        };
    }
    return runWorker(request);
}
export async function startWorkerForRun(runId, request) {
    const result = await startWorker(request);
    const run = createRunRecord(request.kind, { event: 'worker' });
    const withWorker = addWorkerResult({ ...run, id: runId }, result);
    const withApproval = result.status === 'approval_required'
        ? addApproval(withWorker, { status: 'pending', reason: result.approvalReason || result.summary })
        : withWorker;
    await writeRunRecord(finishRunRecord(withApproval, result.status === 'ok' ? 'ok' : result.status, result.summary));
    return result;
}
export function checkRuntimeInstructionEdit(targetPath) {
    return assertRuntimeCannotSelfModify(targetPath);
}
export async function checkAssistant(name) {
    const path = assistantPath(name);
    const issues = [];
    let exists = false;
    try {
        const markdown = await readFile(path, 'utf8');
        exists = true;
        if (!markdown.trim())
            issues.push('assistant file is empty');
        try {
            const assistant = parseAssistantMarkdown(markdown, path);
            issues.push(...validateAssistantFile(assistant));
        }
        catch (e) {
            issues.push(e instanceof Error ? e.message : String(e));
        }
    }
    catch {
        issues.push('assistant file not found');
    }
    return { name, path, exists, ok: issues.length === 0, issues };
}
export async function runAssistant(request) {
    const check = await checkAssistant(request.name);
    if (!check.ok) {
        const trigger = request.trigger === 'manual' ? { manual: true } : { event: request.trigger };
        const run = finishRunRecord(createRunRecord(request.name, trigger), 'error', `Assistant cannot run: ${check.issues.join('; ')}`);
        await writeRunRecord(run);
        return {
            name: request.name,
            startedAt: run.startedAt,
            trigger: request.trigger,
            status: 'error',
            summary: run.result || `Assistant cannot run: ${check.issues.join('; ')}`,
        };
    }
    const trigger = request.trigger === 'manual' ? { manual: true } : { event: request.trigger };
    const run = finishRunRecord(createRunRecord(request.name, trigger), 'ok', 'Runner layer is ready. Execution behavior will be added in later phases.');
    await writeRunRecord(run);
    return {
        name: request.name,
        startedAt: run.startedAt,
        trigger: request.trigger,
        status: 'ok',
        summary: run.result || 'Runner layer is ready.',
    };
}
export function explainRunnerLayer() {
    return 'Assistant Runner reads assistants/*.md and executes short-lived runs. Each run records trigger, tools, worker output, approvals, and result.';
}
