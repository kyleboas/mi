import { defineTool } from '../../src/primitives.js';
function unavailable(name) {
    return {
        ok: false,
        tool: name,
        summary: 'Railway local package is installed, but real Railway API wiring is a later phase.',
        needsConfig: ['RAILWAY_TOKEN', 'RAILWAY_PROJECT_ID'],
    };
}
export const railwayGetLatestDeployment = defineTool({
    name: 'railway.getLatestDeployment',
    description: 'Read the latest Railway deployment status.',
    permissions: ['deployments:read'],
    async run() {
        return unavailable('railway.getLatestDeployment');
    },
});
export const railwayGetDeployLogs = defineTool({
    name: 'railway.getDeployLogs',
    description: 'Read Railway deployment logs.',
    permissions: ['logs:read'],
    async run(input) {
        return { ...unavailable('railway.getDeployLogs'), requested: input };
    },
});
export const tools = [railwayGetLatestDeployment, railwayGetDeployLogs];
