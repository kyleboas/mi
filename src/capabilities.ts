import path from 'node:path';

export type PrincipalType = 'human' | 'imessage' | 'web' | 'cron' | 'mi' | 'worker' | 'system';

export type Principal = {
  id: string;
  type: PrincipalType;
  displayName?: string;
  source?: string;
};

export type CapabilityRight = 'read' | 'write' | 'execute' | 'fetch' | 'exchange';
export type CapabilityDecision = 'allow' | 'deny' | 'approval_required';

export type CapabilityConstraints = {
  recursive?: boolean;
  exact?: boolean;
  methods?: string[];
  env?: string[];
  commands?: string[];
  profile?: CapabilityProfileName;
  reason?: string;
};

export type CapabilityGrant = {
  id: string;
  resource: string;
  rights: CapabilityRight[];
  constraints?: CapabilityConstraints;
  principal: Principal;
  parentId?: string;
  createdAt: string;
  expiresAt?: string;
};

export type CapabilityRequest = {
  principal?: Principal;
  resource: string;
  right: CapabilityRight;
  tool?: string;
  action?: string;
  at?: string;
};

export type CapabilityAuthorization = {
  decision: CapabilityDecision;
  allowed: boolean;
  reason: string;
  capabilityId?: string;
  missing?: Pick<CapabilityRequest, 'resource' | 'right' | 'tool' | 'action'>;
};

export type CapabilityAuditEvent = CapabilityAuthorization & {
  ts: string;
  principal?: Principal;
  request: CapabilityRequest;
};

export type CapabilityProfileName = 'chat-read' | 'worker-read' | 'worker-write-scoped' | 'mi-main-orchestrator';

export type CapabilityProfile = {
  name: CapabilityProfileName;
  tools: string[];
  description: string;
  allowBash: boolean;
  env: string[];
};

export const SAFE_ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'HOSTNAME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'TERM',
  'TMPDIR',
  'TMP',
  'TEMP',
  'PI_PROVIDER',
  'PI_MODEL',
  'PI_CONFIG_DIR',
  'PI_GATEWAY_URL',
  'AGENT_GATEWAY_URL',
] as const;

export const CAPABILITY_PROFILES: Record<CapabilityProfileName, CapabilityProfile> = {
  'chat-read': {
    name: 'chat-read',
    tools: ['read', 'grep', 'find', 'ls'],
    description: 'Read/search only; raw bash is denied.',
    allowBash: false,
    env: [...SAFE_ENV_ALLOWLIST],
  },
  'worker-read': {
    name: 'worker-read',
    tools: ['read', 'grep', 'find', 'ls'],
    description: 'Scoped worker read/search only; raw bash is denied.',
    allowBash: false,
    env: [...SAFE_ENV_ALLOWLIST],
  },
  'worker-write-scoped': {
    name: 'worker-write-scoped',
    tools: ['read', 'grep', 'find', 'ls', 'write', 'edit'],
    description: 'Scoped worker file read/write without raw bash.',
    allowBash: false,
    env: [...SAFE_ENV_ALLOWLIST],
  },
  'mi-main-orchestrator': {
    name: 'mi-main-orchestrator',
    tools: ['read', 'grep', 'find', 'ls', 'write', 'edit'],
    description: 'Broad Mi orchestration profile; still no raw bash by default.',
    allowBash: false,
    env: [...SAFE_ENV_ALLOWLIST],
  },
};

export function principal(id: string, type: PrincipalType = 'human', displayName?: string): Principal {
  return displayName ? { id, type, displayName } : { id, type };
}

export function defaultPrincipal(source = 'local'): Principal {
  return { id: source, type: source === 'mi' ? 'mi' : 'human', displayName: source };
}

export function capabilityId(prefix = 'cap') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function normalizeFileResource(inputPath: string, cwd = process.cwd()): string {
  const absolute = path.resolve(cwd, inputPath || '.');
  return `file://${absolute}`;
}

export function mintCapabilityGrant(input: {
  resource: string;
  rights: CapabilityRight[];
  principal?: Principal;
  constraints?: CapabilityConstraints;
  parentId?: string;
  ttlMs?: number;
  expiresAt?: string;
  id?: string;
  createdAt?: string;
}): CapabilityGrant {
  const createdAt = input.createdAt || new Date().toISOString();
  return {
    id: input.id || capabilityId(),
    resource: input.resource,
    rights: [...new Set(input.rights)],
    constraints: input.constraints,
    principal: input.principal || defaultPrincipal(),
    parentId: input.parentId,
    createdAt,
    expiresAt: input.expiresAt || (input.ttlMs ? new Date(Date.parse(createdAt) + input.ttlMs).toISOString() : undefined),
  };
}

export function fileGrant(inputPath: string, rights: CapabilityRight[], options: { cwd?: string; principal?: Principal; recursive?: boolean; ttlMs?: number } = {}) {
  return mintCapabilityGrant({
    resource: normalizeFileResource(inputPath, options.cwd),
    rights,
    principal: options.principal,
    ttlMs: options.ttlMs,
    constraints: { recursive: options.recursive ?? true, exact: !(options.recursive ?? true) },
  });
}

export function urlGrant(url: string, options: { principal?: Principal; ttlMs?: number; methods?: string[] } = {}) {
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error(`Unsupported URL capability protocol: ${parsed.protocol}`);
  return mintCapabilityGrant({
    resource: parsed.toString(),
    rights: ['fetch'],
    principal: options.principal,
    ttlMs: options.ttlMs,
    constraints: { exact: true, methods: options.methods || ['GET', 'HEAD'] },
  });
}

function isExpired(grant: CapabilityGrant, at = new Date().toISOString()) {
  return Boolean(grant.expiresAt && Date.parse(grant.expiresAt) <= Date.parse(at));
}

function resourceMatches(grant: CapabilityGrant, requested: string) {
  if (grant.resource === requested) return true;
  if (grant.resource.startsWith('file://') && requested.startsWith('file://') && grant.constraints?.recursive !== false) {
    const base = grant.resource.replace(/\/+$/, '');
    return requested === base || requested.startsWith(`${base}/`);
  }
  return false;
}

export function authorizeCapability(request: CapabilityRequest, grants: CapabilityGrant[], options: { requireApprovalForMissing?: boolean } = {}): CapabilityAuthorization {
  const at = request.at || new Date().toISOString();
  for (const grant of grants) {
    if (isExpired(grant, at)) continue;
    if (!grant.rights.includes(request.right)) continue;
    if (!resourceMatches(grant, request.resource)) continue;
    return { decision: 'allow', allowed: true, reason: `authorized by ${grant.id}`, capabilityId: grant.id };
  }
  const missing = { resource: request.resource, right: request.right, tool: request.tool, action: request.action };
  if (options.requireApprovalForMissing) {
    return { decision: 'approval_required', allowed: false, reason: `missing ${request.right} capability for ${request.resource}`, missing };
  }
  return { decision: 'deny', allowed: false, reason: `missing ${request.right} capability for ${request.resource}`, missing };
}

export function auditCapability(request: CapabilityRequest, grants: CapabilityGrant[], options?: { requireApprovalForMissing?: boolean }): CapabilityAuditEvent {
  const authorization = authorizeCapability(request, grants, options);
  return {
    ...authorization,
    ts: new Date().toISOString(),
    principal: request.principal,
    request,
  };
}
