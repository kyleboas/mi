import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { parseAssistantMarkdown, validateAssistantFile } from '../src/assistant.js';
import { runAssistant, startWorker } from '../src/runner.js';
import { decideToolSafety } from '../src/safety.js';
import { runScheduledAssistant } from '../src/scheduler.js';
import { requireTool } from '../src/tool-registry.js';

const checks: Array<{ name: string; ok: boolean; detail?: unknown }> = [];
function check(name: string, ok: boolean, detail?: unknown) {
  checks.push({ name, ok, detail });
}

const productionMarkdown = await readFile('assistants/production.md', 'utf8');
const production = parseAssistantMarkdown(productionMarkdown, 'assistants/production.md');
check('production assistant validates', validateAssistantFile(production).length === 0, validateAssistantFile(production));

const manual = await runAssistant({ name: 'production', trigger: 'manual' });
check('manual run production', manual.status === 'ok', manual);

const scheduled = await runScheduledAssistant('production');
check('scheduled run production', !scheduled.skipped && scheduled.result.status === 'ok', scheduled);

const health = await fetch(`http://${process.env.HOST || '127.0.0.1'}:${process.env.PORT || '8787'}/health`).then((r) => r.json()).catch((error) => ({ ok: false, error: String(error) }));
check('Tailnet web health', Boolean(health.ok && health.tailnet?.required && health.tailnet?.allowed), health);

const inspectSafety = decideToolSafety({ permissions: {} }, requireTool('pi.inspect'));
check('read-only tool allowed', inspectSafety.allowed, inspectSafety);

const repairSafety = decideToolSafety({ permissions: {} }, requireTool('pi.repair'));
check('approval-required path', !repairSafety.allowed && repairSafety.approvalRequired, repairSafety);

const repairWorker = await startWorker({ kind: 'pi.repair', issue: 'simulated failing CI', evidence: 'v0 validation' });
check('simulated failing CI path gates pi.repair', repairWorker.status === 'approval_required', repairWorker);

for (const item of checks) {
  console.log(`${item.ok ? 'ok' : 'not ok'} - ${item.name}`);
  if (!item.ok || process.env.VALIDATE_VERBOSE === 'true') console.log(JSON.stringify(item.detail, null, 2));
}

if (checks.some((item) => !item.ok)) process.exitCode = 1;
