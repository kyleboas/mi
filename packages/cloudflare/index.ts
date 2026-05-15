import { defineTool, type Tool } from '../../src/primitives.js';

export const cloudflareGetIncidents = defineTool({
  name: 'cloudflare.getIncidents',
  description: 'Read Cloudflare public incident status.',
  permissions: ['status:read'],
  async run() {
    return {
      ok: false,
      tool: 'cloudflare.getIncidents',
      summary: 'Cloudflare local package is installed, but real status/API wiring is a later phase.',
    };
  },
});

export const tools: Tool[] = [cloudflareGetIncidents];
