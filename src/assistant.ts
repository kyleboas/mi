export type AssistantName = string;

export type TriggerConfig =
  | { manual: true }
  | { every: string }
  | { webhook: string }
  | { event: string };

export type Permissions = Record<string, Record<string, string | boolean>>;

export type AssistantFile = {
  name: AssistantName;
  path: string;
  triggers: TriggerConfig[];
  tools: string[];
  permissions: Permissions;
  instructions: string;
  rawFrontmatter: string;
  rawMarkdown: string;
};

export type AssistantDraft = {
  name: AssistantName;
  path: string;
  markdown: string;
};

export type AssistantRunRequest = {
  name: AssistantName;
  trigger: 'manual' | 'timer' | 'webhook' | 'event';
  input?: string;
};

export type AssistantRunResult = {
  name: AssistantName;
  startedAt: string;
  trigger: AssistantRunRequest['trigger'];
  status: 'ok' | 'needs_attention' | 'approval_required' | 'error';
  summary: string;
};

export function assistantPath(name: AssistantName) {
  const safe = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!safe) throw new Error('assistant name required');
  return `assistants/${safe}.md`;
}

function parseScalar(value: string): string | boolean {
  const trimmed = value.trim();
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  return trimmed.replace(/^['"]|['"]$/g, '');
}

function parseStringList(frontmatter: string, key: string): string[] {
  const lines = frontmatter.split('\n');
  const start = lines.findIndex((line) => line.trim() === `${key}:`);
  if (start === -1) return [];
  const values: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith('  - ')) break;
    values.push(String(parseScalar(line.slice(4))));
  }
  return values;
}

function parseTriggers(frontmatter: string): TriggerConfig[] {
  const lines = frontmatter.split('\n');
  const start = lines.findIndex((line) => line.trim() === 'triggers:');
  if (start === -1) return [];
  const triggers: TriggerConfig[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith('  - ')) break;
    const item = line.slice(4);
    const colon = item.indexOf(':');
    if (colon === -1) continue;
    const key = item.slice(0, colon).trim();
    const value = parseScalar(item.slice(colon + 1));
    if (key === 'manual' && value === true) triggers.push({ manual: true });
    else if (key === 'every' && typeof value === 'string') triggers.push({ every: value });
    else if (key === 'webhook' && typeof value === 'string') triggers.push({ webhook: value });
    else if (key === 'event' && typeof value === 'string') triggers.push({ event: value });
  }
  return triggers;
}

function parsePermissions(frontmatter: string): Permissions {
  const lines = frontmatter.split('\n');
  const start = lines.findIndex((line) => line.trim() === 'permissions:');
  const permissions: Permissions = {};
  if (start === -1) return permissions;
  let section = '';
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith('  ')) break;
    if (/^  [A-Za-z0-9_-]+:\s*$/.test(line)) {
      section = line.trim().slice(0, -1);
      permissions[section] = {};
      continue;
    }
    const match = line.match(/^    ([A-Za-z0-9_-]+):\s*(.+)$/);
    if (section && match) permissions[section][match[1]] = parseScalar(match[2]);
  }
  return permissions;
}

export function parseAssistantMarkdown(markdown: string, path = ''): AssistantFile {
  const match = markdown.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) throw new Error('assistant file must start with frontmatter delimited by ---');
  const rawFrontmatter = match[1];
  const instructions = match[2].trim();
  const name = String(rawFrontmatter.match(/^name:\s*(.+)$/m)?.[1] || '').trim();
  if (!name) throw new Error('assistant frontmatter requires name');
  const triggers = parseTriggers(rawFrontmatter);
  const tools = parseStringList(rawFrontmatter, 'tools');
  const permissions = parsePermissions(rawFrontmatter);
  return {
    name,
    path: path || assistantPath(name),
    triggers,
    tools,
    permissions,
    instructions,
    rawFrontmatter,
    rawMarkdown: markdown,
  };
}

export function validateAssistantFile(file: AssistantFile): string[] {
  const issues: string[] = [];
  if (!file.name.trim()) issues.push('frontmatter.name is required');
  if (file.triggers.length === 0) issues.push('frontmatter.triggers must include at least one trigger');
  if (!Array.isArray(file.tools)) issues.push('frontmatter.tools must be a list');
  if (!file.instructions.trim()) issues.push('assistant instructions are required');
  if (!/^#\s+/m.test(file.instructions)) issues.push('assistant instructions should start with a Markdown heading');
  return issues;
}
