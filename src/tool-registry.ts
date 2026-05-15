import type { Tool } from './primitives.js';
import { tools as piTools } from '../packages/pi/index.js';
import { tools as githubTools } from '../packages/github/index.js';
import { tools as railwayTools } from '../packages/railway/index.js';
import { tools as cloudflareTools } from '../packages/cloudflare/index.js';

const localTools: Tool[] = [
  ...piTools,
  ...githubTools,
  ...railwayTools,
  ...cloudflareTools,
];

export function listTools() {
  return localTools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    permissions: tool.permissions || [],
  }));
}

export function getTool(name: string) {
  return localTools.find((tool) => tool.name === name);
}

export function requireTool(name: string) {
  const tool = getTool(name);
  if (!tool) throw new Error(`tool not found: ${name}`);
  return tool;
}
