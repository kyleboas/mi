import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { appendFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Mi capability guard for scoped Pi workers.
 *
 * Spawn scoped workers with:
 *   --no-extensions --extension <this file> --tools read,grep,find,ls
 *   MI_CAPABILITY_GRANTS_FILE=/path/to/grants.json
 *
 * This extension is the enforcement plane for phase-1 host capabilities. It
 * blocks tool calls before execution when no explicit grant covers the resource.
 */

type Right = 'read' | 'write' | 'execute' | 'fetch' | 'exchange';

type Grant = {
  id: string;
  resource: string;
  rights: Right[];
  constraints?: { recursive?: boolean; exact?: boolean; commands?: string[]; env?: string[]; profile?: string };
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

function fileResource(inputPath: string | undefined, cwd: string) {
  const absolute = resolve(cwd, inputPath || '.');
  return `file://${absolute}`;
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

function authorize(resource: string, right: Right) {
  for (const grant of grants) {
    if (isExpired(grant)) continue;
    if (!grant.rights?.includes(right)) continue;
    if (!resourceMatches(grant, resource)) continue;
    return { allowed: true, capabilityId: grant.id, reason: `authorized by ${grant.id}` };
  }
  return { allowed: false, reason: `missing ${right} capability for ${resource}` };
}

function requestForTool(toolName: string, input: any, cwd: string): { right: Right; resource: string } | undefined {
  if (toolName === 'read') return { right: 'read', resource: fileResource(input?.path, cwd) };
  if (toolName === 'grep') return { right: 'read', resource: fileResource(input?.path || '.', cwd) };
  if (toolName === 'find') return { right: 'read', resource: fileResource(input?.path || '.', cwd) };
  if (toolName === 'ls') return { right: 'read', resource: fileResource(input?.path || '.', cwd) };
  if (toolName === 'write') return { right: 'write', resource: fileResource(input?.path, cwd) };
  if (toolName === 'edit') return { right: 'write', resource: fileResource(input?.path, cwd) };
  if (toolName === 'bash') return { right: 'execute', resource: 'tool://bash' };
  return undefined;
}

export default function miCapabilityGuard(pi: ExtensionAPI) {
  pi.on('tool_call', async (event, ctx) => {
    const request = requestForTool(event.toolName, event.input, ctx.cwd || process.cwd());
    if (!request) return undefined;
    const decision = authorize(request.resource, request.right);
    const record: AuditRecord = {
      ts: new Date().toISOString(),
      decision: decision.allowed ? 'allow' : enforcement === 'shadow' ? 'shadow' : 'deny',
      toolName: event.toolName,
      toolCallId: event.toolCallId,
      right: request.right,
      resource: request.resource,
      reason: decision.reason,
      capabilityId: decision.capabilityId,
    };
    audit(record);
    if (!decision.allowed && enforcement !== 'shadow') {
      return { block: true, reason: decision.reason };
    }
    return undefined;
  });
}
