import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { appendFileSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/**
 * Mi capability guard for scoped Pi workers and coordinators.
 *
 * Every tool must be explicitly known here. A newly installed extension tool
 * therefore starts denied instead of silently gaining Mi's sender authority.
 */

type Right = 'read' | 'write' | 'execute' | 'fetch' | 'exchange';

type Grant = {
  id: string;
  resource: string;
  rights: Right[];
  constraints?: { recursive?: boolean; exact?: boolean; commands?: string[]; env?: string[]; profile?: string; scope?: string };
  expiresAt?: string;
  principal?: unknown;
};

type AuditRecord = {
  ts: string;
  decision: 'allow' | 'deny' | 'shadow';
  toolName: string;
  toolCallId?: string;
  right: Right;
  resource: string;
  reason: string;
  capabilityId?: string;
};

type ToolRequest = { right: Right; resource: string; path?: string };

const ALLOWED_MI_EXTENSION_TOOLS = new Set(['mi_orchestrator_delegate']);
const DIVER_NOTES_READ_OPERATIONS = new Set(['tasks.list', 'notes.list', 'projects.list', 'project-tasks.list']);
const DIVER_NOTES_WRITE_OPERATIONS = new Set(['tasks.add', 'tasks.complete', 'tasks.reopen', 'notes.add', 'projects.ensure', 'project-tasks.add', 'project-tasks.complete', 'project-tasks.reopen', 'project-subtasks.add', 'project-subtasks.complete', 'project-subtasks.reopen']);
const BLOCKED_ORCHESTRATOR_TOOLS = new Set(['orchestrator_delegate', 'orchestrator_steer', 'orchestrator_workers', 'orchestrator_stop', 'orchestrator_takeover']);
const PROTECTED_PATH_NAMES = new Set(['.git', '.pi', '.config', '.ssh', 'node_modules', 'state', 'secrets', 'credentials', 'config']);

function readGrants(): Grant[] {
  const file = process.env.MI_CAPABILITY_GRANTS_FILE;
  if (!file) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return Array.isArray(parsed) ? parsed : Array.isArray(parsed.grants) ? parsed.grants : [];
  } catch {
    return [];
  }
}

const grants = readGrants();
const auditPath = process.env.MI_CAPABILITY_AUDIT_FILE || '';
const enforcement = String(process.env.MI_CAPABILITY_ENFORCEMENT || 'enforce').toLowerCase();

function audit(record: AuditRecord) {
  if (!auditPath) return;
  try {
    appendFileSync(auditPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  } catch {
    // Never let audit logging failure grant access.
  }
}

function canonicalPath(inputPath: string | undefined, cwd: string) {
  const requested = resolve(cwd, inputPath || '.');
  let existing = requested;
  const tail: string[] = [];
  while (true) {
    try {
      const base = realpathSync(existing);
      return tail.length ? resolve(base, ...tail.reverse()) : base;
    } catch {
      const parent = dirname(existing);
      if (parent === existing) return requested;
      tail.push(existing.slice(parent.length).replace(/^[/\\]+/, ''));
      existing = parent;
    }
  }
}

function fileResource(inputPath: string | undefined, cwd: string) {
  return `file://${canonicalPath(inputPath, cwd)}`;
}

function isExpired(grant: Grant) {
  return Boolean(grant.expiresAt && Date.parse(grant.expiresAt) <= Date.now());
}

function resourceMatches(grant: Grant, resource: string) {
  if (grant.resource === resource) return true;
  if (grant.resource.startsWith('file://') && resource.startsWith('file://') && grant.constraints?.recursive !== false) {
    const base = grant.resource.replace(/\/+$/, '');
    return resource === base || resource.startsWith(`${base}/`);
  }
  return false;
}

function protectedPath(resource: string) {
  if (!resource.startsWith('file://')) return false;
  const parts = resource.slice('file://'.length).split(/[\\/]+/).filter(Boolean);
  return parts.some((part) => PROTECTED_PATH_NAMES.has(part) || /^\.env(?:\.|$)/i.test(part));
}

function trustedAdvisorSkillResource() {
  try {
    const root = realpathSync(process.env.MI_ADVISOR_SKILL_PATH || join(homedir(), '.pi', 'agent', 'skills', 'advisor'));
    return `file://${root}`.replace(/\\/g, '/');
  } catch {
    return '';
  }
}

function isTrustedAdvisorReadGrant(grant: Grant, resource: string, right: Right) {
  const root = trustedAdvisorSkillResource();
  return right === 'read'
    && grant.constraints?.profile === 'advisor-read'
    && Boolean(root)
    && (resource === root || resource.startsWith(`${root}/`))
    && resourceMatches(grant, resource);
}

function authorize(resource: string, right: Right) {
  for (const grant of grants) {
    if (isExpired(grant)) continue;
    if (!grant.rights?.includes(right)) continue;
    if (!resourceMatches(grant, resource)) continue;
    if (protectedPath(resource) && !isTrustedAdvisorReadGrant(grant, resource, right)) continue;
    return { allowed: true, capabilityId: grant.id, reason: `authorized by ${grant.id}` };
  }
  if (protectedPath(resource)) return { allowed: false, reason: `protected Mi path is not available: ${resource}` };
  return { allowed: false, reason: `missing ${right} capability for ${resource}` };
}

function requestForTool(toolName: string, input: any, cwd: string): ToolRequest | undefined {
  if (toolName === 'read') return { right: 'read', resource: fileResource(input?.path, cwd) };
  if (toolName === 'grep') return { right: 'read', resource: fileResource(input?.path || '.', cwd) };
  if (toolName === 'find') return { right: 'read', resource: fileResource(input?.path || '.', cwd) };
  if (toolName === 'ls') return { right: 'read', resource: fileResource(input?.path || '.', cwd) };
  if (toolName === 'write') return { right: 'write', resource: fileResource(input?.path, cwd) };
  if (toolName === 'edit') return { right: 'write', resource: fileResource(input?.path, cwd) };
  if (toolName === 'bash') return { right: 'execute', resource: 'tool://bash' };
  if (toolName === 'mi_diver_notes') {
    const operation = input?.operation;
    if (typeof operation !== 'string') return undefined;
    if (DIVER_NOTES_READ_OPERATIONS.has(operation)) return { right: 'read', resource: 'diver-notes://vault' };
    if (DIVER_NOTES_WRITE_OPERATIONS.has(operation)) return { right: 'write', resource: 'diver-notes://vault' };
    return undefined;
  }
  return undefined;
}

function extensionDecision(toolName: string) {
  if (ALLOWED_MI_EXTENSION_TOOLS.has(toolName) && process.env.MI_COORDINATOR_MODE === '1' && process.env.MI_COORDINATOR_POLICY_FILE) {
    return { allowed: true, reason: 'reviewed Mi coordinator adapter' };
  }
  if (BLOCKED_ORCHESTRATOR_TOOLS.has(toolName)) return { allowed: false, reason: 'global orchestrator controls are not available to Mi; use the reviewed Mi adapter' };
  return { allowed: false, reason: `unreviewed extension tool is denied: ${toolName}` };
}

export default function miCapabilityGuard(pi: ExtensionAPI) {
  pi.on('tool_call', async (event, ctx) => {
    const request = requestForTool(event.toolName, event.input, ctx.cwd || process.cwd());
    const decision = request
      ? authorize(request.resource, request.right)
      : extensionDecision(event.toolName);
    const right = request?.right || 'execute';
    const resource = request?.resource || `tool://${event.toolName}`;
    const record: AuditRecord = {
      ts: new Date().toISOString(),
      decision: decision.allowed ? 'allow' : enforcement === 'shadow' ? 'shadow' : 'deny',
      toolName: event.toolName,
      toolCallId: event.toolCallId,
      right,
      resource,
      reason: decision.reason,
      capabilityId: decision.capabilityId,
    };
    audit(record);
    if (!decision.allowed && enforcement !== 'shadow') return { block: true, reason: decision.reason };
    return undefined;
  });
}
